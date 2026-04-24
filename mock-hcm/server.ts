/**
 * Mock HCM Server  — TRD §9
 * Simulates Workday/SAP behaviour for integration tests and local development.
 *
 * Scenarios implemented (TRD §9.2):
 *   1. Normal operation
 *   2. Insufficient balance → 422
 *   3. Silent failure mode → 200 but does NOT deduct (tests our defensive guard)
 *   4. Work-anniversary bonus push (admin endpoint)
 *   5. Intermittent failure → 503 on every other request
 *   6. Stale batch push (admin endpoint)
 *
 * Run standalone:  npx ts-node mock-hcm/server.ts
 * Import in tests: import { createMockHcmServer } from './mock-hcm/server'
 */

import * as http from 'http';
import * as url from 'url';

// ─────────────────────────────────────────────
// In-memory state
// ─────────────────────────────────────────────

interface HcmBalance {
  employeeExternalId: string;
  locationExternalId: string;
  totalDays: number;
  usedDays: number;
  pendingDays: number;
}

interface HcmRequest {
  id: string;
  referenceId: string;
  employeeExternalId: string;
  locationExternalId: string;
  durationDays: number;
  status: 'ACCEPTED' | 'CANCELLED';
}

const balances = new Map<string, HcmBalance>();
const requests = new Map<string, HcmRequest>();

let requestCounter = 1;

// Chaos / simulation controls
let silentFailureMode = false;        // Scenario 3
let intermittentFailureMode = false;  // Scenario 5
let intermittentRequestCount = 0;
let errorModeRemaining = 0;           // Set-error-mode counter

function key(emp: string, loc: string) { return `${emp}::${loc}`; }

function seedInitialBalances() {
  const employees = ['EMP001', 'EMP002', 'EMP003'];
  const locations  = ['LOC-US', 'LOC-UK', 'LOC-PK'];
  employees.forEach((e) =>
    locations.forEach((l) =>
      balances.set(key(e, l), {
        employeeExternalId: e,
        locationExternalId: l,
        totalDays: 20,
        usedDays: 0,
        pendingDays: 0,
      }),
    ),
  );
}

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { res(raw ? JSON.parse(raw) : {}); } catch { res({}); } });
    req.on('error', rej);
  });
}

function json(res: http.ServerResponse, status: number, body: any) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

// ─────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const parsed   = url.parse(req.url ?? '', true);
  const pathname = parsed.pathname ?? '';
  const method   = req.method ?? 'GET';
  const body     = await readBody(req);

  // Artificial latency to simulate real HCM (10–60 ms)
  await new Promise((r) => setTimeout(r, Math.random() * 50 + 10));

  // ── Scenario 5: intermittent 503 ─────────────────
  if (intermittentFailureMode) {
    intermittentRequestCount++;
    if (intermittentRequestCount % 2 === 0) {
      return json(res, 503, { message: 'HCM intermittent failure (mock)' });
    }
  }

  // ── Error-mode: force N failures ─────────────────
  if (errorModeRemaining > 0) {
    errorModeRemaining--;
    return json(res, 500, { message: 'HCM forced error (mock chaos mode)' });
  }

  // ── GET /hcm/balances/:emp/:loc ───────────────────
  const balanceGet = pathname.match(/^\/hcm\/balances\/([^/]+)\/([^/]+)$/);
  if (method === 'GET' && balanceGet) {
    const [, emp, loc] = balanceGet;
    const b = balances.get(key(emp, loc));
    if (!b) return json(res, 404, { message: `No balance for ${emp}/${loc}` });
    return json(res, 200, b);
  }

  // ── POST /hcm/requests — submit time-off ─────────
  if (method === 'POST' && pathname === '/hcm/requests') {
    const { employeeExternalId, locationExternalId, durationDays, referenceId } = body;
    const b = balances.get(key(employeeExternalId, locationExternalId));

    if (!b) {
      return json(res, 422, { errorCode: 'INVALID_DIMENSION', message: `Unknown employee/location combination` });
    }

    // Idempotency by caller reference ID: return existing accepted request
    // without applying balance changes a second time.
    const existing = Array.from(requests.values()).find((r) =>
      r.referenceId === referenceId
      && r.employeeExternalId === employeeExternalId
      && r.locationExternalId === locationExternalId
      && r.status === 'ACCEPTED',
    );
    if (existing) {
      const availableNow = b.totalDays - b.usedDays - b.pendingDays;
      return json(res, 200, {
        status: 'ACCEPTED',
        hcm_reference_id: existing.id,
        remainingBalance: Math.max(0, availableNow),
      });
    }

    const available = b.totalDays - b.usedDays - b.pendingDays;

    if (durationDays > available) {
      return json(res, 422, {
        errorCode: 'INSUFFICIENT_BALANCE',
        message: `Requested ${durationDays} days but only ${available} available`,
        available,
      });
    }

    // Scenario 3: silent failure — 200 but no deduction
    if (!silentFailureMode) {
      b.pendingDays += durationDays;
    }

    const hcmId = `HCM-${String(requestCounter++).padStart(6, '0')}`;
    requests.set(hcmId, {
      id: hcmId,
      referenceId,
      employeeExternalId,
      locationExternalId,
      durationDays,
      status: 'ACCEPTED',
    });

    return json(res, 200, {
      status: 'ACCEPTED',
      hcm_reference_id: hcmId,
      remainingBalance: available - durationDays,
    });
  }

  // ── DELETE /hcm/requests/:id — cancel ────────────
  const reqDelete = pathname.match(/^\/hcm\/requests\/([^/]+)$/);
  if (method === 'DELETE' && reqDelete) {
    const [, hcmId] = reqDelete;
    const r = requests.get(hcmId);
    if (!r) return json(res, 404, { message: `HCM request ${hcmId} not found` });

    const b = balances.get(key(r.employeeExternalId, r.locationExternalId));
    if (b) b.pendingDays = Math.max(0, b.pendingDays - r.durationDays);

    r.status = 'CANCELLED';
    return json(res, 200, { success: true });
  }

  // ── POST /hcm/batch — push all balances ──────────
  if (method === 'POST' && pathname === '/hcm/batch') {
    const { employeeExternalIds } = body;
    let all = Array.from(balances.values());
    if (employeeExternalIds?.length) {
      all = all.filter((b) => employeeExternalIds.includes(b.employeeExternalId));
    }
    return json(res, 200, {
      balances: all.map((b) => ({
        employeeExternalId: b.employeeExternalId,
        locationExternalId: b.locationExternalId,
        totalDays: b.totalDays,
      })),
      generatedAt: new Date().toISOString(),
    });
  }

  // ── Admin: POST /hcm/admin/bonus — Scenario 4 ────
  if (method === 'POST' && pathname === '/hcm/admin/bonus') {
    const { employeeExternalId, locationExternalId, bonusDays, readyOnCallbackUrl } = body;
    const b = balances.get(key(employeeExternalId, locationExternalId));
    if (!b) return json(res, 404, { message: 'Balance not found' });

    b.totalDays += bonusDays;
    console.log(`[MockHCM] Work-anniversary bonus: ${employeeExternalId} +${bonusDays} days`);

    // Push to ReadyOn's real-time sync endpoint if callback provided
    if (readyOnCallbackUrl) {
      const axios = require('axios');
      axios.post(readyOnCallbackUrl, {
        employeeExternalId,
        locationExternalId,
        totalDays: b.totalDays,
      }).catch((e: any) => console.error('[MockHCM] Callback failed:', e.message));
    }

    return json(res, 200, { success: true, newTotal: b.totalDays });
  }

  // ── Admin: POST /hcm/admin/reset — Scenario 6 ────
  if (method === 'POST' && pathname === '/hcm/admin/reset') {
    const { employeeExternalId, locationExternalId, newTotalDays } = body;
    const b = balances.get(key(employeeExternalId, locationExternalId));
    if (!b) return json(res, 404, { message: 'Balance not found' });
    b.totalDays = newTotalDays;
    return json(res, 200, { success: true, newTotal: b.totalDays });
  }

  // ── Admin: POST /hcm/admin/set-balance — test setup ──
  if (method === 'POST' && pathname === '/hcm/admin/set-balance') {
    const { employeeExternalId, locationExternalId, totalDays, usedDays, pendingDays } = body;
    balances.set(key(employeeExternalId, locationExternalId), {
      employeeExternalId,
      locationExternalId,
      totalDays: totalDays ?? 20,
      usedDays: usedDays ?? 0,
      pendingDays: pendingDays ?? 0,
    });
    return json(res, 200, { success: true });
  }

  // ── Admin: POST /hcm/admin/set-error-mode ────────
  if (method === 'POST' && pathname === '/hcm/admin/set-error-mode') {
    errorModeRemaining = body.count ?? 1;
    return json(res, 200, { success: true, errorModeRemaining });
  }

  // ── Admin: POST /hcm/admin/set-silent-failure ────
  if (method === 'POST' && pathname === '/hcm/admin/set-silent-failure') {
    silentFailureMode = body.enabled ?? true;
    return json(res, 200, { success: true, silentFailureMode });
  }

  // ── Admin: POST /hcm/admin/set-intermittent ──────
  if (method === 'POST' && pathname === '/hcm/admin/set-intermittent') {
    intermittentFailureMode = body.enabled ?? true;
    intermittentRequestCount = 0;
    return json(res, 200, { success: true, intermittentFailureMode });
  }

  // ── Admin: GET /hcm/admin/state ──────────────────
  if (method === 'GET' && pathname === '/hcm/admin/state') {
    return json(res, 200, {
      balances: Object.fromEntries(balances),
      requests: Object.fromEntries(requests),
      silentFailureMode,
      intermittentFailureMode,
      errorModeRemaining,
    });
  }

  // ── Admin: POST /hcm/admin/reset-all ─────────────
  if (method === 'POST' && pathname === '/hcm/admin/reset-all') {
    balances.clear();
    requests.clear();
    requestCounter = 1;
    silentFailureMode = false;
    intermittentFailureMode = false;
    errorModeRemaining = 0;
    seedInitialBalances();
    return json(res, 200, { success: true });
  }

  // ── Health ────────────────────────────────────────
  if (pathname === '/health') {
    return json(res, 200, { status: 'ok', service: 'mock-hcm', time: new Date().toISOString() });
  }

  return json(res, 404, { message: `${method} ${pathname} not found on mock HCM` });
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export function createMockHcmServer(): http.Server {
  seedInitialBalances();
  return http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err: any) {
      json(res, 500, { message: err.message });
    }
  });
}

export function getMockHcmState() {
  return { balances: Object.fromEntries(balances), requests: Object.fromEntries(requests) };
}

export function resetMockHcmState() {
  balances.clear();
  requests.clear();
  requestCounter = 1;
  silentFailureMode = false;
  intermittentFailureMode = false;
  errorModeRemaining = 0;
  seedInitialBalances();
}

export function setMockBalance(emp: string, loc: string, total: number, used = 0, pending = 0) {
  balances.set(key(emp, loc), {
    employeeExternalId: emp,
    locationExternalId: loc,
    totalDays: total,
    usedDays: used,
    pendingDays: pending,
  });
}

export function setSilentFailureMode(enabled: boolean) { silentFailureMode = enabled; }
export function setIntermittentMode(enabled: boolean) {
  intermittentFailureMode = enabled;
  intermittentRequestCount = 0;
}
export function setErrorMode(count: number) { errorModeRemaining = count; }

// Standalone entry
if (require.main === module) {
  const PORT = parseInt(process.env.MOCK_HCM_PORT ?? '4000', 10);
  const server = createMockHcmServer();
  server.listen(PORT, () => {
    console.log(`[MockHCM] Running on http://localhost:${PORT}`);
    console.log(`[MockHCM] Admin: GET http://localhost:${PORT}/hcm/admin/state`);
  });
}
