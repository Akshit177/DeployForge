const express = require("express");
const pool = require("../config/db.js");
const { authenticateToken } = require("../middleware/auth.js");
const { emitDeploymentLog } = require("../services/logEmitter.js");
const { publishDeploymentJob, getQueueMetrics } = require("../services/queue.js");
const { triggerOutboxRelay } = require("../services/outboxRelay.js");

const router = express.Router();

async function recordLog(deploymentId, projectId, userId, level, source, message) {
  try {
    const res = await pool.query(
      `INSERT INTO logs (deployment_id, project_id, user_id, level, source, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [deploymentId, projectId, userId, level, source, message]
    );
    const row = res.rows[0];
    const d = new Date(row.created_at);
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    emitDeploymentLog(deploymentId, {
      id: row.id,
      deployment_id: row.deployment_id,
      project_id: row.project_id,
      level: row.level,
      source: row.source,
      text: row.message,
      message: row.message,
      time: timeStr,
      created_at: row.created_at,
    });
  } catch (err) {
    console.warn("Could not record log:", err.message);
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_STATUSES = [
  "Queued",
  "Building",
  "Deploying",
  "Running",
  "Failed",
  "Cancelled",
  "Stopped",
  "Succeeded",
];

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatDeployment(d) {
  const numStr = String(d.deployment_number || 1);
  const status = d.status === "Succeeded" ? "Running" : d.status || "Queued";
  const displayState = status === "Running" ? "Succeeded" : status;

  return {
    id: d.id,
    num: numStr,
    deployment_number: d.deployment_number,
    display_id: `#${numStr}`,
    project_id: d.project_id,
    project: d.project_name || "unknown",
    projectName: d.project_name || "unknown",
    repo: d.repository_url || "",
    repository_url: d.repository_url || "",
    runtime: d.runtime || "node",
    message: d.commit_message || "Deploy latest changes",
    commit: (d.commit_hash || "HEAD").slice(0, 7),
    commit_hash: d.commit_hash || "HEAD",
    branch: d.branch || "main",
    status: status,
    state: displayState,
    trigger: d.trigger || "manual",
    environment: d.environment || "production",
    url: d.url || d.project_domain || "",
    duration_seconds: d.duration_seconds || 0,
    duration: formatDuration(d.duration_seconds),
    serving: status === "Running",
    container_id: d.container_id || null,
    error_message: d.error_message || null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

router.use(authenticateToken);

// GET /api/deployments/queue/status - Redis Streams queue metrics
router.get("/queue/status", async (req, res) => {
  try {
    const metrics = await getQueueMetrics();
    return res.status(200).json(metrics);
  } catch (error) {
    return res.status(500).json({ message: "Unable to retrieve queue metrics." });
  }
});

// GET /api/deployments - List user's deployments with optional filters
router.get("/", async (req, res) => {
  const { project_id, status, limit = 50, offset = 0 } = req.query;

  try {
    const params = [req.user.id];
    let query = `
      SELECT
        d.*,
        p.name AS project_name,
        p.repository_url,
        p.runtime,
        p.domain AS project_domain
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE d.user_id = $1
    `;

    if (project_id) {
      if (!UUID_REGEX.test(project_id)) {
        return res.status(400).json({ message: "Invalid project_id format." });
      }
      params.push(project_id);
      query += ` AND d.project_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      query += ` AND d.status = $${params.length}`;
    }

    params.push(Number.parseInt(limit, 10) || 50);
    params.push(Number.parseInt(offset, 10) || 0);
    query += ` ORDER BY d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(query, params);
    const deployments = result.rows.map(formatDeployment);

    return res.status(200).json({
      deployments,
      count: deployments.length,
    });
  } catch (error) {
    console.error("Failed to list deployments:", error);
    return res.status(500).json({ message: "Unable to retrieve deployments right now." });
  }
});

// POST /api/deployments - Trigger/queue a new deployment via Transactional Outbox
router.post("/", async (req, res) => {
  const {
    project_id,
    branch,
    commit_hash = "HEAD",
    commit_message = "Deploy latest changes",
    environment = "production",
    trigger = "manual",
  } = req.body;

  if (!project_id || !UUID_REGEX.test(project_id)) {
    return res.status(400).json({ message: "A valid project_id is required." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify user owns the project
    const projectRes = await client.query(
      `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
      [project_id, req.user.id]
    );

    if (projectRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Project not found or unauthorized." });
    }

    const project = projectRes.rows[0];
    const deployBranch = branch ? String(branch).trim() : project.branch;
    const deployCommit = String(commit_hash).trim() || project.latest_commit || "HEAD";
    const deployMessage = String(commit_message).trim() || "Deploy latest changes";
    const deployEnv = String(environment).trim() || "production";
    const deployTrigger = String(trigger).trim() || "manual";

    const insertResult = await client.query(
      `INSERT INTO deployments (
        project_id, user_id, commit_hash, commit_message, branch, status, trigger, environment, url
      ) VALUES ($1, $2, $3, $4, $5, 'INITIATED', $6, $7, $8)
      RETURNING *`,
      [
        project.id,
        req.user.id,
        deployCommit,
        deployMessage,
        deployBranch,
        deployTrigger,
        deployEnv,
        project.domain,
      ]
    );

    const newDeploy = insertResult.rows[0];

    // Atomically update project state to INITIATED
    await client.query(
      `UPDATE projects
       SET status = 'INITIATED', latest_commit = $1, updated_at = NOW()
       WHERE id = $2`,
      [deployCommit, project.id]
    );

    // Atomically insert Outbox Event (guaranteed delivery to Redis)
    const outboxPayload = {
      deployment_id: newDeploy.id,
      project_id: project.id,
      user_id: req.user.id,
      repo_url: project.repository_url,
      branch: deployBranch,
      commit_hash: deployCommit,
      runtime: project.runtime,
      port: project.port,
      trigger: deployTrigger,
      deployment_number: newDeploy.deployment_number,
    };

    await client.query(
      `INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, status
      ) VALUES ('DEPLOYMENT', $1, 'DEPLOYMENT_INITIATED', $2::jsonb, 'PENDING')`,
      [newDeploy.id, JSON.stringify(outboxPayload)]
    );

    await client.query("COMMIT");

    // Immediate post-commit trigger for sub-millisecond dispatch
    triggerOutboxRelay();

    recordLog(
      newDeploy.id,
      project.id,
      req.user.id,
      "INFO",
      "system",
      `Deployment #${newDeploy.deployment_number} initiated (${deployBranch} · ${deployCommit.slice(0, 7)})`
    ).catch(() => {});

    return res.status(201).json({
      message: `Deployment #${newDeploy.deployment_number} queued successfully.`,
      deployment: formatDeployment({
        ...newDeploy,
        project_name: project.name,
        repository_url: project.repository_url,
        runtime: project.runtime,
        project_domain: project.domain,
      }),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to trigger deployment:", error);
    return res.status(500).json({ message: "Unable to trigger deployment right now." });
  } finally {
    client.release();
  }
});

// GET /api/deployments/:id - Get deployment details
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const isUuid = UUID_REGEX.test(id);
  const isNumber = /^\d+$/.test(id);

  if (!isUuid && !isNumber) {
    return res.status(400).json({ message: "Invalid deployment ID format." });
  }

  try {
    const query = `
      SELECT
        d.*,
        p.name AS project_name,
        p.repository_url,
        p.runtime,
        p.domain AS project_domain
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE ${isUuid ? "d.id = $1" : "d.deployment_number = $1"} AND d.user_id = $2
    `;

    const result = await pool.query(query, [id, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Deployment not found." });
    }

    return res.status(200).json({
      deployment: formatDeployment(result.rows[0]),
    });
  } catch (error) {
    console.error("Failed to fetch deployment:", error);
    return res.status(500).json({ message: "Unable to retrieve deployment." });
  }
});

// PATCH /api/deployments/:id/status - Update deployment status lifecycle
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status, duration_seconds, error_message, container_id, url } = req.body;

  if (!UUID_REGEX.test(id) && !/^\d+$/.test(id)) {
    return res.status(400).json({ message: "Invalid deployment ID format." });
  }

  if (!status || !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({
      message: `Invalid status. Must be one of: ${ALLOWED_STATUSES.join(", ")}`,
    });
  }

  try {
    // Check ownership
    const checkQuery = `
      SELECT d.*, p.id AS project_id
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE ${UUID_REGEX.test(id) ? "d.id = $1" : "d.deployment_number = $1"} AND d.user_id = $2
    `;
    const check = await pool.query(checkQuery, [id, req.user.id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Deployment not found." });
    }

    const current = check.rows[0];
    const newDuration = duration_seconds !== undefined ? Number(duration_seconds) : current.duration_seconds;
    const newError = error_message !== undefined ? error_message : current.error_message;
    const newContainer = container_id !== undefined ? container_id : current.container_id;
    const newUrl = url !== undefined ? url : current.url;

    const updateRes = await pool.query(
      `UPDATE deployments
       SET status = $1,
           duration_seconds = $2,
           error_message = $3,
           container_id = $4,
           url = $5,
           updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [status, newDuration, newError, newContainer, newUrl, current.id]
    );

    // Sync project status with the deployment state
    const normalizedProjectStatus =
      status === "Succeeded" ? "Running" : status === "Cancelled" ? "Failed" : status;
    await pool.query(
      `UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2`,
      [normalizedProjectStatus, current.project_id]
    );

    const updated = updateRes.rows[0];

    const logMsg =
      status === "Building"
        ? "Build worker allocated. Cloning repo and running Docker build..."
        : status === "Deploying"
        ? "Docker build succeeded. Spawning isolated container and routing Nginx..."
        : status === "Running" || status === "Succeeded"
        ? `Deployment #${updated.deployment_number} is healthy and serving live traffic at https://${updated.url || check.rows[0].project_domain}`
        : status === "Failed"
        ? `Deployment failed: ${newError || "Unknown build error"}`
        : `Deployment status changed to ${status}`;

    await recordLog(
      current.id,
      current.project_id,
      req.user.id,
      status === "Failed" ? "ERROR" : status === "Building" ? "STEP" : "INFO",
      status === "Running" ? "deploy" : "build",
      logMsg
    );

    return res.status(200).json({
      message: `Deployment #${updated.deployment_number} transitioned to ${status}.`,
      deployment: formatDeployment({
        ...updated,
        project_name: check.rows[0].project_name,
        repository_url: check.rows[0].repository_url,
        runtime: check.rows[0].runtime,
        project_domain: check.rows[0].project_domain,
      }),
    });
  } catch (error) {
    console.error("Failed to update deployment status:", error);
    return res.status(500).json({ message: "Unable to update deployment status." });
  }
});

// POST /api/deployments/:id/cancel - Cancel active or queued deployment
router.post("/:id/cancel", async (req, res) => {
  const { id } = req.params;

  if (!UUID_REGEX.test(id) && !/^\d+$/.test(id)) {
    return res.status(400).json({ message: "Invalid deployment ID format." });
  }

  try {
    const checkQuery = `
      SELECT d.*, p.id AS project_id
      FROM deployments d
      JOIN projects p ON d.project_id = p.id
      WHERE ${UUID_REGEX.test(id) ? "d.id = $1" : "d.deployment_number = $1"} AND d.user_id = $2
    `;
    const check = await pool.query(checkQuery, [id, req.user.id]);

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Deployment not found." });
    }

    const current = check.rows[0];
    const normStatus = (current.status || "").toUpperCase();
    if (normStatus === "RUNNING" || normStatus === "FAILED" || normStatus === "CANCELLED" || normStatus === "STOPPED") {
      return res.status(400).json({
        message: `Deployment cannot be cancelled because its current status is "${current.status}".`,
      });
    }

    const cancelRes = await pool.query(
      `UPDATE deployments
       SET status = 'Cancelled', error_message = 'Deployment cancelled by user.', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [current.id]
    );

    await pool.query(
      `UPDATE projects SET status = 'Stopped', updated_at = NOW() WHERE id = $1`,
      [current.project_id]
    );

    await recordLog(
      current.id,
      current.project_id,
      req.user.id,
      "WARN",
      "system",
      `Deployment #${cancelRes.rows[0].deployment_number} was cancelled by user.`
    );

    return res.status(200).json({
      message: `Deployment #${cancelRes.rows[0].deployment_number} has been cancelled.`,
      deployment: formatDeployment(cancelRes.rows[0]),
    });
  } catch (error) {
    console.error("Failed to cancel deployment:", error);
    return res.status(500).json({ message: "Unable to cancel deployment." });
  }
});

module.exports = router;
