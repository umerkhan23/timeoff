import { Module } from '@nestjs/common';
import { HcmClientService } from './hcm-client.service';

@Module({
  providers: [HcmClientService],
  exports: [HcmClientService],
})
export class HcmClientModule {}
