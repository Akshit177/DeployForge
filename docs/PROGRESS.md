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

