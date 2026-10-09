import jwt from 'jsonwebtoken';
import pool from '../config/db.js';

export const authenticateToken = async (req, res, next) => {
    const token = req.cookies.token;

    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await pool.query('SELECT * FROM users WHERE user_id = $1', [decoded.id]);

        if (user.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        req.user = user.rows[0];
        next();
    } catch (error) {
        return res.status(400).json({ message: 'Invalid token.' });
    }
};