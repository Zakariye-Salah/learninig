// backend/src/routes/help.js  (append or create this)
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');

const Announcement = require('../models/Announcement');
const User = require('../models/User');

const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/help/announcements
 * Public: returns latest published announcements (most recent first).
 * Optional ?limit= number
 */
router.get('/announcements', async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const list = await Announcement.find({ isPublished: true }).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ announcements: list });
  } catch (err) {
    console.error('help.announcements.get', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/help/announcements
 * Admin only: create announcement
 * Body: { title?, text }
 */
router.post('/announcements', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const text = sanitizeHtml(String(req.body.text || '').trim());
    const title = sanitizeHtml(String(req.body.title || '').trim());
    if (!text) return res.status(400).json({ error: 'Text required' });
    const a = await Announcement.create({
      title,
      text,
      authorId: req.user._id,
      authorName: req.user.fullName || req.user.username || ''
    });
    return res.json({ ok: true, announcement: a });
  } catch (err) {
    console.error('help.announcements.post', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * PUT /api/help/announcements/:id
 * Admin: edit announcement
 */
router.put('/announcements/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const updates = {};
    if (req.body.text !== undefined) updates.text = sanitizeHtml(String(req.body.text || '').trim());
    if (req.body.title !== undefined) updates.title = sanitizeHtml(String(req.body.title || '').trim());
    if (req.body.isPublished !== undefined) updates.isPublished = !!req.body.isPublished;
    updates.updatedAt = new Date();
    const a = await Announcement.findByIdAndUpdate(id, updates, { new: true });
    if (!a) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, announcement: a });
  } catch (err) {
    console.error('help.announcements.put', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/help/announcements/:id
 * Admin: delete announcement
 */
router.delete('/announcements/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    await Announcement.deleteOne({ _id: id });
    return res.json({ ok: true });
  } catch (err) {
    console.error('help.announcements.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/help/unread-count
 * If user logged in -> return count of announcements created after user's lastSeenAnnouncementsAt
 * If not logged in -> 0
 */
router.get('/unread-count', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.json({ unread: 0 });
    const lastSeen = req.user.lastSeenAnnouncementsAt || new Date(0);
    const cnt = await Announcement.countDocuments({ isPublished: true, createdAt: { $gt: lastSeen } });
    return res.json({ unread: cnt });
  } catch (err) {
    console.error('help.unread-count', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/help/mark-read
 * Mark all announcements as read for the user (updates user.lastSeenAnnouncementsAt = now)
 */
router.post('/mark-read', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    await User.findByIdAndUpdate(req.user._id, { lastSeenAnnouncementsAt: new Date() });
    return res.json({ ok: true });
  } catch (err) {
    console.error('help.mark-read', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
