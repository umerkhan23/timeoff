import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class BatchRecordDto {
  @ApiProperty({ example: 'EMP001' })
  @IsString()
  employeeExternalId: string;

  @ApiProperty({ example: 'LOC-US' })
  @IsString()
  locationExternalId: string;

  @ApiProperty({ example: 20 })
  @IsNumber()
  @Min(0)
  totalDays: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reservedDays?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  usedDays?: number;
}

export class BatchPayloadDto {
  @ApiProperty({ example: 'batch-2026-04-24-001' })
  @IsString()
  batchId: string;

  @ApiProperty({ example: '2026-04-24T19:00:00.000Z' })
  @IsDateString()
  generatedAt: string;

  @ApiProperty({ type: [BatchRecordDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchRecordDto)
  records: BatchRecordDto[];
}

export class RealtimePayloadDto {
  @ApiProperty({ example: 'EMP001' })
  @IsString()
  employeeExternalId: string;

  @ApiProperty({ example: 'LOC-US' })
  @IsString()
  locationExternalId: string;

  @ApiProperty({ example: 25 })
  @IsNumber()
  @Min(0)
  totalDays: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  reservedDays?: number;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  usedDays?: number;
}

export class TriggerPullDto {
  @ApiPropertyOptional({ example: ['EMP001', 'EMP002'] })
  @IsOptional()
  @IsArray()
  employeeExternalIds?: string[];
}
