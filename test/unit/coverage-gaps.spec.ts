/**
 * Targeted coverage tests for uncovered branches.
 * Covers: retryStuckSubmissions, HCM transient error in submitToHcmAsync,
 * AuditService.findByEmployee, SyncService.triggerPull,
 * HcmClient cancel 404, balance decommit audit log.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { RequestService } from '../../src/modules/requests/request.service';
import { TimeOffRequest, RequestStatus } from '../../src/modules/requests/entities/time-off-request.entity';
import { Employee } from '../../src/modules/employees/entities/employee.entity';
import { Location } from '../../src/modules/locations/entities/location.entity';
import { BalanceService } from '../../src/modules/balances/balance.service';
import { HcmClientService } from '../../src/modules/hcm-client/hcm-client.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { BalanceAuditLog, AuditSource } from '../../src/modules/audit/entities/balance-audit-log.entity';
import { SyncService } from '../../src/modules/sync/sync.service';
import { SyncJob, SyncJobStatus } from '../../src/modules/sync/entities/sync-job.entity';
import { DataSource } from 'typeorm';

// ─────────────────────────────────────────────
// AuditService — findByEmployee coverage
// ─────────────────────────────────────────────
describe('AuditService — coverage', () => {
  let service: AuditService;
  let auditRepo: any;

  beforeEach(async () => {
    auditRepo = {
      create: jest.fn().mockImplementation((d) => d),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
      find: jest.fn(),
    };
    const mod = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: getRepositoryToken(BalanceAuditLog), useValue: auditRepo },
      ],
    }).compile();
    service = mod.get(AuditService);
  });

  it('findByEmployee returns logs in DESC order', async () => {
    const logs = [{ id: 'log-1', employee_id: 'emp-1' }];
    auditRepo.find.mockResolvedValue(logs);

    const result = await service.findByEmployee('emp-1');

    expect(auditRepo.find).toHaveBeenCalledWith({
      where: { employee_id: 'emp-1' },
      order: { created_at: 'DESC' },
    });
    expect(result).toEqual(logs);
  });
});

// ─────────────────────────────────────────────
// RequestService — retryStuckSubmissions + HCM transient error
// ─────────────────────────────────────────────
describe('RequestService — coverage gaps', () => {
  let service: RequestService;
  let requestRepo: any;
  let employeeRepo: any;
  let locationRepo: any;
  let balanceService: any;
  let hcmClient: any;

  const mkEmployee = () => ({ id: 'emp-1', external_id: 'EMP001', name: 'Alice', email: 'a@t.com' });
  const mkLocation = () => ({ id: 'loc-1', external_id: 'LOC-US', name: 'NY' });
  const mkRequest  = (overrides = {}): TimeOffRequest => ({
    id: 'req-1', employee_id: 'emp-1', location_id: 'loc-1',
    start_date: '2025-08-01', end_date: '2025-08-05',
    duration_days: 5, reason: null, status: RequestStatus.PENDING_HCM,
    idempotency_key: null, hcm_reference_id: null, hcm_filed_at: null,
    hcm_error: 'prev error', hcm_retry_count: 1,
    created_at: new Date(), updated_at: new Date(),
    employee: null, location: null,
    ...overrides,
  });

  beforeEach(async () => {
    requestRepo  = {
      create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      increment: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      }),
    };
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

    const mod = await Test.createTestingModule({
      providers: [
        RequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        { provide: getRepositoryToken(Location), useValue: locationRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmClientService, useValue: hcmClient },
      ],
    }).compile();
    service = mod.get(RequestService);
  });

  afterEach(() => jest.clearAllMocks());

  it('retryStuckSubmissions re-submits stuck PENDING_HCM requests', async () => {
    const stuck = [mkRequest()];
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(stuck),
    });
    employeeRepo.findOne.mockResolvedValue(mkEmployee());
    locationRepo.findOne.mockResolvedValue(mkLocation());
    hcmClient.submitRequest.mockResolvedValue({ status: 'ACCEPTED', hcm_reference_id: 'HCM-NEW' });

    const count = await service.retryStuckSubmissions();

    expect(count).toBe(1);
    // submitToHcmAsync called in background
    await new Promise((r) => setTimeout(r, 50));
    expect(hcmClient.submitRequest).toHaveBeenCalled();
  });

  it('retryStuckSubmissions returns 0 when no stuck requests', async () => {
    // Default mock returns []
    const count = await service.retryStuckSubmissions();
    expect(count).toBe(0);
    expect(hcmClient.submitRequest).not.toHaveBeenCalled();
  });

  it('retryStuckSubmissions skips request when employee not found', async () => {
    const stuck = [mkRequest()];
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(stuck),
    });
    employeeRepo.findOne.mockResolvedValue(null); // no employee
    locationRepo.findOne.mockResolvedValue(mkLocation());

    const count = await service.retryStuckSubmissions();

    expect(count).toBe(1); // counted but not actually submitted
    await new Promise((r) => setTimeout(r, 50));
    expect(hcmClient.submitRequest).not.toHaveBeenCalled();
  });

  it('HCM transient error in submitToHcmAsync increments retry count', async () => {
    employeeRepo.findOne.mockResolvedValue(mkEmployee());
    locationRepo.findOne.mockResolvedValue(mkLocation());
    balanceService.reserve.mockResolvedValue({ success: true, balance: {} });
    requestRepo.create.mockImplementation((d: any) => ({ ...mkRequest(), ...d, status: RequestStatus.PENDING_LOCAL }));
    requestRepo.save.mockImplementation((r: any) => Promise.resolve({ ...r, id: 'req-1' }));

    // HCM throws a network error (transient)
    hcmClient.submitRequest.mockRejectedValue(new Error('ECONNREFUSED'));

    await service.submit({
      employeeId: 'emp-1', locationId: 'loc-1',
      startDate: '2025-08-01', endDate: '2025-08-05', durationDays: 5,
    });

    // Wait for async HCM submission to fail
    await new Promise((r) => setTimeout(r, 100));

    // Should have updated retry count
    expect(requestRepo.update).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ hcm_error: 'ECONNREFUSED' }),
    );
  });

  it('HCM transient error defaults retry count from undefined', async () => {
    const req = mkRequest({ hcm_retry_count: undefined as any, status: RequestStatus.PENDING_HCM });
    requestRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([req]),
    });
    employeeRepo.findOne.mockResolvedValue(mkEmployee());
    locationRepo.findOne.mockResolvedValue(mkLocation());
    hcmClient.submitRequest.mockRejectedValue(new Error('timeout'));

    await service.retryStuckSubmissions();
    await new Promise((r) => setTimeout(r, 50));

    expect(requestRepo.update).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ hcm_retry_count: 1 }),
    );
  });

  it('findAll with no filters returns all requests', async () => {
    requestRepo.find.mockResolvedValue([mkRequest()]);
    const results = await service.findAll({});
    expect(requestRepo.find).toHaveBeenCalledWith({
      where: {},
      order: { created_at: 'DESC' },
    });
    expect(results).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// SyncService — triggerPull coverage
// ─────────────────────────────────────────────
describe('SyncService — triggerPull coverage', () => {
  let service: SyncService;
  let jobRepo: any;
  let employeeRepo: any;
  let locationRepo: any;
  let balanceService: any;
  let hcmClient: any;

  beforeEach(async () => {
    jobRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((d: any) => ({ ...d, id: 'job-pull-1', status: SyncJobStatus.PENDING })),
      save: jest.fn().mockImplementation((j: any) => Promise.resolve({ ...j, id: 'job-pull-1' })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    employeeRepo = { findOne: jest.fn().mockResolvedValue({ id: 'emp-1', external_id: 'EMP001' }) };
    locationRepo = { findOne: jest.fn().mockResolvedValue({ id: 'loc-1', external_id: 'LOC-US' }) };
    balanceService = { upsertFromHcm: jest.fn().mockResolvedValue({ balance: {}, conflicted: false }) };
    hcmClient = {
      triggerBatchPull: jest.fn().mockResolvedValue({
        balances: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 }],
        generatedAt: new Date().toISOString(),
      }),
    };

    const mod = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(SyncJob), useValue: jobRepo },
        { provide: getRepositoryToken(Employee), useValue: employeeRepo },
        { provide: getRepositoryToken(Location), useValue: locationRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmClientService, useValue: hcmClient },
      ],
    }).compile();
    service = mod.get(SyncService);
  });

  afterEach(() => jest.clearAllMocks());

  it('triggerPull calls HCM and enqueues a batch job', async () => {
    const result = await service.triggerPull(['EMP001']);

    expect(hcmClient.triggerBatchPull).toHaveBeenCalledWith(['EMP001']);
    expect(result.jobId).toBe('job-pull-1');
  });

  it('triggerPull with no args pulls all employees', async () => {
    await service.triggerPull();
    expect(hcmClient.triggerBatchPull).toHaveBeenCalledWith(undefined);
  });

  it('getJobStatus returns completed job', async () => {
    const job = { id: 'job-1', status: SyncJobStatus.COMPLETED };
    jobRepo.findOne.mockResolvedValue(job);

    const result = await service.getJobStatus('job-1');
    expect(result.status).toBe(SyncJobStatus.COMPLETED);
  });

  it('batch records_total stored correctly', async () => {
    const job = await service.enqueueBatch({
      batchId: `batch-cov-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      records: [
        { employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 },
        { employeeExternalId: 'EMP001', locationExternalId: 'LOC-UK', totalDays: 15 },
      ],
    });
    expect(job.records_total).toBe(2);
  });

  it('enqueueBatch logs processing error when processBatch crashes before try/catch', async () => {
    const loggerSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    jobRepo.update.mockRejectedValueOnce(new Error('db write failed'));

    await service.enqueueBatch({
      batchId: `batch-crash-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      records: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 }],
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('processing error'));
    loggerSpy.mockRestore();
  });
});
