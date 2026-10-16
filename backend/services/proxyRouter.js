const pool = require("../config/db.js");

// In-memory routing table: Map of domain -> upstream route configuration
const routingTable = new Map();

/**
 * Register or update an active upstream route
 */
function registerUpstreamRoute(domain, routeInfo) {
  if (!domain) return;
  const normalizedDomain = domain.toLowerCase().trim();

  const fallbackContainerName = routeInfo.deployment_id || routeInfo.deploymentId
    ? `df-${String(routeInfo.deployment_id || routeInfo.deploymentId).replace(/-/g, "").slice(0, 12)}`
    : null;
  const containerName = routeInfo.container_name || routeInfo.containerName || fallbackContainerName;

  const entry = {
    domain: normalizedDomain,
    project_id: routeInfo.project_id || routeInfo.projectId,
    project_name: routeInfo.project_name || routeInfo.projectName || "app",
    deployment_id: routeInfo.deployment_id || routeInfo.deploymentId,
    container_id: routeInfo.container_id || routeInfo.containerId,
    container_name: containerName,
    target_host: routeInfo.target_host || routeInfo.targetHost || containerName || "127.0.0.1",
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
  let normalized = domain.toLowerCase().trim().replace(/^https?:\/\//, "");
  if (normalized.includes(":")) {
    normalized = normalized.split(":")[0];
  }
  const direct = routingTable.get(normalized);
  if (direct) return direct;

  for (const entry of routingTable.values()) {
    const slug = (entry.project_name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
    const domainPrefix = (entry.domain || "").replace(/^https?:\/\//, "").replace(/\.deployforge\.app$/i, "").toLowerCase();

    if (
      normalized === `${slug}.localhost` ||
      normalized === `${slug}.127.0.0.1.nip.io` ||
      (domainPrefix && (normalized === `${domainPrefix}.localhost` || normalized === `${domainPrefix}.127.0.0.1.nip.io`))
    ) {
      return entry;
    }
  }

  return null;
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
              d.id AS deployment_id, d.container_id, d.container_name, d.status AS deployment_status
       FROM projects p
       JOIN deployments d ON d.project_id = p.id AND UPPER(d.status) = 'RUNNING'
       ORDER BY d.created_at DESC`
    );

    for (const row of result.rows) {
      if (row.domain) {
        const fallbackName = `df-${row.deployment_id.replace(/-/g, "").slice(0, 12)}`;
        const containerName = row.container_name || fallbackName;
        registerUpstreamRoute(row.domain, {
          projectId: row.project_id,
          projectName: row.project_name,
          deploymentId: row.deployment_id,
          containerId: row.container_id || `c_${row.deployment_id.replace(/-/g, "").slice(0, 12)}`,
          containerName: containerName,
          targetHost: containerName,
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

  const includeDevDomains =
    process.env.DEV_DOMAINS === "true" ||
    (process.env.NODE_ENV !== "production" && process.env.DEV_DOMAINS !== "false");

  for (const route of routes) {
    const safeProjectSlug = route.project_name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "") || "app";
    const domainPrefix = (route.domain || "").replace(/^https?:\/\//, "").replace(/\.deployforge\.app$/i, "").toLowerCase();
    const safeProjectIdShort = String(route.project_id || "app").replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase();
    const safeUpstreamName = `upstream_df_${safeProjectIdShort}_${route.port}`;

    const domainList = [];
    if (route.domain) {
      domainList.push(route.domain.toLowerCase().trim());
    }
    if (includeDevDomains) {
      const primarySlug = domainPrefix || safeProjectSlug;
      const devLocalhost = `${primarySlug}.localhost`;
      const devNipIo = `${primarySlug}.127.0.0.1.nip.io`;
      if (!domainList.includes(devLocalhost)) {
        domainList.push(devLocalhost);
      }
      if (!domainList.includes(devNipIo)) {
        domainList.push(devNipIo);
      }

      if (domainPrefix && domainPrefix !== safeProjectSlug) {
        const altLocalhost = `${safeProjectSlug}.localhost`;
        const altNipIo = `${safeProjectSlug}.127.0.0.1.nip.io`;
        const isSafeSlugTakenByOther = routes.some(
          (r) => r !== route && ((r.domain || "").replace(/\.deployforge\.app$/i, "").toLowerCase() === safeProjectSlug)
        );
        if (!isSafeSlugTakenByOther) {
          if (!domainList.includes(altLocalhost)) {
            domainList.push(altLocalhost);
          }
          if (!domainList.includes(altNipIo)) {
            domainList.push(altNipIo);
          }
        }
      }
    }
    const serverNames = domainList.map((d) => `    server_name ${d};\n`).join("");

    config += `upstream ${safeUpstreamName} {
    server ${route.target_host}:${route.port} max_fails=3 fail_timeout=10s;
    keepalive 32;
}

server {
    listen 80;
    listen [::]:80;
${serverNames}
    location / {
        proxy_pass http://${safeUpstreamName};
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
