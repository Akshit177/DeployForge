/**
 * Public URL builder - the ONE place that decides what URL a deployed project
 * is reachable at.
 *
 * Why this exists:
 *   Projects are stored with a logical domain of the form `<slug>.deployforge.app`.
 *   That is an identifier, not a hostname you own, so it never resolves on a
 *   self-hosted stack. The URL users should open is `<slug>.<PUBLIC_BASE_DOMAIN>`
 *   served by the Nginx ingress on INGRESS_PORT.
 *
 * Configuration (all optional, defaults suit a local `docker compose up`):
 *   PUBLIC_BASE_DOMAIN  base host for project subdomains.
 *                         local dev       -> localhost            (default)
 *                         Safari / no *.localhost support
 *                                         -> 127.0.0.1.nip.io
 *                         VM / cloud host -> <PUBLIC_IP>.nip.io  or  apps.example.com
 *   PUBLIC_SCHEME       http | https                             (default: http)
 *   PUBLIC_PORT         externally visible ingress port          (default: INGRESS_PORT, else 80)
 *                       The default port of the scheme (80 / 443) is omitted from URLs.
 */

const LOGICAL_DOMAIN_SUFFIX = /\.deployforge\.app$/i;

function getPublicBaseDomain() {
  const raw = String(process.env.PUBLIC_BASE_DOMAIN || "localhost")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return raw || "localhost";
}

function getPublicScheme() {
  return String(process.env.PUBLIC_SCHEME || "http").toLowerCase() === "https" ? "https" : "http";
}

function getPublicPortSuffix() {
  const scheme = getPublicScheme();
  const port = String(process.env.PUBLIC_PORT || process.env.INGRESS_PORT || "80").trim();
  if (!/^\d+$/.test(port)) return "";
  if ((scheme === "http" && port === "80") || (scheme === "https" && port === "443")) return "";
  return `:${port}`;
}

/** `my-app.deployforge.app` -> `my-app` (sanitised to a DNS-safe label). */
function slugFromDomain(domain, fallbackName) {
  const prefix = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(LOGICAL_DOMAIN_SUFFIX, "");
  const source = prefix || String(fallbackName || "");
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/** Hostname (no scheme/port) the ingress serves this project on. */
function buildPublicHost({ domain, name } = {}) {
  return `${slugFromDomain(domain, name)}.${getPublicBaseDomain()}`;
}

/** Full clickable URL, e.g. `http://my-app.localhost` or `https://my-app.1.2.3.4.nip.io`. */
function buildPublicUrl({ domain, name } = {}) {
  return `${getPublicScheme()}://${buildPublicHost({ domain, name })}${getPublicPortSuffix()}`;
}

module.exports = {
  getPublicBaseDomain,
  getPublicScheme,
  getPublicPortSuffix,
  slugFromDomain,
  buildPublicHost,
  buildPublicUrl,
};
