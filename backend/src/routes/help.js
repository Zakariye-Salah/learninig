const express = require('express');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');
const HelpConversation = require('../models/HelpConversation');
const User = require('../models/User');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const Announcement = require('../models/Announcement');

const router = express.Router();

// Helper to emit socket events if socket.io present
function emitIO(req, event, payload) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    // admins room
    io.to('admins').emit(event, payload);
  } catch (e) { console.warn('emitIO failed', e); }
}


// POST /api/help/messages  -> user sends a message (creates conversation if needed)
router.post('/messages', authMiddleware, async (req, res) => {
  try {
    const textRaw = (req.body.text || '').toString().trim();
    if (!textRaw) return res.status(400).json({ error: 'Message text required' });
    const text = sanitizeHtml(textRaw, { allowedTags: [], allowedAttributes: {} }).slice(0,2000);

    let conv = await HelpConversation.findOne({ userId: req.user._id });
    if (!conv) {
      conv = await HelpConversation.create({
        userId: req.user._id,
        userName: req.user.fullName || '',
        userUsername: req.user.username || '',
        messages: [],
        lastMessage: text
      });
    }

    conv.messages.push({ sender: 'user', text, createdAt: new Date(), readByAdmin: false, readByUser: true });
    conv.lastMessage = text;
    conv.updatedAt = new Date();
    await conv.save();

    // notify admins via socket.io if available
    emitIO(req, 'help:new-message', { conversationId: conv._id, userId: String(req.user._id), userName: conv.userName, lastMessage: conv.lastMessage });

    res.json({ ok: true, conversation: conv });
  } catch (err) {
    console.error('help.messages.post', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/help/my -> get the current user's conversation and messages
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const conv = await HelpConversation.findOne({ userId: req.user._id }).lean();
    if (!conv) return res.json({ conversation: null });
    res.json({ conversation: conv });
  } catch (err) {
    console.error('help.my.get', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- Admin endpoints (admins only) ---------- */

// GET /api/help/conversations  -> list all conversation threads (latest first)
router.get('/conversations', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit || '100', 10));
    const convs = await HelpConversation.find({}).sort({ updatedAt: -1 }).limit(limit).select('userId userName userUsername lastMessage updatedAt messages').lean();
    // compute unread counts for admin
    const list = convs.map(c => ({
      _id: c._id,
      userId: c.userId,
      userName: c.userName,
      userUsername: c.userUsername,
      lastMessage: c.lastMessage,
      updatedAt: c.updatedAt,
      unreadForAdmin: (Array.isArray(c.messages) ? c.messages.filter(m => !m.readByAdmin && m.sender === 'user').length : 0)
    }));
    res.json({ conversations: list });
  } catch (err) {
    console.error('help.conversations.list', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/help/conversations/:id -> admin reads a conversation (and mark user messages as read by admin)
router.get('/conversations/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const conv = await HelpConversation.findById(id);
    if (!conv) return res.status(404).json({ error: 'Not found' });

    // mark user messages readByAdmin
    let changed = false;
    conv.messages.forEach(m => { if (m.sender === 'user' && !m.readByAdmin) { m.readByAdmin = true; changed = true; } });
    if (changed) { conv.updatedAt = new Date(); await conv.save(); }

    // populate some user info if available
    const user = await User.findById(conv.userId).select('fullName username email').lean();
    return res.json({ conversation: conv.toObject(), user });
  } catch (err) {
    console.error('help.conversations.get', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/help/conversations/:id/reply -> admin replies to user
router.post('/conversations/:id/reply', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const textRaw = (req.body.text || '').toString().trim();
    if (!textRaw) return res.status(400).json({ error: 'Message text required' });
    const text = sanitizeHtml(textRaw, { allowedTags: [], allowedAttributes: {} }).slice(0,2000);

    const conv = await HelpConversation.findById(id);
    if (!conv) return res.status(404).json({ error: 'Not found' });

    conv.messages.push({ sender: 'admin', text, createdAt: new Date(), readByAdmin: true, readByUser: false });
    conv.lastMessage = text;
    conv.updatedAt = new Date();
    await conv.save();

    // notify user room via socket if available
    try { const io = req.app.get('io'); if (io) io.to('user:' + String(conv.userId)).emit('help:admin-reply', { conversationId: conv._id, text }); } catch(e){}

    res.json({ ok: true, conversation: conv });
  } catch (err) {
    console.error('help.conversations.reply', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/help/conversations/:id/mark-read (admin) optional -> mark all as readByAdmin
router.post('/conversations/:id/mark-read', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const conv = await HelpConversation.findById(id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    let changed = false;
    conv.messages.forEach(m => { if (m.sender === 'user' && !m.readByAdmin) { m.readByAdmin = true; changed = true; } });
    if (changed) { conv.updatedAt = new Date(); await conv.save(); }
    res.json({ ok: true });
  } catch (err) {
    console.error('help.conversations.markread', err);
    res.status(500).json({ error: 'Server error' });
  }
});

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

