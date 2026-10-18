const http = require("http");
const net = require("net");
const pool = require("../config/db.js");
const { recordWorkerLog } = require("./logEmitter.js");
const { getMode } = require("./dockerClient.js");

/**
 * Checks TCP socket or HTTP connectivity for a container port.
 * Supports realistic simulation when in simulator mode, and strict real probing in real mode.
 */
async function probeContainerEndpoint({ host = "127.0.0.1", port = 3000, path = "/", timeoutMs = 2000 }) {
  const startTime = Date.now();

  return new Promise((resolve) => {
    // Attempt real HTTP request
    const req = http.get(
      {
        host,
        port,
        path,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // discard the body so the socket is released
        const latencyMs = Date.now() - startTime;
        resolve({
          healthy: res.statusCode >= 200 && res.statusCode < 400,
          statusCode: res.statusCode,
          latencyMs,
          method: "HTTP",
          host,
          port,
          timestamp: new Date().toISOString(),
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      const isSimFail =
        host.includes("fail") ||
        host.includes("unhealthy") ||
        host.includes("crash") ||
        host.includes("stopped");

      // In real Docker mode or simulated failure, failure to reach container must report as unhealthy
      if (getMode() === "real" || isSimFail) {
        return resolve({
          healthy: false,
          statusCode: 504,
          latencyMs: timeoutMs,
          method: "HTTP",
          host,
          port,
          error: "Health check probe timed out",
          timestamp: new Date().toISOString(),
        });
      }

      // In local simulator mode for normal containers, return simulated healthy container response
      const latencyMs = Math.floor(Math.random() * 8) + 2;
      resolve({
        healthy: true,
        statusCode: 200,
        latencyMs,
        simulated: true,
        host,
        port,
        timestamp: new Date().toISOString(),
      });
    });

    req.on("error", (err) => {
      const isSimFail =
        host.includes("fail") ||
        host.includes("unhealthy") ||
        host.includes("crash") ||
        host.includes("stopped");

      // In real Docker mode or simulated failure, network error must report as unhealthy
      if (getMode() === "real" || isSimFail) {
        return resolve({
          healthy: false,
          statusCode: 502,
          latencyMs: Date.now() - startTime,
          method: "HTTP",
          host,
          port,
          error: err.message,
          timestamp: new Date().toISOString(),
        });
      }

      // In local simulator mode for normal containers, return simulated healthy container response
      const latencyMs = Math.floor(Math.random() * 8) + 2;
      resolve({
        healthy: true,
        statusCode: 200,
        latencyMs,
        simulated: true,
        host,
        port,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

/**
 * Run a full health probe against a project's active deployment
 */
async function checkProjectHealth(projectId, userId) {
  const result = await pool.query(
    `SELECT p.id, p.name, p.domain, p.port, p.status AS project_status,
            d.id AS deployment_id, d.container_id, d.container_name, d.status AS deployment_status, d.duration_seconds
     FROM projects p
     LEFT JOIN deployments d ON d.project_id = p.id AND UPPER(d.status) = 'RUNNING'
     WHERE p.id = $1 AND p.user_id = $2
     ORDER BY d.created_at DESC
     LIMIT 1`,
    [projectId, userId]
  );

  if (result.rows.length === 0) {
    return { error: "Project not found", status: 404 };
  }

  const row = result.rows[0];
  const port = row.port || 3000;
  const containerTarget = row.container_name || (row.deployment_id ? `df-${row.deployment_id.replace(/-/g, "").slice(0, 12)}` : null);

  const isStopped =
    (row.project_status || "").toUpperCase() === "STOPPED" ||
    (row.deployment_status || "").toUpperCase() === "STOPPED" ||
    (row.project_status || "").toUpperCase() === "FAILED" ||
    (row.deployment_status || "").toUpperCase() === "FAILED";

  if (isStopped) {
    return {
      project_id: row.id,
      project_name: row.name,
      domain: row.domain,
      port,
      container_id: row.container_id || null,
      container_name: containerTarget,
      status: row.deployment_status || row.project_status || "STOPPED",
      probe: {
        healthy: false,
        status_code: 503,
        latency_ms: 0,
        simulated: getMode() === "simulator",
        error: "No active running deployment found: deployment is stopped or failed",
        timestamp: new Date().toISOString(),
      },
    };
  }

  const host = containerTarget || "127.0.0.1";
  const probe = await probeContainerEndpoint({ host, port });

  return {
    project_id: row.id,
    project_name: row.name,
    domain: row.domain,
    port,
    container_id: row.container_id || (row.deployment_id ? `c_${row.deployment_id.replace(/-/g, "").slice(0, 12)}` : null),
    container_name: containerTarget,
    status: row.deployment_status || row.project_status,
    probe: {
      healthy: probe.healthy,
      status_code: probe.statusCode,
      latency_ms: probe.latencyMs,
      simulated: Boolean(probe.simulated),
      timestamp: probe.timestamp,
    },
  };
}

module.exports = {
  probeContainerEndpoint,
  checkProjectHealth,
};
