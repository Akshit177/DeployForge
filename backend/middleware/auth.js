const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { verifyAccessToken, generateAccessToken, getCookieOptions } = require("../services/auth.js");
const { getSession } = require("../services/sessionService.js");

// Seconds before expiry at which an active session gets a fresh access token.
const REFRESH_WINDOW_SECONDS = Number(process.env.TOKEN_REFRESH_WINDOW_SECONDS || 300);

function extractToken(req, allowQueryToken) {
    if (req.cookies?.token) return { token: req.cookies.token, source: "cookie" };
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
        const token = header.slice(7).trim();
        if (token) return { token, source: "bearer" };
    }
    if (allowQueryToken && typeof req.query?.token === "string" && req.query.token) {
        return { token: req.query.token, source: "query" };
    }
    return { token: null, source: null };
}

/**
 * Sliding session: the access token is short-lived (15 min) but the Redis session
 * lives for 24 h. Re-issue a fresh token (cookie + X-Auth-Token header) when the
 * current one is close to expiry so active users are not signed out mid-session.
 */
function maybeRefreshToken(res, decoded, source) {
    if (!decoded.sid || !decoded.exp || source === "query" || res.headersSent) return;
    const remaining = decoded.exp - Math.floor(Date.now() / 1000);
    if (remaining > REFRESH_WINDOW_SECONDS) return;
    try {
        const fresh = generateAccessToken(decoded.id, decoded.sid);
        res.cookie("token", fresh, getCookieOptions());
        res.setHeader("X-Auth-Token", fresh);
    } catch (_) {
        // Refresh is best-effort; the current token is still valid.
    }
}

/**
 * Build an authentication middleware.
 *  - Accepts the token from the auth cookie or an `Authorization: Bearer` header.
 *  - With `allowQueryToken` it also accepts `?token=` (EventSource cannot set headers).
 *  - Always enforces Redis session revocation, so logout is honoured everywhere.
 *  - Any invalid or expired token is a 401 (the frontend only reacts to 401).
 */
function createAuthenticator({ allowQueryToken = false } = {}) {
    return async function authenticate(req, res, next) {
        const { token, source } = extractToken(req, allowQueryToken);

        if (!token) {
            return res.status(401).json({ message: "Access denied. No token provided." });
        }

        let decoded;
        try {
            decoded = verifyAccessToken(token);
        } catch (error) {
            const expired = error && error.name === "TokenExpiredError";
            return res.status(401).json({
                message: expired ? "Session expired. Please sign in again." : "Invalid token.",
            });
        }

        // Fast-path: Check Redis session if session ID is in token
        if (decoded.sid) {
            try {
                const session = await getSession(decoded.sid);
                if (session) {
                    req.user = session;
                    req.sessionId = decoded.sid;
                    maybeRefreshToken(res, decoded, source);
                    return next();
                }

                // If Redis is online and ready, but session key is missing, token was revoked on logout
                if (redis.status === "ready") {
                    return res.status(401).json({ message: "Session expired or revoked." });
                }
            } catch (sessionErr) {
                console.warn("Session check fallback to database:", sessionErr.message);
            }
        }

        // Fallback: Query PostgreSQL directly
        try {
            const user = await pool.query(
                "SELECT id, name, email, github_connected, github_username, notification_preferences, created_at, updated_at FROM users WHERE id = $1",
                [decoded.id]
            );

            if (user.rows.length === 0) {
                return res.status(401).json({ message: "User not found." });
            }

            const u = user.rows[0];
            req.user = {
                ...u,
                user_name: u.name,
            };
            req.sessionId = decoded.sid || null;
            maybeRefreshToken(res, decoded, source);
            return next();
        } catch (error) {
            return next(error);
        }
    };
}

const authenticateToken = createAuthenticator();
const authenticateTokenOrQuery = createAuthenticator({ allowQueryToken: true });

async function assertOwnsDeployment(userId, deploymentId) {
    if (!userId || !deploymentId) return null;
    try {
        const res = await pool.query(
            `SELECT d.*, p.name AS project_name, p.domain AS project_domain
             FROM deployments d
             JOIN projects p ON d.project_id = p.id
             WHERE d.id = $1 AND d.user_id = $2`,
            [deploymentId, userId]
        );
        return res.rows.length > 0 ? res.rows[0] : null;
    } catch (err) {
        console.error("assertOwnsDeployment error:", err);
        return null;
    }
}

async function assertOwnsProject(userId, projectId) {
    if (!userId || !projectId) return null;
    try {
        const res = await pool.query(
            `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
            [projectId, userId]
        );
        return res.rows.length > 0 ? res.rows[0] : null;
    } catch (err) {
        console.error("assertOwnsProject error:", err);
        return null;
    }
}

module.exports = {
    authenticateToken,
    authenticateTokenOrQuery,
    createAuthenticator,
    assertOwnsDeployment,
    assertOwnsProject,
};