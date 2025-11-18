// backend/src/routes/lessons.js
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const Folder = require('../models/Folder');
const Lesson = require('../models/Lesson');
const User = require('../models/User');
const { JWT_SECRET } = require('../config');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

/* ================= helpers ================= */
function sanitizeFolderNameInput(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { en: sanitizeHtml(raw.trim()), som: '' };
  }
  return {
    en: sanitizeHtml((raw.en||'').toString().trim()),
    som: sanitizeHtml((raw.som||'').toString().trim())
  };
}

function buildTree(folders, lessons, parentId = null) {
  const nodes = [];
  folders
    .filter(f => {
      const pid = f.parentId ? String(f.parentId) : null;
      return pid === (parentId ? String(parentId) : null);
    })
    .forEach(f => {
      const node = {
        _id: f._id,
        name: f.name,
        icon: f.icon,
        isDeleted: !!f.isDeleted,
        createdAt: f.createdAt,
        lessons: (lessons || []).filter(l => l.folderId && String(l.folderId) === String(f._id)).map(l => ({
          _id: l._id,
          title: l.title,
          content: l.content,
          isDeleted: !!l.isDeleted,
        })),
        children: buildTree(folders, lessons, f._id)
      };
      nodes.push(node);
    });
  return nodes;
}

/**
 * Optional authenticate: if Authorization present and valid -> set req.user.
 * If token absent or invalid -> do nothing (guest).
 */
async function optionalAuthenticate(req) {
  try {
    const auth = req.headers && req.headers.authorization;
    if (!auth) return;
    const parts = auth.split(' ');
    if (parts.length !== 2) return;
    const token = parts[1];
    if (!token) return;
    const data = jwt.verify(token, JWT_SECRET);
    if (!data || !data.id) return;
    const user = await User.findById(data.id);
    if (!user || user.isDeleted) return;
    req.user = user;
  } catch (err) {
    // swallow errors so optional auth doesn't block guests
    console.warn('optionalAuthenticate failed:', err && err.message);
  }
}


/* ================= ROUTES (STATIC FIRST) ================= */

// simple GET /api/users/me
router.get('/users/me', authMiddleware, async (req, res) => {
  try {
    const u = await User.findById(req.user._id).lean();
    if (!u) return res.status(404).json({ error:'Not found' });
    return res.json({ user: u });
  } catch (e) { console.error(e); return res.status(500).json({ error:'Server error' }); }
});


/** GET /api/lessons/tree?deleted=1  -> nested tree for frontend
 *  - Public: guests can call it and see folders/lessons
 *  - If token provided and user is admin AND ?deleted=1 -> include deleted entries
 */
router.get('/tree', async (req, res) => {
  try {
    await optionalAuthenticate(req);

    const includeDeleted = req.query.deleted === '1' && req.user && req.user.role === 'admin';
    const folders = await Folder.find(includeDeleted ? {} : { isDeleted: { $ne: true } }).lean();
    const lessons = await Lesson.find(includeDeleted ? {} : { isDeleted: { $ne: true } }).lean();

    folders.sort((a,b) => {
      const aN = (a.name && a.name.en) ? a.name.en : (typeof a.name === 'string' ? a.name : '');
      const bN = (b.name && b.name.en) ? b.name.en : (typeof b.name === 'string' ? b.name : '');
      return String(aN).toLowerCase().localeCompare(String(bN).toLowerCase());
    });

    const tree = buildTree(folders, lessons, null);
    return res.json({ tree });
  } catch (err) {
    console.error('lessons.tree', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/lessons/:id/view  -> increment views (unique per logged-in user when possible)
// POST /api/lessons/:id/view  -> increment views (count every call)
router.post('/:id/view', authMiddleware, async (req, res) => {
  try {
    const lessonId = req.params.id;
    const userId = req.user && req.user._id ? String(req.user._id) : null;

    const lesson = await Lesson.findById(lessonId);
    if (!lesson) return res.status(404).json({ error: 'Not found' });

    // Always increment the persistent counter
    lesson.viewsCount = (lesson.viewsCount || 0) + 1;

    // Optionally keep a viewers list (records each viewer entry; duplicates will represent repeated views)
    if (userId) {
      if (!Array.isArray(lesson.viewers)) lesson.viewers = [];
      lesson.viewers.push(userId); // note: duplicates allowed if you want each view recorded
    }

    await lesson.save();
    return res.json({ ok: true, viewsCount: lesson.viewsCount });
  } catch (err) {
    console.error('lesson.view', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/lessons/:id/favorite  (add favorite)
router.post('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const uid = req.user._id;
    const lid = req.params.id;
    const user = await User.findById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!Array.isArray(user.favorites)) user.favorites = [];
    if (!user.favorites.map(String).includes(String(lid))) user.favorites.push(lid);
    await user.save();
    return res.json({ ok:true, favorites: user.favorites });
  } catch (err) {
    console.error('favorite.add', err);
    return res.status(500).json({ error:'Server error' });
  }
});

// DELETE /api/lessons/:id/favorite  (remove favorite)
router.delete('/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const uid = req.user._id;
    const lid = req.params.id;
    const user = await User.findById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.favorites = (user.favorites || []).filter(x => String(x) !== String(lid));
    await user.save();
    return res.json({ ok:true, favorites: user.favorites });
  } catch (err) {
    console.error('favorite.remove', err);
    return res.status(500).json({ error:'Server error' });
  }
});

/** GET /api/lessons/recycle  (admin) */
router.get('/recycle', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const folders = await Folder.find({ isDeleted: true }).lean();
    const lessons = await Lesson.find({ isDeleted: true }).lean();
    return res.json({ folders, lessons });
  } catch (err) {
    console.error('lessons.recycle', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** GET /api/lessons/folders (list) */
router.get('/folders', authMiddleware, async (req, res) => {
  try {
    if (req.query.deleted === '1') {
      if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
      const folders = await Folder.find({ isDeleted: true }).lean();
      return res.json(folders);
    }
    const folders = await Folder.find({ isDeleted: { $ne: true } }).lean();
    return res.json(folders);
  } catch (err) {
    console.error('folders.get', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/lessons/folders  (admin) */
router.post('/folders', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const nameObj = sanitizeFolderNameInput(req.body.name || '');
    if (!nameObj || !nameObj.en) return res.status(400).json({ error: 'Name required' });
    const folder = await Folder.create({ name: nameObj, parentId: req.body.parentId || null, icon: req.body.icon || '', authorId: req.user._id });
    return res.json({ folder });
  } catch (err) {
    console.error('folders.create', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/lessons/folders/:id (admin) */
router.put('/folders/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name) updates.name = sanitizeFolderNameInput(req.body.name);
    if (req.body.icon !== undefined) updates.icon = req.body.icon;
    updates.updatedAt = new Date();
    const folder = await Folder.findByIdAndUpdate(req.params.id, updates, { new: true });
    return res.json({ folder });
  } catch (err) {
    console.error('folders.update', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/lessons/folders/:id (admin) soft-delete or permanent */
async function softDeleteFolderAndChildren(folderId) {
  const toProcess = [String(folderId)];
  while (toProcess.length) {
    const id = toProcess.pop();
    await Folder.findByIdAndUpdate(id, { isDeleted: true });
    await Lesson.updateMany({ folderId: id }, { $set: { isDeleted: true } });
    const children = await Folder.find({ parentId: id }).lean();
    children.forEach(c => toProcess.push(String(c._id)));
  }
}

async function permanentDeleteFolderAndChildren(folderId) {
  const toProcess = [String(folderId)];
  while (toProcess.length) {
    const id = toProcess.pop();
    await Lesson.deleteMany({ folderId: id });
    const children = await Folder.find({ parentId: id }).lean();
    children.forEach(c => toProcess.push(String(c._id)));
    await Folder.deleteOne({ _id: id });
  }
}

router.delete('/folders/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const perm = req.query.permanent === '1';
    if (perm) {
      await permanentDeleteFolderAndChildren(req.params.id);
      return res.json({ ok: true });
    } else {
      await softDeleteFolderAndChildren(req.params.id);
      return res.json({ ok: true });
    }
  } catch (err) {
    console.error('folders.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/folders/:id/restore', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const toProcess = [String(req.params.id)];
    while (toProcess.length) {
      const id = toProcess.pop();
      await Folder.findByIdAndUpdate(id, { isDeleted: false });
      await Lesson.updateMany({ folderId: id }, { $set: { isDeleted: false } });
      const children = await Folder.find({ parentId: id }).lean();
      children.forEach(c => toProcess.push(String(c._id)));
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('folders.restore', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ================= Lessons CRUD & list (supports ?deleted=1) ================= */

/** GET /api/lessons?deleted=1  - returns flat lessons (for fallback) */
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.query.deleted === '1') {
      if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed' });
      const lessons = await Lesson.find({ isDeleted: true }).lean();
      return res.json(lessons);
    }
    // by default, return tree (frontend uses /tree) but keep a safe fallback
    const folders = await Folder.find({ isDeleted: { $ne: true } }).lean();
    const lessons = await Lesson.find({ isDeleted: { $ne: true } }).lean();
    const tree = buildTree(folders, lessons, null);
    return res.json({ tree });
  } catch (err) {
    console.error('lessons.list', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/lessons  (create) */
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const title = req.body.title || {};
    if (!((title.en||'').trim())) return res.status(400).json({ error: 'Title required' });
    const lesson = await Lesson.create({
      title: { en: sanitizeHtml(title.en||''), som: sanitizeHtml(title.som||'') },
      content: { en: sanitizeHtml((req.body.content||{}).en||''), som: sanitizeHtml((req.body.content||{}).som||'') },
      folderId: req.body.folderId || null,
      authorId: req.user._id,
      createdAt: new Date(),
      updatedAt: new Date(),
      isPublished: req.body.isPublished !== undefined ? !!req.body.isPublished : true
    });
    return res.status(201).json({ lesson });
  } catch (err) {
    console.error('lessons.create', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** PUT /api/lessons/:id (update) */
router.put('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const updates = {};
    if (req.body.title) updates.title = { en: sanitizeHtml(req.body.title.en||''), som: sanitizeHtml(req.body.title.som||'') };
    if (req.body.content) updates.content = { en: sanitizeHtml(req.body.content.en||''), som: sanitizeHtml(req.body.content.som||'') };
    if (req.body.folderId !== undefined) updates.folderId = req.body.folderId;
    if (req.body.isPublished !== undefined) updates.isPublished = !!req.body.isPublished;
    updates.updatedAt = new Date();
    const l = await Lesson.findByIdAndUpdate(req.params.id, updates, { new: true });
    return res.json({ lesson: l });
  } catch (err) {
    console.error('lessons.update', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /api/lessons/:id (soft delete or permanent) */
router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const perm = req.query.permanent === '1';
    const lesson = await Lesson.findById(req.params.id);
    if (!lesson) return res.status(404).json({ error: 'Not found' });
    if (perm) {
      await Lesson.deleteOne({ _id: lesson._id });
      return res.json({ ok: true });
    } else {
      lesson.isDeleted = true;
      await lesson.save();
      return res.json({ ok: true });
    }
  } catch (err) {
    console.error('lessons.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/** POST /api/lessons/:id/restore (admin) */
router.post('/:id/restore', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
    const lesson = await Lesson.findById(req.params.id);
    if (!lesson) return res.status(404).json({ error: 'Not found' });
    lesson.isDeleted = false;
    await lesson.save();
    return res.json({ ok: true, lesson });
  } catch (err) {
    console.error('lessons.restore', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ================= Param route LAST (validate id) ================= */
// GET /api/lessons/:id  (returns lesson + author + viewsCount)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const lesson = await Lesson.findById(id).lean();
    if (!lesson) return res.status(404).json({ error: 'Not found' });

    // populate author display name if possible
    try {
      if (lesson.authorId) {
        const author = await User.findById(lesson.authorId).lean();
        if (author) {
          lesson.author = {
            _id: author._id,
            fullName: author.fullName || ((author.firstName||'') + ' ' + (author.lastName||'')).trim() || author.username || ''
          };
        }
      }
    } catch (e) {
      // ignore author fetch errors
    }

    // return the stored viewsCount (not unique dedupe)
    lesson.viewsCount = lesson.viewsCount || 0;

    return res.json({ lesson });
  } catch (err) {
    console.error('lessons.get', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



module.exports = router;
