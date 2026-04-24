import {
  Entity, PrimaryColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { Employee } from '../../employees/entities/employee.entity';
import { Location } from '../../locations/entities/location.entity';

/**
 * TRD §5 — Request State Machine
 *
 * PENDING_LOCAL   → initial state; reserved_days already incremented
 * PENDING_HCM     → async HCM submission in progress
 * PENDING_APPROVAL→ HCM acknowledged; waiting for manager
 * APPROVED        → manager approved; reserved→used
 * REJECTED        → manager rejected; reservation released
 * CANCELLED       → employee cancelled; reservation/used released; HCM reversal filed
 * FAILED          → HCM rejected or local balance check failed; reservation released
 * NEEDS_REVIEW    → HCM reduced balance below reserved amount; flagged for manager
 */
export enum RequestStatus {
  PENDING_LOCAL    = 'PENDING_LOCAL',
  PENDING_HCM      = 'PENDING_HCM',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED         = 'APPROVED',
  REJECTED         = 'REJECTED',
  CANCELLED        = 'CANCELLED',
  FAILED           = 'FAILED',
  NEEDS_REVIEW     = 'NEEDS_REVIEW',
}

/** Statuses where a reservation is still held against the balance */
export const ACTIVE_STATUSES: RequestStatus[] = [
  RequestStatus.PENDING_LOCAL,
  RequestStatus.PENDING_HCM,
  RequestStatus.PENDING_APPROVAL,
  RequestStatus.NEEDS_REVIEW,
];

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  @Index()
  employee_id: string;

  @Column({ type: 'text' })
  location_id: string;

  @Column({ type: 'date' })
  start_date: string;

  @Column({ type: 'date' })
  end_date: string;

  @Column({ type: 'real' })
  duration_days: number;

  @Column({ type: 'text', nullable: true })
  reason: string;

  @Column({ type: 'text', default: RequestStatus.PENDING_LOCAL })
  @Index()
  status: RequestStatus;

  @Column({ type: 'text', nullable: true, unique: true })
  idempotency_key: string;

  @Column({ type: 'text', nullable: true })
  hcm_reference_id: string;

  @Column({ type: 'datetime', nullable: true })
  hcm_filed_at: Date;

  @Column({ type: 'text', nullable: true })
  hcm_error: string;

  @Column({ type: 'integer', default: 0 })
  hcm_retry_count: number;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;

  @ManyToOne(() => Employee, (e) => e.requests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee: Employee;

  @ManyToOne(() => Location, (l) => l.requests, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location: Location;
}
