const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Validate that a deploymentId is a clean identifier (prevents path traversal)
 * @param {string} deploymentId
 * @returns {boolean}
 */
function isValidDeploymentId(deploymentId) {
  if (!deploymentId || typeof deploymentId !== "string") return false;
  // Allow UUIDs, alphanumeric, hyphens, and underscores only
  return /^[a-zA-Z0-9_-]+$/.test(deploymentId.trim());
}

/**
 * Get or determine the base workspace storage directory
 * @returns {string}
 */
function getBaseWorkspacePath() {
  const configured = process.env.WORKSPACE_BASE_PATH;
  if (configured) {
    try {
      if (!fs.existsSync(configured)) {
        fs.mkdirSync(configured, { recursive: true });
      }
      return configured;
    } catch (err) {
      // If configured path is not writable (e.g. /var/lib on macOS dev), fallback
    }
  }

  // Local fallback directory
  const fallback = path.join(os.homedir(), ".deployforge", "workspaces");
  if (!fs.existsSync(fallback)) {
    fs.mkdirSync(fallback, { recursive: true });
  }
  return fallback;
}

/**
 * Get the isolated workspace directory for a specific deployment
 * @param {string} deploymentId
 * @returns {string} Absolute path to workspace directory
 */
function getWorkspacePath(deploymentId) {
  if (!isValidDeploymentId(deploymentId)) {
    throw new Error(`Invalid deploymentId '${deploymentId}': must be alphanumeric with hyphens or underscores only`);
  }

  const basePath = getBaseWorkspacePath();
  const workspacePath = path.resolve(basePath, deploymentId.trim());

  // Ensure workspacePath is strictly inside basePath
  if (!workspacePath.startsWith(path.resolve(basePath))) {
    throw new Error(`Security violation: Workspace path traversal detected for deployment '${deploymentId}'`);
  }

  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  return workspacePath;
}

/**
 * Remove an isolated workspace directory
 * @param {string} workspacePath
 * @returns {boolean}
 */
function cleanupWorkspace(workspacePath) {
  try {
    if (workspacePath && fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`Failed to cleanup workspace '${workspacePath}':`, err.message);
    return false;
  }
}

/**
 * Detect runtime and build requirements for a cloned repository workspace.
 * Strict Dockerfile Policy: DeployForge requires every repository to supply a root Dockerfile.
 * @param {string} workspacePath
 * @returns {object} Runtime detection metadata
 */
function detectRuntime(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: '${workspacePath}'`);
  }

  const dockerfilePath = path.join(workspacePath, "Dockerfile");
  if (fs.existsSync(dockerfilePath)) {
    return {
      runtime: "dockerfile",
      hasCustomDockerfile: true,
      dockerfilePath,
      detectedPort: null,
    };
  }

  throw new Error(
    "No root Dockerfile found in repository. DeployForge requires every repository to provide a valid Dockerfile in its root directory."
  );
}

/**
 * Ensure Dockerfile is ready in workspace
 * @param {string} workspacePath
 * @param {object} runtimeInfo
 * @returns {string} Absolute path to Dockerfile
 */
function prepareWorkspaceDockerfile(workspacePath, runtimeInfo) {
  const customPath = path.join(workspacePath, "Dockerfile");
  if (!fs.existsSync(customPath)) {
    throw new Error(`Expected root Dockerfile at '${customPath}', but file was not found.`);
  }
  return customPath;
}

module.exports = {
  isValidDeploymentId,
  getBaseWorkspacePath,
  getWorkspacePath,
  cleanupWorkspace,
  detectRuntime,
  prepareWorkspaceDockerfile,
};
