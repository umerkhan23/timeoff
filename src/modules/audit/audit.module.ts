// audit.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BalanceAuditLog } from './entities/balance-audit-log.entity';
import { AuditService } from './audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([BalanceAuditLog])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
