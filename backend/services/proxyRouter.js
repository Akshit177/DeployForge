const pool = require("../config/db.js");
const { getPublicBaseDomain } = require("../utils/publicUrl.js");
const { isSafeHostname } = require("../utils/validators.js");

// In-memory routing table: Map of domain -> upstream route configuration
const routingTable = new Map();

/** `https://Foo.Example.com:8080/x` -> `foo.example.com` */
function normalizeDomainKey(domain) {
  if (!domain || typeof domain !== "string") return "";
  return domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .split(":")[0];
}

/**
 * Build a validated route entry. Returns null when the domain, upstream host or port is not
 * safe to use. Everything here ends up in generated nginx config, so it must be a plain
 * hostname / port and never arbitrary text.
 */
function buildRouteEntry(domain, routeInfo = {}) {
  const normalizedDomain = normalizeDomainKey(domain);
  if (!isSafeHostname(normalizedDomain)) return null;

  const deploymentId = routeInfo.deployment_id || routeInfo.deploymentId;
  const fallbackContainerName = deploymentId
    ? `df-${String(deploymentId).replace(/-/g, "").slice(0, 12)}`
    : null;
  const containerName = routeInfo.container_name || routeInfo.containerName || fallbackContainerName;
  const targetHost = routeInfo.target_host || routeInfo.targetHost || containerName || "127.0.0.1";
  if (!isSafeHostname(String(targetHost))) return null;

  const port = Number(routeInfo.port || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    domain: normalizedDomain,
    project_id: routeInfo.project_id || routeInfo.projectId,
    project_name: routeInfo.project_name || routeInfo.projectName || "app",
    deployment_id: deploymentId,
    container_id: routeInfo.container_id || routeInfo.containerId,
    container_name: containerName,
    target_host: targetHost,
    port,
    status: routeInfo.status || "Healthy",
    registered_at: new Date().toISOString(),
    registered_at_ms: Date.now(),
    last_probe_ms: routeInfo.last_probe_ms || 3,
  };
}

function scheduleNginxSync() {
  try {
    const { syncNginxConfig } = require("./nginxManager.js");
    syncNginxConfig().catch(() => {});
  } catch (_) {}
}

// While a DB sync is in flight, remember routes removed meanwhile so the (older) snapshot
// does not resurrect them.
let activeSync = null;

/**
 * Register or update an active upstream route.
 * Returns the entry, or null if the route was rejected as unsafe.
 */
function registerUpstreamRoute(domain, routeInfo = {}) {
  if (!domain) return;
  const entry = buildRouteEntry(domain, routeInfo);
  if (!entry) {
    console.warn(`[ProxyRouter] Rejected unsafe route registration for domain "${String(domain).slice(0, 100)}"`);
    return null;
  }

  routingTable.set(entry.domain, entry);
  if (activeSync) activeSync.removed.delete(entry.domain);
  scheduleNginxSync();
  return entry;
}

/**
 * Remove an upstream route when a deployment is stopped, cancelled, or deleted.
 *
 * Matching is exact - never substring based - so tearing down `shop.deployforge.app`
 * cannot take `bigshop.deployforge.app` (possibly another tenant's) offline.
 *
 *  - `deploymentId` given: only drop a route that is *currently served by that deployment*.
 *    A stopped/cancelled/failed deployment must not unroute a different, still-live one.
 *  - otherwise: drop the exact `domain`, and every route of `projectId` (project teardown).
 *  - `projectName` is only honoured as a legacy fallback when neither id is supplied, because
 *    project names are unique per user, not globally.
 */
function unregisterUpstreamRoute(domain, options = {}) {
  const opts = typeof options === "string" ? { projectId: options } : (options || {});
  const cleanDomain = normalizeDomainKey(domain);
  let deleted = false;

  for (const [key, entry] of Array.from(routingTable.entries())) {
    let remove = false;

    if (opts.deploymentId) {
      remove = entry.deployment_id === opts.deploymentId;
    } else {
      if (cleanDomain && (key === cleanDomain || entry.domain === cleanDomain)) remove = true;
      if (opts.projectId && entry.project_id === opts.projectId) remove = true;
      if (
        !opts.projectId &&
        opts.projectName &&
        (entry.project_name || "").toLowerCase() === String(opts.projectName).toLowerCase()
      ) {
        remove = true;
      }
    }

    if (remove) {
      routingTable.delete(key);
      if (activeSync) activeSync.removed.add(key);
      deleted = true;
    }
  }

  if (deleted) scheduleNginxSync();
  return deleted;
}

function slugOf(entry) {
  return (entry.project_name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
}

function domainPrefixOf(entry) {
  return (entry.domain || "").replace(/^https?:\/\//, "").replace(/\.deployforge\.app$/i, "").toLowerCase();
}

/**
 * Resolve incoming domain to its registered upstream route.
 * The unique domain prefix always wins over the (non-unique) project-name alias, so two tenants
 * with a project called "blog" (`blog` / `blog-2`) never get each other's traffic.
 */
function resolveDomain(domain) {
  const normalized = normalizeDomainKey(domain);
  if (!normalized) return null;
  const direct = routingTable.get(normalized);
  if (direct) return direct;
  const publicBase = getPublicBaseDomain();
  const entries = Array.from(routingTable.values());

  // Pass 1: exact, unique domain prefix on any dev/public base domain
  for (const entry of entries) {
    const prefix = domainPrefixOf(entry);
    if (!prefix) continue;
    if (
      (publicBase !== "localhost" && normalized === `${prefix}.${publicBase}`) ||
      normalized === `${prefix}.localhost` ||
      normalized === `${prefix}.127.0.0.1.nip.io`
    ) {
      return entry;
    }
  }

  // Pass 2: project-name alias (only meaningful while the name is not shadowed by a prefix)
  for (const entry of entries) {
    const slug = slugOf(entry);
    if (!slug) continue;
    if (
      (publicBase !== "localhost" && normalized === `${slug}.${publicBase}`) ||
      normalized === `${slug}.localhost` ||
      normalized === `${slug}.127.0.0.1.nip.io`
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
 * Synchronize the in-memory routing table with Running projects and deployments in PostgreSQL.
 *
 * The new table is built off to the side and swapped in synchronously, so concurrent requests
 * never observe an empty table. If a project has several RUNNING deployments the newest wins.
 */
async function syncFromDatabase() {
  const sync = { startedAt: Date.now(), removed: new Set() };
  activeSync = sync;
  try {
    const result = await pool.query(
      `SELECT p.id AS project_id, p.name AS project_name, p.domain, p.port,
              d.id AS deployment_id, d.container_id, d.container_name, d.status AS deployment_status
       FROM projects p
       JOIN deployments d ON d.project_id = p.id AND UPPER(d.status) = 'RUNNING'
       ORDER BY d.created_at DESC`
    );

    const next = new Map();
    for (const row of result.rows) {
      if (!row.domain) continue;
      const key = normalizeDomainKey(row.domain);
      if (!key || next.has(key)) continue; // rows are newest-first: first one wins

      const fallbackName = `df-${row.deployment_id.replace(/-/g, "").slice(0, 12)}`;
      const containerName = row.container_name || fallbackName;
      const entry = buildRouteEntry(row.domain, {
        projectId: row.project_id,
        projectName: row.project_name,
        deploymentId: row.deployment_id,
        containerId: row.container_id || `c_${row.deployment_id.replace(/-/g, "").slice(0, 12)}`,
        containerName,
        targetHost: containerName,
        port: row.port || 3000,
        status: "Healthy",
      });
      if (entry) next.set(entry.domain, entry);
    }

    // Keep routes registered while the query was running (they are newer than the snapshot),
    // and honour removals that happened meanwhile.
    for (const [key, existing] of routingTable.entries()) {
      if ((existing.registered_at_ms || 0) >= sync.startedAt) next.set(key, existing);
    }
    for (const key of sync.removed) {
      const fresh = next.get(key);
      if (!fresh || (fresh.registered_at_ms || 0) < sync.startedAt) next.delete(key);
    }

    routingTable.clear();
    for (const [key, entry] of next.entries()) routingTable.set(key, entry);

    try {
      const { syncNginxConfig } = require("./nginxManager.js");
      await syncNginxConfig();
    } catch (_) {}

    return getRoutingTable();
  } catch (err) {
    console.warn("ProxyRouter sync warning:", err.message);
    return getRoutingTable();
  } finally {
    if (activeSync === sync) activeSync = null;
  }
}

let throttledSync = { at: 0, promise: null };

/**
 * Rate-limited / de-duplicated variant for request-path "route miss" lookups. Without this an
 * unauthenticated client sending random Host headers could force a DB query + nginx rewrite per
 * request.
 */
function syncFromDatabaseThrottled(minIntervalMs = 3000) {
  const now = Date.now();
  if (throttledSync.promise) return throttledSync.promise;
  if (now - throttledSync.at < minIntervalMs) return Promise.resolve(getRoutingTable());

  throttledSync.at = now;
  const promise = syncFromDatabase().finally(() => {
    throttledSync.promise = null;
  });
  throttledSync.promise = promise;
  return promise;
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
    // Defence in depth: never emit config for anything that is not a plain host / port.
    if (!isSafeHostname(route.domain) || !isSafeHostname(String(route.target_host)) || !Number.isInteger(route.port)) {
      continue;
    }

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
    // Public ingress hostname (PUBLIC_BASE_DOMAIN) - added regardless of DEV_DOMAINS so a
    // VM / cloud deployment is reachable at the exact URL the dashboard shows.
    const publicBase = getPublicBaseDomain();
    if (publicBase !== "localhost") {
      const publicHost = `${domainPrefix || safeProjectSlug}.${publicBase}`;
      if (!domainList.includes(publicHost)) {
        domainList.push(publicHost);
      }
    }
    const serverNames = domainList.filter(isSafeHostname).map((d) => `    server_name ${d};\n`).join("");

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
  syncFromDatabaseThrottled,
  generateNginxConfig,
  normalizeDomainKey,
};
