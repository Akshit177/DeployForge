# Progress Log

## Phase 0: Close the doors

### S-01: Arbitrary container stop/remove and cross-tenant route takedown
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Removed `PATCH /api/deployments/:id/status` endpoint from `backend/routes/deployments.js` and removed `updateDeploymentStatus` from `frontend/src/services/deploymentService.js`.
  - Enforced `Labels["deployforge.managed"] === "true"` and deployment ID matching in `backend/services/dockerClient.js` before `stopContainer` or `removeContainer` can proceed.
  - Made `stop` and `cancel` handlers in `backend/routes/deployments.js` use the project's verified domain (`project_domain`) and pass `expectedDeploymentId` to container teardown.
  - Passed `deploymentId` into `createContainer` from `backend/workers/deploymentWorker.js`.
- **Files touched:**
  - `backend/routes/deployments.js`
  - `backend/services/dockerClient.js`
  - `backend/workers/deploymentWorker.js`
  - `frontend/src/services/deploymentService.js`
  - `backend/tests/deployments_api.test.js`
  - `backend/tests/docker_client.test.js`
- **Tests added / updated:**
  - `backend/tests/deployments_api.test.js`: Verified `PATCH /api/deployments/:id/status` returns 404 for authenticated owner and cross-tenant caller; updated state assertions to inspect DB-backed changes.
  - `backend/tests/docker_client.test.js`: Added assertions that `stopContainer` and `removeContainer` reject unmanaged containers (`deployforge-postgres`), and `stopContainer` rejects deployment ID mismatches.
- **Verification result:** VERIFIED — Reproduction script confirmed 404 on `PATCH /status`; test suite (13 backend files, 28 C++ unit tests, frontend build) all pass.
- **Anything deferred:** None.

### S-02: Unauthenticated routing endpoints
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Added router-level `authenticateToken` middleware to `backend/routes/routing.js`.
  - Scoped `GET /api/routing/table` to return only routes for projects owned by the authenticated `req.user.id`.
  - Scoped `GET /api/routing/resolve/:domain` to return route details only if owned by `req.user.id` (returns 404 otherwise).
  - Removed `syncFromDatabase()` side-effect from `GET /table` and `GET /resolve/:domain` read handlers.
  - Dropped `nginx_config` payload from `/api/routing/table` responses to prevent internal infrastructure config leakage.
- **Files touched:**
  - `backend/routes/routing.js`
  - `backend/tests/health_and_routing.test.js`
  - `backend/tests/e2e_platform.test.js`
- **Tests added / updated:**
  - `backend/tests/health_and_routing.test.js`: Verified unauthenticated access to `/table`, `/resolve/:domain`, and `/health/:projectId` returns 401; verified authenticated table returns only caller's routes and omits `nginx_config`; verified cross-tenant caller cannot view or resolve other tenant's route (404).
  - `backend/tests/e2e_platform.test.js`: Updated routing table verification to use authenticated session and assert clean response.
- **Verification result:** VERIFIED — Reproduction script confirmed 401 on anonymous access and absence of leaked config; full test suite passed.
- **Anything deferred:** None.

### S-03: Cross-tenant log forging, live-log eavesdropping, hot-state IDOR
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Implemented shared ownership assertion helpers `assertOwnsDeployment(userId, deploymentId)` and `assertOwnsProject(userId, projectId)` in `backend/middleware/auth.js`.
  - Enforced ownership check before accessing Redis hot state in `GET /api/deployments/:id/live` in `backend/routes/deployments.js`.
  - Enforced deployment ownership validation in `POST /api/logs`, strictly ignoring client-supplied `project_id` and using the database-verified `project_id`.
  - Added deployment and project ownership validation to `GET /api/logs/stream` before opening SSE stream, and dropped the unauthenticated/unfiltered `"all"` stream subscription.
  - Added `user_id` to `formatLogEntry` and `recordWorkerLog` / `emitDeploymentLog` payloads in `backend/services/logEmitter.js` and `backend/routes/logs.js` to ensure the SSE listener filter enforces tenant isolation.
- **Files touched:**
  - `backend/middleware/auth.js`
  - `backend/routes/deployments.js`
  - `backend/routes/logs.js`
  - `backend/services/logEmitter.js`
  - `backend/tests/logs_api.test.js`
- **Tests added / updated:**
  - `backend/tests/logs_api.test.js`: Added tests asserting cross-tenant log forging returns 404, cross-tenant deployment and project SSE stream connections return 404, and cross-tenant live hot state queries return 404.
- **Verification result:** VERIFIED — Reproduction script confirmed 404 across forge, live hot-state, and stream checks; full test suite passed.
- **Anything deferred:** None.
### S-05: Default/fallback secrets
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Added startup configuration validator `backend/config/validateEnv.js` wired into `backend/server.js`, failing fast in production mode if `JWT_SECRET` or `ENCRYPTION_KEY` are missing, shorter than 32 characters, use insecure defaults, or collide; and failing if `DB_PASSWORD` is `'postgres'`.
  - Updated `backend/services/crypto.js` to enforce distinct `ENCRYPTION_KEY` from `JWT_SECRET` in production, prepended key-version byte `01` to ciphertext on encryption, and supported backwards-compatible decryption for unversioned legacy ciphertext.
  - Gated demo user creation in `backend/database/migrate.js` behind `SEED_DEMO === 'true'` and non-production environment.
  - Updated `docker-compose.yml` to use required variable syntax (`${DB_PASSWORD:?set DB_PASSWORD}`, `${JWT_SECRET:?set JWT_SECRET}`, `${ENCRYPTION_KEY:?set ENCRYPTION_KEY}`).
  - Updated `.env.example` to document required production secrets, distinct key requirements, key generation commands (`openssl rand -base64 32`), and `SEED_DEMO`.
- **Files touched:**
  - `backend/config/validateEnv.js`
  - `backend/server.js`
  - `backend/services/crypto.js`
  - `backend/database/migrate.js`
  - `docker-compose.yml`
  - `.env.example`
  - `backend/package.json`
  - `backend/tests/validate_env.test.js`
- **Tests added / updated:**
  - `backend/tests/validate_env.test.js`: Added 13 tests verifying production fail-fast on missing/short/default/colliding secrets, development non-strictness, key-version prefixing ("01"), legacy ciphertext decryption compatibility, and tampering rejection.
- **Verification result:** VERIFIED — `NODE_ENV=production node backend/server.js` exits non-zero with explicit error message; `docker compose config` without env exits with code 1 naming missing variables; test suite (14 backend test runs, 28 C++ unit tests, frontend build) all pass.
- **Anything deferred:** None.

### F-06: Outbox loses jobs on Redis outage
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Removed error swallowing and fallback in `backend/services/queue.js` (`publishDeploymentJob` and `ensureConsumerGroup`), ensuring Redis publication failures strictly throw.
  - Added `next_retry_at` column to `outbox_events` table in `backend/database/schema.sql` and `backend/database/migrate.js`.
  - Updated `backend/services/outboxRelay.js` to implement exponential backoff on retry (`next_retry_at`), increment `retry_count` without marking PROCESSED on Redis errors, and mark event and deployment as `FAILED` (with diagnostic error message) after exceeding `MAX_RETRIES`.
  - Added `reapStuckDeployments` to `backend/services/outboxRelay.js` to identify deployments stuck in `INITIATED`/`QUEUED` for longer than the reaper threshold with no active `PENDING` outbox tasks and fail them cleanly; wired reaper into the background outbox relay loop.
- **Files touched:**
  - `backend/services/queue.js`
  - `backend/services/outboxRelay.js`
  - `backend/database/schema.sql`
  - `backend/database/migrate.js`
  - `backend/package.json`
  - `backend/tests/outbox_resilience.test.js`
- **Tests added / updated:**
  - `backend/tests/outbox_resilience.test.js`: Added 4 tests verifying `publishDeploymentJob` rejection on Redis failure, event staying `PENDING` with incrementing `retry_count` and exponential backoff during Redis outages, delivery to `PROCESSED` and deployment advancing to `QUEUED` upon Redis recovery, dead-lettering to `FAILED` after `MAX_RETRIES`, and reaping of stuck deployments.
- **Verification result:** VERIFIED — Reproduction confirmed previous swallow behavior; full test suite (15 backend test files, 28 C++ worker tests, frontend build) all pass.
- **Anything deferred:** None.
