const Docker = require("dockerode");
const tar = require("tar-fs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Log prominent warning if running in simulator mode in production.
 * Do not throw — DeployForge is an educational platform.
 */
if (
  process.env.NODE_ENV === "production" &&
  (process.env.DOCKER_MODE || "simulator").toLowerCase() !== "real"
) {
  console.warn(
    "\n================================================================================" +
      "\n⚠️  [DeployForge WARNING] DOCKER_MODE is not set to 'real' in production!" +
      "\n   Running in 'simulator' mode. Container virtualization will be simulated." +
      "\n================================================================================\n"
  );
}

/**
 * Utility helper to sleep for a specified duration in milliseconds
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve Docker connection configuration based on environment and system paths:
 * 1. process.env.DOCKER_HOST (if set)
 * 2. /var/run/docker.sock
 * 3. $HOME/.docker/run/docker.sock (macOS Docker Desktop)
 * @returns {object} Dockerode connection options
 */
function resolveDockerConfig() {
  if (process.env.DOCKER_HOST) {
    if (process.env.DOCKER_HOST.startsWith("unix://")) {
      return { socketPath: process.env.DOCKER_HOST.replace("unix://", "") };
    }
    return {}; // Let Dockerode parse TCP/HTTP host from process.env.DOCKER_HOST
  }

  const defaultSock = "/var/run/docker.sock";
  const macSock = path.join(os.homedir(), ".docker", "run", "docker.sock");

  if (fs.existsSync(defaultSock)) {
    return { socketPath: defaultSock };
  }
  if (fs.existsSync(macSock)) {
    return { socketPath: macSock };
  }
  return { socketPath: defaultSock };
}

let dockerInstance = null;

/**
 * Get or initialize Dockerode instance
 * @returns {Docker}
 */
function getDocker() {
  const config = resolveDockerConfig();
  if (!dockerInstance) {
    dockerInstance = new Docker(config);
  } else if (
    !process.env.DOCKER_HOST &&
    dockerInstance.modem &&
    dockerInstance.modem.socketPath === "/var/run/docker.sock" &&
    !fs.existsSync("/var/run/docker.sock") &&
    config.socketPath !== "/var/run/docker.sock"
  ) {
    dockerInstance = new Docker(config);
  }
  return dockerInstance;
}

/**
 * Get the current execution mode
 * @returns {'real'|'simulator'}
 */
function getMode() {
  return (process.env.DOCKER_MODE || "simulator").toLowerCase() === "real"
    ? "real"
    : "simulator";
}

/**
 * Check if Docker daemon is reachable
 * Real: docker.ping()
 * Simulator: always returns true
 * @returns {Promise<boolean>}
 */
async function isDockerAvailable() {
  if (getMode() === "simulator") {
    return true;
  }

  try {
    const docker = getDocker();
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a Docker image from a directory containing a Dockerfile
 * @param {string} contextPath - absolute path to build context directory
 * @param {string} imageName - tag for the built image (e.g., 'deployforge-app-<deployment_id>')
 * @param {object} [options] - { dockerfile: 'Dockerfile' }
 * @returns {Promise<{ imageId: string, imageName: string }>}
 *
 * Real: docker.buildImage() with tar stream of contextPath, follow build output
 * Simulator: sleep 200ms, return { imageId: 'sim_img_<random>', imageName }
 */
async function buildImage(contextPath, imageName, options = {}) {
  if (getMode() === "simulator") {
    await sleep(200);
    const randomHex = crypto.randomBytes(6).toString("hex");
    return {
      imageId: `sim_img_${randomHex}`,
      imageName,
    };
  }

  try {
    const docker = getDocker();
    const tarStream = tar.pack(contextPath);
    const dockerfile = options.dockerfile || "Dockerfile";

    const stream = await docker.buildImage(tarStream, {
      t: imageName,
      dockerfile,
    });

    const output = await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, res) => {
        if (err) return reject(err);

        if (Array.isArray(res)) {
          for (const entry of res) {
            if (entry && (entry.error || entry.errorDetail)) {
              const errMsg =
                entry.error ||
                (entry.errorDetail && entry.errorDetail.message) ||
                "Docker image build failed";
              return reject(new Error(errMsg));
            }
          }
        }
        resolve(res);
      });
    });

    let imageId = imageName;
    if (Array.isArray(output)) {
      for (let i = output.length - 1; i >= 0; i--) {
        const item = output[i];
        if (item && item.aux && item.aux.ID) {
          imageId = item.aux.ID;
          break;
        }
      }
    }

    return {
      imageId,
      imageName,
    };
  } catch (err) {
    throw new Error(`Failed to build Docker image '${imageName}': ${err.message}`);
  }
}

/**
 * Create and optionally start a container
 * @param {object} config
 * @param {string} config.imageName - image to use
 * @param {string} config.containerName - name for the container (e.g., 'df-<deployment_id_short>')
 * @param {number} config.containerPort - internal port the app listens on
 * @param {object} [config.env] - environment variables as { KEY: 'value' }
 * @param {string} [config.networkName] - Docker network to connect to
 * @param {object} [config.resourceLimits] - { memoryMB: 512, cpuShares: 256, pidsLimit: 100 }
 * @returns {Promise<{ containerId: string, containerName: string }>}
 *
 * Real: docker.createContainer() with:
 *   - ExposedPorts: { '<containerPort>/tcp': {} }
 *   - NO HostConfig.PortBindings (no host port mapping — Nginx routes via app network)
 *   - HostConfig.Memory (from resourceLimits.memoryMB * 1024 * 1024)
 *   - HostConfig.CpuShares (from resourceLimits.cpuShares)
 *   - HostConfig.PidsLimit (from resourceLimits.pidsLimit)
 *   - HostConfig.Privileged: false (ALWAYS)
 *   - HostConfig.ReadonlyRootfs: false
 *   - User: '1000:1000' (non-root)
 *   - NetworkingConfig connecting to config.networkName if provided
 * Simulator: sleep 100ms, return { containerId: 'sim_c_<random_12_hex>', containerName }
 */
async function createContainer(config) {
  if (getMode() === "simulator") {
    await sleep(100);
    const randomHex = crypto.randomBytes(6).toString("hex");
    return {
      containerId: `sim_c_${randomHex}`,
      containerName: config.containerName,
    };
  }

  try {
    const docker = getDocker();
    const portKey = `${config.containerPort}/tcp`;

    const hostConfig = {
      Privileged: false,
      ReadonlyRootfs: false,
    };

    if (config.resourceLimits) {
      if (config.resourceLimits.memoryMB) {
        hostConfig.Memory = config.resourceLimits.memoryMB * 1024 * 1024;
      }
      if (config.resourceLimits.cpuShares) {
        hostConfig.CpuShares = config.resourceLimits.cpuShares;
      }
      if (config.resourceLimits.pidsLimit) {
        hostConfig.PidsLimit = config.resourceLimits.pidsLimit;
      }
    }

    let envList = [];
    if (config.env) {
      if (Array.isArray(config.env)) {
        envList = config.env;
      } else if (typeof config.env === "object") {
        envList = Object.entries(config.env).map(([k, v]) => `${k}=${v}`);
      }
    }

    const containerOptions = {
      Image: config.imageName,
      name: config.containerName,
      User: "1000:1000",
      ExposedPorts: {
        [portKey]: {},
      },
      HostConfig: hostConfig,
      Env: envList,
    };

    if (config.networkName) {
      containerOptions.NetworkingConfig = {
        EndpointsConfig: {
          [config.networkName]: {},
        },
      };
    }

    const container = await docker.createContainer(containerOptions);

    return {
      containerId: container.id,
      containerName: config.containerName,
    };
  } catch (err) {
    throw new Error(`Failed to create container '${config.containerName}': ${err.message}`);
  }
}

/**
 * Start a created container
 * @param {string} containerId
 * @returns {Promise<{ started: boolean }>}
 *
 * Real: container.start()
 * Simulator: sleep 100ms, return { started: true }
 */
async function startContainer(containerId) {
  if (getMode() === "simulator") {
    await sleep(100);
    return { started: true };
  }

  try {
    const docker = getDocker();
    const container = docker.getContainer(containerId);
    await container.start();
    return { started: true };
  } catch (err) {
    throw new Error(`Failed to start container '${containerId}': ${err.message}`);
  }
}

/**
 * Inspect a running container
 * @param {string} containerId
 * @returns {Promise<{ state: string, running: boolean, ports: object, networkIp: string|null }>}
 *
 * Real: container.inspect() — extract State.Status, State.Running,
 *       NetworkSettings.Networks[networkName].IPAddress
 * Simulator: return { state: 'running', running: true, ports: {}, networkIp: '172.20.0.' + random }
 */
async function inspectContainer(containerId) {
  if (getMode() === "simulator") {
    await sleep(50);
    const randomHost = Math.floor(Math.random() * 200) + 2;
    return {
      state: "running",
      running: true,
      ports: {},
      networkIp: `172.20.0.${randomHost}`,
    };
  }

  try {
    const docker = getDocker();
    const container = docker.getContainer(containerId);
    const data = await container.inspect();

    const state = data.State ? data.State.Status : "unknown";
    const running = data.State ? Boolean(data.State.Running) : false;
    const ports = (data.NetworkSettings && data.NetworkSettings.Ports) || {};

    let networkIp = null;
    if (data.NetworkSettings && data.NetworkSettings.Networks) {
      for (const netKey of Object.keys(data.NetworkSettings.Networks)) {
        const net = data.NetworkSettings.Networks[netKey];
        if (net && net.IPAddress) {
          networkIp = net.IPAddress;
          break;
        }
      }
    }

    if (!networkIp && data.NetworkSettings && data.NetworkSettings.IPAddress) {
      networkIp = data.NetworkSettings.IPAddress;
    }

    return {
      state,
      running,
      ports,
      networkIp,
    };
  } catch (err) {
    throw new Error(`Failed to inspect container '${containerId}': ${err.message}`);
  }
}

/**
 * Stop a running container
 * @param {string} containerId
 * @param {number} [timeoutSec=10]
 * @returns {Promise<{ stopped: boolean }>}
 *
 * Real: container.stop({ t: timeoutSec })
 * Simulator: sleep 50ms, return { stopped: true }
 */
async function stopContainer(containerId, timeoutSec = 10) {
  if (getMode() === "simulator") {
    await sleep(50);
    return { stopped: true };
  }

  try {
    const docker = getDocker();
    const container = docker.getContainer(containerId);
    await container.stop({ t: timeoutSec });
    return { stopped: true };
  } catch (err) {
    if (err.statusCode === 304) {
      return { stopped: true };
    }
    throw new Error(`Failed to stop container '${containerId}': ${err.message}`);
  }
}

/**
 * Remove a container (must be stopped first)
 * @param {string} containerId
 * @param {object} [options] - { force: false, removeVolumes: true }
 * @returns {Promise<{ removed: boolean }>}
 *
 * Real: container.remove({ force, v: removeVolumes })
 * Simulator: sleep 50ms, return { removed: true }
 */
async function removeContainer(containerId, options = {}) {
  if (getMode() === "simulator") {
    await sleep(50);
    return { removed: true };
  }

  try {
    const docker = getDocker();
    const container = docker.getContainer(containerId);
    await container.remove({
      force: options.force || false,
      v: options.removeVolumes !== undefined ? options.removeVolumes : true,
    });
    return { removed: true };
  } catch (err) {
    throw new Error(`Failed to remove container '${containerId}': ${err.message}`);
  }
}

module.exports = {
  isDockerAvailable,
  buildImage,
  createContainer,
  startContainer,
  inspectContainer,
  stopContainer,
  removeContainer,
  getMode,
};
