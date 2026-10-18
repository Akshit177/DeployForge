const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");
const { getMode } = require("./dockerClient.js");

const execAsync = promisify(exec);

// Path configuration for Nginx files
const NGINX_DIR = path.resolve(__dirname, "../../nginx");
const CONF_D_DIR = path.join(NGINX_DIR, "conf.d");
const UPSTREAMS_CONF_FILE =
  process.env.NGINX_UPSTREAMS_PATH || path.join(CONF_D_DIR, "deployforge-upstreams.conf");
const INGRESS_CONF_FILE = path.join(CONF_D_DIR, "deployforge-ingress.conf");
const BASE_CONF_FILE = path.join(NGINX_DIR, "nginx.conf");

const DEBOUNCE_MS = Number(process.env.NGINX_SYNC_DEBOUNCE_MS) || 150;

const syncStats = {
  totalSyncCalls: 0,
  actualWriteCount: 0,
  actualReloadCount: 0,
};

function getSyncStats() {
  return { ...syncStats };
}

function resetSyncStats() {
  syncStats.totalSyncCalls = 0;
  syncStats.actualWriteCount = 0;
  syncStats.actualReloadCount = 0;
}

/**
 * Ensure Nginx directory structure and base configuration templates exist
 */
function ensureNginxStructure() {
  if (!fs.existsSync(CONF_D_DIR)) {
    fs.mkdirSync(CONF_D_DIR, { recursive: true });
  }

  const mapBlock = `    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }
`;

  // Base nginx.conf
  if (!fs.existsSync(BASE_CONF_FILE)) {
    const baseConfig = `user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;

events {
    worker_connections  1024;
}

http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    tcp_nopush      on;
    tcp_nodelay     on;
    keepalive_timeout  65;
    types_hash_max_size 2048;

    # Include upstream and server definitions
    include /etc/nginx/conf.d/*.conf;
}
`;
    fs.writeFileSync(BASE_CONF_FILE, baseConfig, "utf-8");
  } else {
    try {
      const existing = fs.readFileSync(BASE_CONF_FILE, "utf-8");
      if (!existing.includes("$connection_upgrade")) {
        const updated = existing.replace(
          /(http\s*\{[^\n]*\n)/,
          `$1\n${mapBlock}\n`
        );
        fs.writeFileSync(BASE_CONF_FILE, updated, "utf-8");
      }
    } catch (_) {}
  }

  // Main Ingress reverse proxy configuration (API & Platform)
  if (!fs.existsSync(INGRESS_CONF_FILE)) {
    const ingressConfig = `# ==============================================================================
# DeployForge Ingress Gateway Configuration
# Routes /api/ to internal Node.js API container on control plane network
# Serves frontend static application
# ==============================================================================

upstream deployforge_api {
    server api:3000 max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # DeployForge REST API
    location /api/ {
        proxy_pass http://deployforge_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
    }

    # Control-plane only: /internal/* (decrypted env vars for the worker) is reachable on the
    # internal docker network but must never be exposed through the public ingress.
    location ^~ /internal/ {
        return 404;
    }

    # Static UI or API fallback
    location / {
        proxy_pass http://deployforge_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
`;
    fs.writeFileSync(INGRESS_CONF_FILE, ingressConfig, "utf-8");
  } else {
    try {
      const existing = fs.readFileSync(INGRESS_CONF_FILE, "utf-8");
      if (existing.includes("proxy_set_header Connection 'upgrade';")) {
        const updated = existing.replace(
          "proxy_set_header Connection 'upgrade';",
          "proxy_set_header Connection $connection_upgrade;"
        );
        fs.writeFileSync(INGRESS_CONF_FILE, updated, "utf-8");
      }
    } catch (_) {}
  }
}

/**
 * Validate Nginx configuration syntax
 * @returns {Promise<{ valid: boolean, output?: string, error?: string }>}
 */
async function validateNginxConfig() {
  if (getMode() === "simulator") {
    return { valid: true, simulated: true };
  }

  try {
    // Attempt validation via running nginx container in Docker
    const { stdout, stderr } = await execAsync("docker exec deployforge-nginx nginx -t");
    return { valid: true, output: stdout || stderr };
  } catch (err) {
    const msg = String(err.message || "") + String(err.stderr || "");
    if (
      msg.includes("No such container") ||
      msg.includes("is not running") ||
      msg.includes("is restarting") ||
      msg.includes("cannot exec in a stopped state")
    ) {
      return { valid: true, skipped: true, output: "Nginx container not ready for exec validation" };
    }
    return {
      valid: false,
      error: err.message,
      output: err.stderr || err.stdout,
    };
  }
}

/**
 * Reload Nginx to apply modified routing configurations
 * @returns {Promise<{ reloaded: boolean, error?: string }>}
 */
async function reloadNginx() {
  if (getMode() === "simulator") {
    return { reloaded: true, simulated: true };
  }

  try {
    await execAsync("docker exec deployforge-nginx nginx -s reload");
    return { reloaded: true };
  } catch (err) {
    console.warn("Failed to reload Nginx container:", err.message);
    return { reloaded: false, error: err.message };
  }
}

let pendingWaiters = [];
let isWriting = false;
let debounceTimer = null;
let pendingConfigContent = null;

/**
 * Perform single-flight atomic write to disk, validate, rename, and reload
 */
async function executeSingleWrite(explicitContent) {
  ensureNginxStructure();

  let configContent = explicitContent;
  if (!configContent) {
    const { generateNginxConfig } = require("./proxyRouter.js");
    configContent = generateNginxConfig();
  }

  const tmpPath = `${UPSTREAMS_CONF_FILE}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  let prevConfig = null;

  try {
    if (fs.existsSync(UPSTREAMS_CONF_FILE)) {
      prevConfig = await fs.promises.readFile(UPSTREAMS_CONF_FILE, "utf-8");
    }
  } catch (_) {}

  try {
    // 1. Write updated upstream configuration to unique .tmp file
    await fs.promises.writeFile(tmpPath, configContent, "utf-8");

    // 2. POSIX atomic rename over active upstream config
    await fs.promises.rename(tmpPath, UPSTREAMS_CONF_FILE);
    syncStats.actualWriteCount++;

    // 3. Syntax validation (if real mode)
    const validation = await validateNginxConfig();
    if (!validation.valid) {
      console.warn("Nginx configuration validation failed, rolling back:", validation.error);
      try {
        if (prevConfig !== null) {
          await fs.promises.writeFile(UPSTREAMS_CONF_FILE, prevConfig, "utf-8");
        } else {
          await fs.promises.unlink(UPSTREAMS_CONF_FILE);
        }
      } catch (_) {}

      return {
        synced: false,
        path: UPSTREAMS_CONF_FILE,
        valid: false,
        reloaded: false,
        error: validation.error,
      };
    }

    // 4. Reload Nginx
    const reloadResult = await reloadNginx();
    const reloaded = Boolean(reloadResult.reloaded);
    if (reloaded) {
      syncStats.actualReloadCount++;
    }

    return {
      synced: true,
      path: UPSTREAMS_CONF_FILE,
      valid: true,
      reloaded,
      error: undefined,
    };
  } catch (err) {
    // Clean up temp file if still present
    try {
      if (fs.existsSync(tmpPath)) {
        await fs.promises.unlink(tmpPath);
      }
    } catch (_) {}

    console.warn("Failed to synchronize Nginx configuration:", err.message);
    return {
      synced: false,
      path: UPSTREAMS_CONF_FILE,
      valid: false,
      reloaded: false,
      error: err.message,
    };
  }
}

/**
 * Flush accumulated sync requests in a single flight
 */
async function flushSync() {
  debounceTimer = null;
  if (isWriting) {
    return;
  }
  if (pendingWaiters.length === 0) {
    return;
  }

  isWriting = true;
  const currentBatch = pendingWaiters;
  pendingWaiters = [];
  const configToWrite = pendingConfigContent;
  pendingConfigContent = null;

  let result;
  try {
    result = await executeSingleWrite(configToWrite);
  } catch (err) {
    result = {
      synced: false,
      path: UPSTREAMS_CONF_FILE,
      valid: false,
      reloaded: false,
      error: err.message,
    };
  } finally {
    isWriting = false;

    // Settle all callers belonging to this coalesced batch
    for (const waiter of currentBatch) {
      waiter.resolve(result);
    }

    // If subsequent calls arrived while write was executing, schedule trailing debounce sync
    if (pendingWaiters.length > 0 && !debounceTimer) {
      debounceTimer = setTimeout(flushSync, DEBOUNCE_MS);
    }
  }
}

/**
 * Synchronize the current proxyRouter routing table to disk and reload Nginx.
 * Single-flight, debounced writer coalescing bursts into one write+reload per 150-200ms
 * with atomic rename and stats tracking.
 * @param {string} [nginxConfigContent] - Pre-rendered config string, or will generate from proxyRouter
 * @returns {Promise<{ synced: boolean, path: string, valid: boolean, reloaded: boolean, error?: string }>}
 */
function syncNginxConfig(nginxConfigContent) {
  syncStats.totalSyncCalls++;
  if (nginxConfigContent !== undefined) {
    pendingConfigContent = nginxConfigContent;
  }

  return new Promise((resolve, reject) => {
    pendingWaiters.push({ resolve, reject });

    if (isWriting) {
      // Write in flight; trailing sync will be scheduled upon completion
      return;
    }

    if (!debounceTimer) {
      debounceTimer = setTimeout(flushSync, DEBOUNCE_MS);
    }
  });
}

module.exports = {
  NGINX_DIR,
  CONF_D_DIR,
  UPSTREAMS_CONF_FILE,
  INGRESS_CONF_FILE,
  BASE_CONF_FILE,
  ensureNginxStructure,
  validateNginxConfig,
  reloadNginx,
  syncNginxConfig,
  getSyncStats,
  resetSyncStats,
};
