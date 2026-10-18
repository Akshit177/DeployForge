const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config();
const jwt = require("jsonwebtoken");

function getJWTSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error("JWT_SECRET is not defined in environment variables");
    }
    return secret;
}

function generateAccessToken(userId, sessionId = null) {
    if (!userId) {
        throw new Error("A user ID is required to generate an access token.");
    }

    const payload = { id: String(userId) };
    if (sessionId) {
        payload.sid = String(sessionId);
    }

    return jwt.sign(
        payload,
        getJWTSecret(),
        {
            algorithm: "HS256",
            expiresIn: "15m",
        }
    );
}

function verifyAccessToken(token) {
    if (!token) {
        throw new Error("Token is required for verification.");
    }

    return jwt.verify(token, getJWTSecret(), {
        algorithms: ["HS256"],
    });
}

/**
 * Cookie options for the auth token. Kept in one place so login, register,
 * logout and the sliding-refresh logic in the auth middleware all agree.
 */
function getCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === "true",
        sameSite: "lax",
        maxAge: 15 * 60 * 1000,
    };
}

module.exports = {
    generateAccessToken,
    verifyAccessToken,
    getCookieOptions,
};