import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export enum SyncJobStatus {
  PENDING   = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED    = 'FAILED',
}

@Entity('sync_jobs')
export class SyncJob {
  @PrimaryColumn({ type: 'text' })
  id: string; // jobId returned to caller

  @Column({ type: 'text', unique: true })
  batch_id: string; // idempotency key — HCM-supplied batchId

  @Column({ type: 'text' })
  generated_at: string; // ISO datetime from HCM — used for staleness check

  @Column({ type: 'text', default: SyncJobStatus.PENDING })
  status: SyncJobStatus;

  @Column({ type: 'integer', default: 0 })
  records_total: number;

  @Column({ type: 'integer', default: 0 })
  records_processed: number;

  @Column({ type: 'integer', default: 0 })
  records_failed: number;

  @Column({ type: 'text', nullable: true })
  error_detail: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;
}
