// backend/src/routes/stories.js
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const StoryFolder = require('../models/StoryFolder');
const Story = require('../models/Story');
const Comment = require('../models/Comment');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { JWT_SECRET } = require('../config') || process.env;



function normalizeStory(s){
  const obj = s.toObject ? s.toObject() : s;
  obj.reactionCounts = obj.reactionCounts || { like:0, love:0, haha:0, wow:0, angry:0, sad:0 };
  if (obj.reactionsByUser && obj.reactionsByUser.entries) {
    try { obj.reactionsByUser = Object.fromEntries(Array.from(obj.reactionsByUser.entries())); } catch(e){ obj.reactionsByUser = obj.reactionsByUser || {}; }
  }
  obj.reactionsByUser = obj.reactionsByUser || {};
  obj.readBy = (obj.readBy || []).map(String); // <--- normalize
  return obj;
}

// helper to optionally extract userId from Authorization header.
// returns userId string or null (does not error)
function getUserIdFromAuthHeader(req){
  try {
    const auth = (req.headers.authorization || '').trim();
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    const token = m[1];
    if (!JWT_SECRET) return null;
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && (payload.id || payload._id || payload.userId) ? String(payload.id || payload._id || payload.userId) : null;
  } catch(err){
    return null;
  }
}

/* =============== FOLDERS =============== */
// list folders (non-deleted)
// optional query ?mine=true -> only folders created by current user (requires bearer token)
router.get('/folders', async (req,res) => {
  try {
    const q = { isDeleted: false };
    if (String(req.query.mine).toLowerCase() === 'true') {
      const userId = getUserIdFromAuthHeader(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      q.createdBy = userId;
    }
    const folders = await StoryFolder.find(q).sort({ createdAt: -1 }).lean();
    return res.json({ folders });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// --- Allow authenticated users to create folders (so they can add folder when submitting) ---
// Replace earlier admin-only /folders POST with this (requires authentication only)
router.post('/folders', requireAuth, async (req, res) => {
  try {
    const { nameEng, nameSom } = req.body;
    if (!nameEng) return res.status(400).json({ error: 'nameEng required' });
    const f = await StoryFolder.create({ nameEng, nameSom, createdBy: String(req.user._id) });
    return res.json({ folder: f });
  } catch (err) { console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* ========== USER SUBMISSIONS ========== */

// Create user-submitted story (requests approval). Anyone logged in can submit.
// POST /user/stories  body: { folderId?, titleEng, titleSom, contentEng, contentSom }
router.post('/user/stories', requireAuth, async (req, res) => {
  try {
    const { folderId, titleEng, titleSom, contentEng, contentSom } = req.body;
    if (!(titleEng || titleSom)) return res.status(400).json({ error: 'Title required' });
    if (!(contentEng || contentSom)) return res.status(400).json({ error: 'Content required' });

    const s = await Story.create({
      folderId: folderId || null,
      titleEng, titleSom, contentEng, contentSom,
      published: false,
      pendingApproval: true,
      authorId: String(req.user._id),
      authorName: req.user.fullName || req.user.username || 'User',
      createdBy: String(req.user._id)
    });
    // notify admins via socket if available
    req.app.get('io')?.emit('stories:newPending', { storyId: s._id });
    return res.json({ ok:true, story: s });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// Get current user's submissions (drafts/pending/published) -> GET /user/stories
router.get('/user/stories', requireAuth, async (req, res) => {
  try {
    const stories = await Story.find({ authorId: String(req.user._id) }).sort({ createdAt: -1 }).lean();
    return res.json({ stories });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// User edits their story: will set pendingApproval=true and published=false so admin verifies update
// PUT /user/stories/:id  body: { folderId?, titleEng, titleSom, contentEng, contentSom }
router.put('/user/stories/:id', requireAuth, async (req, res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (String(s.authorId) !== String(req.user._id) && !(req.user.role === 'admin' || req.user.isAdmin)) {
      return res.status(403).json({ error: 'Not allowed' });
    }

    // apply edits
    s.titleEng = req.body.titleEng !== undefined ? req.body.titleEng : s.titleEng;
    s.titleSom = req.body.titleSom !== undefined ? req.body.titleSom : s.titleSom;
    s.contentEng = req.body.contentEng !== undefined ? req.body.contentEng : s.contentEng;
    s.contentSom = req.body.contentSom !== undefined ? req.body.contentSom : s.contentSom;
    s.folderId = req.body.folderId !== undefined ? req.body.folderId : s.folderId;
    s.updatedAt = new Date();

    // if edited by user (not admin) require re-verification
    if (!(req.user.role === 'admin' || req.user.isAdmin)) {
      s.pendingApproval = true;
      s.published = false;
    }
    await s.save();
    // notify admins
    req.app.get('io')?.emit('stories:editedPending', { storyId: s._id });
    return res.json({ ok:true, story: s });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// User requests deletion: set pendingDelete=true (admin must confirm)
// POST /user/stories/:id/request-delete
router.post('/user/stories/:id/request-delete', requireAuth, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (String(s.authorId) !== String(req.user._id) && !(req.user.role === 'admin' || req.user.isAdmin)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    s.pendingDelete = true;
    await s.save();
    req.app.get('io')?.emit('stories:deleteRequested', { storyId: s._id });
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* ========== ADMIN REVIEW ========== */

// List pending stories for admin review
// GET /stories/pending
router.get('/stories/pending', requireAuth, requireAdmin, async (req,res) => {
  try {
    const pending = await Story.find({ isDeleted: false, $or: [{ pendingApproval: true }, { pendingDelete: true } ] }).sort({ createdAt: -1 }).lean();
    return res.json({ stories: pending });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// Admin approves a pending story (publish it)
// POST /stories/:id/approve
router.post('/stories/:id/approve', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.published = true;
    s.pendingApproval = false;
    s.pendingDelete = false;
    s.updatedAt = new Date();
    await s.save();
    req.app.get('io')?.emit('stories:approved', { storyId: s._id });
    return res.json({ ok:true, story: s });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// Admin rejects a pending story (keep it unpublished and clear pendingApproval)
// POST /stories/:id/reject
router.post('/stories/:id/reject', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.pendingApproval = false;
    s.published = false;
    s.updatedAt = new Date();
    await s.save();
    req.app.get('io')?.emit('stories:rejected', { storyId: s._id });
    return res.json({ ok:true, story: s });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// Admin confirms deletion: permanently delete
// POST /stories/:id/confirm-delete
router.post('/stories/:id/confirm-delete', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    await Story.deleteOne({ _id: s._id });
    await Comment.deleteMany({ storyId: s._id });
    req.app.get('io')?.emit('stories:deleted', { storyId: s._id });
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});











// update folder
router.put('/folders/:id', requireAuth, requireAdmin, async (req,res) => {
  try {
    const f = await StoryFolder.findById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    f.nameEng = req.body.nameEng || f.nameEng;
    f.nameSom = req.body.nameSom || f.nameSom;
    await f.save();
    res.json({ folder: f });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// soft delete (archive)
router.delete('/folders/:id', requireAuth, requireAdmin, async (req,res) => {
  try {
    const f = await StoryFolder.findById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    f.isDeleted = true;
    await f.save();
    // also soft-delete stories under it
    await Story.updateMany({ folderId: f._id }, { $set: { isDeleted: true }});
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// restore folder
router.post('/folders/:id/restore', requireAuth, requireAdmin, async (req,res) => {
  try {
    const f = await StoryFolder.findById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    f.isDeleted = false; await f.save();
    await Story.updateMany({ folderId: f._id }, { $set: { isDeleted: false }});
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// permanently delete folder and stories
router.delete('/folders/:id/permanent', requireAuth, requireAdmin, async (req,res) => {
  try {
    const f = await StoryFolder.findById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    await Story.deleteMany({ folderId: f._id });
    await f.remove();
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* =============== STORIES =============== */

// list all stories (non-deleted)
// optional query ?mine=true -> only stories created by current user (requires bearer token)
router.get('/stories', async (req,res) => {
  try {
    const q = { isDeleted: false };
    if (String(req.query.mine).toLowerCase() === 'true') {
      const userId = getUserIdFromAuthHeader(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      q.createdBy = userId;
    }
    const stories = await Story.find(q).sort({ createdAt: -1 }).lean();
    const enriched = stories.map(normalizeStory);
    return res.json({ stories: enriched });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// list stories in folder
// optional ?mine=true to only include stories createdBy this user
router.get('/folders/:id/stories', async (req,res) => {
  try {
    const q = { folderId: req.params.id, isDeleted: false };
    if (String(req.query.mine).toLowerCase() === 'true') {
      const userId = getUserIdFromAuthHeader(req);
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      q.createdBy = userId;
    }
    const stories = await Story.find(q).sort({ createdAt: -1 }).lean();
    return res.json({ stories: stories.map(normalizeStory) });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// create story (admin)
router.post('/folders/:id/stories', requireAuth, requireAdmin, async (req,res) => {
  try {
    const folder = await StoryFolder.findById(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    const { titleEng, titleSom, contentEng, contentSom } = req.body;
    const s = await Story.create({
      folderId: folder._id,
      titleEng, titleSom, contentEng, contentSom,
      createdBy: String(req.user._id)
    });
    return res.json({ story: normalizeStory(s) });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// get story with top reaction and comments
router.get('/stories/:id', async (req,res) => {
  try {
    const s = await Story.findById(req.params.id).lean();
    if (!s) return res.status(404).json({ error: 'Not found' });
    const comments = await Comment.find({ storyId: s._id, isDeleted: false, parentId: null }).sort({ isPinned: -1, createdAt: -1 }).lean();
    // attach replies for each comment
    for (let c of comments){
      const replies = await Comment.find({ parentId: c._id, isDeleted: false }).sort({ createdAt: 1 }).lean();
      c.replies = replies;
    }
    return res.json({ story: normalizeStory(s), comments });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// update story (admin)
router.put('/stories/:id', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.titleEng = req.body.titleEng !== undefined ? req.body.titleEng : s.titleEng;
    s.titleSom = req.body.titleSom !== undefined ? req.body.titleSom : s.titleSom;
    s.contentEng = req.body.contentEng !== undefined ? req.body.contentEng : s.contentEng;
    s.contentSom = req.body.contentSom !== undefined ? req.body.contentSom : s.contentSom;
    s.updatedAt = new Date();
    await s.save();
    return res.json({ story: normalizeStory(s) });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// soft-delete story
router.delete('/stories/:id', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.isDeleted = true; await s.save();
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// restore story
router.post('/stories/:id/restore', requireAuth, requireAdmin, async (req,res) => {
  try {
    const s = await Story.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.isDeleted = false; await s.save();
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// permanently delete story
router.delete('/stories/:id/permanent', requireAuth, requireAdmin, async (req,res) => {
  try {
    await Story.deleteOne({ _id: req.params.id });
    await Comment.deleteMany({ storyId: req.params.id });
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* ========== Reactions ========== */
// story reaction (toggle)
router.post('/stories/:id/reactions', requireAuth, async (req,res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });
    const { reaction } = req.body;
    const userId = String(req.user._id);
    // allow passing null or '' to remove reaction
    if (!reaction) {
      story.applyReaction(userId, null);
    } else {
      if (!['like','love','haha','wow','angry','sad'].includes(reaction)) return res.status(400).json({ error: 'Invalid reaction' });
      story.applyReaction(userId, reaction);
    }
    await story.save();
    req.app.get('io')?.emit('stories:update', { storyId: story._id });
    return res.json({ ok:true, story: normalizeStory(story) });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// mark read (add userId to readBy)
router.post('/stories/:id/read', requireAuth, async (req,res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });
    const uid = String(req.user._id);
    const existing = (story.readBy || []).map(String);
    if (!existing.includes(uid)) {
      story.readBy.push(uid);
      await story.save();
    }
        return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* ========== Comments & Replies ========== */
// list comments for story (top-level only)
router.get('/stories/:id/comments', async (req,res) => {
  try {
    const comments = await Comment.find({ storyId: req.params.id, parentId: null, isDeleted: false }).sort({ isPinned: -1, createdAt: -1 }).lean();
    for (let c of comments){
      const replies = await Comment.find({ parentId: c._id, isDeleted: false }).sort({ createdAt: 1 }).lean();
      c.replies = replies;
      // prepare reactionCounts map for frontend (normalize Map -> object)
      if (c.reactionCounts && c.reactionCounts.entries) {
        try {
          c.reactionCounts = Object.fromEntries(Array.from(c.reactionCounts.entries()));
        } catch(e) { c.reactionCounts = c.reactionCounts || {}; }
      }
    }
    return res.json({ comments });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// add comment
router.post('/stories/:id/comments', requireAuth, async (req,res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const c = await Comment.create({
      storyId: req.params.id,
      parentId: null,
      userId: req.user._id,
      userName: req.user.fullName || req.user.username || 'User',
      content,
      isAdmin: !!(req.user.role === 'admin' || req.user.isAdmin)
    });
    req.app.get('io')?.emit('comments:new', { storyId: req.params.id });
    return res.json({ comment: c });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// reply to comment
router.post('/comments/:id/reply', requireAuth, async (req,res) => {
  try {
    const parent = await Comment.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Parent comment not found' });
    const { content } = req.body; if (!content) return res.status(400).json({ error: 'Content required' });
    const c = await Comment.create({
      storyId: parent.storyId,
      parentId: parent._id,
      userId: req.user._id,
      userName: req.user.fullName || req.user.username || 'User',
      content,
      isAdmin: !!(req.user.role === 'admin' || req.user.isAdmin)
    });
    req.app.get('io')?.emit('comments:new', { storyId: parent.storyId });
    return res.json({ comment: c });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// react to comment
router.post('/comments/:id/reactions', requireAuth, async (req,res) => {
  try {
    const c = await Comment.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Comment not found' });
    const { reaction } = req.body;
    const uid = String(req.user._id);
    // use schema method (assumes Comment has applyReaction like Story)
    c.applyReaction(uid, reaction);
    c.updatedAt = new Date();
    await c.save();
    req.app.get('io')?.emit('comments:update', { storyId: c.storyId });
    return res.json({ ok:true, comment: c });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// delete comment (owner or admin) -> fully remove doc
router.delete('/comments/:id', requireAuth, async (req,res) => {
  try {
    const c = await Comment.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const isOwner = String(c.userId) === String(req.user._id);
    const isAdminReq = (req.user.role === 'admin' || req.user.isAdmin);
    if (!isOwner && !isAdminReq) return res.status(403).json({ error: 'Not allowed' });
    await Comment.deleteMany({ _id: c._id }); // remove this comment
    // also remove replies
    await Comment.deleteMany({ parentId: c._id });
    req.app.get('io')?.emit('comments:deleted', { storyId: c.storyId });
    return res.json({ ok:true });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

// pin/unpin comment (admin)
router.post('/comments/:id/pin', requireAuth, requireAdmin, async (req,res) => {
  try {
    const c = await Comment.findById(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.isPinned = !c.isPinned; await c.save();
    return res.json({ ok:true, pinned: c.isPinned });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

/* ========== Recycle list ========== */
// get items in recycle (admin)
router.get('/recycle', requireAuth, requireAdmin, async (req,res) => {
  try {
    const folders = await StoryFolder.find({ isDeleted: true }).lean();
    const stories = await Story.find({ isDeleted: true }).lean();
    return res.json({ folders, stories });
  } catch(err){ console.error(err); return res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
