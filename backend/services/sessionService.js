const crypto = require("crypto");
const redis = require("../config/redis.js");

const SESSION_PREFIX = "session:";
const DEFAULT_SESSION_TTL_SECONDS = 86400; // 24 hours

/**
 * Format Redis key for a given session ID
 */
function sessionKey(sessionId) {
  return `${SESSION_PREFIX}${sessionId}`;
}

/**
 * Create a new user session in Redis
 * @param {object} user - User record from PostgreSQL
 * @param {number} [ttlSeconds] - Session expiration in seconds (default 24h)
 * @returns {Promise<string>} Created session ID
 */
async function createSession(user, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  const sessionId = crypto.randomUUID();
  const key = sessionKey(sessionId);

  const sessionData = {
    id: user.id,
    name: user.name || user.user_name || "",
    user_name: user.name || user.user_name || "",
    email: user.email,
    github_connected: Boolean(user.github_connected),
    notification_preferences: user.notification_preferences || {
      notify_failures: true,
      notify_weekly: false,
    },
    created_at: new Date().toISOString(),
  };

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    await redis.set(key, JSON.stringify(sessionData), "EX", ttlSeconds);
    return sessionId;
  } catch (error) {
    console.warn("Failed to store session in Redis:", error.message);
    return sessionId;
  }
}

/**
 * Retrieve session data from Redis
 * @param {string} sessionId
 * @returns {Promise<object|null>} Session data or null if not found/expired
 */
async function getSession(sessionId) {
  if (!sessionId) return null;
  const key = sessionKey(sessionId);

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to retrieve session from Redis:", error.message);
    return null;
  }
}

/**
 * Extend session TTL (touch session)
 * @param {string} sessionId
 * @param {number} [ttlSeconds]
 */
async function touchSession(sessionId, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  if (!sessionId) return false;
  const key = sessionKey(sessionId);

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const res = await redis.expire(key, ttlSeconds);
    return res === 1;
  } catch (error) {
    console.warn("Failed to touch session in Redis:", error.message);
    return false;
  }
}

/**
 * Update cached user data within an active session
 * @param {string} sessionId
 * @param {object} updates
 */
async function updateSessionUser(sessionId, updates) {
  if (!sessionId) return null;
  const key = sessionKey(sessionId);

  try {
    const existing = await getSession(sessionId);
    if (!existing) return null;

    const merged = {
      ...existing,
      ...updates,
      user_name: updates.name || updates.user_name || existing.user_name,
      updated_at: new Date().toISOString(),
    };

    const ttl = await redis.ttl(key);
    const expireTime = ttl > 0 ? ttl : DEFAULT_SESSION_TTL_SECONDS;
    await redis.set(key, JSON.stringify(merged), "EX", expireTime);
    return merged;
  } catch (error) {
    console.warn("Failed to update session in Redis:", error.message);
    return null;
  }
}

/**
 * Invalidate/destroy a session in Redis (instant logout revocation)
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function destroySession(sessionId) {
  if (!sessionId) return false;
  const key = sessionKey(sessionId);

  try {
    if (redis.status !== "ready" && redis.status !== "connecting") {
      await redis.connect().catch(() => {});
    }
    const res = await redis.del(key);
    return res > 0;
  } catch (error) {
    console.warn("Failed to destroy session in Redis:", error.message);
    return false;
  }
}

module.exports = {
  SESSION_PREFIX,
  DEFAULT_SESSION_TTL_SECONDS,
  createSession,
  getSession,
  touchSession,
  updateSessionUser,
  destroySession,
};
