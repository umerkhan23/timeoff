import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { SyncService } from '../../../src/modules/sync/sync.service';
import { SyncJob, SyncJobStatus } from '../../../src/modules/sync/entities/sync-job.entity';
import { Employee } from '../../../src/modules/employees/entities/employee.entity';
import { Location } from '../../../src/modules/locations/entities/location.entity';
import { BalanceService } from '../../../src/modules/balances/balance.service';
import { HcmClientService } from '../../../src/modules/hcm-client/hcm-client.service';
import { AuditSource } from '../../../src/modules/audit/entities/balance-audit-log.entity';

const mkEmployee = (id = 'emp-1', extId = 'EMP001'): Employee =>
  ({ id, external_id: extId, name: 'Alice', email: 'a@test.com', created_at: new Date(), updated_at: new Date(), balances: [], requests: [], audit_logs: [] });

const mkLocation = (id = 'loc-1', extId = 'LOC-US'): Location =>
  ({ id, external_id: extId, name: 'NY', created_at: new Date(), balances: [], requests: [] });

const mkJob = (overrides: Partial<SyncJob> = {}): SyncJob => ({
  id: 'job-1', batch_id: 'batch-1', generated_at: new Date().toISOString(),
  status: SyncJobStatus.PENDING, records_total: 0, records_processed: 0,
  records_failed: 0, error_detail: null,
  created_at: new Date(), updated_at: new Date(),
  ...overrides,
});

describe('SyncService — unit', () => {
  let service: SyncService;
  let jobRepo: any;
  let employeeRepo: any;
  let locationRepo: any;
  let balanceService: any;
  let hcmClient: any;

  beforeEach(async () => {
    jobRepo      = { findOne: jest.fn(), create: jest.fn(), save: jest.fn(), update: jest.fn() };
    employeeRepo = { findOne: jest.fn() };
    locationRepo = { findOne: jest.fn() };
    balanceService = { upsertFromHcm: jest.fn().mockResolvedValue({ balance: {}, conflicted: false }) };
    hcmClient    = { triggerBatchPull: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncJob),  useValue: jobRepo       },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo  },
        { provide: getRepositoryToken(Location), useValue: locationRepo  },
        { provide: BalanceService,               useValue: balanceService },
        { provide: HcmClientService,             useValue: hcmClient     },
      ],
    }).compile();

    service = mod.get(SyncService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─────────────────────────────────────────────
  // handleRealtimePush — TRD §7.1
  // ─────────────────────────────────────────────
  describe('handleRealtimePush', () => {
    it('resolves external IDs and upserts balance', async () => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(mkLocation());
      balanceService.upsertFromHcm.mockResolvedValue({ balance: { total_days: 25 }, conflicted: false });

      const result = await service.handleRealtimePush({
        employeeExternalId: 'EMP001',
        locationExternalId: 'LOC-US',
        totalDays: 25,
      });

      expect(balanceService.upsertFromHcm).toHaveBeenCalledWith({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        totalDays: 25,
        source: AuditSource.HCM_REALTIME,
      });
      expect(result.conflicted).toBe(false);
    });

    it('throws BadRequestException on unknown employee external_id', async () => {
      employeeRepo.findOne.mockResolvedValue(null);
      locationRepo.findOne.mockResolvedValue(mkLocation());

      await expect(service.handleRealtimePush({
        employeeExternalId: 'UNKNOWN',
        locationExternalId: 'LOC-US',
        totalDays: 20,
      })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException on unknown location external_id', async () => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(null);

      await expect(service.handleRealtimePush({
        employeeExternalId: 'EMP001',
        locationExternalId: 'UNKNOWN',
        totalDays: 20,
      })).rejects.toThrow(BadRequestException);
    });

    it('returns conflicted:true when HCM reduces balance below reserved amount', async () => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(mkLocation());
      balanceService.upsertFromHcm.mockResolvedValue({ balance: {}, conflicted: true });

      const result = await service.handleRealtimePush({
        employeeExternalId: 'EMP001',
        locationExternalId: 'LOC-US',
        totalDays: 2, // very low — causes conflict
      });

      expect(result.conflicted).toBe(true);
    });

    it('passes reservedDays and usedDays when provided in realtime payload', async () => {
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(mkLocation());
      balanceService.upsertFromHcm.mockResolvedValue({ balance: {}, conflicted: false });

      await service.handleRealtimePush({
        employeeExternalId: 'EMP001',
        locationExternalId: 'LOC-US',
        totalDays: 25,
        reservedDays: 2,
        usedDays: 3,
      });

      expect(balanceService.upsertFromHcm).toHaveBeenCalledWith(expect.objectContaining({
        reservedDays: 2,
        usedDays: 3,
      }));
    });
  });

  // ─────────────────────────────────────────────
  // enqueueBatch — TRD §8
  // ─────────────────────────────────────────────
  describe('enqueueBatch', () => {
    const validPayload = () => ({
      batchId: 'batch-abc',
      generatedAt: new Date().toISOString(),
      records: [
        { employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 },
      ],
    });

    beforeEach(() => {
      jobRepo.findOne.mockResolvedValue(null); // no duplicate
      jobRepo.create.mockImplementation((d: any) => ({ ...mkJob(), ...d }));
      jobRepo.save.mockImplementation((j: any) => Promise.resolve({ ...j, id: 'job-new' }));
      jobRepo.update.mockResolvedValue({ affected: 1 });
      employeeRepo.findOne.mockResolvedValue(mkEmployee());
      locationRepo.findOne.mockResolvedValue(mkLocation());
    });

    it('creates a PENDING sync job and returns it immediately', async () => {
      const job = await service.enqueueBatch(validPayload());
      expect(job.status).toBe(SyncJobStatus.PENDING);
      expect(job.records_total).toBe(1);
      expect(jobRepo.save).toHaveBeenCalled();
    });

    it('throws ConflictException on duplicate batchId — TRD §11.2 batch idempotency', async () => {
      jobRepo.findOne.mockResolvedValue(mkJob({ batch_id: 'batch-abc' }));

      await expect(service.enqueueBatch(validPayload())).rejects.toThrow(ConflictException);
      await expect(service.enqueueBatch(validPayload())).rejects.toThrow(/batch-abc/);
    });

    it('processes batch in background and calls upsertFromHcm for each record', async () => {
      await service.enqueueBatch(validPayload());
      // Allow the background async to run
      await new Promise((r) => setTimeout(r, 50));

      expect(balanceService.upsertFromHcm).toHaveBeenCalledWith(expect.objectContaining({
        employeeId: 'emp-1',
        locationId: 'loc-1',
        totalDays: 20,
        source: AuditSource.HCM_BATCH,
      }));
    });

    it('marks job FAILED if employee external_id is unknown — TRD §8.1 all-or-nothing', async () => {
      employeeRepo.findOne.mockResolvedValue(null); // unknown employee

      await service.enqueueBatch(validPayload());
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({ status: SyncJobStatus.FAILED }),
      );
      // Crucially: upsertFromHcm should NOT have been called
      expect(balanceService.upsertFromHcm).not.toHaveBeenCalled();
    });

    it('marks job FAILED if any record has negative totalDays', async () => {
      const payload = {
        ...validPayload(),
        records: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: -5 }],
      };

      await service.enqueueBatch(payload);
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({ status: SyncJobStatus.FAILED }),
      );
    });

    it('marks job FAILED if any record has negative reservedDays', async () => {
      const payload = {
        ...validPayload(),
        records: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 5, reservedDays: -1 }],
      };

      await service.enqueueBatch(payload as any);
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({
          status: SyncJobStatus.FAILED,
          error_detail: expect.stringContaining('Negative reservedDays'),
        }),
      );
    });

    it('marks job FAILED if any record has negative usedDays', async () => {
      const payload = {
        ...validPayload(),
        records: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 5, usedDays: -1 }],
      };

      await service.enqueueBatch(payload as any);
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({
          status: SyncJobStatus.FAILED,
          error_detail: expect.stringContaining('Negative usedDays'),
        }),
      );
    });

    it('marks job FAILED if location external_id is unknown', async () => {
      locationRepo.findOne.mockResolvedValue(null);

      await service.enqueueBatch(validPayload());
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({ status: SyncJobStatus.FAILED }),
      );
    });

    it('marks job COMPLETED on success and stores records_processed count', async () => {
      await service.enqueueBatch(validPayload());
      await new Promise((r) => setTimeout(r, 50));

      expect(jobRepo.update).toHaveBeenCalledWith(
        'job-new',
        expect.objectContaining({ status: SyncJobStatus.COMPLETED, records_processed: 1 }),
      );
    });
  });

  // ─────────────────────────────────────────────
  // getJobStatus
  // ─────────────────────────────────────────────
  describe('getJobStatus', () => {
    it('returns job when found', async () => {
      const job = mkJob({ status: SyncJobStatus.COMPLETED });
      jobRepo.findOne.mockResolvedValue(job);

      const result = await service.getJobStatus('job-1');
      expect(result.status).toBe(SyncJobStatus.COMPLETED);
    });

    it('throws BadRequestException for non-existent job', async () => {
      jobRepo.findOne.mockResolvedValue(null);
      await expect(service.getJobStatus('bad-id')).rejects.toThrow(BadRequestException);
    });
  });

  describe('triggerPull', () => {
    it('returns existing job when enqueueBatch collides with duplicate batchId', async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1234567890);
      hcmClient.triggerBatchPull.mockResolvedValue({
        balances: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20, reservedDays: 1, usedDays: 2 }],
        generatedAt: new Date().toISOString(),
      });
      const existing = mkJob({ id: 'job-existing', batch_id: 'pull-1234567890' });
      jobRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);
      jobRepo.save.mockRejectedValueOnce(new ConflictException('duplicate'));

      const result = await service.triggerPull(['EMP001']);

      expect(result.jobId).toBe('job-existing');
      expect(hcmClient.triggerBatchPull).toHaveBeenCalledWith(['EMP001']);
      nowSpy.mockRestore();
    });
  });
});
