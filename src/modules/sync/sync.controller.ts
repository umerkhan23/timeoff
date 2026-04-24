import {
  Controller, Post, Get, Body, Param, HttpCode, HttpStatus,
  UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SyncService } from './sync.service';
import {
  BatchPayloadDto,
  RealtimePayloadDto,
  TriggerPullDto,
} from './dto/sync.dto';

@ApiTags('Sync')
@Controller('balances/sync')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SyncController {
  constructor(private readonly svc: SyncService) {}

  /** TRD §7.1 — Real-time push from HCM (work anniversary, HR correction) */
  @Post('realtime')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'HCM real-time balance push' })
  realtime(@Body() dto: RealtimePayloadDto) {
    return this.svc.handleRealtimePush(dto);
  }

  /** TRD §8 — Full batch ingest. Returns 202 + jobId immediately. */
  @Post('batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'HCM full batch balance dump — returns jobId' })
  @ApiResponse({ status: 202, description: 'Accepted; poll /sync/jobs/:jobId for status' })
  @ApiResponse({ status: 409, description: 'Duplicate batchId' })
  async batch(@Body() dto: BatchPayloadDto) {
    const job = await this.svc.enqueueBatch(dto);
    return { jobId: job.id, status: job.status, records: job.records_total };
  }

  /** TRD §7.1 — HR Admin triggers ReadyOn to pull from HCM */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'HR Admin: trigger pull sync from HCM' })
  trigger(@Body() dto: TriggerPullDto) {
    return this.svc.triggerPull(dto.employeeExternalIds);
  }

  /** Poll batch job status */
  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Poll batch sync job status' })
  getJob(@Param('jobId') jobId: string) {
    return this.svc.getJobStatus(jobId);
  }
}
