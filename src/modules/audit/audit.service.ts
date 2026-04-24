import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { BalanceAuditLog, AuditSource } from './entities/balance-audit-log.entity';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(BalanceAuditLog)
    private readonly auditRepo: Repository<BalanceAuditLog>,
  ) {}

  async log(params: {
    employee_id: string;
    location_id: string;
    delta_days: number;
    balance_after: number;
    source: AuditSource;
    reference_id?: string;
  }): Promise<BalanceAuditLog> {
    const entry = this.auditRepo.create({
      id: uuidv4(),
      ...params,
    });
    return this.auditRepo.save(entry);
  }

  async findByEmployee(employee_id: string): Promise<BalanceAuditLog[]> {
    return this.auditRepo.find({
      where: { employee_id },
      order: { created_at: 'DESC' },
    });
  }
}
