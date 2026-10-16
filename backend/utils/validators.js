const ALLOWED_REPO_REGEX = /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?(\/)?$/i;
const BRANCH_REGEX = /^[A-Za-z0-9._/-]{1,100}$/;
const COMMIT_HASH_REGEX = /^[0-9a-fA-F]{7,40}$/;
const IDENTIFIER_REGEX = /^[A-Za-z0-9_-]{1,50}$/;

/**
 * Validates repository URL against allowlisted HTTPS providers (GitHub, GitLab, Bitbucket).
 * Strictly rejects private IPs (e.g. 169.254.169.254), internal hostnames (redis, localhost),
 * unencrypted http://, and non-whitelisted domains to prevent SSRF.
 */
function isValidRepoUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const url = rawUrl.trim();
  if (process.env.NODE_ENV === "test") {
    // In test environment, permit local filesystem repository paths for offline fixtures
    if (url.startsWith("/") || url.startsWith("file://")) {
      return true;
    }
  }
  return ALLOWED_REPO_REGEX.test(url);
}

/**
 * Validates git branch name. Must be 1-100 characters.
 * Strictly prevents leading hyphen '-' (flags like --upload-pack) and path traversal '..'.
 */
function isValidBranch(rawBranch) {
  if (typeof rawBranch !== "string") return false;
  const branch = rawBranch.trim();
  if (!branch || branch.length > 100) return false;
  if (branch.startsWith("-") || branch.includes("..")) return false;
  return BRANCH_REGEX.test(branch);
}

/**
 * Validates git commit hash. Must be 'HEAD' or a 7-40 hex SHA.
 */
function isValidCommitHash(rawHash) {
  if (rawHash === undefined || rawHash === null || rawHash === "") return true;
  if (typeof rawHash !== "string") return false;
  const hash = rawHash.trim();
  if (hash === "HEAD") return true;
  return COMMIT_HASH_REGEX.test(hash);
}

/**
 * Sanitizes commit message: strips control characters and caps length to 500 characters.
 */
function sanitizeCommitMessage(rawMsg) {
  if (typeof rawMsg !== "string") return "Deploy latest changes";
  return rawMsg
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, 500);
}

/**
 * Validates deployment trigger tag (e.g. manual, webhook, rollback).
 */
function isValidTrigger(rawTrigger) {
  if (rawTrigger === undefined || rawTrigger === null || rawTrigger === "") return true;
  if (typeof rawTrigger !== "string") return false;
  return IDENTIFIER_REGEX.test(rawTrigger.trim());
}

/**
 * Validates deployment environment name (e.g. production, staging).
 */
function isValidEnvironment(rawEnv) {
  if (rawEnv === undefined || rawEnv === null || rawEnv === "") return true;
  if (typeof rawEnv !== "string") return false;
  return IDENTIFIER_REGEX.test(rawEnv.trim());
}

module.exports = {
  isValidRepoUrl,
  isValidBranch,
  isValidCommitHash,
  sanitizeCommitMessage,
  isValidTrigger,
  isValidEnvironment,
  ALLOWED_REPO_REGEX,
  BRANCH_REGEX,
  COMMIT_HASH_REGEX,
};
