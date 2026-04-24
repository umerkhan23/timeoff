import {
  Entity, PrimaryColumn, Column, OneToMany,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { LeaveBalance } from '../../balances/entities/leave-balance.entity';
import { TimeOffRequest } from '../../requests/entities/time-off-request.entity';
import { BalanceAuditLog } from '../../audit/entities/balance-audit-log.entity';

@Entity('employees')
export class Employee {
  @PrimaryColumn({ type: 'text' })
  id: string; // UUID v4

  @Column({ type: 'text', unique: true, nullable: false })
  external_id: string; // HCM employee identifier

  @Column({ type: 'text', nullable: false })
  name: string;

  @Column({ type: 'text', unique: true, nullable: false })
  email: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updated_at: Date;

  @OneToMany(() => LeaveBalance, (b) => b.employee)
  balances: LeaveBalance[];

  @OneToMany(() => TimeOffRequest, (r) => r.employee)
  requests: TimeOffRequest[];

  @OneToMany(() => BalanceAuditLog, (a) => a.employee_id)
  audit_logs: BalanceAuditLog[];
}
