import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from './entities/time-off-request.entity';
import { Employee } from '../employees/entities/employee.entity';
import { Location } from '../locations/entities/location.entity';
import { RequestService } from './request.service';
import { RequestController } from './request.controller';
import { BalanceModule } from '../balances/balance.module';
import { HcmClientModule } from '../hcm-client/hcm-client.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, Employee, Location]),
    BalanceModule,
    HcmClientModule,
  ],
  providers: [RequestService],
  controllers: [RequestController],
  exports: [RequestService],
})
export class RequestModule {}
