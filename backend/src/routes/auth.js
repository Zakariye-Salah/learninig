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

function escapeRegex(s = '') {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeEmail(s) {
  return typeof s === 'string' && s.indexOf('@') !== -1;
}

/**
 * GET /api/auth/check-username?username=...
 * Returns { ok: true, available: true/false }
 * Accepts both plain usernames and email-like usernames.
 */
router.get('/check-username', async (req, res) => {
  try {
    const raw = (req.query.username || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Missing username' });

    const normalized = raw.toLowerCase();
    console.log('auth.check-username ->', { raw, normalized });

    let exists = null;
    if (looksLikeEmail(raw)) {
      // check email uniqueness
      exists = await User.findOne({
        $or: [
          { email: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' } },
          { username: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' } }
        ]
      }).lean();
    } else {
      // plain username - check usernameNormalized or case-insensitive username
      exists = await User.findOne({
        $or: [
          { usernameNormalized: normalized },
          { username: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' } }
        ]
      }).lean();
    }

    return res.json({ ok: true, available: !Boolean(exists) });
  } catch (err) {
    console.error('auth.check-username', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * POST /api/auth/register
 * Accepts username (plain or email), fullName, password, optionally phone/country/city.
 * - If username contains '@', we set user's email field to that value (lowercased).
 * - server computes usernameNormalized (lowercase).
 */
router.post('/register', async (req, res) => {
  try {
    const usernameRaw = String(req.body.username || '').trim();
    const usernameNormalized = usernameRaw.toLowerCase();
    const fullName = sanitizeHtml(String(req.body.fullName || '').trim());
    const password = String(req.body.password || '');
    const phoneNumber = sanitizeHtml(String(req.body.phoneNumber || '').trim() || '');
    const country = sanitizeHtml(String(req.body.country || '').trim() || '');
    const countryName = sanitizeHtml(String(req.body.countryName || '').trim() || '');
    const city = sanitizeHtml(String(req.body.city || '').trim() || '');
    const countryCallingCode = sanitizeHtml(String(req.body.countryCallingCode || '').trim() || '');

    console.log('auth.register attempt ->', { usernameRaw, usernameNormalized, fullName });

    if (!usernameRaw || !fullName || !password) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password too short (min 6 characters)' });
    }

    // Determine if usernameRaw is an email-like string. If yes, we will store it in email.
    const isEmail = looksLikeEmail(usernameRaw);
    const emailNormalized = isEmail ? usernameNormalized : null;

    // Check for existing user: either username or email conflict (case-insensitive)
    let exists = await User.findOne({
      $or: [
        { usernameNormalized },
        { username: { $regex: `^${escapeRegex(usernameRaw)}$`, $options: 'i' } },
        ...(isEmail ? [{ email: { $regex: `^${escapeRegex(usernameRaw)}$`, $options: 'i' } }] : [])
      ]
    }).lean();

    if (exists) {
      console.warn('auth.register -> username/email exists', { usernameRaw, usernameNormalized, existId: exists._id });
      return res.status(400).json({ ok: false, error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(password, 10);

    // compute flag emoji helper if you have it; else set null
    const flagEmoji = typeof countryCodeToEmoji === 'function' ? countryCodeToEmoji(country) : null;

    const userDoc = {
      username: usernameRaw,
      usernameNormalized,
      fullName,
      passwordHash: hash,
      phoneNumber: phoneNumber || null,
      country: country || null,
      countryName: countryName || (country || null),
      countryFlagEmoji: flagEmoji || null,
      countryCallingCode: countryCallingCode || null,
      city: city || null
    };

    if (isEmail) {
      userDoc.email = emailNormalized; // store email normalized (lowercase)
    }

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
    // duplicate key (handle race conditions)
    if (err && (err.code === 11000 || (err.name === 'MongoError' && err.code === 11000))) {
      console.warn('auth.register duplicate key', err.keyValue || err);
      return res.status(400).json({ ok: false, error: 'Username already exists' });
    }
    if (err && err.name === 'ValidationError') {
      const messages = Object.values(err.errors || {}).map(e => e.message).filter(Boolean);
      return res.status(400).json({ ok: false, error: messages.join('; ') || 'Validation failed' });
    }

    console.error('auth.register', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});


/**
 * POST /api/auth/login
 * Accepts username or email. Uses case-insensitive lookup.
 */
router.post('/login', async (req, res) => {
  try {
    const raw = (req.body.username || req.body.email || '').trim();
    const password = req.body.password;
    if (!raw || !password) return res.status(400).json({ ok: false, error: 'Missing fields' });

    let user = null;
    if (looksLikeEmail(raw)) {
      // login by email (case-insensitive)
      user = await User.findOne({ email: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' }, isDeleted: { $ne: true } });
      if (!user) {
        // also allow login by username that equals this email exactly
        user = await User.findOne({ username: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' }, isDeleted: { $ne: true } });
      }
    } else {
      // login by username: try normalized then fallback to case-insensitive username
      const normalized = raw.toLowerCase();
      user = await User.findOne({
        $or: [
          { usernameNormalized: normalized },
          { username: { $regex: `^${escapeRegex(raw)}$`, $options: 'i' } }
        ],
        isDeleted: { $ne: true }
      });
    }

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
      // compute emoji server-side
      updates.countryFlagEmoji = countryCodeToEmoji(String(req.body.country || '').trim());
    } else if (req.body.countryFlagEmoji !== undefined) {
      updates.countryFlagEmoji = sanitizeHtml(String(req.body.countryFlagEmoji || '').trim());
    }

    // If password passed and long enough, hash & set
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
