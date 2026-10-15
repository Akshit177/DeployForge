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

/**
 * Ensure Nginx directory structure and base configuration templates exist
 */
function ensureNginxStructure() {
  if (!fs.existsSync(CONF_D_DIR)) {
    fs.mkdirSync(CONF_D_DIR, { recursive: true });
  }

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
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
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

let syncQueue = Promise.resolve();

/**
 * Synchronize the current proxyRouter routing table to disk and reload Nginx.
 * Serialized via an in-memory promise queue with atomic temp-file write + rename
 * to prevent corrupted or truncated reads under concurrent deployment reloads.
 * @param {string} [nginxConfigContent] - Pre-rendered config string, or will generate from proxyRouter
 * @returns {Promise<{ synced: boolean, path: string, valid: boolean, reloaded: boolean, error?: string }>}
 */
async function syncNginxConfig(nginxConfigContent) {
  const executeSync = async () => {
    ensureNginxStructure();

    let configContent = nginxConfigContent;
    if (!configContent) {
      const { generateNginxConfig } = require("./proxyRouter.js");
      configContent = generateNginxConfig();
    }

    const tmpPath = `${UPSTREAMS_CONF_FILE}.tmp`;
    let prevConfig = null;

    try {
      if (fs.existsSync(UPSTREAMS_CONF_FILE)) {
        prevConfig = await fs.promises.readFile(UPSTREAMS_CONF_FILE, "utf-8");
      }
    } catch (_) {}

    try {
      // 1. Write updated upstream configuration to .tmp file
      await fs.promises.writeFile(tmpPath, configContent, "utf-8");

      // 2. POSIX atomic rename over active upstream config
      await fs.promises.rename(tmpPath, UPSTREAMS_CONF_FILE);

      // 3. Syntax validation
      const validation = await validateNginxConfig();
      let reloaded = false;

      if (validation.valid) {
        const reloadResult = await reloadNginx();
        reloaded = Boolean(reloadResult.reloaded);
      } else {
        console.warn("Nginx configuration validation failed:", validation.error);
        // Rollback to previous config if it existed
        if (prevConfig !== null) {
          try {
            await fs.promises.writeFile(tmpPath, prevConfig, "utf-8");
            await fs.promises.rename(tmpPath, UPSTREAMS_CONF_FILE);
            console.warn("Rolled back Nginx configuration to last known good state.");
          } catch (rollbackErr) {
            console.error("Failed to rollback Nginx configuration:", rollbackErr.message);
          }
        }
      }

      return {
        synced: true,
        path: UPSTREAMS_CONF_FILE,
        valid: validation.valid,
        reloaded,
        error: validation.valid ? undefined : validation.error,
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
  };

  // Enqueue to guarantee serialized execution
  const currentSync = syncQueue.then(executeSync, executeSync);
  syncQueue = currentSync.catch(() => {});
  return currentSync;
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
};
