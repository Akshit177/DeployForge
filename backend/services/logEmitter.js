const EventEmitter = require("events");

class LogEmitter extends EventEmitter {}

const emitter = new LogEmitter();
// Allow multiple listeners per deployment or project
emitter.setMaxListeners(100);

function emitDeploymentLog(deploymentId, logEntry) {
  if (deploymentId) {
    emitter.emit(`deployment:${deploymentId}`, logEntry);
  }
  if (logEntry.project_id) {
    emitter.emit(`project:${logEntry.project_id}`, logEntry);
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
  subscribeToDeploymentLogs,
  subscribeToProjectLogs,
};
