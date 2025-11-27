// backend/src/middleware/auth.js
'use strict';

/**
 * Authentication middleware
 *
 * - Verifies JWT (using JWT_SECRET from config) and loads the user record.
 * - Exports two middlewares used across the app:
 *    requireAuth  -> attaches req.user (lean object) or returns 401/500
 *    requireAdmin -> ensures req.user.role === 'admin' (or user.isAdmin) or 403
 *
 * For compatibility with older code we also export `authMiddleware` as an alias
 * to `requireAuth` so routes that import `authMiddleware` continue to work.
 *
 * Development fallback tokens:
 *  - Bearer admin-token  -> attaches a simple admin user object (useful for local testing)
 *  - Bearer user-token   -> attaches a simple regular user object
 *
 * IMPORTANT: Replace fallback behavior with real JWT/session logic in production.
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../config') || process.env;

async function requireAuth(req, res, next) {
  try {
    const auth = (req.headers.authorization || '').trim();
    if (!auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: 'Invalid auth format' });
    const token = match[1];

    // Development/test fallback tokens (easy local testing)
    if (token === 'admin-token') {
      req.user = {
        _id: 'admin-id',
        username: 'admin',
        fullName: 'Admin',
        role: 'admin',
        isAdmin: true
      };
      return next();
    }
    if (token === 'user-token') {
      req.user = {
        _id: 'user-id',
        username: 'user',
        fullName: 'Demo User',
        role: 'user',
        isAdmin: false
      };
      return next();
    }

    // If no JWT secret configured, return helpful error
    const secret = JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      console.warn('[auth] JWT_SECRET is not set — refusing to verify token');
      return res.status(500).json({ error: 'Server misconfigured (missing JWT_SECRET)' });
    }

    // Verify JWT
    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (err) {
      console.warn('[auth] token verify failed', err && err.message);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // payload expected to contain user id as `id` or `_id` or `userId`
    const userId = payload && (payload.id || payload._id || payload.userId);
    if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

    // load user from DB (remove sensitive fields)
    const user = await User.findById(userId).select('-password -passwordHash -salt -__v').lean();
    if (!user || user.isDeleted) return res.status(401).json({ error: 'User not found or disabled' });

    // attach user (lean object)
    req.user = user;
    return next();
  } catch (err) {
    console.error('[auth] requireAuth error', err);
    return res.status(500).json({ error: 'Authentication error' });
  }
}
function requireAdmin(req, res, next) {
  try {
    const u = req.user;
    if (!u) return res.status(401).json({ error: 'Authentication required' });

    // Allow 'admin' OR 'controller' (and keep backward compatibility with isAdmin flag)
    const role = (u.role && String(u.role).toLowerCase()) || '';
    const isAdmin = role === 'admin' || role === 'controller' || !!u.isAdmin;

    if (!isAdmin) return res.status(403).json({ error: 'Admins (or controllers) only' });
    return next();
  } catch (err) {
    console.error('[auth] requireAdmin error', err);
    return res.status(500).json({ error: 'Authorization error' });
  }
}



// Add this function to allow "optional" auth (does not block guests)
async function optionalAuthenticate(req, res, next) {
  try {
    const auth = req.headers && req.headers.authorization;
    if (!auth) return next();
    const parts = auth.split(' ');
    if (parts.length !== 2) return next();
    const token = parts[1];
    if (!token) return next();
    let data;
    try {
      data = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // invalid token -> treat as guest
      return next();
    }
    if (!data || !data.id) return next();
    const user = await User.findById(data.id);
    if (!user || user.isDeleted) return next();
    req.user = user;
    return next();
  } catch (err) {
    console.warn('optionalAuthenticate failed:', err && err.message ? err.message : err);
    return next();
  }
}


// Export both the new names and a compatibility alias `authMiddleware`
module.exports = {
  requireAuth,
  requireAdmin,
  optionalAuthenticate,
  authMiddleware: requireAuth
};
