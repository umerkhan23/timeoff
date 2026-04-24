import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpException } from '@nestjs/common';
import axios from 'axios';
import nock from 'nock';
import { HcmClientService } from '../../../src/modules/hcm-client/hcm-client.service';

const BASE = 'http://mock-hcm.test';

describe('HcmClientService — unit', () => {
  let service: HcmClientService;

  beforeEach(async () => {
    nock.disableNetConnect();

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HcmClientService,
        {
          provide: ConfigService,
          useValue: {
            get: (k: string, def?: any) =>
              ({ HCM_BASE_URL: BASE, HCM_API_KEY: 'key', HCM_TIMEOUT_MS: 3000 }[k] ?? def),
          },
        },
      ],
    }).compile();

    service = mod.get(HcmClientService);
  });

  afterEach(() => { nock.cleanAll(); });
  afterAll(() => { nock.enableNetConnect(); nock.restore(); });
  beforeAll(() => { if (!nock.isActive()) nock.activate(); });

  // ─────────────────────────────────────────────
  // getBalance
  // ─────────────────────────────────────────────
  describe('getBalance', () => {
    it('returns balance on 200', async () => {
      nock(BASE).get('/hcm/balances/EMP001/LOC-US')
        .reply(200, { employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 });

      const b = await service.getBalance('EMP001', 'LOC-US');
      expect(b.totalDays).toBe(20);
    });

    it('throws HttpException on 404', async () => {
      nock(BASE).get('/hcm/balances/UNKNOWN/LOC-US').reply(404, { message: 'Not found' });
      await expect(service.getBalance('UNKNOWN', 'LOC-US')).rejects.toThrow(HttpException);
    });

    it('throws on 503 service unavailable', async () => {
      nock(BASE).get('/hcm/balances/EMP001/LOC-US').reply(503, { message: 'Down' });
      await expect(service.getBalance('EMP001', 'LOC-US')).rejects.toThrow(HttpException);
    });

    it('throws on network error', async () => {
      nock(BASE).get('/hcm/balances/EMP001/LOC-US').replyWithError('ECONNREFUSED');
      await expect(service.getBalance('EMP001', 'LOC-US')).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────
  // submitRequest
  // ─────────────────────────────────────────────
  describe('submitRequest', () => {
    const payload = {
      employeeExternalId: 'EMP001', locationExternalId: 'LOC-US',
      startDate: '2025-08-01', endDate: '2025-08-05',
      durationDays: 5, referenceId: 'req-1',
    };

    it('returns ACCEPTED with hcm_reference_id on success', async () => {
      nock(BASE).post('/hcm/requests')
        .reply(200, { status: 'ACCEPTED', hcm_reference_id: 'HCM-000001', remainingBalance: 15 });

      const result = await service.submitRequest(payload);
      expect(result.status).toBe('ACCEPTED');
      expect(result.hcm_reference_id).toBe('HCM-000001');
    });

    it('returns REJECTED (not throws) when HCM returns 422 — TRD §2.2 Challenge B', async () => {
      nock(BASE).post('/hcm/requests')
        .reply(422, { errorCode: 'INSUFFICIENT_BALANCE', message: 'Only 2 days available' });

      const result = await service.submitRequest(payload);
      expect(result.status).toBe('REJECTED');
      expect(result.errorCode).toBe('INSUFFICIENT_BALANCE');
      expect(result.errorMessage).toContain('2 days available');
    });

    it('returns REJECTED when HCM returns 400 for invalid dimensions', async () => {
      nock(BASE).post('/hcm/requests')
        .reply(400, { errorCode: 'INVALID_DIMENSION', message: 'Employee not enrolled at location' });

      const result = await service.submitRequest(payload);
      expect(result.status).toBe('REJECTED');
      expect(result.errorCode).toBe('INVALID_DIMENSION');
    });

    it('throws HttpException on 503 (network-level failure, not business rejection)', async () => {
      nock(BASE).post('/hcm/requests').replyWithError('connect ECONNREFUSED');
      await expect(service.submitRequest(payload)).rejects.toThrow();
    });

    it('throws HttpException when HCM submit returns 503 response', async () => {
      nock(BASE).post('/hcm/requests').reply(503, { message: 'Service unavailable' });
      await expect(service.submitRequest(payload)).rejects.toThrow(HttpException);
    });
  });

  // ─────────────────────────────────────────────
  // cancelRequest
  // ─────────────────────────────────────────────
  describe('cancelRequest', () => {
    it('returns success:true on 200', async () => {
      nock(BASE).delete('/hcm/requests/HCM-000001').reply(200, { success: true });
      const r = await service.cancelRequest('HCM-000001');
      expect(r.success).toBe(true);
    });

    it('throws HttpException when HCM returns 404', async () => {
      nock(BASE).delete('/hcm/requests/BAD-ID').reply(404, { message: 'Not found' });
      await expect(service.cancelRequest('BAD-ID')).rejects.toThrow(HttpException);
    });
  });

  // ─────────────────────────────────────────────
  // triggerBatchPull
  // ─────────────────────────────────────────────
  describe('triggerBatchPull', () => {
    it('returns batch of balances from HCM', async () => {
      const balances = [
        { employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 },
        { employeeExternalId: 'EMP002', locationExternalId: 'LOC-UK', totalDays: 25 },
      ];
      nock(BASE).post('/hcm/batch')
        .reply(200, { balances, generatedAt: new Date().toISOString() });

      const result = await service.triggerBatchPull();
      expect(result.balances).toHaveLength(2);
      expect(result.balances[0].totalDays).toBe(20);
    });

    it('sends specific employeeExternalIds in request body', async () => {
      nock(BASE).post('/hcm/batch', { employeeExternalIds: ['EMP001'] })
        .reply(200, {
          balances: [{ employeeExternalId: 'EMP001', locationExternalId: 'LOC-US', totalDays: 20 }],
          generatedAt: new Date().toISOString(),
        });

      const result = await service.triggerBatchPull(['EMP001']);
      expect(result.balances).toHaveLength(1);
    });

    it('throws HttpException when trigger batch pull returns 500', async () => {
      nock(BASE).post('/hcm/batch').reply(500, { message: 'Upstream exploded' });
      await expect(service.triggerBatchPull()).rejects.toThrow(HttpException);
    });
  });

  it('rethrows non-Axios errors unchanged', () => {
    const err = new Error('plain error');
    expect(() => (service as any).rethrow(err, 'customOp')).toThrow('plain error');
  });

  it('submitRequest handles non-Axios thrown errors via rethrow path', async () => {
    const postSpy = jest.spyOn((service as any).http, 'post').mockRejectedValueOnce(new Error('plain submit error'));
    const axiosTypeSpy = jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);

    await expect(service.submitRequest({
      employeeExternalId: 'EMP001',
      locationExternalId: 'LOC-US',
      startDate: '2025-08-01',
      endDate: '2025-08-02',
      durationDays: 1,
      referenceId: 'ref-plain',
    })).rejects.toThrow('plain submit error');

    axiosTypeSpy.mockRestore();
    postSpy.mockRestore();
  });
});
