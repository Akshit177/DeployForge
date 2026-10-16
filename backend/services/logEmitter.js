const EventEmitter = require("events");
const pool = require("../config/db.js");
const redis = require("../config/redis.js");

class LogEmitter extends EventEmitter {}

const emitter = new LogEmitter();
// Allow multiple listeners per deployment or project
emitter.setMaxListeners(100);

function emitDeploymentLog(deploymentId, logEntry) {
  if (deploymentId) {
    emitter.emit(`deployment:${deploymentId}`, logEntry);
    if (redis && (redis.status === "ready" || redis.status === "connecting")) {
      redis.publish(`logs:${deploymentId}`, JSON.stringify(logEntry)).catch(() => {});
    }
  }
  if (logEntry && logEntry.project_id) {
    emitter.emit(`project:${logEntry.project_id}`, logEntry);
    if (redis && (redis.status === "ready" || redis.status === "connecting")) {
      redis.publish(`project:${logEntry.project_id}`, JSON.stringify(logEntry)).catch(() => {});
    }
  }
}

async function recordWorkerLog(deploymentId, projectId, userId, level, source, message) {
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
      user_id: row.user_id,
      level: row.level,
      source: row.source,
      text: row.message,
      message: row.message,
      time: timeStr,
      created_at: row.created_at,
    });
    return row;
  } catch (err) {
    console.warn("Log recording warning:", err.message);
    return null;
  }
}

function subscribeToDeploymentLogs(deploymentId, callback) {
  const channel = `deployment:${deploymentId}`;
  emitter.on(channel, callback);
  return () => emitter.removeListener(channel, callback);
}

function subscribeToProjectLogs(projectId, callback) {
  const channel = `project:${projectId}`;
  emitter.on(channel, callback);
  return () => emitter.removeListener(channel, callback);
}

module.exports = {
  emitDeploymentLog,
  recordWorkerLog,
  recordLog: recordWorkerLog,
  subscribeToDeploymentLogs,
  subscribeToProjectLogs,
};
