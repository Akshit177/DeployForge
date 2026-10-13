const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/db.js");
const { generateAccessToken } = require("../services/auth.js");

const router = express.Router();

const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 15 * 60 * 1000,
};

function publicUser(user) {
    return { id: user.id, user_name: user.user_name, email: user.email };
}

router.post("/register", async (req, res) => {
    const { user_name, email, password } = req.body;

    if (
        typeof user_name !== "string" ||
        !user_name.trim() ||
        typeof email !== "string" ||
        !email.trim() ||
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
            "INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name AS user_name, email",
            [user_name.trim(), normalizedEmail, hashedPassword]
        );
        const user = result.rows[0];

        res.cookie("token", generateAccessToken(user.id), cookieOptions);
        return res.status(201).json({
            message: `Account created successfully for ${user.user_name}.`,
            user: publicUser(user),
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
            "SELECT id, name AS user_name, email, password_hash FROM users WHERE email = $1",
            [email.trim().toLowerCase()]
        );
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            return res.status(401).json({ message: "Invalid email or password." });
        }

        res.cookie("token", generateAccessToken(user.id), cookieOptions);
        return res.status(200).json({
            message: `Welcome back, ${user.user_name}.`,
            user: publicUser(user),
        });
    } catch (error) {
        console.error("Login failed:", error);
        return res.status(500).json({ message: "Unable to sign in right now." });
    }
});

router.post("/logout", (req, res) => {
    res.clearCookie("token", cookieOptions);
    res.status(200).json({ message: "Signed out successfully." });
});

module.exports = router;
