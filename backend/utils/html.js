/**
 * Minimal HTML escaping for values interpolated into server-rendered status pages.
 * Project names, error messages and Host headers are user-influenced and must never be
 * written into markup verbatim.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = { escapeHtml };
