/**
 * DeployForge Deployment Lifecycle State Machine
 * Defines canonical status enum, allowed state transitions, and idempotency rules.
 */

const DEPLOYMENT_STATUSES = Object.freeze([
  "INITIATED",
  "QUEUED",
  "CLONING",
  "BUILDING",
  "STARTING",
  "RUNNING",
  "FAILED",
  "STOPPED",
  "CANCELLED",
]);

const TERMINAL_STATUSES = Object.freeze([
  "FAILED",
  "STOPPED",
  "CANCELLED",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  INITIATED: Object.freeze(["QUEUED", "CLONING", "BUILDING", "STARTING", "RUNNING", "FAILED", "CANCELLED"]),
  QUEUED: Object.freeze(["CLONING", "BUILDING", "STARTING", "RUNNING", "FAILED", "CANCELLED"]),
  CLONING: Object.freeze(["BUILDING", "RUNNING", "FAILED", "CANCELLED"]),
  BUILDING: Object.freeze(["STARTING", "RUNNING", "FAILED", "CANCELLED"]),
  STARTING: Object.freeze(["RUNNING", "FAILED", "CANCELLED"]),
  RUNNING: Object.freeze(["STOPPED", "FAILED", "CANCELLED"]),
  FAILED: Object.freeze([]),
  STOPPED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

/**
 * Normalize input status to uppercase trimmed string
 * @param {string} status
 * @returns {string}
 */
function normalizeStatus(status) {
  return String(status || "").trim().toUpperCase();
}

/**
 * Check if status is a known canonical deployment status
 * @param {string} status
 * @returns {boolean}
 */
function isValidStatus(status) {
  return DEPLOYMENT_STATUSES.includes(normalizeStatus(status));
}

/**
 * Check if status is a terminal state (cannot transition out)
 * @param {string} status
 * @returns {boolean}
 */
function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status));
}

/**
 * Check if transition from fromStatus to toStatus is permitted.
 * Idempotent transitions (from === to) are considered valid.
 * Transitions out of terminal states (FAILED, STOPPED, CANCELLED) are strictly forbidden.
 *
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function canTransition(fromStatus, toStatus) {
  const from = normalizeStatus(fromStatus);
  const to = normalizeStatus(toStatus);

  if (!isValidStatus(from) || !isValidStatus(to)) {
    return false;
  }

  // Idempotent self-transition
  if (from === to) {
    return true;
  }

  // Terminal states cannot transition to any other state
  if (isTerminalStatus(from)) {
    return false;
  }

  const allowed = ALLOWED_TRANSITIONS[from];
  return Boolean(allowed && allowed.includes(to));
}

/**
 * Returns list of source statuses that can legally transition to targetStatus,
 * including targetStatus itself (for idempotency).
 *
 * @param {string} targetStatus
 * @returns {string[]}
 */
function getAllowedPreviousStatuses(targetStatus) {
  const target = normalizeStatus(targetStatus);
  if (!isValidStatus(target)) {
    return [];
  }

  const result = new Set([target]);
  for (const [sourceStatus, allowedTargets] of Object.entries(ALLOWED_TRANSITIONS)) {
    if (allowedTargets.includes(target)) {
      result.add(sourceStatus);
    }
  }

  return Array.from(result);
}

module.exports = {
  DEPLOYMENT_STATUSES,
  TERMINAL_STATUSES,
  ALLOWED_TRANSITIONS,
  normalizeStatus,
  isValidStatus,
  isTerminalStatus,
  canTransition,
  getAllowedPreviousStatuses,
};
