# Time-Off Microservice

**Stack:** NestJS · TypeScript · SQLite (sql.js) · TypeORM  
**Assessment:** Wizdaa Take-Home — Muhammad Umer Khan

---

## Setup

```bash
npm install
```

## Run the service

```bash
# Development mode
npm run start:dev

# API docs (Swagger)
open http://localhost:3000/api/docs
```

## Run the Mock HCM server (separate terminal)

```bash
npm run start:mock-hcm
# Runs on http://localhost:4000
```

## Seed the database

Run this once (or whenever you want to reset sample data):

```bash
npx ts-node -r tsconfig-paths/register seed.ts
```

## Run tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# E2E tests (uses real mock HCM server, no nock)
npm run test:e2e

# With coverage report
npm run test:cov
```

Coverage report is generated in `./coverage/index.html`.

---

## Environment variables

Copy `.env.example` to `.env` to override defaults:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Service port |
| `HCM_BASE_URL` | `http://localhost:4000` | HCM system base URL |
| `HCM_API_KEY` | `mock-key` | API key sent to HCM |
| `HCM_TIMEOUT_MS` | `10000` | HCM request timeout |
| `DB_PATH` | `timeoff.db` | SQLite file path |
| `MOCK_HCM_PORT` | `4000` | Mock HCM server port |

---

## API Overview

### Balance endpoints
| Method | Path | Description |
|---|---|---|
| `GET` | `/balances/:employeeId` | All location balances for employee |
| `GET` | `/balances/:employeeId/locations/:locationId` | Specific (employee, location) balance |
| `POST` | `/balances/sync/realtime` | HCM real-time balance push (webhook) |
| `POST` | `/balances/sync/batch` | HCM full batch dump — returns `jobId` |
| `GET` | `/balances/sync/jobs/:jobId` | Poll batch sync job status |
| `POST` | `/balances/sync/trigger` | HR Admin: trigger pull from HCM |

### Request endpoints
| Method | Path | Description |
|---|---|---|
| `POST` | `/requests` | Submit time-off request |
| `GET` | `/requests` | List requests (`?employeeId=&status=`) |
| `GET` | `/requests/:id` | Get request by ID |
| `PATCH` | `/requests/:id/approve` | Manager approves |
| `PATCH` | `/requests/:id/reject` | Manager rejects |
| `DELETE` | `/requests/:id?employeeId=` | Employee cancels |

---

## Architecture

The service is built around the TRD's state machine:

```
PENDING_LOCAL → PENDING_HCM → PENDING_APPROVAL → APPROVED
                    ↓                ↓
                  FAILED          REJECTED / CANCELLED
```

Key design decisions:

1. **Optimistic locking** on `leave_balances.version` prevents race conditions
2. **Two-layer validation**: local balance check first, then async HCM submission
3. **202 + jobId** pattern for batch sync prevents HTTP timeouts
4. **Conflict resolution**: if HCM reduces balance below reserved, active requests are flagged `NEEDS_REVIEW`
5. **Append-only audit log** for every balance mutation

---

## Mock HCM Admin Endpoints

The mock HCM server (for tests/dev) exposes simulation controls:

| Endpoint | Effect |
|---|---|
| `POST /hcm/admin/bonus` | Simulate work-anniversary bonus |
| `POST /hcm/admin/reset` | Simulate year-start refresh |
| `POST /hcm/admin/set-silent-failure` | Toggle silent failure mode |
| `POST /hcm/admin/set-intermittent` | Toggle 503 on every other request |
| `POST /hcm/admin/set-error-mode` | Force next N requests to return 500 |
| `POST /hcm/admin/set-balance` | Seed a specific balance |
| `POST /hcm/admin/reset-all` | Reset all state |
| `GET /hcm/admin/state` | Inspect full mock state |
