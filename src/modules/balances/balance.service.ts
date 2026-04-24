import {
  Injectable, Logger, NotFoundException, UnprocessableEntityException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { LeaveBalance } from './entities/leave-balance.entity';
import { AuditService } from '../audit/audit.service';
import { AuditSource } from '../audit/entities/balance-audit-log.entity';
import {
  TimeOffRequest, RequestStatus, ACTIVE_STATUSES,
} from '../requests/entities/time-off-request.entity';

const MAX_LOCK_RETRIES = 3;

export interface ReservationResult {
  success: boolean;
  balance?: LeaveBalance;
  errorCode?: 'INSUFFICIENT_BALANCE' | 'NOT_FOUND' | 'CONFLICT';
  availableBefore?: number;
}

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  // ─────────────────────────────────────────────
  // Reads
  // ─────────────────────────────────────────────

  async findByEmployee(employeeId: string): Promise<LeaveBalance[]> {
    return this.balanceRepo.find({
      where: { employee_id: employeeId },
      relations: ['location'],
    });
  }

  async findOne(employeeId: string, locationId: string): Promise<LeaveBalance> {
    const b = await this.balanceRepo.findOne({
      where: { employee_id: employeeId, location_id: locationId },
    });
    if (!b) throw new NotFoundException(
      `Balance not found for employee=${employeeId} location=${locationId}`,
    );
    return b;
  }

  // ─────────────────────────────────────────────
  // TRD §7.3 — Optimistic reservation
  // ─────────────────────────────────────────────

  /**
   * Atomically reserve `days` against a balance row using optimistic locking.
   * Retries up to MAX_LOCK_RETRIES times on version conflict before giving up.
   *
   * SQL used:
   *   UPDATE leave_balances
   *   SET reserved_days = reserved_days + :days, version = version + 1, updated_at = now
   *   WHERE employee_id = :eid AND location_id = :lid
   *     AND version = :ver
   *     AND (total_days - reserved_days - used_days) >= :days
   */
  async reserve(
    employeeId: string,
    locationId: string,
    days: number,
    referenceId: string,
  ): Promise<ReservationResult> {
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const balance = await this.balanceRepo.findOne({
        where: { employee_id: employeeId, location_id: locationId },
      });

      if (!balance) return { success: false, errorCode: 'NOT_FOUND' };

      const available = balance.total_days - balance.reserved_days - balance.used_days;

      if (available < days) {
        return { success: false, errorCode: 'INSUFFICIENT_BALANCE', availableBefore: available };
      }

      // Conditional UPDATE — fails if version changed or balance dropped concurrently.
      // Use a single QueryRunner so autoSave/export() does not fire between statements
      // and reset the rows-modified counter before we can read it.
      const runner = this.dataSource.createQueryRunner();
      await runner.connect();
      let affected = 0;
      try {
        const result = await (runner as any).query(
          `UPDATE leave_balances
           SET reserved_days = reserved_days + ?,
               version       = version + 1,
               updated_at    = datetime('now')
           WHERE employee_id = ?
             AND location_id = ?
             AND version     = ?
             AND (total_days - reserved_days - used_days) >= ?`,
          [days, employeeId, locationId, balance.version, days],
          true, // useStructuredResult — gives us result.affected directly
        );
        affected = result.affected ?? 0;
      } finally {
        await runner.release();
      }

      if (affected > 0) {
        await this.auditService.log({
          employee_id: employeeId,
          location_id: locationId,
          delta_days: -days,
          balance_after: available - days,
          source: AuditSource.REQUEST,
          reference_id: referenceId,
        });
        const updated = await this.balanceRepo.findOne({
          where: { employee_id: employeeId, location_id: locationId },
        });
        return { success: true, balance: updated };
      }

      // version changed — retry after brief back-off
      await this.sleep(30 * (attempt + 1));
    }

    return { success: false, errorCode: 'CONFLICT' };
  }

  /**
   * Release a pending reservation (on REJECTED / FAILED / CANCELLED from PENDING_APPROVAL).
   */
  async release(
    employeeId: string,
    locationId: string,
    days: number,
    referenceId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });
      if (!balance) return;

      balance.reserved_days = Math.max(0, balance.reserved_days - days);
      balance.version += 1;
      await manager.save(LeaveBalance, balance);
    });

    const balance = await this.balanceRepo.findOne({
      where: { employee_id: employeeId, location_id: locationId },
    });
    if (balance) {
      await this.auditService.log({
        employee_id: employeeId,
        location_id: locationId,
        delta_days: +days,
        balance_after: balance.available_days,
        source: AuditSource.REQUEST,
        reference_id: referenceId,
      });
    }
  }

  /**
   * Commit a reservation to used_days on APPROVED.
   * Moves reserved_days → used_days atomically.
   */
  async commit(
    employeeId: string,
    locationId: string,
    days: number,
    referenceId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });
      if (!balance) throw new NotFoundException('Balance not found');

      balance.reserved_days = Math.max(0, balance.reserved_days - days);
      balance.used_days += days;
      balance.version += 1;
      await manager.save(LeaveBalance, balance);
    });
  }

  /**
   * Decommit used_days on APPROVED → CANCELLED.
   */
  async decommit(
    employeeId: string,
    locationId: string,
    days: number,
    referenceId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });
      if (!balance) throw new NotFoundException('Balance not found');

      balance.used_days = Math.max(0, balance.used_days - days);
      balance.version += 1;
      await manager.save(LeaveBalance, balance);
    });

    const balance = await this.balanceRepo.findOne({
      where: { employee_id: employeeId, location_id: locationId },
    });
    if (balance) {
      await this.auditService.log({
        employee_id: employeeId,
        location_id: locationId,
        delta_days: +days,
        balance_after: balance.available_days,
        source: AuditSource.REQUEST,
        reference_id: referenceId,
      });
    }
  }

  // ─────────────────────────────────────────────
  // TRD §7.1 / §7.2 — HCM sync upsert with conflict resolution
  // ─────────────────────────────────────────────

  /**
   * Upsert a balance from HCM (real-time or batch).
   * If the new total causes available_days < 0, flags active requests as NEEDS_REVIEW.
   */
  async upsertFromHcm(params: {
    employeeId: string;
    locationId: string;
    totalDays: number;
    reservedDays?: number;
    usedDays?: number;
    source: AuditSource;
    referenceId?: string;
  }): Promise<{ balance: LeaveBalance; conflicted: boolean }> {
    const {
      employeeId, locationId, totalDays, reservedDays, usedDays, source, referenceId,
    } = params;

    return this.dataSource.transaction(async (manager) => {
      let balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });

      const previousTotal = balance?.total_days ?? null;
      const delta = previousTotal !== null ? totalDays - previousTotal : totalDays;

      if (!balance) {
        balance = manager.create(LeaveBalance, {
          id: uuidv4(),
          employee_id: employeeId,
          location_id: locationId,
          total_days: totalDays,
          reserved_days: reservedDays ?? 0,
          used_days: usedDays ?? 0,
          version: 1,
          hcm_synced_at: new Date(),
        });
      } else {
        balance.total_days = totalDays;
        if (reservedDays !== undefined) balance.reserved_days = reservedDays;
        if (usedDays !== undefined) balance.used_days = usedDays;
        balance.hcm_synced_at = new Date();
        balance.version += 1;
      }

      await manager.save(LeaveBalance, balance);

      // TRD §7.2 — conflict resolution
      const newAvailable = totalDays - balance.reserved_days - balance.used_days;
      let conflicted = false;

      if (newAvailable < 0) {
        conflicted = true;
        this.logger.warn(
          `Balance conflict for emp=${employeeId} loc=${locationId}: ` +
          `new total=${totalDays}, reserved=${balance.reserved_days}, used=${balance.used_days}. ` +
          `Flagging active requests as NEEDS_REVIEW.`,
        );
        // Flag active requests oldest-first until shortfall is covered
        const actives = await manager.find(TimeOffRequest, {
          where: { employee_id: employeeId, location_id: locationId },
          order: { created_at: 'ASC' },
        });
        const toFlag = actives.filter((r) => ACTIVE_STATUSES.includes(r.status));
        for (const req of toFlag) {
          req.status = RequestStatus.NEEDS_REVIEW;
          await manager.save(TimeOffRequest, req);
        }
      }

      // Audit
      await manager.save(
        manager.create(require('../audit/entities/balance-audit-log.entity').BalanceAuditLog, {
          id: uuidv4(),
          employee_id: employeeId,
          location_id: locationId,
          delta_days: delta,
          balance_after: Math.max(0, newAvailable),
          source,
          reference_id: referenceId ?? null,
        }),
      );

      return { balance, conflicted };
    });
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
