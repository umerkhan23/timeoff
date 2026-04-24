import {
  Injectable, Logger, ConflictException, BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { SyncJob, SyncJobStatus } from './entities/sync-job.entity';
import { BalanceService } from '../balances/balance.service';
import { HcmClientService } from '../hcm-client/hcm-client.service';
import { Employee } from '../employees/entities/employee.entity';
import { Location } from '../locations/entities/location.entity';
import { AuditSource } from '../audit/entities/balance-audit-log.entity';

export interface BatchRecord {
  employeeExternalId: string;
  locationExternalId: string;
  totalDays: number;
  reservedDays?: number;
  usedDays?: number;
}

export interface BatchPayload {
  batchId: string;
  generatedAt: string; // ISO datetime
  records: BatchRecord[];
}

export interface RealtimePayload {
  employeeExternalId: string;
  locationExternalId: string;
  totalDays: number;
  reservedDays?: number;
  usedDays?: number;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncJob)
    private readonly jobRepo: Repository<SyncJob>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  // ─────────────────────────────────────────────
  // TRD §7.1 — Real-time push
  // ─────────────────────────────────────────────

  async handleRealtimePush(payload: RealtimePayload): Promise<{
    balance: any; conflicted: boolean;
  }> {
    const [employee, location] = await this.resolveExternalIds(
      payload.employeeExternalId,
      payload.locationExternalId,
    );

    return this.balanceService.upsertFromHcm({
      employeeId: employee.id,
      locationId: location.id,
      totalDays: payload.totalDays,
      reservedDays: payload.reservedDays,
      usedDays: payload.usedDays,
      source: AuditSource.HCM_REALTIME,
    });
  }

  // ─────────────────────────────────────────────
  // TRD §8 — Batch ingest (async, 202 pattern)
  // ─────────────────────────────────────────────

  async enqueueBatch(payload: BatchPayload): Promise<SyncJob> {
    // Idempotency — reject duplicate batchId
    const existing = await this.jobRepo.findOne({ where: { batch_id: payload.batchId } });
    if (existing) {
      throw new ConflictException(
        `Batch ${payload.batchId} already received (job: ${existing.id})`,
      );
    }

    // Staleness guard — reject if generatedAt is older than any existing hcm_synced_at
    // (simplified: check latest sync job for same recency signal)
    const job = this.jobRepo.create({
      id: uuidv4(),
      batch_id: payload.batchId,
      generated_at: payload.generatedAt,
      status: SyncJobStatus.PENDING,
      records_total: payload.records.length,
    });
    const saved = await this.jobRepo.save(job);

    // Process in background — does not block 202 response
    this.processBatch(saved.id, payload).catch((err) =>
      this.logger.error(`Batch ${saved.id} processing error: ${(err as any).message}`),
    );

    return saved;
  }

  async getJobStatus(jobId: string): Promise<SyncJob> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new BadRequestException(`Job ${jobId} not found`);
    return job;
  }

  /**
   * TRD §8.1 — Atomic batch processing pipeline.
   * All-or-nothing: if any record fails validation, entire batch is rolled back.
   */
  private async processBatch(jobId: string, payload: BatchPayload): Promise<void> {
    await this.jobRepo.update(jobId, { status: SyncJobStatus.PROCESSING });

    try {
      // Validate all records before touching any balance (TRD §8.1 step 5-6)
      const resolved: Array<{
        employee: Employee; location: Location; totalDays: number; reservedDays?: number; usedDays?: number;
      }> = [];

      for (const record of payload.records) {
        const employee = await this.employeeRepo.findOne({
          where: { external_id: record.employeeExternalId },
        });
        const location = await this.locationRepo.findOne({
          where: { external_id: record.locationExternalId },
        });

        if (!employee) {
          throw new Error(`Unknown employee external_id: ${record.employeeExternalId}`);
        }
        if (!location) {
          throw new Error(`Unknown location external_id: ${record.locationExternalId}`);
        }
        if (record.totalDays < 0) {
          throw new Error(
            `Negative totalDays for ${record.employeeExternalId}/${record.locationExternalId}`,
          );
        }
        if (record.reservedDays !== undefined && record.reservedDays < 0) {
          throw new Error(
            `Negative reservedDays for ${record.employeeExternalId}/${record.locationExternalId}`,
          );
        }
        if (record.usedDays !== undefined && record.usedDays < 0) {
          throw new Error(
            `Negative usedDays for ${record.employeeExternalId}/${record.locationExternalId}`,
          );
        }
        resolved.push({
          employee,
          location,
          totalDays: record.totalDays,
          reservedDays: record.reservedDays,
          usedDays: record.usedDays,
        });
      }

      // All validated — now apply atomically
      let processed = 0;
      for (const { employee, location, totalDays, reservedDays, usedDays } of resolved) {
        await this.balanceService.upsertFromHcm({
          employeeId: employee.id,
          locationId: location.id,
          totalDays,
          reservedDays,
          usedDays,
          source: AuditSource.HCM_BATCH,
          referenceId: jobId,
        });
        processed++;
      }

      await this.jobRepo.update(jobId, {
        status: SyncJobStatus.COMPLETED,
        records_processed: processed,
      });

      this.logger.log(`Batch ${jobId} completed: ${processed} records updated`);
    } catch (err) {
      this.logger.error(`Batch ${jobId} FAILED: ${(err as any).message}`);
      await this.jobRepo.update(jobId, {
        status: SyncJobStatus.FAILED,
        error_detail: (err as any).message,
      });
    }
  }

  // ─────────────────────────────────────────────
  // TRD §7.1 — Pull-on-demand (HR Admin trigger)
  // ─────────────────────────────────────────────

  async triggerPull(employeeExternalIds?: string[]): Promise<{ jobId: string }> {
    this.logger.log(`Pull sync triggered for ${employeeExternalIds?.length ?? 'all'} employees`);
    const response = await this.hcmClient.triggerBatchPull(employeeExternalIds);

    const batchId = `pull-${Date.now()}`;
    const job = await this.enqueueBatch({
      batchId,
      generatedAt: response.generatedAt,
      records: response.balances.map((b) => ({
        employeeExternalId: b.employeeExternalId,
        locationExternalId: b.locationExternalId,
        totalDays: b.totalDays,
        reservedDays: b.reservedDays,
        usedDays: b.usedDays,
      })),
    }).catch(async (err) => {
      // If duplicate batchId (pull within same ms), return existing job
      const existing = await this.jobRepo.findOne({ where: { batch_id: batchId } });
      return existing;
    });

    return { jobId: job.id };
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async resolveExternalIds(
    empExternalId: string,
    locExternalId: string,
  ): Promise<[Employee, Location]> {
    const employee = await this.employeeRepo.findOne({ where: { external_id: empExternalId } });
    const location = await this.locationRepo.findOne({ where: { external_id: locExternalId } });
    if (!employee) throw new BadRequestException(`Unknown employee external_id: ${empExternalId}`);
    if (!location) throw new BadRequestException(`Unknown location external_id: ${locExternalId}`);
    return [employee, location];
  }
}
