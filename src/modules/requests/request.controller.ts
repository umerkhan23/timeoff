import {
  Controller, Post, Get, Patch, Delete, Body, Param, Query,
  HttpCode, HttpStatus, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RequestService } from './request.service';
import { SubmitRequestDto, ApproveRequestDto, RejectRequestDto } from './dto/request.dto';

@ApiTags('Requests')
@Controller('requests')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class RequestController {
  constructor(private readonly svc: RequestService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a time-off request' })
  @ApiResponse({ status: 201, description: 'Request created — PENDING_LOCAL' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict — returns original' })
  submit(@Body() dto: SubmitRequestDto) {
    return this.svc.submit({
      employeeId: dto.employeeId,
      locationId: dto.locationId,
      startDate: dto.startDate,
      endDate: dto.endDate,
      durationDays: dto.durationDays,
      reason: dto.reason,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List requests with optional filters' })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiQuery({ name: 'status', required: false })
  findAll(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: string,
  ) {
    return this.svc.findAll({ employeeId, status });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get request by ID' })
  findOne(@Param('id') id: string) {
    return this.svc.findOne(id);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Manager approves a PENDING_APPROVAL request' })
  approve(@Param('id') id: string, @Body() dto: ApproveRequestDto) {
    return this.svc.approve(id, dto);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Manager rejects a PENDING_APPROVAL request' })
  reject(@Param('id') id: string, @Body() dto: RejectRequestDto) {
    return this.svc.reject(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Employee cancels their own request' })
  cancel(
    @Param('id') id: string,
    @Query('employeeId') employeeId: string,
  ) {
    return this.svc.cancel(id, employeeId);
  }
}
