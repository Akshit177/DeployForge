const pool = require("../config/db.js");

// In-memory routing table: Map of domain -> upstream route configuration
const routingTable = new Map();

/**
 * Register or update an active upstream route
 */
function registerUpstreamRoute(domain, routeInfo) {
  if (!domain) return;
  const normalizedDomain = domain.toLowerCase().trim();

  const entry = {
    domain: normalizedDomain,
    project_id: routeInfo.project_id || routeInfo.projectId,
    project_name: routeInfo.project_name || routeInfo.projectName || "app",
    deployment_id: routeInfo.deployment_id || routeInfo.deploymentId,
    container_id: routeInfo.container_id || routeInfo.containerId,
    target_host: routeInfo.target_host || routeInfo.targetHost || "127.0.0.1",
    port: Number(routeInfo.port || 3000),
    status: routeInfo.status || "Healthy",
    registered_at: new Date().toISOString(),
    last_probe_ms: routeInfo.last_probe_ms || 3,
  };

  routingTable.set(normalizedDomain, entry);

  try {
    const { syncNginxConfig } = require("./nginxManager.js");
    syncNginxConfig().catch(() => {});
  } catch (_) {}

  return entry;
}

/**
 * Remove an upstream route when a deployment is stopped or cancelled
 */
function unregisterUpstreamRoute(domain) {
  if (!domain) return false;
  const deleted = routingTable.delete(domain.toLowerCase().trim());

  if (deleted) {
    try {
      const { syncNginxConfig } = require("./nginxManager.js");
      syncNginxConfig().catch(() => {});
    } catch (_) {}
  }

  return deleted;
}

/**
 * Resolve incoming domain to its registered upstream route
 */
function resolveDomain(domain) {
  if (!domain) return null;
  return routingTable.get(domain.toLowerCase().trim()) || null;
}

/**
 * Get all active upstream routes in the routing table
 */
function getRoutingTable() {
  return Array.from(routingTable.values());
}

/**
 * Synchronize the in-memory routing table with Running projects and deployments in PostgreSQL
 */
async function syncFromDatabase() {
  try {
    const result = await pool.query(
      `SELECT p.id AS project_id, p.name AS project_name, p.domain, p.port,
              d.id AS deployment_id, d.container_id, d.status AS deployment_status
       FROM projects p
       JOIN deployments d ON d.project_id = p.id AND UPPER(d.status) = 'RUNNING'
       ORDER BY d.created_at DESC`
    );

    for (const row of result.rows) {
      if (row.domain) {
        registerUpstreamRoute(row.domain, {
          projectId: row.project_id,
          projectName: row.project_name,
          deploymentId: row.deployment_id,
          containerId: row.container_id || `c_${row.deployment_id.replace(/-/g, "").slice(0, 12)}`,
          targetHost: "127.0.0.1",
          port: row.port || 3000,
          status: "Healthy",
        });
      }
    }

    try {
      const { syncNginxConfig } = require("./nginxManager.js");
      syncNginxConfig().catch(() => {});
    } catch (_) {}

    return getRoutingTable();
  } catch (err) {
    console.warn("ProxyRouter sync warning:", err.message);
    return getRoutingTable();
  }
}

/**
 * Generate production-grade Nginx reverse proxy configuration
 */
function generateNginxConfig() {
  const routes = getRoutingTable();
  const timestamp = new Date().toISOString();

  let config = `# ==============================================================================
# DeployForge Edge Proxy Dynamic Upstream Configuration
# Generated at: ${timestamp}
# Active upstream routes: ${routes.length}
# ==============================================================================

`;

  if (routes.length === 0) {
    config += `# No active container upstreams currently registered.\n`;
    return config;
  }

  for (const route of routes) {
    const safeProjectSlug = route.project_name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "app";
    const safeUpstreamName = `upstream_${route.project_name.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_${route.port}`;
    config += `upstream ${safeUpstreamName} {
    server ${route.target_host}:${route.port} max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${route.domain};
    server_name ${safeProjectSlug}.localhost;
    server_name ${safeProjectSlug}.127.0.0.1.nip.io;

    location / {
        proxy_pass http://${safeUpstreamName};
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
}

`;
  }

  return config;
}

module.exports = {
  registerUpstreamRoute,
  unregisterUpstreamRoute,
  resolveDomain,
  getRoutingTable,
  syncFromDatabase,
  generateNginxConfig,
};
