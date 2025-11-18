// backend/src/routes/users.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const User = require('../models/User');

const router = express.Router();

/**
 * Helper to publicize user shape (same idea as leaderboard)
 */
function publicizeUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    id: u._id,
    username: u.username,
    fullName: u.fullName,
    role: u.role,
    country: u.country || null,
    countryName: u.countryName || null,
    countryFlagEmoji: u.countryFlagEmoji || null,
    countryFlagUrl: u.countryFlagUrl || null,
    city: u.city || null,
    phoneNumber: u.phoneNumber || null,
    balanceDollar: Number(u.balanceDollar || 0)
  };
}

/**
 * GET /api/user/:id
 * Return { user: { ... } } as frontend expects
 */
router.get('/user/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const u = await User.findById(id).select('-passwordHash -salt').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    return res.json({ user: publicizeUser(u) });
  } catch (err) {
    console.error('GET /api/user/:id error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/users?ids=id1,id2,...
 * Return { users: [...] } (frontend also tolerates raw arrays)
 */
router.get('/users', async (req, res) => {
  try {
    const idsRaw = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!idsRaw.length) return res.status(400).json({ error: 'ids query required' });

    const idsValid = idsRaw.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!idsValid.length) return res.status(400).json({ error: 'no valid ids' });

    const users = await User.find({ _id: { $in: idsValid } }).select('-passwordHash -salt').lean();
    // return as { users } since frontend code checks that shape
    return res.json({ users });
  } catch (err) {
    console.error('GET /api/users error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
