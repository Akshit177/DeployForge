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

### F-03: Worker image cannot build
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Added `nlohmann-json` to builder `apk add` dependencies in `worker/Dockerfile`.
  - Added `.PHONY: worker` and target `worker: $(TARGET)` in `worker/Makefile` to build only the worker binary without compiling unit test targets during container image builds.
  - Updated `worker/Dockerfile` builder stage to invoke `make clean && make worker`.
  - Configured production stage in `worker/Dockerfile` to run as non-root user `deployforge` in the `docker` group with appropriate directory ownership.
  - Added `worker/.dockerignore` to exclude `.git`, `bin/`, `*.o`, and `tests/`.
- **Files touched:**
  - `worker/Dockerfile`
  - `worker/Makefile`
  - `worker/.dockerignore`
- **Tests added / updated:**
  - Verified Docker container image build: `docker build -t deployforge-worker-test worker/` succeeded and non-root execution confirmed.
  - Ran C++ worker test suite: `make -C worker test` (28/28 passed).
- **Verification result:** VERIFIED — `docker build -t deployforge-worker-test worker/` builds cleanly; C++ test suite passes.
- **Anything deferred:** None.

### F-04: Dashboard not served from Docker image
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Converted `backend/Dockerfile` into a multi-stage build: stage 1 builds the Vite frontend SPA, stage 2 copies the distribution assets to `/app/public`.
  - Updated `backend/server.js` to serve `PUBLIC_DIR` (with fallback to `../frontend/dist`), while ensuring missing static assets with extensions return 404 instead of falling back to `index.html`.
  - Updated `docker-compose.yml` to use repository root context for building the `api` service.
  - Added repository-level `.dockerignore` ignoring node_modules, git history, and local credentials.
- **Files touched:**
  - `backend/Dockerfile`
  - `backend/server.js`
  - `docker-compose.yml`
  - `.dockerignore`
- **Tests added / updated:**
  - Ran multi-stage Docker build: `docker build -t deployforge-api-test -f backend/Dockerfile .`.
  - Ran containerized verification: confirmed `GET /` and `GET /projects` return `<div id="root"></div>`, and missing asset request `GET /assets/missing.js` returns HTTP 404.
- **Verification result:** VERIFIED — Docker image builds cleanly; container serves SPA on root and deep paths; returns 404 on missing assets.
- **Anything deferred:** None.

### P-01: Validate pagination limits and date filters
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Added reusable `parsePagination` middleware in `backend/middleware/pagination.js` that strictly parses and validates query parameters (`limit`, `offset`, `since`, `until`).
  - Clamps `limit` to range `[1, 200]` (defaulting to 50 if omitted, clamping values > 200 down to 200, and rejecting non-positive or non-integer values with 400).
  - Enforces `offset >= 0` (defaulting to 0 if omitted, rejecting negative or non-integer values with 400).
  - Parses ISO-8601 date filters `since` and `until` into valid `Date` objects, rejecting unparseable date values with 400.
  - Wired `parsePagination` into list endpoints across `backend/routes/deployments.js`, `backend/routes/projects.js`, and `backend/routes/logs.js` using parameterized SQL queries.
  - Stopped `SELECT *` in the auth fallback path (`backend/middleware/auth.js`) when authenticating without a Redis session, selecting explicit safe columns (`id, name, email, github_connected, github_username, notification_preferences, created_at, updated_at`) so password hashes never flow into `req.user`.
- **Files touched:**
  - `backend/middleware/pagination.js`
  - `backend/routes/deployments.js`
  - `backend/routes/projects.js`
  - `backend/routes/logs.js`
  - `backend/middleware/auth.js`
  - `backend/package.json`
  - `backend/tests/pagination.test.js`
- **Tests added / updated:**
  - `backend/tests/pagination.test.js`: Added 18 tests (3 unit tests on middleware + 15 table-driven API integration tests) validating default limits, clamping upper bounds, rejecting non-positive/malformed limits and offsets, date validation, and asserting `req.user` excludes password/password_hash on sessionless auth fallback.
- **Verification result:** VERIFIED — Table-driven API tests pass; full test suite (16 backend test files, 28 C++ worker tests, frontend build) all pass cleanly.
- **Anything deferred:** None.

### H-01: Repo hygiene, untrack generated config, and remove dead code
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Removed dead `backend/models/user.js` (leftover prototype model from mongoose).
  - Removed unused `mongoose` dependency from `backend/package.json`.
  - Confirmed `backend/main.html` and `backend/MOCK_DATA.json` are not tracked in git and removed.
  - Untracked generated runtime file `nginx/conf.d/deployforge-upstreams.conf` from git tracking via `git rm --cached` and added it to `.gitignore` so test runs no longer dirty git status.
  - Added MIT `LICENSE` file in the repository root and updated `README.md` License section to reference the MIT License.
  - Hardened after-hooks in `backend/tests/outbox_resilience.test.js` to ensure Redis connections and DB pools always close cleanly.
- **Files touched:**
  - `backend/models/user.js` (deleted)
  - `backend/package.json`
  - `.gitignore`
  - `nginx/conf.d/deployforge-upstreams.conf` (untracked)
  - `LICENSE` (created)
  - `README.md`
  - `backend/tests/outbox_resilience.test.js`
- **Tests added / updated:**
  - Ran backend test suite `npm test` (all 16 test files pass cleanly).
  - Ran worker test suite `make -C worker test` (28/28 tests pass).
  - Ran frontend build `npm --prefix frontend run build` (builds cleanly with Vite).
- **Verification result:** VERIFIED — `git status --porcelain` shows no modified files after test runs; all test suites pass with 100% success.
- **Anything deferred:** Phase 1 / Phase 2 scope of H-01 (.env.example cleanup and further hygiene as noted in roadmap).

### T-02: Comprehensive authorization matrix tests
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Implemented auto-enumerating authorization matrix test suite in `backend/tests/authz_matrix.test.js` covering all 33 distinct routes in the application.
  - Automatically walks Express router layers and nested sub-routers (e.g. `/:id/env`) to guarantee no routes can be added without authorization coverage.
  - Asserted anonymous requests across all 30 non-public routes return HTTP 401 Unauthorized (public routes `/api/auth/register`, `/api/auth/login`, and `/api/auth/logout` permit anonymous access).
  - Asserted cross-tenant IDOR access (User B attempting to read, update, delete, or inspect User A's projects, deployments, live hot-states, vault secrets, custom domains, logs, SSE streams, and routing resolution/health) strictly returns HTTP 404 across all endpoints.
  - Asserted legitimate owner access for User A succeeds with 2xx across all corresponding resource endpoints.
  - Wired `node --test tests/authz_matrix.test.js` into `backend/package.json` test script.
- **Files touched:**
  - `backend/tests/authz_matrix.test.js`
  - `backend/package.json`
- **Tests added / updated:**
  - `backend/tests/authz_matrix.test.js`: 31 tests across 5 suites (Auto-enumeration route discovery, anonymous 401 protection, cross-tenant IDOR 404 isolation, and owner 2xx operations).
- **Verification result:** VERIFIED — All 31 matrix tests pass; all 17 backend test suites pass with 100% success.
- **Anything deferred:** None.

### T-03: Add GitHub Actions CI workflow skeleton
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Created `.github/workflows/ci.yml` defining the CI pipeline for pull requests and pushes to `main` and `phase-*` branches.
  - Configured PostgreSQL 16 and Redis 7 container services with health checks.
  - Added steps for Node.js 20 setup, frontend build, database schema migration, backend test suite execution with isolated environment variables, C++ worker compilation and test suite execution, Docker Compose image build, and working tree cleanliness verification.
- **Files touched:**
  - `.github/workflows/ci.yml`
- **Tests added / updated:**
  - Verified YAML syntax of workflow definition.
  - Ran full test verification matching CI pipeline steps locally: all 17 backend test files, 28 C++ worker tests, frontend build, and clean git state verification.
- **Verification result:** VERIFIED — Local execution of CI pipeline steps succeeds with 100% pass; working tree remains clean after test runs.
- **Anything deferred:** Full multi-platform matrix and GitHub Actions runner execution (Phase 1 / T-04).

## Phase 1: Operational Baseline & Core Engine

### R-01: Nginx config manager hardening and debouncing
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Implemented single-flight debounced writer for `syncNginxConfig` in `backend/services/nginxManager.js` coalescing bursts into one write+reload per 150-200 ms window (`DEBOUNCE_MS`), with trailing execution for concurrent calls occurring mid-flight.
  - Implemented atomic write using unique temporary files (`${UPSTREAMS_CONF_FILE}.tmp.${Date.now()}.${Math.random()}`), syntax validation, and POSIX rename over `UPSTREAMS_CONF_FILE` so existing configuration is preserved on failure without leaving stray `.tmp` files.
  - Exported `getSyncStats()` and `resetSyncStats()` tracking `totalSyncCalls`, `actualWriteCount`, and `actualReloadCount`.
  - Added `map $http_upgrade $connection_upgrade` block to `nginx/nginx.conf` and `ensureNginxStructure()` base config template.
  - Replaced hardcoded `proxy_set_header Connection 'upgrade';` with `proxy_set_header Connection $connection_upgrade;` across `generateNginxConfig()` in `backend/services/proxyRouter.js`, `deployforge-ingress.conf`, and `ensureNginxStructure()`.
  - Placed development hostnames (`.localhost` and `.nip.io`) behind conditional `includeDevDomains` check (`DEV_DOMAINS=true` or non-production environment without `DEV_DOMAINS=false`).
  - Added dedicated unit test suite `backend/tests/nginx_manager.test.js` validating debounced burst coalescing (50 concurrent calls -> <= 3 actual writes/reloads), atomic temp rename cleanliness, dev domains gating, and WebSocket connection upgrade headers.
  - Wired `node --test tests/nginx_manager.test.js` into `backend/package.json` `scripts.test`.
- **Files touched:**
  - `backend/services/proxyRouter.js`
  - `backend/services/nginxManager.js`
  - `backend/package.json`
  - `backend/tests/nginx_manager.test.js`
  - `nginx/nginx.conf`
  - `nginx/conf.d/deployforge-ingress.conf`
  - `docs/PROGRESS.md`
- **Tests added / updated:**
  - `backend/tests/nginx_manager.test.js`: 4 tests (debounced burst coalescing with 50 concurrent calls, atomic file rename leaving no stray `.tmp` files, conditional dev domain inclusion, and WebSocket upgrade header mapping).
- **Verification result:** VERIFIED — 50 parallel `syncNginxConfig()` calls coalesced to 1 actual write/reload with all 50 resolving `{ synced: true }`; full test suite (18 backend test files, 28 C++ worker tests, frontend build) all pass with 100% success; git status clean of runtime test debris.
- **Anything deferred:** None.
### S-04: Global domain uniqueness, reserved slugs, and collision-free upstreams
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Added unique constraint `CONSTRAINT uq_projects_domain UNIQUE (domain)` to `projects` table in `backend/database/schema.sql`.
  - Added migration in `backend/database/migrate.js` to deduplicate existing duplicate domains using window functions (keeping oldest unchanged and suffixing the rest) and enforce `uq_projects_domain`.
  - Defined `RESERVED_SLUGS` and implemented `allocateDomain(client, baseSlug, excludeProjectId)` in `backend/routes/projects.js` to reject reserved names (`api`, `www`, `admin`, `app`, `dashboard`, `status`, `health`, `auth`, `login`, `static`, `deployforge`) and sequentially assign unique suffixed subdomains (`-2`, `-3`, ...) on collision.
  - Wired `allocateDomain` and reserved slug validation into `POST /api/projects` and `PATCH /api/projects/:id` wrapped in database transactions.
  - Hardened Nginx dynamic config generator in `backend/services/proxyRouter.js` to generate collision-free upstream block names hashed by project ID (`upstream_df_${safeProjectIdShort}_${port}`) rather than project name.
  - Updated upstream assertions in `backend/tests/health_and_routing.test.js` and `backend/tests/phase_c_integration.test.js`.
  - Added dedicated test suite `backend/tests/domain_allocation.test.js` covering reserved slug rejection, cross-tenant domain allocation collision avoidance, renaming reallocation, and collision-free Nginx upstreams.
  - Appended `tests/domain_allocation.test.js` to `backend/package.json` `scripts.test`.
- **Files touched:**
  - `backend/database/schema.sql`
  - `backend/database/migrate.js`
  - `backend/routes/projects.js`
  - `backend/services/proxyRouter.js`
  - `backend/package.json`
  - `backend/tests/domain_allocation.test.js`
  - `backend/tests/health_and_routing.test.js`
  - `backend/tests/phase_c_integration.test.js`
  - `docs/PROGRESS.md`
- **Tests added / updated:**
  - `backend/tests/domain_allocation.test.js`: 4 tests (reserved slug 400 rejection across all reserved names, two tenants creating same project name receiving distinct suffixed domains, renaming with collision handling and reserved validation, and Nginx upstream generator collision-free hashing).
  - `backend/tests/health_and_routing.test.js`: updated upstream block and proxy_pass assertions to match `upstream_df_proj123_8080`.
  - `backend/tests/phase_c_integration.test.js`: updated upstream block and proxy_pass assertions to match `upstream_df_${expectedShortId}_3000`.
- **Verification result:** VERIFIED — Migrations applied cleanly; all 19 backend test files passed (100%); 28 C++ worker tests passed; frontend build succeeded; git working tree clean of test runtime debris.
- **Anything deferred:** None.

### F-01: Align C++ worker deployment event envelope with persistence consumer
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - C++ `publishEvent` now wraps deployment payload into a JSON object (`nlohmann::json`) and emits canonical envelope fields (`event_type`, `aggregate_id`, `payload`, `created_at`).
  - Added `duration_seconds` measurement to `WorkerDaemon::processSingleJob` on completion/failure and passed `durationSeconds` to `publishEvent`.
  - Hardened `backend/workers/persistenceWorker.js` to validate `payload`, route malformed/poison messages to `stream:deployment_events:dlq`, and XACK to prevent PEL poisoning.
  - Added UUID format validation in `applyEventTransaction` to prevent syntax errors in PostgreSQL from invalid/synthetic IDs.
  - Exported `EVENTS_DLQ_STREAM` from `backend/services/deploymentEvents.js` and `backend/workers/persistenceWorker.js`.
  - Added dedicated test suite `backend/tests/event_envelope.test.js` validating dead-lettering of flat legacy events, parsing of envelope events, and `DEPLOYMENT_COMPLETED` persistence with duration and container ID.
  - Updated `worker/tests/test_runner.cpp` to verify envelope fields and inner payload JSON attributes, and isolated test worker runs to dedicated test streams.
  - Appended `tests/event_envelope.test.js` to `backend/package.json` `scripts.test`.
- **Files touched:**
  - `backend/services/deploymentEvents.js`
  - `backend/workers/persistenceWorker.js`
  - `backend/package.json`
  - `backend/tests/event_envelope.test.js`
  - `worker/include/redis_client.hpp`
  - `worker/src/redis_client.cpp`
  - `worker/src/worker.cpp`
  - `worker/tests/test_runner.cpp`
  - `docs/PROGRESS.md`
- **Tests added / updated:**
  - `backend/tests/event_envelope.test.js`: 3 tests (graceful rejection and DLQ routing of flat payloadless events with XACK; parsing and DB commit of canonical envelope; and handling of DEPLOYMENT_COMPLETED with duration_seconds and container_id).
  - `worker/tests/test_runner.cpp`: Updated `testRedisClient` with 10 new assertions verifying envelope fields and inner JSON payload keys, and configured `testWorkerLifecycle` with dedicated test streams (38/38 C++ tests passing).
- **Verification result:** VERIFIED — 38/38 C++ tests passing, 20/20 backend test suites passing, frontend Vite build clean.
- **Anything deferred:** None.

### F-02: Harden C++ Docker build and start path and job validation (S-07)
- **Status:** DONE
- **Evidence:** VERIFIED
- **What changed:**
  - Eliminated `popen` shell pipe in `DockerClient::buildImage` and replaced with `ProcessRunner::executeCommand` running `docker build -t <image> <ctx>` directly with an argv array, preventing shell injection (S-07) and checking build exit codes.
  - Added `isValidImageName` validation regex `^[a-z0-9][a-z0-9_.-]{0,127}(:[A-Za-z0-9_.-]{1,128})?$`.
  - Made `DockerClient` HTTP client status-aware with status line parsing, chunked transfer decoding (`Transfer-Encoding: chunked`), and non-2xx throwing.
  - Enforced `startContainer` return check in `WorkerDaemon::processSingleJob`, failing deployment if start fails instead of falsely reporting RUNNING.
  - Implemented `WorkerDaemon::validateJob` (S-07) validating UUIDs, project name slug, port (1-65535), and repo/branch injection metacharacter safety, rejecting invalid jobs immediately as `FAILED` without spawning processes.
- **Files touched:**
  - `worker/include/docker_client.hpp`
  - `worker/src/docker_client.cpp`
  - `worker/include/worker.hpp`
  - `worker/src/worker.cpp`
  - `worker/tests/test_runner.cpp`
  - `docs/PROGRESS.md`
- **Tests added / updated:**
  - 23 new test assertions in `worker/tests/test_runner.cpp` covering image name validation, chunked decoding, HTTP status parsing (200, 204, 400, 500), job field injection rejection, and startContainer failure handling (61/61 total).
- **Verification result:** VERIFIED — 61/61 C++ tests passing, 20/20 backend test suites passing, frontend Vite build clean.
- **Anything deferred:** None.
