import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaveBalance } from './entities/leave-balance.entity';
import { TimeOffRequest } from '../requests/entities/time-off-request.entity';
import { BalanceService } from './balance.service';
import { BalanceController } from './balance.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [TypeOrmModule.forFeature([LeaveBalance, TimeOffRequest]), AuditModule],
  providers: [BalanceService],
  controllers: [BalanceController],
  exports: [BalanceService],
})
export class BalanceModule {}
