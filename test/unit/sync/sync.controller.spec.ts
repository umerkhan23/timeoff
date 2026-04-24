import { SyncController } from '../../../src/modules/sync/sync.controller';
import { SyncJobStatus } from '../../../src/modules/sync/entities/sync-job.entity';

describe('SyncController — unit', () => {
  it('forwards trigger payload to service.triggerPull', async () => {
    const svc = {
      handleRealtimePush: jest.fn(),
      enqueueBatch: jest.fn(),
      triggerPull: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
      getJobStatus: jest.fn(),
    } as any;
    const controller = new SyncController(svc);

    const result = await controller.trigger({ employeeExternalIds: ['EMP001'] });

    expect(svc.triggerPull).toHaveBeenCalledWith(['EMP001']);
    expect(result).toEqual({ jobId: 'job-1' });
  });

  it('maps batch response shape with job metadata', async () => {
    const svc = {
      enqueueBatch: jest.fn().mockResolvedValue({
        id: 'job-9',
        status: SyncJobStatus.PENDING,
        records_total: 2,
      }),
      handleRealtimePush: jest.fn(),
      triggerPull: jest.fn(),
      getJobStatus: jest.fn(),
    } as any;
    const controller = new SyncController(svc);

    const result = await controller.batch({
      batchId: 'b-1',
      generatedAt: new Date().toISOString(),
      records: [],
    } as any);

    expect(result).toEqual({ jobId: 'job-9', status: SyncJobStatus.PENDING, records: 2 });
  });
});
