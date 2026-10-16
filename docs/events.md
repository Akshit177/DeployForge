# DeployForge Event & Job Contracts Specification

This document defines the canonical schemas for Redis Streams messages exchanged between the API server, C++ worker daemon, and persistence consumer.

Golden contract JSON fixtures live in `docs/contracts/*.json` and are verified by both the Node test suite (`backend/tests/t01_contract_tests.test.js`) and the C++ test runner (`worker/tests/test_runner.cpp`).

---

## 1. Deployment Jobs (`stream:deployments`)

When an outbox event is relayed, the API pushes a job to `stream:deployments` consumed by the `deployforge_workers` consumer group.

### Stream Field Mapping
Jobs are written as flat key-value pairs in the Redis stream:
- `deployment_id`: UUIDv4 string identifying the deployment run.
- `project_id`: UUIDv4 string of the owning project.
- `user_id`: UUIDv4 string of the project owner.
- `repo_url`: HTTPS repository URL (validated against approved git hosts).
- `branch`: Target git branch (alphanumeric, no leading hyphens or path traversals).
- `commit_hash`: Target git commit SHA (7–40 hexadecimal) or `HEAD`.
- `runtime`: Container runtime environment (`node`, `dockerfile`, etc.).
- `port`: Port string or number exposed by the container (1–65535).
- `trigger`: Deployment trigger mechanism (`manual`, `webhook`, `cli`).
- `domain`: Assigned ingress domain for routing.
- `project_name`: Safe alphanumeric slug of the project.
- `created_at`: ISO-8601 UTC timestamp.

Fixture: [`job_contract.json`](file:///Users/anuragksingh/Desktop/Dev/PBL/PBL_deploy_forge/docs/contracts/job_contract.json)

---

## 2. Deployment Event Envelope (`stream:deployment_events`)

Both C++ worker engine and Node pipeline workers emit canonical event envelopes consumed by the `deployforge_persistence` consumer group.

### Outer Envelope Fields
- `event_type`: Lifecycle event (`STAGE_CHANGED`, `DEPLOYMENT_COMPLETED`, `DEPLOYMENT_FAILED`, `DEPLOYMENT_CANCELLED`).
- `aggregate_id`: Deployment UUID matching the aggregate root.
- `payload`: JSON string containing structured event attributes.
- `created_at`: ISO-8601 UTC timestamp.

### Inner Payload Fields
- `deployment_id`: UUIDv4 string.
- `project_id`: UUIDv4 string.
- `user_id`: UUIDv4 string.
- `status`: Canonical uppercase status (`INITIATED`, `QUEUED`, `CLONING`, `BUILDING`, `STARTING`, `RUNNING`, `FAILED`, `STOPPED`, `CANCELLED`).
- `stage`: Current pipeline stage (`clone`, `build`, `deploy`, `running`, `failed`, `cancelled`).
- `container_id`: Docker container hash / ID.
- `container_name`: Canonical container hostname (`df-<shortId>`).
- `domain`: Ingress FQDN domain name.
- `port`: Exposed container port.
- `duration_seconds`: Measured pipeline execution duration in seconds.
- `commit_hash`: Resolved git commit SHA from workspace.
- `commit_message`: Git commit summary message.
- `error_message`: Error diagnostics (on failure/timeout).
- `timestamp`: ISO-8601 UTC timestamp.

Dead-Letter Queue:
Events missing the `payload` envelope field are rejected and routed to `stream:deployment_events:dlq` and acknowledged to prevent Poison Pill blocking.

Fixture: [`event_envelope_contract.json`](file:///Users/anuragksingh/Desktop/Dev/PBL/PBL_deploy_forge/docs/contracts/event_envelope_contract.json)

---

## 3. Log Stream Envelope (`stream:deployment_events` & Pub/Sub)

Workers emit real-time build and execution logs both to Redis stream (for persistent ingestion) and Redis Pub/Sub channels (for real-time SSE streaming).

### Envelope Fields
- `event_type`: `LOG_EMITTED`
- `aggregate_id`: Deployment UUID.
- `payload`: JSON string containing:
  - `deployment_id`: UUIDv4 string.
  - `project_id`: UUIDv4 string.
  - `user_id`: UUIDv4 string.
  - `level`: Log severity (`INFO`, `WARN`, `ERROR`, `DEBUG`).
  - `source`: Subsystem emitter (`clone`, `build`, `start`, `health`, `docker`).
  - `message`: Human-readable log line.
  - `timestamp`: ISO-8601 UTC timestamp.

### Pub/Sub Distribution Channels
- Deployment stream: `logs:<deployment_id>`
- Project stream: `project:<project_id>`

Fixture: [`log_envelope_contract.json`](file:///Users/anuragksingh/Desktop/Dev/PBL/PBL_deploy_forge/docs/contracts/log_envelope_contract.json)
