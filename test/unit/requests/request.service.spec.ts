import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException, BadRequestException,
  UnprocessableEntityException, ConflictException,
} from '@nestjs/common';
import { RequestService } from '../../../src/modules/requests/request.service';
import { TimeOffRequest, RequestStatus } from '../../../src/modules/requests/entities/time-off-request.entity';
import { Employee } from '../../../src/modules/employees/entities/employee.entity';
import { Location } from '../../../src/modules/locations/entities/location.entity';
import { BalanceService } from '../../../src/modules/balances/balance.service';
import { HcmClientService } from '../../../src/modules/hcm-client/hcm-client.service';

const mkEmployee  = (): Employee  => ({ id: 'emp-1', external_id: 'EMP001', name: 'Alice', email: 'a@test.com', created_at: new Date(), updated_at: new Date(), balances: [], requests: [], audit_logs: [] });
const mkLocation  = (): Location  => ({ id: 'loc-1', external_id: 'LOC-US', name: 'NY', created_at: new Date(), balances: [], requests: [] });
const mkRequest   = (overrides: Partial<TimeOffRequest> = {}): TimeOffRequest => ({
  id: 'req-1', employee_id: 'emp-1', location_id: 'loc-1',
  start_date: '2025-08-01', end_date: '2025-08-05',
  duration_days: 5, reason: null, status: RequestStatus.PENDING_LOCAL,
  idempotency_key: null, hcm_reference_id: null, hcm_filed_at: null,
  hcm_error: null, hcm_retry_count: 0,
  created_at: new Date(), updated_at: new Date(),
  employee: null, location: null,
  ...overrides,
});

describe('RequestService — unit', () => {
  let service: RequestService;
  let requestRepo: any;
  let employeeRepo: any;
  let locationRepo: any;
  let balanceService: any;
  let hcmClient: any;

  beforeEach(async () => {
    requestRepo  = { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn(() => ({ where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), getMany: jest.fn().mockResolvedValue([]) })) };
    employeeRepo = { findOne: jest.fn() };
    locationRepo = { findOne: jest.fn() };
    balanceService = {
      reserve: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      decommit: jest.fn().mockResolvedValue(undefined),
    };
    hcmClient = {
      submitRequest: jest.fn(),
      cancelRequest: jest.fn().mockResolvedValue({ success: true }),
    };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        RequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo  },
        { provide: getRepositoryToken(Employee),       useValue: employeeRepo },
        { provide: getRepositoryToken(Location),       useValue: locationRepo },
        { provide: BalanceService,                     useValue: balanceService },
        { provide: HcmClientService,                   useValue: hcmClient    },
      ],
    }).compile();

    service = mod.get(RequestService);
  });

  afterEach(() => jest.clearAllMocks());

  // ──────────────────────────────────────────
  // submit
  // ──────────────────────────────────────────
  describe('submit', () => {
    beforeEach(() => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(mkLocation());
      balanceService.reserve.mockResolvedValue({ success: true, balance: {} });
      requestRepo.create.mockImplementation((d: any) => ({ ...mkRequest(), ...d }));
      requestRepo.save.mockImplementation((r: any) => Promise.resolve({ ...r, id: 'req-1' }));
      requestRepo.update.mockResolvedValue({ affected: 1 });
      hcmClient.submitRequest.mockResolvedValue({ status: 'ACCEPTED', hcm_reference_id: 'HCM-000001' });
    });

    it('creates a PENDING_LOCAL request and returns immediately', async () => {
      const result = await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      });
      expect(result.status).toBe(RequestStatus.PENDING_LOCAL);
      expect(balanceService.reserve).toHaveBeenCalledWith('emp-1', 'loc-1', 5, expect.any(String));
    });

    it('returns the original request on duplicate idempotency key', async () => {
      const existing = mkRequest({ idempotency_key: 'idem-key-1' });
      requestRepo.findOne.mockResolvedValue(existing);

      const result = await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
        idempotencyKey: 'idem-key-1',
      });

      // Must return original without calling reserve again
      expect(result.idempotency_key).toBe('idem-key-1');
      expect(balanceService.reserve).not.toHaveBeenCalled();
    });

    it('throws UnprocessableEntityException when balance is insufficient', async () => {
      balanceService.reserve.mockResolvedValue({
        success: false, errorCode: 'INSUFFICIENT_BALANCE', availableBefore: 2,
      });
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws UnprocessableEntityException with available days in the message', async () => {
      balanceService.reserve.mockResolvedValue({
        success: false, errorCode: 'INSUFFICIENT_BALANCE', availableBefore: 2,
      });
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(/Available: 2/);
    });

    it('throws ConflictException on optimistic lock exhaustion', async () => {
      balanceService.reserve.mockResolvedValue({ success: false, errorCode: 'CONFLICT' });
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when employee does not exist', async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      await expect(service.submit({
        employeeId: 'emp-X', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when location does not exist', async () => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(null);
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-X',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when reservation returns NOT_FOUND', async () => {
      balanceService.reserve.mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' });
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      })).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when end_date < start_date', async () => {
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-10', endDate: '2025-08-01', durationDays: 5,
      })).rejects.toThrow(BadRequestException);
    });

    it('accepts same-day requests (start == end)', async () => {
      const result = await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-01', durationDays: 1,
      });
      expect(result.status).toBe(RequestStatus.PENDING_LOCAL);
    });

    it('throws BadRequestException for invalid date format', async () => {
      await expect(service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: 'invalid-date', endDate: '2025-08-01', durationDays: 1,
      })).rejects.toThrow(BadRequestException);
    });

    it('logs async failure when pre-HCM status update fails', async () => {
      const loggerErrorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      requestRepo.update.mockRejectedValueOnce(new Error('db update failed'));

      await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Async HCM submission failed'));
      loggerErrorSpy.mockRestore();
    });

    it('sets hcm_error from errorCode when HCM rejects without errorMessage', async () => {
      hcmClient.submitRequest.mockResolvedValueOnce({ status: 'REJECTED', errorCode: 'INVALID_DIMENSION' });
      requestRepo.update.mockResolvedValue({});

      await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(requestRepo.update).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ hcm_error: 'INVALID_DIMENSION' }),
      );
    });

    it('sets fallback HCM_REJECTED when reject has no error fields', async () => {
      hcmClient.submitRequest.mockResolvedValueOnce({ status: 'REJECTED' });
      requestRepo.update.mockResolvedValue({});

      await service.submit({
        employeeId: 'emp-1', locationId: 'loc-1',
        startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(requestRepo.update).toHaveBeenCalledWith(
        'req-1',
        expect.objectContaining({ hcm_error: 'HCM_REJECTED' }),
      );
    });
  });

  // ──────────────────────────────────────────
  // approve — TRD §5: PENDING_APPROVAL → APPROVED
  // ──────────────────────────────────────────
  describe('approve', () => {
    it('approves a PENDING_APPROVAL request and commits balance', async () => {
      const req = mkRequest({ status: RequestStatus.PENDING_APPROVAL });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.APPROVED });
      requestRepo.update.mockResolvedValue({ affected: 1 });

      const result = await service.approve('req-1', {});

      expect(balanceService.commit).toHaveBeenCalledWith('emp-1', 'loc-1', 5, 'req-1');
      expect(result.status).toBe(RequestStatus.APPROVED);
    });

    it('throws BadRequestException when approving PENDING_LOCAL (invalid transition)', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.PENDING_LOCAL }));
      await expect(service.approve('req-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when approving an APPROVED request (double-approve)', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.APPROVED }));
      await expect(service.approve('req-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when approving a FAILED request', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.FAILED }));
      await expect(service.approve('req-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent request', async () => {
      requestRepo.findOne.mockResolvedValue(null);
      await expect(service.approve('bad-id', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ──────────────────────────────────────────
  // reject — TRD §5: PENDING_APPROVAL → REJECTED
  // ──────────────────────────────────────────
  describe('reject', () => {
    it('rejects a PENDING_APPROVAL request and releases reservation', async () => {
      const req = mkRequest({ status: RequestStatus.PENDING_APPROVAL });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.REJECTED });
      requestRepo.update.mockResolvedValue({ affected: 1 });

      await service.reject('req-1', {});

      expect(balanceService.release).toHaveBeenCalledWith('emp-1', 'loc-1', 5, 'req-1');
    });

    it('calls HCM cancel when hcm_reference_id is present', async () => {
      const req = mkRequest({ status: RequestStatus.PENDING_APPROVAL, hcm_reference_id: 'HCM-000001' });
      requestRepo.findOne.mockResolvedValue(req);
      requestRepo.update.mockResolvedValue({});

      await service.reject('req-1', {});

      expect(hcmClient.cancelRequest).toHaveBeenCalledWith('HCM-000001');
    });

    it('still rejects locally even if HCM cancel call fails', async () => {
      const req = mkRequest({ status: RequestStatus.PENDING_APPROVAL, hcm_reference_id: 'HCM-000001' });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.REJECTED });
      requestRepo.update.mockResolvedValue({});
      hcmClient.cancelRequest.mockRejectedValue(new Error('HCM timeout'));

      // Should not throw
      await expect(service.reject('req-1', {})).resolves.not.toThrow();
      expect(balanceService.release).toHaveBeenCalled();
    });

    it('throws BadRequestException when rejecting an already REJECTED request', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.REJECTED }));
      await expect(service.reject('req-1', {})).rejects.toThrow(BadRequestException);
    });
  });

  // ──────────────────────────────────────────
  // cancel — TRD §5: PENDING_APPROVAL | APPROVED → CANCELLED
  // ──────────────────────────────────────────
  describe('cancel', () => {
    it('allows employee to cancel their own PENDING_APPROVAL request', async () => {
      const req = mkRequest({ status: RequestStatus.PENDING_APPROVAL, employee_id: 'emp-1' });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.CANCELLED });
      requestRepo.update.mockResolvedValue({});

      await service.cancel('req-1', 'emp-1');

      expect(balanceService.release).toHaveBeenCalledWith('emp-1', 'loc-1', 5, 'req-1');
    });

    it('decommits used_days when cancelling an APPROVED request', async () => {
      const req = mkRequest({ status: RequestStatus.APPROVED, employee_id: 'emp-1' });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.CANCELLED });
      requestRepo.update.mockResolvedValue({});

      await service.cancel('req-1', 'emp-1');

      expect(balanceService.decommit).toHaveBeenCalledWith('emp-1', 'loc-1', 5, 'req-1');
    });

    it('throws BadRequestException when cancelling another employee\'s request', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ employee_id: 'emp-1' }));
      await expect(service.cancel('req-1', 'emp-OTHER')).rejects.toThrow(BadRequestException);
      await expect(service.cancel('req-1', 'emp-OTHER')).rejects.toThrow(/own/);
    });

    it('throws BadRequestException when cancelling a FAILED request', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.FAILED, employee_id: 'emp-1' }));
      await expect(service.cancel('req-1', 'emp-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when cancelling a REJECTED request', async () => {
      requestRepo.findOne.mockResolvedValue(mkRequest({ status: RequestStatus.REJECTED, employee_id: 'emp-1' }));
      await expect(service.cancel('req-1', 'emp-1')).rejects.toThrow(BadRequestException);
    });

    it('still cancels locally even if HCM cancel fails during cancel()', async () => {
      const loggerWarnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const req = mkRequest({
        status: RequestStatus.PENDING_APPROVAL,
        employee_id: 'emp-1',
        hcm_reference_id: 'HCM-000002',
      });
      requestRepo.findOne
        .mockResolvedValueOnce(req)
        .mockResolvedValueOnce({ ...req, status: RequestStatus.CANCELLED });
      requestRepo.update.mockResolvedValue({});
      hcmClient.cancelRequest.mockRejectedValueOnce(new Error('network timeout'));

      await expect(service.cancel('req-1', 'emp-1')).resolves.not.toThrow();
      expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining('HCM cancel failed'));
      loggerWarnSpy.mockRestore();
    });
  });
});
