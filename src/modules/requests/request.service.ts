import {
  Injectable, Logger, NotFoundException, BadRequestException,
  UnprocessableEntityException, ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
  TimeOffRequest, RequestStatus, ACTIVE_STATUSES,
} from './entities/time-off-request.entity';
import { BalanceService } from '../balances/balance.service';
import { HcmClientService } from '../hcm-client/hcm-client.service';
import { Employee } from '../employees/entities/employee.entity';
import { Location } from '../locations/entities/location.entity';

export interface SubmitRequestDto {
  employeeId: string;    // internal UUID
  locationId: string;    // internal UUID
  startDate: string;     // ISO date
  endDate: string;       // ISO date
  durationDays: number;
  reason?: string;
  idempotencyKey?: string;
}

export interface ApproveDto { managerId?: string; }
export interface RejectDto  { managerId?: string; reason?: string; }

@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Location)
    private readonly locationRepo: Repository<Location>,
    private readonly balanceService: BalanceService,
    private readonly hcmClient: HcmClientService,
  ) {}

  // ─────────────────────────────────────────────
  // Submit — TRD §5: — → PENDING_LOCAL
  // ─────────────────────────────────────────────

  async submit(dto: SubmitRequestDto): Promise<TimeOffRequest> {
    // Idempotency: if key already used, return original response
    if (dto.idempotencyKey) {
      const existing = await this.requestRepo.findOne({
        where: { idempotency_key: dto.idempotencyKey },
      });
      if (existing) return existing;
    }

    this.validateDates(dto.startDate, dto.endDate);

    const [employee, location] = await Promise.all([
      this.employeeRepo.findOne({ where: { id: dto.employeeId } }),
      this.locationRepo.findOne({ where: { id: dto.locationId } }),
    ]);
    if (!employee) throw new NotFoundException(`Employee ${dto.employeeId} not found`);
    if (!location) throw new NotFoundException(`Location ${dto.locationId} not found`);

    const id = uuidv4();

    // TRD §7.3 — optimistic reservation
    const reservation = await this.balanceService.reserve(
      dto.employeeId,
      dto.locationId,
      dto.durationDays,
      id,
    );

    if (!reservation.success) {
      switch (reservation.errorCode) {
        case 'NOT_FOUND':
          throw new NotFoundException(
            `No balance record for employee=${dto.employeeId} location=${dto.locationId}`,
          );
        case 'INSUFFICIENT_BALANCE':
          throw new UnprocessableEntityException(
            `Insufficient balance. Requested: ${dto.durationDays} days, ` +
            `Available: ${reservation.availableBefore} days.`,
          );
        case 'CONFLICT':
          throw new ConflictException(
            'Could not acquire balance reservation after retries. Please try again.',
          );
      }
    }

    const request = this.requestRepo.create({
      id,
      employee_id: dto.employeeId,
      location_id: dto.locationId,
      start_date: dto.startDate,
      end_date: dto.endDate,
      duration_days: dto.durationDays,
      reason: dto.reason ?? null,
      idempotency_key: dto.idempotencyKey ?? null,
      status: RequestStatus.PENDING_LOCAL,
    });

    const saved = await this.requestRepo.save(request);

    // Async HCM submission — does not block response to employee
    this.submitToHcmAsync(saved, employee, location).catch((err) =>
      this.logger.error(`Async HCM submission failed for ${saved.id}: ${(err as any).message}`),
    );

    return saved;
  }

  // ─────────────────────────────────────────────
  // Async HCM flow: PENDING_LOCAL → PENDING_HCM → PENDING_APPROVAL | FAILED
  // ─────────────────────────────────────────────

  private async submitToHcmAsync(
    request: TimeOffRequest,
    employee: Employee,
    location: Location,
  ): Promise<void> {
    // Transition: PENDING_LOCAL → PENDING_HCM
    await this.requestRepo.update(request.id, { status: RequestStatus.PENDING_HCM });

    try {
      const result = await this.hcmClient.submitRequest({
        employeeExternalId: employee.external_id,
        locationExternalId: location.external_id,
        startDate: request.start_date,
        endDate: request.end_date,
        durationDays: request.duration_days,
        referenceId: request.id,
      });

      if (result.status === 'REJECTED') {
        this.logger.warn(`HCM rejected request ${request.id}: ${result.errorMessage}`);
        // Release reservation
        await this.balanceService.release(
          request.employee_id, request.location_id, request.duration_days, request.id,
        );
        await this.requestRepo.update(request.id, {
          status: RequestStatus.FAILED,
          hcm_error: result.errorMessage ?? result.errorCode ?? 'HCM_REJECTED',
          hcm_filed_at: new Date(),
        });
        return;
      }

      // ACCEPTED → PENDING_APPROVAL
      await this.requestRepo.update(request.id, {
        status: RequestStatus.PENDING_APPROVAL,
        hcm_reference_id: result.hcm_reference_id,
        hcm_filed_at: new Date(),
      });
    } catch (err) {
      // Transient HCM failure — keep PENDING_HCM, scheduler will retry
      const count = (request.hcm_retry_count ?? 0) + 1;
      await this.requestRepo.update(request.id, {
        hcm_error: (err as any).message,
        hcm_retry_count: count,
      });
      this.logger.warn(`HCM submission error for ${request.id} (attempt ${count}): ${(err as any).message}`);
    }
  }

  // ─────────────────────────────────────────────
  // Approve — TRD §5: PENDING_APPROVAL → APPROVED
  // ─────────────────────────────────────────────

  async approve(id: string, dto: ApproveDto): Promise<TimeOffRequest> {
    const request = await this.getOrThrow(id);

    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Cannot approve request in status ${request.status}. Must be PENDING_APPROVAL.`,
      );
    }

    // reserved → used
    await this.balanceService.commit(
      request.employee_id, request.location_id, request.duration_days, id,
    );

    await this.requestRepo.update(id, { status: RequestStatus.APPROVED });
    return this.getOrThrow(id);
  }

  // ─────────────────────────────────────────────
  // Reject — TRD §5: PENDING_APPROVAL → REJECTED
  // ─────────────────────────────────────────────

  async reject(id: string, dto: RejectDto): Promise<TimeOffRequest> {
    const request = await this.getOrThrow(id);

    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new BadRequestException(
        `Cannot reject request in status ${request.status}. Must be PENDING_APPROVAL.`,
      );
    }

    // Release reservation
    await this.balanceService.release(
      request.employee_id, request.location_id, request.duration_days, id,
    );

    // Cancel in HCM if filed
    if (request.hcm_reference_id) {
      await this.hcmClient.cancelRequest(request.hcm_reference_id).catch((e) =>
        this.logger.warn(`HCM cancel failed for ${request.hcm_reference_id}: ${e.message}`),
      );
    }

    await this.requestRepo.update(id, { status: RequestStatus.REJECTED });
    return this.getOrThrow(id);
  }

  // ─────────────────────────────────────────────
  // Cancel — TRD §5: PENDING_APPROVAL | APPROVED → CANCELLED
  // ─────────────────────────────────────────────

  async cancel(id: string, employeeId: string): Promise<TimeOffRequest> {
    const request = await this.getOrThrow(id);

    if (request.employee_id !== employeeId) {
      throw new BadRequestException('You can only cancel your own requests.');
    }

    const cancellable = [
      RequestStatus.PENDING_LOCAL,
      RequestStatus.PENDING_HCM,
      RequestStatus.PENDING_APPROVAL,
      RequestStatus.APPROVED,
    ];

    if (!cancellable.includes(request.status)) {
      throw new BadRequestException(
        `Cannot cancel request in status ${request.status}.`,
      );
    }

    if (request.status === RequestStatus.APPROVED) {
      // used → freed
      await this.balanceService.decommit(
        request.employee_id, request.location_id, request.duration_days, id,
      );
    } else {
      // reservation released
      await this.balanceService.release(
        request.employee_id, request.location_id, request.duration_days, id,
      );
    }

    if (request.hcm_reference_id) {
      await this.hcmClient.cancelRequest(request.hcm_reference_id).catch((e) =>
        this.logger.warn(`HCM cancel failed for ${request.hcm_reference_id}: ${e.message}`),
      );
    }

    await this.requestRepo.update(id, { status: RequestStatus.CANCELLED });
    return this.getOrThrow(id);
  }

  // ─────────────────────────────────────────────
  // Queries
  // ─────────────────────────────────────────────

  async findAll(filters: { employeeId?: string; status?: string }): Promise<TimeOffRequest[]> {
    const where: any = {};
    if (filters.employeeId) where.employee_id = filters.employeeId;
    if (filters.status)     where.status = filters.status;
    return this.requestRepo.find({ where, order: { created_at: 'DESC' } });
  }

  async findOne(id: string): Promise<TimeOffRequest> {
    return this.getOrThrow(id);
  }

  /** Retry scheduler — re-submits PENDING_HCM requests that have errors */
  async retryStuckSubmissions(maxRetries = 5): Promise<number> {
    const stuck = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.status = :s', { s: RequestStatus.PENDING_HCM })
      .andWhere('r.hcm_retry_count < :max', { max: maxRetries })
      .andWhere('r.hcm_error IS NOT NULL')
      .getMany();

    for (const req of stuck) {
      const employee = await this.employeeRepo.findOne({ where: { id: req.employee_id } });
      const location = await this.locationRepo.findOne({ where: { id: req.location_id } });
      if (employee && location) {
        this.submitToHcmAsync(req, employee, location).catch(() => {});
      }
    }
    return stuck.length;
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async getOrThrow(id: string): Promise<TimeOffRequest> {
    const r = await this.requestRepo.findOne({ where: { id } });
    if (!r) throw new NotFoundException(`Request ${id} not found`);
    return r;
  }

  private validateDates(start: string, end: string): void {
    const s = new Date(start), e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    if (e < s) {
      throw new BadRequestException('end_date must be >= start_date.');
    }
  }
}
