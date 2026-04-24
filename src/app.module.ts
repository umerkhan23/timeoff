import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './modules/employees/entities/employee.entity';
import { Location } from './modules/locations/entities/location.entity';
import { LeaveBalance } from './modules/balances/entities/leave-balance.entity';
import { TimeOffRequest } from './modules/requests/entities/time-off-request.entity';
import { BalanceAuditLog } from './modules/audit/entities/balance-audit-log.entity';
import { SyncJob } from './modules/sync/entities/sync-job.entity';
import { EmployeeModule } from './modules/employees/employee.module';
import { LocationModule } from './modules/locations/location.module';
import { AuditModule } from './modules/audit/audit.module';
import { HcmClientModule } from './modules/hcm-client/hcm-client.module';
import { BalanceModule } from './modules/balances/balance.module';
import { RequestModule } from './modules/requests/request.module';
import { SyncModule } from './modules/sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'sqljs',
      synchronize: true,
      autoSave: true,
      location: process.env.DB_PATH ?? 'timeoff.db',
      logging: process.env.NODE_ENV === 'development',
      entities: [Employee, Location, LeaveBalance, TimeOffRequest, BalanceAuditLog, SyncJob],
    }),
    EmployeeModule,
    LocationModule,
    AuditModule,
    HcmClientModule,
    BalanceModule,
    RequestModule,
    SyncModule,
  ],
})
export class AppModule {}
