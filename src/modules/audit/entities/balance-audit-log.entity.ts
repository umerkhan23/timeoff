import {
  Entity, PrimaryColumn, Column, CreateDateColumn, Index,
} from 'typeorm';

export enum AuditSource {
  REQUEST     = 'REQUEST',
  HCM_REALTIME = 'HCM_REALTIME',
  HCM_BATCH   = 'HCM_BATCH',
}

/**
 * Append-only audit trail of every balance mutation.
 * TRD §4.1 — AuditModule never mutates; only inserts.
 */
@Entity('balance_audit_log')
export class BalanceAuditLog {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  @Index()
  employee_id: string;

  @Column({ type: 'text' })
  location_id: string;

  /** Positive = credit (balance increase), Negative = debit (balance decrease) */
  @Column({ type: 'real' })
  delta_days: number;

  /** available_days = total − reserved − used AFTER this mutation */
  @Column({ type: 'real' })
  balance_after: number;

  @Column({ type: 'text' })
  source: AuditSource;

  /** Request ID or batch ID that caused this mutation */
  @Column({ type: 'text', nullable: true })
  reference_id: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;
}
