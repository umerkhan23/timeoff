import {
  Entity, PrimaryColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { Employee } from '../../employees/entities/employee.entity';
import { Location } from '../../locations/entities/location.entity';

@Entity('leave_balances')
@Index(['employee_id', 'location_id'], { unique: true })
export class LeaveBalance {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  @Index()
  employee_id: string;

  @Column({ type: 'text' })
  @Index()
  location_id: string;

  /**
   * Authoritative total from HCM.
   * TRD invariant: available_days = total_days − reserved_days − used_days ≥ 0
   */
  @Column({ type: 'real', nullable: false })
  total_days: number;

  /** Sum of durations of all PENDING_LOCAL / PENDING_HCM / PENDING_APPROVAL requests */
  @Column({ type: 'real', default: 0 })
  reserved_days: number;

  /** Sum of durations of all APPROVED requests */
  @Column({ type: 'real', default: 0 })
  used_days: number;

  /**
   * Optimistic lock counter.
   * Every UPDATE must supply AND version = :expectedVersion.
   * If 0 rows affected → concurrent write or insufficient balance.
   */
  @Column({ type: 'integer', default: 0 })
  version: number;

  /** Timestamp of the most recent HCM push that updated this record */
  @Column({ type: 'datetime', nullable: true })
  hcm_synced_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;

  @ManyToOne(() => Employee, (e) => e.balances, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee: Employee;

  @ManyToOne(() => Location, (l) => l.balances, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'location_id' })
  location: Location;

  /** Derived — never stored. Use this everywhere balance math is needed. */
  get available_days(): number {
    return Math.max(0, this.total_days - this.reserved_days - this.used_days);
  }
}
