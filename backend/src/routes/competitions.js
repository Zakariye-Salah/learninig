// backend/src/routes/competitions.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Competition = require('../models/Competition');
const User = require('../models/User');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

// near other requires at top of file


const router = express.Router();


/**
 * GET /api/competitions/current
 * Return the currently active competition (most recent isActive:true) and top users.
 */
router.get('/current', async (req, res) => {
  try {
    const comp = await Competition.findOne({ isActive: true }).sort({ startDate: -1 }).lean();
    if (!comp) return res.status(404).json({ error: 'No active competition' });

    const users = await User.find({ isDeleted: { $ne: true } })
      .sort({ pointsCurrent: -1 })
      .limit(200)
      .lean();

    const top = users.map(u => ({
      userId: u._id,
      userName: u.fullName || u.username || '',
      points: typeof u.pointsCurrent === 'number' ? u.pointsCurrent : 0
    }));

    return res.json({ competition: comp, top });
  } catch (err) {
    console.error('competitions.current', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/competitions
 * List all competitions (history + current)
 */
router.get('/', async (req, res) => {
  try {
    const comps = await Competition.find({}).sort({ startDate: -1 }).lean();
    return res.json({ competitions: comps });
  } catch (err) {
    console.error('competitions.list', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/competitions
 * Admin only: create a new competition and deactivate previous active one.
 * Body: { name, startDate, endDate }
 * This will snapshot previous active competition (user points) and reset all users' pointsCurrent = 0.
 */
// POST /api/competitions  (replace existing)
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    const { name } = req.body;
    const startDateRaw = ('startDate' in req.body) ? req.body.startDate : undefined;
    const endDateRaw = ('endDate' in req.body) ? req.body.endDate : undefined;

    if (!name) {
      await session.abortTransaction().catch(()=>{});
      session.endSession();
      return res.status(400).json({ error: 'name required' });
    }

    // parse dates robustly
    const parseDateSafe = (v) => {
      if (v === undefined || v === null || String(v).trim() === '') return undefined;
      const d = new Date(v);
      if (isNaN(d.getTime())) return null; // invalid
      return d;
    };

    const startParsed = parseDateSafe(startDateRaw) || new Date();
    const endParsed = parseDateSafe(endDateRaw);

    if (startDateRaw !== undefined && startParsed === null) {
      await session.abortTransaction().catch(()=>{});
      session.endSession();
      return res.status(400).json({ error: 'Invalid startDate' });
    }
    if (endDateRaw !== undefined && endParsed === null) {
      await session.abortTransaction().catch(()=>{});
      session.endSession();
      return res.status(400).json({ error: 'Invalid endDate' });
    }

    // find current active comp and snapshot
    const prev = await Competition.findOne({ isActive: true }).session(session);
    if (prev) {
      const users = await User.find({ isDeleted: { $ne: true } }).select('_id pointsCurrent').lean().session(session);
      const snapshot = {
        createdAt: new Date(),
        zeroed: true,
        userPoints: users.map(u => ({ userId: u._id, points: u.pointsCurrent || 0 }))
      };
      await Competition.updateOne({ _id: prev._id }, { $set: { isActive: false, snapshot, updatedAt: new Date() } }).session(session);
    }

    // create new competition
    const compDoc = {
      name,
      startDate: startParsed,
      endDate: typeof endParsed !== 'undefined' ? endParsed : undefined,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const [created] = await Competition.create([compDoc], { session });

    // reset user points
    const result = await User.updateMany({ isDeleted: { $ne: true } }, { $set: { pointsCurrent: 0, pointsResetAt: new Date() } }).session(session);

    await session.commitTransaction();
    session.endSession();

    const io = req.app.get('io');
    if (io) io.emit('competitions:changed', { action: 'created', competition: created });

    return res.json({ competition: created, modifiedCount: result.modifiedCount || 0 });
  } catch (err) {
    await session.abortTransaction().catch(()=>{});
    session.endSession();
    console.error('competitions.create', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/**
 * PUT /api/competitions/:id
 * Admin only: update competition fields. Body: { name, startDate, endDate, isActive }
 * If isActive true, other competitions are deactivated.
 */
// PUT /api/competitions/:id  (replace existing)
router.put('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const fields = {};
    // Accept fields only if present (so admin can clear by sending empty/null)
    if ('name' in req.body && typeof req.body.name === 'string') fields.name = req.body.name;

    const parseDateSafe = (v) => {
      if (v === undefined || v === null || String(v).trim() === '') return null; // treat explicitly provided empty as "clear"
      const d = new Date(v);
      if (isNaN(d.getTime())) return 'INVALID';
      return d;
    };

    if ('startDate' in req.body) {
      const parsed = parseDateSafe(req.body.startDate);
      if (parsed === 'INVALID') return res.status(400).json({ error: 'Invalid startDate' });
      // if parsed === null => clear (set to null), else set date
      fields.startDate = parsed === null ? null : parsed;
    }
    if ('endDate' in req.body) {
      const parsed = parseDateSafe(req.body.endDate);
      if (parsed === 'INVALID') return res.status(400).json({ error: 'Invalid endDate' });
      fields.endDate = parsed === null ? null : parsed;
    }

    if (typeof req.body.isActive === 'boolean' && req.body.isActive === true) {
      // deactivate others if this becomes active
      await Competition.updateMany({ _id: { $ne: id }, isActive: true }, { $set: { isActive: false, updatedAt: new Date() } });
    }

    fields.updatedAt = new Date();
    const updated = await Competition.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
    if (!updated) return res.status(404).json({ error: 'Not found' });

    const io = req.app.get('io');
    if (io) io.emit('competitions:changed', { action: 'updated', competition: updated });

    return res.json({ competition: updated });
  } catch (err) {
    console.error('competitions.update', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/**
 * DELETE /api/competitions/:id
 * Admin only: delete a competition.
 * If the deleted competition was active, we create a fallback active competition (start=now)
 * to ensure there is always an active comp. (This behavior prevents frontend 404s; modify if you prefer otherwise.)
 */
router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const comp = await Competition.findById(id);
    if (!comp) return res.status(404).json({ error: 'Not found' });

    const wasActive = !!comp.isActive;
    await Competition.deleteOne({ _id: id });

    let createdFallback = null;
    if (wasActive) {
      // create fallback active competition so frontend always has an active comp
      const now = new Date();
      const name = now.toLocaleString('en-US', { year: 'numeric', month: 'long' }) + ' Competition';
      createdFallback = await Competition.create({ name, startDate: now, isActive: true, createdAt: now, updatedAt: now });
    }

    const io = req.app.get('io');
    if (io) io.emit('competitions:changed', { action: 'deleted', deletedId: id, fallback: createdFallback ? createdFallback : null });

    return res.json({ ok: true, deletedId: id, fallback: createdFallback ? createdFallback : undefined });
  } catch (err) {
    console.error('competitions.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Add near top of file with other requires:
const LeaderboardComment = require('../models/LeaderboardComment');

// --- new route: GET /api/competitions/:id/results ---
router.get('/:id/results', async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const comp = await Competition.findById(id).lean();
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    // Prefer stored finalResults if available
    let finalResults = Array.isArray(comp.finalResults) && comp.finalResults.length ? comp.finalResults.slice() : [];
    let computed = false;

    if (!finalResults.length) {
      // 1) If a snapshot exists, use it (preserves archived points)
      if (comp.snapshot && Array.isArray(comp.snapshot.userPoints) && comp.snapshot.userPoints.length) {
        // sort snapshot by points desc and pick top 10
        const sorted = comp.snapshot.userPoints
          .map(u => ({ userId: String(u.userId), points: Number(u.points || 0) }))
          .sort((a,b) => b.points - a.points)
          .slice(0, 10);

        // fetch user names for those ids
        const ids = sorted.map(x => mongoose.Types.ObjectId(x.userId));
        const users = await User.find({ _id: { $in: ids } }).select('fullName username').lean();
        const usersById = users.reduce((acc,u) => { acc[String(u._id)] = u; return acc; }, {});

        finalResults = sorted.map((s, i) => ({
          rank: i+1,
          userId: s.userId,
          fullName: (usersById[s.userId] && (usersById[s.userId].fullName || usersById[s.userId].username)) || 'Unknown',
          points: s.points
        }));
        computed = true;
      } else {
        // 2) Fallback: compute from current users' pointsCurrent (live)
        const users = await User.find({ isDeleted: { $ne: true } })
          .sort({ pointsCurrent: -1 })
          .limit(10)
          .select('fullName username pointsCurrent')
          .lean();

        finalResults = users.map((u, i) => ({
          rank: i+1,
          userId: u._id,
          fullName: u.fullName || u.username || 'Unknown',
          points: Number(u.pointsCurrent || 0)
        }));
        computed = true;
      }
    }

    // Fetch comments for this competition (non-deleted)
    let comments = [];
    try {
      comments = await LeaderboardComment.find({ competitionId: id, isDeleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .select('userId userName content createdAt')
        .lean();
    } catch (e) {
      comments = [];
    }

    return res.json({ competition: comp, finalResults, computed, comments });
  } catch (err) {
    console.error('competitions.results', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


/**
 * DELETE /api/competitions/:id/results
 * Admin only: clear stored finalResults and snapshot.userPoints for a competition,
 * and mark related comments as deleted. This does NOT delete the competition itself.
 */
router.delete('/:id/results', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const comp = await Competition.findById(id);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    // clear stored finalResults and snapshot (keep competition document)
    comp.finalResults = [];
    comp.snapshot = undefined;
    comp.updatedAt = new Date();
    await comp.save();

    // mark any comments for this competition as deleted (soft-delete)
    try {
      await LeaderboardComment.updateMany(
        { competitionId: id, isDeleted: { $ne: true } },
        { $set: { isDeleted: true, deletedAt: new Date(), deletedBy: req.user._id } }
      );
    } catch (e) {
      // non-fatal - log + continue
      console.warn('Failed to mark leaderboard comments deleted for competition', id, e);
    }

    // notify clients (optional)
    const io = req.app.get('io');
    if (io) io.emit('competitions:results-cleared', { competitionId: String(id), clearedBy: String(req.user._id) });

    return res.json({ ok: true, message: 'Competition results cleared' });
  } catch (err) {
    console.error('competitions.clearResults', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



module.exports = router;
