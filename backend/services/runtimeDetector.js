const fs = require("fs");
const path = require("path");
const os = require("os");

const TEMPLATES_DIR = path.join(__dirname, "../templates");

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
 * Detect runtime and build requirements for a cloned repository workspace
 * @param {string} workspacePath
 * @returns {object} Runtime detection metadata
 */
function detectRuntime(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: '${workspacePath}'`);
  }

  // 1. Check for user-provided Dockerfile
  const dockerfilePath = path.join(workspacePath, "Dockerfile");
  if (fs.existsSync(dockerfilePath)) {
    return {
      runtime: "dockerfile",
      hasCustomDockerfile: true,
      dockerfilePath,
      detectedPort: null,
    };
  }

  // 2. Check for Node.js (package.json)
  const pkgPath = path.join(workspacePath, "package.json");
  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch (parseErr) {
      console.warn("Could not parse package.json:", parseErr.message);
    }

    const startScript = pkg.scripts && pkg.scripts.start;
    const hasServerJs = fs.existsSync(path.join(workspacePath, "server.js"));
    const hasIndexJs = fs.existsSync(path.join(workspacePath, "index.js"));
    const hasAppJs = fs.existsSync(path.join(workspacePath, "app.js"));

    return {
      runtime: "node",
      hasCustomDockerfile: false,
      templateFile: "Dockerfile.node",
      detectedPort: 3000,
      startCommand: startScript ? "npm start" : hasServerJs ? "node server.js" : hasIndexJs ? "node index.js" : hasAppJs ? "node app.js" : "npm start",
    };
  }

  // 3. Check for Static Site (index.html)
  const htmlPath = path.join(workspacePath, "index.html");
  if (fs.existsSync(htmlPath)) {
    return {
      runtime: "static",
      hasCustomDockerfile: false,
      templateFile: "Dockerfile.static",
      detectedPort: 80,
    };
  }

  // 4. Unknown/Unsupported runtime
  throw new Error(
    "Unable to detect project runtime. Please supply a Dockerfile in your repository or ensure standard Node.js (package.json) or static (index.html) files exist."
  );
}

/**
 * Ensure Dockerfile is ready in workspace (either validated user Dockerfile or copied template)
 * @param {string} workspacePath
 * @param {object} runtimeInfo
 * @returns {string} Absolute path to Dockerfile
 */
function prepareWorkspaceDockerfile(workspacePath, runtimeInfo) {
  if (runtimeInfo.hasCustomDockerfile) {
    const customPath = path.join(workspacePath, "Dockerfile");
    if (!fs.existsSync(customPath)) {
      throw new Error(`Expected custom Dockerfile at '${customPath}', but file was not found.`);
    }
    return customPath;
  }

  if (!runtimeInfo.templateFile) {
    throw new Error(`No template file configured for runtime '${runtimeInfo.runtime}'`);
  }

  const templateSource = path.join(TEMPLATES_DIR, runtimeInfo.templateFile);
  if (!fs.existsSync(templateSource)) {
    throw new Error(`Managed template not found: '${templateSource}'`);
  }

  const targetPath = path.join(workspacePath, "Dockerfile");
  fs.copyFileSync(templateSource, targetPath);
  return targetPath;
}

module.exports = {
  isValidDeploymentId,
  getBaseWorkspacePath,
  getWorkspacePath,
  cleanupWorkspace,
  detectRuntime,
  prepareWorkspaceDockerfile,
  TEMPLATES_DIR,
};
