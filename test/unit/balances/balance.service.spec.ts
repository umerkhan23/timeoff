import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BalanceService } from '../../../src/modules/balances/balance.service';
import { LeaveBalance } from '../../../src/modules/balances/entities/leave-balance.entity';
import { TimeOffRequest } from '../../../src/modules/requests/entities/time-off-request.entity';
import { AuditService } from '../../../src/modules/audit/audit.service';
import { AuditSource } from '../../../src/modules/audit/entities/balance-audit-log.entity';

const mkBalance = (overrides: Partial<LeaveBalance> = {}): LeaveBalance => ({
  id: 'bal-1',
  employee_id: 'emp-1',
  location_id: 'loc-1',
  total_days: 20,
  reserved_days: 0,
  used_days: 0,
  version: 0,
  hcm_synced_at: null,
  updated_at: new Date(),
  employee: null,
  location: null,
  get available_days() { return Math.max(0, this.total_days - this.reserved_days - this.used_days); },
  ...overrides,
});

describe('BalanceService — unit', () => {
  let service: BalanceService;
  let balanceRepo: any;
  let requestRepo: any;
  let auditService: any;
  let dataSource: any;
  let mockRunner: any;

  beforeEach(async () => {
    balanceRepo  = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() };
    requestRepo  = { find: jest.fn() };
    auditService = { log: jest.fn().mockResolvedValue({}) };
    mockRunner   = {
      connect: jest.fn().mockResolvedValue(undefined),
      query:   jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
    };
    dataSource   = {
      query: jest.fn(),
      transaction: jest.fn(),
      createQueryRunner: jest.fn(() => mockRunner),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(LeaveBalance),    useValue: balanceRepo  },
        { provide: getRepositoryToken(TimeOffRequest),  useValue: requestRepo  },
        { provide: AuditService,                        useValue: auditService },
        { provide: DataSource,                          useValue: dataSource   },
      ],
    }).compile();

    service = mod.get(BalanceService);
  });

  afterEach(() => jest.clearAllMocks());

  // ──────────────────────────────────────────
  // findOne
  // ──────────────────────────────────────────
  describe('findOne', () => {
    it('returns balance when it exists', async () => {
      balanceRepo.findOne.mockResolvedValue(mkBalance());
      const b = await service.findOne('emp-1', 'loc-1');
      expect(b.total_days).toBe(20);
    });

    it('throws NotFoundException when balance does not exist', async () => {
      balanceRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('emp-X', 'loc-X')).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────────────────
  // reserve — TRD §7.3 optimistic locking
  // ──────────────────────────────────────────
  describe('reserve', () => {
    it('succeeds and returns success:true when balance is sufficient', async () => {
      const bal = mkBalance({ total_days: 20, reserved_days: 0, used_days: 0 });
      balanceRepo.findOne
        .mockResolvedValueOnce(bal)        // pre-check read
        .mockResolvedValueOnce({ ...bal, reserved_days: 5 }); // post-update read
      mockRunner.query.mockResolvedValueOnce({ affected: 1, records: [], raw: [] });

      const result = await service.reserve('emp-1', 'loc-1', 5, 'req-1');

      expect(result.success).toBe(true);
      expect(mockRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE leave_balances'),
        [5, 'emp-1', 'loc-1', 0, 5],
        true,
      );
    });

    it('returns INSUFFICIENT_BALANCE when available_days < requested', async () => {
      balanceRepo.findOne.mockResolvedValue(mkBalance({ total_days: 3, reserved_days: 0, used_days: 0 }));

      const result = await service.reserve('emp-1', 'loc-1', 5, 'req-1');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INSUFFICIENT_BALANCE');
      expect(result.availableBefore).toBe(3);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('accounts for both reserved_days AND used_days in availability calculation', async () => {
      // total=20, reserved=10, used=8 → available=2; requesting 3 must fail
      const bal = mkBalance({ total_days: 20, reserved_days: 10, used_days: 8 });
      balanceRepo.findOne.mockResolvedValue(bal);

      const result = await service.reserve('emp-1', 'loc-1', 3, 'req-1');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INSUFFICIENT_BALANCE');
      expect(result.availableBefore).toBe(2);
    });

    it('succeeds at the exact boundary (requesting all available days)', async () => {
      const bal = mkBalance({ total_days: 5, reserved_days: 0, used_days: 0 });
      balanceRepo.findOne
        .mockResolvedValueOnce(bal)
        .mockResolvedValueOnce({ ...bal, reserved_days: 5 });
      mockRunner.query.mockResolvedValueOnce({ affected: 1, records: [], raw: [] });

      const result = await service.reserve('emp-1', 'loc-1', 5, 'req-1');
      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND when balance record does not exist', async () => {
      balanceRepo.findOne.mockResolvedValue(null);
      const result = await service.reserve('emp-X', 'loc-X', 5, 'req-1');
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('NOT_FOUND');
    });

    it('retries on version conflict and eventually succeeds', async () => {
      const bal = mkBalance({ total_days: 10, reserved_days: 0, used_days: 0 });
      balanceRepo.findOne
        .mockResolvedValueOnce(bal) // attempt 1 read
        .mockResolvedValueOnce(bal) // attempt 2 read
        .mockResolvedValueOnce({ ...bal, reserved_days: 5 }); // post-success read
      mockRunner.query
        .mockResolvedValueOnce({ affected: 0, records: [], raw: [] }) // attempt 1: conflict
        .mockResolvedValueOnce({ affected: 1, records: [], raw: [] }); // attempt 2: success

      const result = await service.reserve('emp-1', 'loc-1', 5, 'req-1');

      expect(result.success).toBe(true);
      expect(mockRunner.query).toHaveBeenCalledTimes(2); // 1 call per attempt
    });

    it('returns CONFLICT after exhausting all retries', async () => {
      const bal = mkBalance({ total_days: 10, reserved_days: 0, used_days: 0 });
      balanceRepo.findOne.mockResolvedValue(bal);
      mockRunner.query.mockResolvedValue({ affected: 0, records: [], raw: [] }); // always conflict

      const result = await service.reserve('emp-1', 'loc-1', 5, 'req-1');

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('CONFLICT');
      expect(mockRunner.query).toHaveBeenCalledTimes(3); // 1 call per attempt × 3 retries
    });

    it('writes an audit log entry on successful reservation', async () => {
      const bal = mkBalance({ total_days: 10, reserved_days: 0, used_days: 0 });
      balanceRepo.findOne
        .mockResolvedValueOnce(bal)
        .mockResolvedValueOnce({ ...bal, reserved_days: 5 });
      mockRunner.query.mockResolvedValueOnce({ affected: 1, records: [], raw: [] });

      await service.reserve('emp-1', 'loc-1', 5, 'req-1');

      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
        delta_days: -5,
        source: AuditSource.REQUEST,
        reference_id: 'req-1',
      }));
    });
  });

  // ──────────────────────────────────────────
  // release
  // ──────────────────────────────────────────
  describe('release', () => {
    it('decrements reserved_days on release', async () => {
      const bal = mkBalance({ reserved_days: 5 });
      dataSource.transaction.mockImplementation(async (fn) => {
        const mgr = {
          findOne: jest.fn().mockResolvedValue(bal),
          save: jest.fn().mockImplementation((_, b) => Promise.resolve(b)),
        };
        return fn(mgr);
      });
      balanceRepo.findOne.mockResolvedValue({ ...bal, reserved_days: 0 });

      await service.release('emp-1', 'loc-1', 5, 'req-1');

      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('never allows reserved_days to go below zero', async () => {
      const bal = mkBalance({ reserved_days: 2 });
      let savedBal: any;
      dataSource.transaction.mockImplementation(async (fn) => {
        const mgr = {
          findOne: jest.fn().mockResolvedValue(bal),
          save: jest.fn().mockImplementation((_, b) => { savedBal = b; return Promise.resolve(b); }),
        };
        return fn(mgr);
      });
      balanceRepo.findOne.mockResolvedValue(mkBalance({ reserved_days: 0 }));

      await service.release('emp-1', 'loc-1', 10, 'req-1'); // releasing more than reserved

      expect(savedBal.reserved_days).toBe(0);
    });
  });

  // ──────────────────────────────────────────
  // commit (reserve → used)
  // ──────────────────────────────────────────
  describe('commit', () => {
    it('moves reserved_days to used_days on approval', async () => {
      const bal = mkBalance({ reserved_days: 5, used_days: 0 });
      let saved: any;
      dataSource.transaction.mockImplementation(async (fn) => {
        const mgr = {
          findOne: jest.fn().mockResolvedValue(bal),
          save: jest.fn().mockImplementation((_, b) => { saved = b; return b; }),
        };
        return fn(mgr);
      });

      await service.commit('emp-1', 'loc-1', 5, 'req-1');

      expect(saved.reserved_days).toBe(0);
      expect(saved.used_days).toBe(5);
    });
  });

  // ──────────────────────────────────────────
  // upsertFromHcm — conflict resolution (TRD §7.2)
  // ──────────────────────────────────────────
  describe('upsertFromHcm', () => {
    it('creates a new balance record when none exists', async () => {
      dataSource.transaction.mockImplementation(async (fn) => {
        const mgr = {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((_, d) => ({ ...d })),
          save: jest.fn().mockImplementation((_, b) => Promise.resolve(b)),
          find: jest.fn().mockResolvedValue([]),
        };
        return fn(mgr);
      });

      const result = await service.upsertFromHcm({
        employeeId: 'emp-1', locationId: 'loc-1',
        totalDays: 20, source: AuditSource.HCM_REALTIME,
      });

      expect(result.balance.total_days).toBe(20);
      expect(result.conflicted).toBe(false);
    });

    it('updates total_days when HCM pushes a work-anniversary bonus', async () => {
      const existing = mkBalance({ total_days: 20, reserved_days: 0, used_days: 0, version: 1 });
      let saved: any;
      dataSource.transaction.mockImplementation(async (fn) => {
        const mgr = {
          findOne: jest.fn().mockResolvedValue(existing),
          create: jest.fn().mockImplementation((_, d) => d),
          save: jest.fn().mockImplementation((Entity, b) => {
            if (b && b.total_days !== undefined) saved = b;
            return Promise.resolve(b ?? {});
          }),
          find: jest.fn().mockResolvedValue([]),
        };
        return fn(mgr);
      });

      const result = await service.upsertFromHcm({
        employeeId: 'emp-1', locationId: 'loc-1',
        totalDays: 25, source: AuditSource.HCM_REALTIME,
      });

      expect(saved.total_days).toBe(25);
      expect(result.conflicted).toBe(false);
    });

    it('flags active requests as NEEDS_REVIEW when HCM reduces balance below reserved', async () => {
      const { RequestStatus } = require('../../../src/modules/requests/entities/time-off-request.entity');
      const existing = mkBalance({ total_days: 20, reserved_days: 15, used_days: 0, version: 1 });
      const activeReq = { id: 'req-1', status: RequestStatus.PENDING_APPROVAL, created_at: new Date() };

      dataSource.transaction.mockImplementation(async (fn) => {
        let reqStatus = activeReq.status;
        const mgr = {
          findOne: jest.fn().mockResolvedValue(existing),
          create: jest.fn(),
          save: jest.fn().mockImplementation((Entity, b) => {
            if (b && b.status) reqStatus = b.status;
            return Promise.resolve(b);
          }),
          find: jest.fn().mockResolvedValue([activeReq]),
        };
        const result = await fn(mgr);
        // Verify the request was flagged
        expect(reqStatus).toBe(RequestStatus.NEEDS_REVIEW);
        return result;
      });

      const result = await service.upsertFromHcm({
        employeeId: 'emp-1', locationId: 'loc-1',
        totalDays: 5, // HCM reduced from 20 → 5; reserved=15 → conflict
        source: AuditSource.HCM_REALTIME,
      });

      expect(result.conflicted).toBe(true);
    });
  });
});
