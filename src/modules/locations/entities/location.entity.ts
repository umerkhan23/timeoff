import {
  Entity, PrimaryColumn, Column, OneToMany, CreateDateColumn,
} from 'typeorm';
import { LeaveBalance } from '../../balances/entities/leave-balance.entity';
import { TimeOffRequest } from '../../requests/entities/time-off-request.entity';

@Entity('locations')
export class Location {
  @PrimaryColumn({ type: 'text' })
  id: string; // UUID v4

  @Column({ type: 'text', unique: true, nullable: false })
  external_id: string; // HCM location identifier

  @Column({ type: 'text', nullable: false })
  name: string;

  @CreateDateColumn({ type: 'datetime' })
  created_at: Date;

  @OneToMany(() => LeaveBalance, (b) => b.location)
  balances: LeaveBalance[];

  @OneToMany(() => TimeOffRequest, (r) => r.location)
  requests: TimeOffRequest[];
}
