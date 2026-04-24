import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import nock from 'nock';
import { buildTestApp, seedDb, wipeDb, SEED } from '../helpers/app.helper';
import { RequestStatus } from '../../src/modules/requests/entities/time-off-request.entity';
import { LeaveBalance } from '../../src/modules/balances/entities/leave-balance.entity';
import { SyncJobStatus } from '../../src/modules/sync/entities/sync-job.entity';

const HCM = 'http://localhost:4000';

describe('Integration — Time-Off Microservice', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    if (!nock.isActive()) nock.activate();
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
    ({ app, ds } = await buildTestApp(HCM));
  });

  afterAll(async () => {
    // Drain any in-flight fire-and-forget tasks before the DataSource is destroyed
    await new Promise((r) => setTimeout(r, 300));
    nock.cleanAll();
    nock.enableNetConnect();
    await app.close();
  }, 30_000);

  beforeEach(async () => {
    // Drain any fire-and-forget async tasks from the previous test before wiping the DB
    await new Promise((r) => setTimeout(r, 150));
    await wipeDb(ds);
    await seedDb(ds, 20);
    nock.cleanAll();
    // Default: HCM always accepts unless test overrides
    nock(HCM).persist().post('/hcm/requests')
      .reply(200, { status: 'ACCEPTED', hcm_reference_id: 'HCM-DEFAULT', remainingBalance: 15 });
    nock(HCM).persist().delete(/\/hcm\/requests\/.*/)
      .reply(200, { success: true });
  });

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────
  function mockHcmAccept(refId = 'HCM-000001') {
    return nock(HCM).persist().post('/hcm/requests')
      .reply(200, { status: 'ACCEPTED', hcm_reference_id: refId, remainingBalance: 15 });
  }
  function mockHcmReject(code = 'INSUFFICIENT_BALANCE', msg = 'Not enough days') {
    return nock(HCM).persist().post('/hcm/requests')
      .reply(422, { errorCode: code, message: msg });
  }
  function mockHcmCancel(refId = 'HCM-000001') {
    return nock(HCM).persist().delete(`/hcm/requests/${refId}`).reply(200, { success: true });
  }
  function submitPayload(overrides: any = {}) {
    return {
      employeeId: SEED.emp.id,
      locationId: SEED.loc.id,
      startDate: '2025-08-01',
      endDate: '2025-08-05',
      durationDays: 5,
      ...overrides,
    };
  }

  // ─────────────────────────────────────────────
  // POST /requests — submit
  // ─────────────────────────────────────────────
  describe('POST /requests', () => {
    it('returns 201 with PENDING_LOCAL when balance is sufficient', async () => {
      mockHcmAccept();
      const res = await request(app.getHttpServer()).post('/requests').send(submitPayload());

      expect(res.status).toBe(201);
      expect(res.body.status).toBe(RequestStatus.PENDING_LOCAL);
      expect(res.body.employee_id).toBe(SEED.emp.id);
      expect(res.body.duration_days).toBe(5);
    });

    it('increments reserved_days on the balance row after submission', async () => {
      mockHcmAccept();
      await request(app.getHttpServer()).post('/requests').send(submitPayload());

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.reserved_days).toBe(5);
      expect(bal.used_days).toBe(0);
    });

    it('returns 422 when balance is insufficient', async () => {
      // Set balance to only 3 days
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 3 },
      );

      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ durationDays: 5 }));

      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/Insufficient balance/);
    });

    it('returns 422 at exact boundary — requesting one more than available', async () => {
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 4 },
      );
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ durationDays: 5 }));
      expect(res.status).toBe(422);
    });

    it('succeeds at exact boundary — requesting exactly available days', async () => {
      mockHcmAccept();
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 5 },
      );
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ durationDays: 5 }));
      expect(res.status).toBe(201);
    });

    it('prevents double-booking — second request fails after first reserves balance', async () => {
      mockHcmAccept('HCM-000001');
      // First request takes 12 out of 20
      await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ durationDays: 12 }));

      // Second request of 10 should now fail (only 8 left)
      const res2 = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ durationDays: 10 }));

      expect(res2.status).toBe(422);
    });

    it('returns 400 when end_date is before start_date', async () => {
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ startDate: '2025-08-10', endDate: '2025-08-01' }));
      expect(res.status).toBe(400);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send({ employeeId: SEED.emp.id });
      expect(res.status).toBe(400);
    });

    it('returns 404 when employee does not exist', async () => {
      const res = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ employeeId: '00000000-0000-0000-0000-000000000000' }));
      expect(res.status).toBe(404);
    });

    it('returns original 201 on duplicate idempotency key without re-reserving', async () => {
      mockHcmAccept('HCM-000001');
      const res1 = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ idempotencyKey: 'idem-abc' }));

      expect(res1.status).toBe(201);
      const originalId = res1.body.id;

      // Second submission with same key
      const res2 = await request(app.getHttpServer())
        .post('/requests')
        .send(submitPayload({ idempotencyKey: 'idem-abc' }));

      expect(res2.body.id).toBe(originalId);

      // Balance should only be reserved once
      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.reserved_days).toBe(5); // not 10
    });
  });

  // ─────────────────────────────────────────────
  // GET /requests
  // ─────────────────────────────────────────────
  describe('GET /requests', () => {
    it('returns empty array when no requests exist', async () => {
      const res = await request(app.getHttpServer()).get('/requests');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('filters by employeeId', async () => {
      mockHcmAccept();
      await request(app.getHttpServer()).post('/requests').send(submitPayload());

      const res = await request(app.getHttpServer())
        .get('/requests')
        .query({ employeeId: SEED.emp.id });

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].employee_id).toBe(SEED.emp.id);
    });

    it('filters by status', async () => {
      mockHcmAccept();
      await request(app.getHttpServer()).post('/requests').send(submitPayload());

      const res = await request(app.getHttpServer())
        .get('/requests')
        .query({ status: RequestStatus.PENDING_LOCAL });

      expect(res.status).toBe(200);
      expect(res.body.every((r: any) => r.status === RequestStatus.PENDING_LOCAL)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // PATCH /requests/:id/approve
  // ─────────────────────────────────────────────
  describe('PATCH /requests/:id/approve', () => {
    async function createPendingApproval() {
      mockHcmAccept('HCM-000001');
      const createRes = await request(app.getHttpServer())
        .post('/requests').send(submitPayload());
      const id = createRes.body.id;
      // Simulate async HCM transition to PENDING_APPROVAL
      await new Promise((r) => setTimeout(r, 80));
      const { TimeOffRequest, RequestStatus } = await import('../../src/modules/requests/entities/time-off-request.entity');
      await ds.getRepository(TimeOffRequest).update(id, {
        status: RequestStatus.PENDING_APPROVAL,
        hcm_reference_id: 'HCM-000001',
      });
      return id;
    }

    it('approves request and moves reserved → used', async () => {
      const id = await createPendingApproval();

      const res = await request(app.getHttpServer())
        .patch(`/requests/${id}/approve`).send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(RequestStatus.APPROVED);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.used_days).toBe(5);
      expect(bal.reserved_days).toBe(0);
    });

    it('returns 400 when approving a PENDING_LOCAL request (invalid transition)', async () => {
      // Insert at PENDING_LOCAL directly — avoid async HCM transition racing the assertion
      const { TimeOffRequest, RequestStatus: RS } = await import('../../src/modules/requests/entities/time-off-request.entity');
      const { v4: uuidv4 } = await import('uuid');
      const r = ds.getRepository(TimeOffRequest).create({
        id: uuidv4(),
        employee_id: SEED.emp.id, location_id: SEED.loc.id,
        start_date: '2025-08-01', end_date: '2025-08-05',
        duration_days: 5, status: RS.PENDING_LOCAL,
      });
      await ds.getRepository(TimeOffRequest).save(r);

      const res = await request(app.getHttpServer())
        .patch(`/requests/${r.id}/approve`).send({});

      expect(res.status).toBe(400);
    });

    it('returns 400 on double-approve', async () => {
      const id = await createPendingApproval();
      await request(app.getHttpServer()).patch(`/requests/${id}/approve`).send({});

      const res2 = await request(app.getHttpServer())
        .patch(`/requests/${id}/approve`).send({});
      expect(res2.status).toBe(400);
    });

    it('returns 404 for non-existent request', async () => {
      const res = await request(app.getHttpServer())
        .patch('/requests/00000000-0000-0000-0000-000000000000/approve').send({});
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // PATCH /requests/:id/reject
  // ─────────────────────────────────────────────
  describe('PATCH /requests/:id/reject', () => {
    it('rejects request and fully restores balance', async () => {
      mockHcmAccept('HCM-000001');
      const createRes = await request(app.getHttpServer())
        .post('/requests').send(submitPayload());
      const id = createRes.body.id;

      await new Promise((r) => setTimeout(r, 80));
      const { TimeOffRequest } = await import('../../src/modules/requests/entities/time-off-request.entity');
      await ds.getRepository(TimeOffRequest).update(id, {
        status: RequestStatus.PENDING_APPROVAL,
        hcm_reference_id: 'HCM-000001',
      });

      mockHcmCancel('HCM-000001');

      const res = await request(app.getHttpServer())
        .patch(`/requests/${id}/reject`).send({ reason: 'Team understaffed' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(RequestStatus.REJECTED);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.reserved_days).toBe(0);
      expect(bal.used_days).toBe(0);
    });

    it('returns 400 when rejecting an already REJECTED request', async () => {
      const { TimeOffRequest } = await import('../../src/modules/requests/entities/time-off-request.entity');
      const r = ds.getRepository(TimeOffRequest).create({
        id: require('uuid').v4(),
        employee_id: SEED.emp.id, location_id: SEED.loc.id,
        start_date: '2025-08-01', end_date: '2025-08-05',
        duration_days: 5, status: RequestStatus.REJECTED,
      });
      await ds.getRepository(TimeOffRequest).save(r);

      const res = await request(app.getHttpServer())
        .patch(`/requests/${r.id}/reject`).send({});
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────
  // DELETE /requests/:id — cancel
  // ─────────────────────────────────────────────
  describe('DELETE /requests/:id', () => {
    it('employee can cancel their own PENDING_LOCAL request and restore balance', async () => {
      mockHcmAccept();
      const createRes = await request(app.getHttpServer())
        .post('/requests').send(submitPayload());
      const id = createRes.body.id;

      const res = await request(app.getHttpServer())
        .delete(`/requests/${id}`)
        .query({ employeeId: SEED.emp.id });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe(RequestStatus.CANCELLED);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.reserved_days).toBe(0);
    });

    it('returns 400 when cancelling another employee\'s request', async () => {
      mockHcmAccept();
      const createRes = await request(app.getHttpServer())
        .post('/requests').send(submitPayload());

      const res = await request(app.getHttpServer())
        .delete(`/requests/${createRes.body.id}`)
        .query({ employeeId: SEED.emp2.id }); // wrong employee

      expect(res.status).toBe(400);
    });

    it('decommits used_days when cancelling an APPROVED request', async () => {
      const { TimeOffRequest } = await import('../../src/modules/requests/entities/time-off-request.entity');
      const r = ds.getRepository(TimeOffRequest).create({
        id: require('uuid').v4(),
        employee_id: SEED.emp.id, location_id: SEED.loc.id,
        start_date: '2025-08-01', end_date: '2025-08-05',
        duration_days: 5, status: RequestStatus.APPROVED,
      });
      await ds.getRepository(TimeOffRequest).save(r);
      // Set used_days to reflect the approved state
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { used_days: 5, reserved_days: 0 },
      );

      const res = await request(app.getHttpServer())
        .delete(`/requests/${r.id}`)
        .query({ employeeId: SEED.emp.id });

      expect(res.status).toBe(200);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.used_days).toBe(0);
    });
  });

  // ─────────────────────────────────────────────
  // GET /balances
  // ─────────────────────────────────────────────
  describe('GET /balances', () => {
    it('returns all location balances for an employee', async () => {
      const res = await request(app.getHttpServer())
        .get(`/balances/${SEED.emp.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].total_days).toBe(20);
    });

    it('returns specific (employee, location) balance', async () => {
      const res = await request(app.getHttpServer())
        .get(`/balances/${SEED.emp.id}/locations/${SEED.loc.id}`);
      expect(res.status).toBe(200);
      expect(res.body.total_days).toBe(20);
      expect(res.body.reserved_days).toBe(0);
    });

    it('returns 404 for unknown employee/location pair', async () => {
      const res = await request(app.getHttpServer())
        .get(`/balances/${SEED.emp.id}/locations/00000000-0000-0000-0000-000000000000`);
      expect(res.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────
  // POST /balances/sync/realtime — TRD §7.1
  // ─────────────────────────────────────────────
  describe('POST /balances/sync/realtime', () => {
    it('updates total_days on work-anniversary bonus push', async () => {
      const res = await request(app.getHttpServer())
        .post('/balances/sync/realtime')
        .send({
          employeeExternalId: SEED.emp.external_id,
          locationExternalId: SEED.loc.external_id,
          totalDays: 25, // +5 bonus
        });

      expect(res.status).toBe(200);
      expect(res.body.balance.total_days).toBe(25);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.total_days).toBe(25);
    });

    it('creates a balance record if none exists yet', async () => {
      const res = await request(app.getHttpServer())
        .post('/balances/sync/realtime')
        .send({
          employeeExternalId: SEED.emp2.external_id,
          locationExternalId: SEED.loc.external_id,
          totalDays: 15,
        });

      expect(res.status).toBe(200);
    });

    it('returns conflicted:true and flags NEEDS_REVIEW when HCM balance drops below reserved', async () => {
      // First make a reservation
      mockHcmAccept();
      await request(app.getHttpServer()).post('/requests').send(submitPayload({ durationDays: 15 }));

      // Now HCM pushes a balance lower than what's reserved
      const res = await request(app.getHttpServer())
        .post('/balances/sync/realtime')
        .send({
          employeeExternalId: SEED.emp.external_id,
          locationExternalId: SEED.loc.external_id,
          totalDays: 5, // reserved=15, total=5 → conflict
        });

      expect(res.status).toBe(200);
      expect(res.body.conflicted).toBe(true);
    });

    it('returns 400 for unknown employee external_id', async () => {
      const res = await request(app.getHttpServer())
        .post('/balances/sync/realtime')
        .send({ employeeExternalId: 'UNKNOWN', locationExternalId: SEED.loc.external_id, totalDays: 20 });
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────
  // POST /balances/sync/batch — TRD §8
  // ─────────────────────────────────────────────
  describe('POST /balances/sync/batch', () => {
    const validBatch = () => ({
      batchId: `batch-${Date.now()}`,
      generatedAt: new Date().toISOString(),
      records: [
        { employeeExternalId: SEED.emp.external_id, locationExternalId: SEED.loc.external_id, totalDays: 22 },
      ],
    });

    it('returns 202 with jobId immediately', async () => {
      const res = await request(app.getHttpServer())
        .post('/balances/sync/batch').send(validBatch());
      expect(res.status).toBe(202);
      expect(res.body.jobId).toBeDefined();
      expect(res.body.status).toBe(SyncJobStatus.PENDING);
    });

    it('updates balance after processing completes', async () => {
      const res = await request(app.getHttpServer())
        .post('/balances/sync/batch').send(validBatch());
      const { jobId } = res.body;

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 150));

      const jobRes = await request(app.getHttpServer()).get(`/balances/sync/jobs/${jobId}`);
      expect(jobRes.body.status).toBe(SyncJobStatus.COMPLETED);

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.total_days).toBe(22);
    });

    it('returns 409 on duplicate batchId — idempotency guard', async () => {
      const batch = validBatch();
      await request(app.getHttpServer()).post('/balances/sync/batch').send(batch);
      await new Promise((r) => setTimeout(r, 50));

      const res2 = await request(app.getHttpServer())
        .post('/balances/sync/batch').send(batch); // same batchId
      expect(res2.status).toBe(409);
    });

    it('marks job FAILED if a record references an unknown employee — all-or-nothing', async () => {
      const batch = {
        batchId: `batch-fail-${Date.now()}`,
        generatedAt: new Date().toISOString(),
        records: [
          { employeeExternalId: 'GHOST-EMP', locationExternalId: SEED.loc.external_id, totalDays: 20 },
        ],
      };

      const res = await request(app.getHttpServer())
        .post('/balances/sync/batch').send(batch);
      const { jobId } = res.body;

      await new Promise((r) => setTimeout(r, 150));

      const jobRes = await request(app.getHttpServer()).get(`/balances/sync/jobs/${jobId}`);
      expect(jobRes.body.status).toBe(SyncJobStatus.FAILED);
      expect(jobRes.body.error_detail).toContain('GHOST-EMP');
    });

    it('year-end reset — overwrites old total with new one from HCM', async () => {
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 5 }, // old stale balance
      );

      const batch = {
        batchId: `year-reset-${Date.now()}`,
        generatedAt: new Date().toISOString(),
        records: [
          { employeeExternalId: SEED.emp.external_id, locationExternalId: SEED.loc.external_id, totalDays: 20 },
        ],
      };

      const res = await request(app.getHttpServer())
        .post('/balances/sync/batch').send(batch);
      await new Promise((r) => setTimeout(r, 150));

      const bal = await ds.getRepository(LeaveBalance).findOne({
        where: { employee_id: SEED.emp.id, location_id: SEED.loc.id },
      });
      expect(bal.total_days).toBe(20);
    });
  });

  // ─────────────────────────────────────────────
  // Silent HCM failure — TRD §9.2 Scenario 3
  // HCM returns 200 but our local guard must still block over-deduction
  // ─────────────────────────────────────────────
  describe('Defensive guard — silent HCM failure', () => {
    it('blocks a second request even if first HCM call was silent-accepted', async () => {
      // Seed with only 8 days
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 8 },
      );

      // HCM silently accepts first request (doesn't deduct on its side)
      nock(HCM).post('/hcm/requests').reply(200, {
        status: 'ACCEPTED', hcm_reference_id: 'HCM-SIL-001',
      });

      await request(app.getHttpServer())
        .post('/requests').send(submitPayload({ durationDays: 6 }));

      // Second request: locally only 2 days remain, our guard fires
      const res2 = await request(app.getHttpServer())
        .post('/requests').send(submitPayload({ durationDays: 4 }));

      expect(res2.status).toBe(422); // Our local guard caught it
    });
  });

  // ─────────────────────────────────────────────
  // Work-anniversary end-to-end — TRD §11.2
  // ─────────────────────────────────────────────
  describe('Work anniversary E2E', () => {
    it('employee can submit after anniversary bonus increases their balance', async () => {
      // Employee has only 2 days — cannot request 5
      await ds.getRepository(LeaveBalance).update(
        { employee_id: SEED.emp.id, location_id: SEED.loc.id },
        { total_days: 2 },
      );

      // Attempt fails
      const fail = await request(app.getHttpServer())
        .post('/requests').send(submitPayload({ durationDays: 5 }));
      expect(fail.status).toBe(422);

      // HCM pushes work-anniversary bonus: +10 days
      await request(app.getHttpServer())
        .post('/balances/sync/realtime')
        .send({
          employeeExternalId: SEED.emp.external_id,
          locationExternalId: SEED.loc.external_id,
          totalDays: 12, // was 2, now 12
        });

      // Attempt now succeeds
      nock(HCM).post('/hcm/requests').reply(200, { status: 'ACCEPTED', hcm_reference_id: 'HCM-ANNIV' });

      const ok = await request(app.getHttpServer())
        .post('/requests').send(submitPayload({ durationDays: 5 }));
      expect(ok.status).toBe(201);
    });
  });
});
