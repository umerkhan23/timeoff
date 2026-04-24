import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncJob } from './entities/sync-job.entity';
import { Employee } from '../employees/entities/employee.entity';
import { Location } from '../locations/entities/location.entity';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { BalanceModule } from '../balances/balance.module';
import { HcmClientModule } from '../hcm-client/hcm-client.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncJob, Employee, Location]),
    BalanceModule,
    HcmClientModule,
  ],
  providers: [SyncService],
  controllers: [SyncController],
  exports: [SyncService],
})
export class SyncModule {}
