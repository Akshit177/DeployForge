const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/db.js");
const { generateAccessToken, verifyAccessToken, getCookieOptions } = require("../services/auth.js");
const { createSession, destroySession } = require("../services/sessionService.js");

const { authenticateToken } = require("../middleware/auth.js");

const router = express.Router();

const cookieOptions = getCookieOptions();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
    return {
        id: user.id,
        user_name: user.name || user.user_name,
        email: user.email,
        github_connected: Boolean(user.github_connected),
        notification_preferences: user.notification_preferences || { notify_failures: true, notify_weekly: false },
    };
}

router.post("/register", async (req, res) => {
    const { user_name, email, password } = req.body;

    if (
        typeof user_name !== "string" ||
        !user_name.trim() ||
        user_name.trim().length > 255 ||
        typeof email !== "string" ||
        !EMAIL_REGEX.test(email.trim()) ||
        email.trim().length > 255 ||
        typeof password !== "string" ||
        password.length < 8
    ) {
        return res.status(400).json({
            message: "Please provide your name, a valid email, and a password of at least 8 characters.",
        });
    }

    try {
        const normalizedEmail = email.trim().toLowerCase();
        const userExists = await pool.query(
            "SELECT id FROM users WHERE email = $1",
            [normalizedEmail]
        );
        if (userExists.rows.length > 0) {
            return res.status(409).json({ message: "An account with this email already exists." });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name AS user_name, email, github_connected, notification_preferences",
            [user_name.trim(), normalizedEmail, hashedPassword]
        );
        const user = result.rows[0];
        const sessionId = await createSession(user);
        const token = generateAccessToken(user.id, sessionId);

        res.cookie("token", token, cookieOptions);
        return res.status(201).json({
            message: `Account created successfully for ${user.user_name}.`,
            token,
            user: publicUser(user),
            session_id: sessionId,
        });
    } catch (error) {
        if (error.code === "23505") {
            return res.status(409).json({ message: "An account with this email already exists." });
        }
        console.error("Registration failed:", error);
        return res.status(500).json({ message: "Unable to create your account right now." });
    }
});

router.post("/login", async (req, res) => {
    const { email, password } = req.body;
    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
        return res.status(400).json({ message: "Please provide your email and password." });
    }

    try {
        const result = await pool.query(
            "SELECT id, name AS user_name, email, password_hash, github_connected, notification_preferences FROM users WHERE email = $1",
            [email.trim().toLowerCase()]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        const sessionId = await createSession(user);
        const token = generateAccessToken(user.id, sessionId);
        res.cookie("token", token, cookieOptions);
        return res.status(200).json({
            message: `Welcome back, ${user.user_name}.`,
            token,
            user: publicUser(user),
            session_id: sessionId,
        });
    } catch (error) {
        console.error("Login failed:", error);
        return res.status(500).json({ message: "Unable to sign in right now." });
    }
});

router.post("/logout", async (req, res) => {
    try {
        // Accept the cookie or an Authorization: Bearer header so API clients can sign out too
        let token = req.cookies?.token;
        if (!token && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
            token = req.headers.authorization.slice(7).trim();
        }
        if (token) {
            try {
                const decoded = verifyAccessToken(token);
                if (decoded?.sid) {
                    await destroySession(decoded.sid);
                }
            } catch (_) {}
        }
    } catch (err) {
        console.warn("Logout session destruction warning:", err.message);
    }
    res.clearCookie("token", cookieOptions);
    return res.status(200).json({ message: "Signed out successfully." });
});

router.get("/me", authenticateToken, (req, res) => {
    return res.status(200).json({
        user: publicUser(req.user),
        session_id: req.sessionId || null,
    });
});

module.exports = router;
