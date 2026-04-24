import { AuditSource } from '../../../src/modules/audit/entities/balance-audit-log.entity';
import { RequestStatus, ACTIVE_STATUSES } from '../../../src/modules/requests/entities/time-off-request.entity';
import { SyncJobStatus } from '../../../src/modules/sync/entities/sync-job.entity';

describe('Entity enums — coverage', () => {
  it('exposes all audit sources', () => {
    expect(AuditSource.REQUEST).toBe('REQUEST');
    expect(AuditSource.HCM_REALTIME).toBe('HCM_REALTIME');
    expect(AuditSource.HCM_BATCH).toBe('HCM_BATCH');
  });

  it('exposes all sync job statuses', () => {
    expect(SyncJobStatus.PENDING).toBe('PENDING');
    expect(SyncJobStatus.PROCESSING).toBe('PROCESSING');
    expect(SyncJobStatus.COMPLETED).toBe('COMPLETED');
    expect(SyncJobStatus.FAILED).toBe('FAILED');
  });

  it('exposes all request statuses and active status set', () => {
    expect(RequestStatus.PENDING_LOCAL).toBe('PENDING_LOCAL');
    expect(RequestStatus.PENDING_HCM).toBe('PENDING_HCM');
    expect(RequestStatus.PENDING_APPROVAL).toBe('PENDING_APPROVAL');
    expect(RequestStatus.APPROVED).toBe('APPROVED');
    expect(RequestStatus.REJECTED).toBe('REJECTED');
    expect(RequestStatus.CANCELLED).toBe('CANCELLED');
    expect(RequestStatus.FAILED).toBe('FAILED');
    expect(RequestStatus.NEEDS_REVIEW).toBe('NEEDS_REVIEW');
    expect(ACTIVE_STATUSES).toEqual([
      RequestStatus.PENDING_LOCAL,
      RequestStatus.PENDING_HCM,
      RequestStatus.PENDING_APPROVAL,
      RequestStatus.NEEDS_REVIEW,
    ]);
  });
});
