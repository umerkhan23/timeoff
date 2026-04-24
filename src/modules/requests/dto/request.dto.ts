import {
  IsString, IsDateString, IsNumber, IsOptional, IsUUID, Min, MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitRequestDto {
  @ApiProperty({ example: 'uuid-of-employee' })
  @IsUUID()
  employeeId: string;

  @ApiProperty({ example: 'uuid-of-location' })
  @IsUUID()
  locationId: string;

  @ApiProperty({ example: '2025-07-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2025-07-05' })
  @IsDateString()
  endDate: string;

  @ApiProperty({ example: 5 })
  @IsNumber()
  @Min(0.5)
  durationDays: number;

  @ApiPropertyOptional({ example: 'Summer holiday' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Client-supplied dedup key' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ApproveRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  managerId?: string;
}

export class RejectRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  managerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}
