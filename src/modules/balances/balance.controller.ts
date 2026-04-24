import { Controller, Get, Post, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BalanceService } from './balance.service';

@ApiTags('Balances')
@Controller('balances')
export class BalanceController {
  constructor(private readonly svc: BalanceService) {}

  @Get(':employeeId')
  @ApiOperation({ summary: 'Get all location balances for an employee' })
  getAll(@Param('employeeId') employeeId: string) {
    return this.svc.findByEmployee(employeeId);
  }

  @Get(':employeeId/locations/:locationId')
  @ApiOperation({ summary: 'Get balance for a specific (employee, location)' })
  getOne(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.svc.findOne(employeeId, locationId);
  }
}
