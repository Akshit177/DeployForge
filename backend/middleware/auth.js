const pool = require("../config/db.js");
const { verifyAccessToken } = require("../services/auth.js");

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

    try {
        const user = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);

        if (user.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }

        req.user = user.rows[0];
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = { authenticateToken };