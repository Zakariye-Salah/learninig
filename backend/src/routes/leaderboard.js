// backend/src/routes/leaderboard.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');                // <<--- ensure mongoose is available
const sanitizeHtml = require('sanitize-html');

const LeaderboardComment = require('../models/LeaderboardComment');
const Competition = require('../models/Competition');
const User = require('../models/User');

const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/leaderboard/competitions/current
 * Convenience endpoint returning active competition + top users
 */
router.get('/competitions/current', async (req, res) => {
  try {
    const comp = await Competition.findOne({ isActive: true }).sort({ startDate: -1 }).lean();
    if (!comp) return res.status(404).json({ error: 'No active competition' });

    const users = await User.find({ isDeleted: { $ne: true } }).sort({ pointsCurrent: -1 }).limit(200).lean();
// include location fields so clients don't need to fetch profiles separately
const top = users.map(u => ({
  userId: u._id,
  userName: u.fullName || u.username || '',
  points: u.pointsCurrent || 0,
  // server side fields
  country: u.country || u.countryName || null,
  countryName: u.countryName || null,
  countryFlagEmoji: u.countryFlagEmoji || null,
  countryFlagUrl: u.countryFlagUrl || null,
  city: u.city || null
}));


    return res.json({ competition: comp, top });
  } catch (err) {
    console.error('leaderboard.current', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/leaderboard/  -> returns leaderboard list
 */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(1000, parseInt(req.query.limit || '100', 10));
    const users = await User.find({ isDeleted: { $ne: true } }).sort({ pointsCurrent: -1 }).limit(limit).lean();
const payload = users.map(u => ({
  userId: u._id,
  userName: u.fullName || u.username || '',
  points: u.pointsCurrent || 0,
  country: u.country || u.countryName || null,
  countryName: u.countryName || null,
  countryFlagEmoji: u.countryFlagEmoji || null,
  countryFlagUrl: u.countryFlagUrl || null,
  city: u.city || null
}));
    return res.json({ leaderboard: payload });
  } catch (err) {
    console.error('leaderboard.list', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/leaderboard/comments  (create)
 */
router.post('/comments', authMiddleware, async (req, res) => {
  try {
    const competitionId = req.body.competitionId;
    const content = sanitizeHtml((req.body.content || '').trim(), { allowedTags: [], allowedAttributes: {} }).slice(0, 1000);
    if (!competitionId || !content) return res.status(400).json({ error: 'Missing' });

    const comp = await Competition.findById(competitionId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    const comment = await LeaderboardComment.create({
      competitionId,
      userId: req.user._id,
      userName: req.user.fullName || req.user.username || 'Unknown',
      content
    });

    // notify room (if io set in app)
    const io = req.app.get('io');
    if (io) io.to(`competition:${competitionId}`).emit('comments:new', { comment });

    return res.json({ comment });
  } catch (err) {
    console.error('leaderboard.comments.post', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/leaderboard/comments?competitionId=...
 */
router.get('/comments', async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) return res.status(400).json({ error: 'competitionId required' });
    const comments = await LeaderboardComment.find({ competitionId }).sort({ createdAt: 1 }).lean();
    return res.json({ comments });
  } catch (err) {
    console.error('leaderboard.comments.list', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/leaderboard/comments/:id
 * user can delete their own; admin can delete any
 */
router.delete('/comments/:id', authMiddleware, async (req, res) => {
  try {
    const c = await LeaderboardComment.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!c.userId.equals(req.user._id) && req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
    c.isDeleted = true;
    c.deletedBy = req.user._id;
    await c.save();

    const io = req.app.get('io');
    if (io) io.emit('comments:deleted', { id: c._id });

    return res.json({ ok: true });
  } catch (err) {
    console.error('leaderboard.comments.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/leaderboard/clear  (clear current user's points)
 */
router.post('/clear', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.pointsCurrent = 0;
    user.pointsUpdatedAt = new Date();
    await user.save();
    return res.json({ ok: true, message: 'Your points have been cleared successfully.' });
  } catch (err) {
    console.error('leaderboard.clear', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/leaderboard/clear-all  (admin)
 */
router.post('/clear-all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const filter = { isDeleted: { $ne: true } };
    const update = { $set: { pointsCurrent: 0, pointsResetAt: new Date() } };
    const result = await User.updateMany(filter, update);
    const io = req.app.get('io');
    if (io) io.emit('leaderboard:changed', { clearedBy: req.user ? String(req.user._id) : null, modifiedCount: result.modifiedCount || 0 });
    return res.json({ ok: true, modifiedCount: result.modifiedCount || 0 });
  } catch (err) {
    console.error('leaderboard.clearAll', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/leaderboard/adjust
 * Admin only: adjust a user's points by delta (positive or negative)
 * Body: { userId, delta }
 */
router.post('/adjust', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { userId, delta } = req.body;
    if (!userId || typeof delta === 'undefined') {
      return res.status(400).json({ error: 'userId and delta are required' });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid userId' });
    }

    const u = await User.findById(userId);
    if (!u) return res.status(404).json({ error: 'User not found' });

    const d = Number(delta);
    if (!Number.isFinite(d)) return res.status(400).json({ error: 'delta must be a number' });

    u.pointsCurrent = (typeof u.pointsCurrent === 'number' ? u.pointsCurrent : 0) + d;
    u.pointsUpdatedAt = new Date();
    await u.save();

    // notify connected clients
    const io = req.app.get('io');
    if (io) {
      io.emit('leaderboard:update', { userId: String(u._id), delta: d, newPoints: u.pointsCurrent });
    }

    return res.json({ ok: true, userId: String(u._id), newPoints: u.pointsCurrent });
  } catch (err) {
    console.error('leaderboard.adjust', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
