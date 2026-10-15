const pool = require("../config/db.js");
const redis = require("../config/redis.js");
const { verifyAccessToken } = require("../services/auth.js");
const { getSession } = require("../services/sessionService.js");

async function authenticateToken(req, res, next) {
    const token = req.cookies?.token;

    if (!token) {
        return res.status(401).json({ message: "Access denied. No token provided." });
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (error) {
        return res.status(400).json({ message: "Invalid token." });
    }

    // Fast-path: Check Redis session if session ID is in token
    if (decoded.sid) {
        try {
            const session = await getSession(decoded.sid);
            if (session) {
                req.user = session;
                req.sessionId = decoded.sid;
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
        const user = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);

        if (user.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }

        req.user = user.rows[0];
        req.sessionId = decoded.sid || null;
        return next();
    } catch (error) {
        return next(error);
    }
}

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
    assertOwnsDeployment,
    assertOwnsProject,
};