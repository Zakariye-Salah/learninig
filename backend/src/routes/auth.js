// backend/src/routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const User = require('../models/User');
const { JWT_SECRET, TOKEN_EXPIRY } = require('../config');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function sign(user) {
  return jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_EXPIRY || '7d' });
}

// helper: compute flag emoji from ISO alpha-2 code (e.g. "US" -> 🇺🇸)
function countryCodeToEmoji(code) {
  try {
    if (!code || typeof code !== 'string') return null;
    // handle special custom codes
    const custom = {
      'XS-SL': '🏳️', // Somaliland - simple fallback emoji (replace with URL if desired)
      'XN-SL': '🏳️',
      'XK': '🇽🇰'
    };
    if (custom[code]) return custom[code];

    // standard 2-letter codes only
    const c = code.trim().toUpperCase();
    if (c.length !== 2) return null;
    const A = 0x1F1E6; // regional indicator symbol letter A
    const first = c.charCodeAt(0) - 65;
    const second = c.charCodeAt(1) - 65;
    if (first < 0 || first > 25 || second < 0 || second > 25) return null;
    return String.fromCodePoint(A + first) + String.fromCodePoint(A + second);
  } catch (e) {
    return null;
  }
}

/**
 * POST /api/auth/register
 * Body: { username, fullName, password, phoneNumber?, country?, countryName?, city?, countryCallingCode? }
 */
router.post('/register', async (req, res) => {
  try {
    const username = sanitizeHtml(String(req.body.username || '').trim());
    const fullName = sanitizeHtml(String(req.body.fullName || '').trim());
    const password = String(req.body.password || '');
    const phoneNumber = sanitizeHtml(String(req.body.phoneNumber || '').trim() || '');
    const country = sanitizeHtml(String(req.body.country || '').trim() || '');
    const countryName = sanitizeHtml(String(req.body.countryName || '').trim() || '');
    const city = sanitizeHtml(String(req.body.city || '').trim() || '');
    const countryCallingCode = sanitizeHtml(String(req.body.countryCallingCode || '').trim() || '');

    if (!username || !fullName || !password) return res.status(400).json({ ok: false, error: 'Missing required fields' });
    if (password.length < 6) return res.status(400).json({ ok: false, error: 'Password too short (min 6 characters)' });

    // ensure username uniqueness
    const exists = await User.findOne({ username }).lean();
    if (exists) return res.status(400).json({ ok: false, error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);

    const flagEmoji = country ? countryCodeToEmoji(country) : null;

    const userDoc = {
      username, fullName, passwordHash: hash,
      phoneNumber: phoneNumber || null,
      country: country || null,
      countryName: countryName || (country || null),
      countryFlagEmoji: flagEmoji,
      countryCallingCode: countryCallingCode || null,
      city: city || null
    };

    const user = await User.create(userDoc);

    const token = sign(user);
    return res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        phoneNumber: user.phoneNumber,
        country: user.country,
        countryName: user.countryName,
        countryFlagEmoji: user.countryFlagEmoji,
        city: user.city,
        balanceDollar: Number(user.balanceDollar || 0)
      }
    });
  } catch (err) {
    console.error('auth.register', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/auth/login  (unchanged logic but returns country/city, flag)
router.post('/login', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const password = req.body.password;
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Missing fields' });

    const user = await User.findOne({ username, isDeleted: { $ne: true } });
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    user.lastLogin = new Date();
    await user.save();

    const token = sign(user);
    return res.json({
      ok: true,
      token,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        phoneNumber: user.phoneNumber,
        country: user.country,
        countryName: user.countryName,
        countryFlagEmoji: user.countryFlagEmoji,
        city: user.city,
        balanceDollar: Number(user.balanceDollar || 0)
      }
    });
  } catch (err) {
    console.error('auth.login', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    const user = await User.findById(req.user._id).select('-passwordHash').lean();
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    return res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        phoneNumber: user.phoneNumber,
        country: user.country,
        countryName: user.countryName,
        countryFlagEmoji: user.countryFlagEmoji,
        countryFlagUrl: user.countryFlagUrl,
        countryCallingCode: user.countryCallingCode,
        city: user.city,
        balanceDollar: Number(user.balanceDollar || 0)
      }
    });
  } catch (err) {
    console.error('auth.me', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// PUT /api/auth/me (update profile)
router.put('/me', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const updates = {};
    if (req.body.fullName !== undefined) updates.fullName = sanitizeHtml(String(req.body.fullName || '').trim());
    if (req.body.email !== undefined) updates.email = sanitizeHtml(String(req.body.email || '').trim());
    if (req.body.phoneNumber !== undefined) updates.phoneNumber = sanitizeHtml(String(req.body.phoneNumber || '').trim());
    if (req.body.country !== undefined) updates.country = sanitizeHtml(String(req.body.country || '').trim());
    if (req.body.countryName !== undefined) updates.countryName = sanitizeHtml(String(req.body.countryName || '').trim());
    if (req.body.countryFlagUrl !== undefined) updates.countryFlagUrl = sanitizeHtml(String(req.body.countryFlagUrl || '').trim());
    if (req.body.countryCallingCode !== undefined) updates.countryCallingCode = sanitizeHtml(String(req.body.countryCallingCode || '').trim());
    if (req.body.city !== undefined) updates.city = sanitizeHtml(String(req.body.city || '').trim());

    if (req.body.country && !req.body.countryFlagEmoji) {
      // compute emoji server-side for better cross-platform
      updates.countryFlagEmoji = countryCodeToEmoji(String(req.body.country || '').trim());
    } else if (req.body.countryFlagEmoji !== undefined) {
      updates.countryFlagEmoji = sanitizeHtml(String(req.body.countryFlagEmoji || '').trim());
    }

    if (req.body.password && String(req.body.password).trim().length >= 6) {
      const hash = await bcrypt.hash(String(req.body.password).trim(), 10);
      updates.passwordHash = hash;
    } else if (req.body.password && String(req.body.password).trim().length > 0) {
      return res.status(400).json({ ok: false, error: 'Password too short (min 6 chars)' });
    }

    const u = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-passwordHash').lean();
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });

    return res.json({
      ok: true,
      user: {
        id: u._id,
        username: u.username,
        fullName: u.fullName,
        email: u.email,
        role: u.role,
        phoneNumber: u.phoneNumber,
        country: u.country,
        countryName: u.countryName,
        countryFlagEmoji: u.countryFlagEmoji,
        countryFlagUrl: u.countryFlagUrl,
        countryCallingCode: u.countryCallingCode,
        city: u.city,
        balanceDollar: Number(u.balanceDollar || 0)
      }
    });
  } catch (err) {
    console.error('auth.me.put', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
