// backend/src/routes/admin.js
const express = require('express');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');

const User = require('../models/User');
const Competition = require('../models/Competition');
const Folder = require('../models/Folder');   // adjust path if your model file name differs
const Lesson = require('../models/Lesson');   // adjust path if necessary

const bcrypt = require('bcrypt');

// Admin: list and verify withdrawals
const Withdrawal = require('../models/Withdrawal');
// IMPORT BOTH middlewares
const { authMiddleware, requireAdmin } = require('../middleware/auth');

// Per-24-hour withdrawal cap (dollars) — keep in sync with account.js
const WITHDRAWAL_24H_CAP = 100.0;
const MIN_WITHDRAW_AMOUNT = 30.0; // optional (if admin uses it)

// near top of admin.js add:
function toOid(id) {
  try { return new mongoose.Types.ObjectId(id); }
  catch (e) { return id; }
}
const router = express.Router();


// near top of backend/src/routes/admin.js (ensure authMiddleware is imported)
router.post('/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const bodyUsername = String(req.body.username || '').trim();
    const fullName = sanitizeHtml(String(req.body.fullName || '').trim());
    const password = String(req.body.password || '');
    const roleRequested = String(req.body.role || 'user').trim().toLowerCase();

    if (!bodyUsername || !fullName || !password) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password too short (min 6 characters)' });
    }

    const ALLOWED = ['admin','controller','user'];
    if (!ALLOWED.includes(roleRequested)) {
      return res.status(400).json({ ok: false, error: 'Invalid role' });
    }

    const usernameNormalized = bodyUsername.toLowerCase();
    const isEmail = bodyUsername.indexOf('@') !== -1;
    const emailNormalized = isEmail ? usernameNormalized : null;

    const existing = await User.findOne({
      $or: [
        { usernameNormalized: usernameNormalized },
        { username: { $regex: `^${bodyUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
        ...(isEmail ? [{ email: { $regex: `^${bodyUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }] : [])
      ]
    }).lean();

    if (existing) {
      return res.status(400).json({ ok: false, error: 'Username or email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);

    const userDoc = {
      username: bodyUsername,
      usernameNormalized,
      fullName,
      passwordHash: hash,
      role: roleRequested,
      email: emailNormalized || null
    };

    const user = await User.create(userDoc);

    return res.json({
      ok: true,
      user: {
        id: user._id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        email: user.email
      }
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.name === 'MongoError' && err.code === 11000)) {
      return res.status(400).json({ ok: false, error: 'Username or email already exists' });
    }
    console.error('POST /api/admin/users error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ---------- Admin: clear points ---------- */
router.post('/users/:id/clear-points', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const uid = req.params.id;
    const u = await User.findByIdAndUpdate(uid, { pointsCurrent: 0, pointsResetAt: new Date() }, { new: true });
    return res.json({ ok: true, user: u });
  } catch (err) {
    console.error('admin.clearpoints', err);
    res.status(500).json({ error: 'Server error' });
  }
});

function localUserFilter() {
  return {
    isDeleted: { $ne: true },
    $or: [
      { provider: { $exists: false } },
      { provider: null },
      { provider: 'local' },
      { passwordHash: { $exists: true } }
    ]
  };
}

// Add near top: (keep existing requires / router variable)
/**
 * Support /api/admin/stats (legacy frontend path) by redirecting to /api/admin/dashboard
 * so older frontend code that requests /api/admin/stats will still work.
 */
router.get('/stats', authMiddleware, requireAdmin, (req, res) => {
  // Redirect will instruct browser to fetch the already-implemented /dashboard handler.
  // This keeps the logic in one place.
  return res.redirect('/api/admin/dashboard');
});

/**
 * POST /api/admin/competitions/archive
 * Admin-only: force-run the archive job (same as earlier archive runner).
 * The job starter (job.start) should have set app.locals.runArchive.
 */
router.post('/competitions/archive', authMiddleware, requireAdmin, async (req, res) => {
  try {
    if (!req.app.locals || typeof req.app.locals.runArchive !== 'function') {
      return res.status(500).json({ error: 'Archive runner not configured' });
    }
    await req.app.locals.runArchive();
    return res.json({ ok: true });
  } catch (err) {
    console.error('admin.competitions.archive', err);
    return res.status(500).json({ error: 'Archive failed' });
  }
});

/* GET /api/admin/users?page&limit&search */
router.get('/users', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(500, parseInt(req.query.limit || '100', 10));
    const search = (req.query.search || '').trim();

    const q = localUserFilter();

    if (search) {
      q.$and = q.$and || [];
      q.$and.push({
        $or: [
          { username: { $regex: search, $options: 'i' } },
          { fullName: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      });
    }

    const users = await User.find(q)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const payload = users.map(u => ({
      _id: u._id,
      username: u.username,
      fullName: u.fullName,
      email: u.email,
      role: u.role,
      pointsCurrent: u.pointsCurrent || 0,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    }));

    res.json({ users: payload });
  } catch (err) {
    console.error('admin.users.list', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/admin/dashboard */
router.get('/dashboard', authMiddleware, requireAdmin, async (req, res) => {
  try {
    // query params
    const period = (req.query.period || 'live'); // live|daily|weekly|monthly|yearly
    const authorOnly = req.query.authorOnly === '0' ? false : true; // default: true (only mine)
    const userId = req.user._id;

    // compute period start
    function periodStart(periodKey) {
      const now = new Date();
      if (periodKey === 'live') {
        const d = new Date();
        d.setTime(now.getTime() - (24 * 3600 * 1000)); // last 24 hours
        return d;
      }
      if (periodKey === 'daily') {
        const d = new Date(now);
        d.setHours(0,0,0,0);
        return d;
      }
      if (periodKey === 'weekly') {
        const d = new Date(now);
        d.setDate(d.getDate() - 6); // last 7 days including today
        d.setHours(0,0,0,0);
        return d;
      }
      if (periodKey === 'monthly') {
        return new Date(now.getFullYear(), now.getMonth(), 1, 0,0,0,0);
      }
      if (periodKey === 'yearly') {
        return new Date(now.getFullYear(), 0, 1, 0,0,0,0);
      }
      // default fallback to last 24h
      const d = new Date();
      d.setTime(now.getTime() - (24 * 3600 * 1000));
      return d;
    }

    const startDate = periodStart(period);

    // base filter for folders/lessons (optionally only those created by this admin)
    const baseFolderFilter = { createdAt: { $gte: startDate } };
    const baseLessonFilter = { createdAt: { $gte: startDate } };
    if (authorOnly) {
      baseFolderFilter.authorId = userId;
      baseLessonFilter.authorId = userId;
    }

    // totals
    const totalUsers = await User.countDocuments(localUserFilter());
    const totalFolders = await Folder.countDocuments(baseFolderFilter);
    const totalLessons = await Lesson.countDocuments(baseLessonFilter);

    // current competition and top10 (top users global still)
    let current = await Competition.findOne({ isActive: true }).sort({ startDate: -1 }).lean();
    if (!current) {
      // fallback to latest competition (allow admin to see & reactivate)
      current = await Competition.findOne({}).sort({ startDate: -1 }).lean();
    }
        const top = await User.find(localUserFilter()).sort({ pointsCurrent: -1 }).limit(10).select('fullName pointsCurrent username').lean();
    const top10 = (top || []).map(u => ({ userId: u._id, fullName: u.fullName, username: u.username, points: u.pointsCurrent }));

    // small aggregation for folders & lessons by day (useful for charts)
    // group by YYYY-MM-DD
    const folderAgg = await Folder.aggregate([
      { $match: baseFolderFilter },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    const lessonAgg = await Lesson.aggregate([
      { $match: baseLessonFilter },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    // folder distribution for top parents (no author filter here; optional)
    let foldersByParent = [];
    try {
      foldersByParent = await Folder.aggregate([
        { $match: authorOnly ? { authorId: userId } : {} },
        { $group: { _id: { $ifNull: ["$parentId", "ROOT"] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]);
    } catch (e) {
      console.warn('foldersByParent aggregate failed', e);
      foldersByParent = [];
    }

    return res.json({
      totalUsers,
      totalFolders,
      totalLessons,
      currentCompetition: current,
      top10,
      charts: {
        usersByDay: [], // keep existing usersByDay chart unchanged (frontend still builds it from other routes)
        foldersByParent,
        foldersByDay: folderAgg,
        lessonsByDay: lessonAgg
      }
    });
  } catch (err) {
    console.error('admin.dashboard', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/* Activate / Deactivate competition */

// inside backend/src/routes/admin.js (replace existing activate/deactivate handlers)

router.post('/competitions/:id/activate', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const compId = req.params.id;

    // find competition
    const comp = await Competition.findById(compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    if (comp.isActive) {
      return res.json({ ok: true, message: 'Competition already active', competition: comp });
    }

    // set all others inactive and activate this one
    await Competition.updateMany({ isActive: true }, { $set: { isActive: false } });
    comp.isActive = true;
    comp.updatedAt = new Date();

    // If there is a snapshot that indicates zeroed points, restore them
    if (comp.snapshot && comp.snapshot.zeroed && Array.isArray(comp.snapshot.userPoints)) {
      // restore in batches to avoid huge single update - use bulkWrite
      const bulk = comp.snapshot.userPoints.map(up => ({
        updateOne: {
          filter: { _id: up.userId },
          update: { $set: { pointsCurrent: Number(up.points || 0) } }
        }
      }));
      if (bulk.length) await User.bulkWrite(bulk, { ordered: false });

      // clear snapshot after restore (optional)
      comp.snapshot = undefined;
    }

    await comp.save();

    const io = req.app.get('io');
    if (io) io.emit('competition:changed', { competitionId: String(comp._id), activatedBy: String(req.user._id) });

    return res.json({ ok: true, competition: comp });
  } catch (err) {
    console.error('admin.activateCompetition', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/competitions/:id/deactivate', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const compId = req.params.id;
    const zeroPoints = req.query.zero === '1' || req.body.zero === true; // optional query/body flag

    const comp = await Competition.findById(compId);
    if (!comp) return res.status(404).json({ error: 'Competition not found' });

    if (!comp.isActive) {
      return res.json({ ok: true, message: 'Competition already inactive', competition: comp });
    }

    // snapshot current points for local users (or all users if you prefer)
    const users = await User.find({ isDeleted: { $ne: true } }).select('_id pointsCurrent').lean();
    const userPoints = users.map(u => ({ userId: u._id, points: Number(u.pointsCurrent || 0) }));

    // store snapshot in competition
    comp.snapshot = {
      createdAt: new Date(),
      zeroed: !!zeroPoints,
      userPoints,
      note: zeroPoints ? 'Zeroed on deactivate' : 'Snapshot on deactivate (not zeroed)'
    };

    // mark inactive
    comp.isActive = false;
    comp.updatedAt = new Date();
    await comp.save();

    // if zeroPoints requested, zero them now
    if (zeroPoints && userPoints.length) {
      // bulk update users: set pointsCurrent = 0 and record pointsResetAt
      const bulk = userPoints.map(up => ({
        updateOne: {
          filter: { _id: up.userId },
          update: { $set: { pointsCurrent: 0, pointsResetAt: new Date() } }
        }
      }));
      if (bulk.length) await User.bulkWrite(bulk, { ordered: false });
    }

    const io = req.app.get('io');
    if (io) io.emit('competition:changed', { competitionId: String(comp._id), deactivatedBy: String(req.user._id) });

    return res.json({ ok: true, competition: comp, zeroed: !!zeroPoints, snapshotCount: userPoints.length });
  } catch (err) {
    console.error('admin.deactivateCompetition', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



// GET /api/admin/withdrawals  (admin: list pending and recent)
// router.get('/withdrawals', authMiddleware, requireAdmin, async (req, res) => {
//   try {
//     const q = {};
//     if (req.query.status) q.status = req.query.status;
//     const list = await Withdrawal.find(q).sort({ requestedAt: -1 }).limit(200).populate('userId', 'fullName username email').lean();
//     res.json({ withdrawals: list });
//   } catch (err) {
//     console.error('admin.withdrawals.list', err);
//     res.status(500).json({ error: 'Server error' });
//   }
// });

// SERVER-SIDE (Express + Mongoose)
// Put this in the same router file where you handle admin withdraws.
// Assumes Withdrawal model, User model, authMiddleware, requireAdmin, toOid helper exist.

const MS_24H = 24 * 3600 * 1000;

router.get('/withdrawals', authMiddleware, requireAdmin, async (req, res) => {
  try {
    // optional: allow status filter, keep your existing q
    const q = {};
    if (req.query.status) q.status = req.query.status;

    // fetch recent withdrawals (same as before)
    const list = await Withdrawal.find(q)
      .sort({ requestedAt: -1 })
      .limit(200)
      .populate('userId', 'fullName username email')
      .lean();

    // If no results, quick-return empty
    if (!list || !list.length) {
      return res.json({ withdrawals: [] });
    }

    // Collect unique user ids from the list (could be strings or ObjectIds)
    const userIdSet = new Set();
    list.forEach(w => {
      if (w.userId && (typeof w.userId === 'object' || mongoose.isValidObjectId(w.userId))) {
        // if populated object, use its _id; if string, use string
        const uid = (typeof w.userId === 'object') ? String(w.userId._id || w.userId.id || '') : String(w.userId);
        if (uid) userIdSet.add(uid);
      } else if (w.userId) {
        userIdSet.add(String(w.userId));
      }
    });

    const userIds = Array.from(userIdSet).filter(Boolean);
    // if no user ids, return list as-is
    if (!userIds.length) {
      return res.json({ withdrawals: list });
    }

    // Aggregate verified counts/amount per user in the last 24h
    const since = new Date(Date.now() - MS_24H);

    // Use aggregate pipeline to compute per-user totals and counts (verified)
    const agg = await Withdrawal.aggregate([
      { $match: { userId: { $in: userIds.map(id => {
          try { return toOid(id); } catch(e) { return String(id); }
        }) },
        status: 'verified',
        verifiedAt: { $gte: since }
      }},
      { $group: {
          _id: '$userId',
          verifiedAmount24: { $sum: '$amount' },
          verifiedCount24: { $sum: 1 }
      }}
    ]);

    // Also compute total requests count (all statuses) in last 24h per user:
    const aggAllCount = await Withdrawal.aggregate([
      { $match: { userId: { $in: userIds.map(id => {
            try { return toOid(id); } catch(e) { return String(id); }
          }) },
          requestedAt: { $gte: since }
      }},
      { $group: { _id: '$userId', requestCount24: { $sum: 1 } } }
    ]);

    // Map aggregated results by userId string
    const statsByUser = {};
    (agg || []).forEach(a => {
      const key = String(a._id);
      statsByUser[key] = statsByUser[key] || {};
      statsByUser[key].verifiedAmount24 = Number((a.verifiedAmount24 || 0).toFixed(6));
      statsByUser[key].verifiedCount24 = Number((a.verifiedCount24 || 0));
    });
    (aggAllCount || []).forEach(a => {
      const key = String(a._id);
      statsByUser[key] = statsByUser[key] || {};
      statsByUser[key].requestCount24 = Number(a.requestCount24 || 0);
    });

    // Attach per-user stats to each withdrawal item (useful for admin UI)
    const enhancedList = list.map(w => {
      let uid = '';
      if (w.userId && typeof w.userId === 'object') uid = String(w.userId._id || w.userId.id || '');
      else uid = String(w.userId || '');
      const st = statsByUser[uid] || { verifiedAmount24: 0, verifiedCount24: 0, requestCount24: 0 };
      // attach non-enumerable? Keep simple: attach as _userStats
      w._userStats = {
        verifiedAmount24: st.verifiedAmount24 || 0,
        verifiedCount24: st.verifiedCount24 || 0,
        requestCount24: st.requestCount24 || 0
      };
      return w;
    });

    return res.json({ withdrawals: enhancedList });
  } catch (err) {
    console.error('admin.withdrawals.list', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

router.post('/withdrawals/:id/verify', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

    const w = await Withdrawal.findById(id);
    if (!w) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });

    if (String(w.status || '').toLowerCase() !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending withdrawals may be verified' });
    }

    // load user
    const user = await User.findById(w.userId);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    // compute verified total in last 24h excluding this withdrawal (if the same doc were verified earlier)
    const since = new Date(Date.now() - MS_24H);

    // aggregate all verified amounts for this user within last 24h excluding current id
    const match = {
      userId: toOid(user._id),
      status: 'verified',
      verifiedAt: { $gte: since }
    };

    const agg = await Withdrawal.aggregate([
      { $match: match },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const verified24 = (agg && agg.length && agg[0].total) ? Number(agg[0].total) : 0;
    const verifiedCount24 = (agg && agg.length && agg[0].count) ? Number(agg[0].count) : 0;

    const remaining = Math.max(0, WITHDRAWAL_24H_CAP - verified24);

    // if verifying this will exceed cap, return error with helpful metadata
    if (Number(w.amount) > remaining) {
      // find earliest verified entry (to compute nextAllowedAt) - if none use earliest pending as fallback
      const oldestVerified = await Withdrawal.findOne({ userId: user._id, status: 'verified', verifiedAt: { $gte: since } }).sort({ verifiedAt: 1 }).lean();
      let nextAllowedAt = null;
      if (oldestVerified && oldestVerified.verifiedAt && verified24 >= WITHDRAWAL_24H_CAP) {
        nextAllowedAt = new Date(new Date(oldestVerified.verifiedAt).getTime() + MS_24H).toISOString();
      }

      return res.status(400).json({
        ok: false,
        error: 'Verifying this withdrawal would exceed the 24h verified cap.',
        remaining: Number(remaining.toFixed(3)),
        cap: WITHDRAWAL_24H_CAP,
        nextAllowedAt,
        verified24: Number(verified24.toFixed(3)),
        verifiedCount24
      });
    }

    // Deduct from user balance (safe numeric handling)
    const balance = Number(user.balanceDollar || 0);
    const deduct = Math.min(balance, Number(w.amount || 0));
    user.balanceDollar = Number((balance - deduct).toFixed(6));

    // mark withdrawal verified
    w.status = 'verified';
    w.verifiedAt = new Date();
    try {
      w.verifiedBy = new mongoose.Types.ObjectId(req.user._id);
    } catch (e) {
      w.verifiedBy = req.user._id;
    }

    // Save both user and withdrawal in parallel
    await Promise.all([ user.save(), w.save() ]);

    // emit socket to notify clients of verification
    const io = req.app.get('io');
    if (io) io.emit('withdrawals:verified', { withdrawal: w });

    return res.json({ ok: true, withdrawal: w, userBalance: user.balanceDollar });
  } catch (err) {
    console.error('admin.withdrawals.verify', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error', message: err.message || String(err) });
  }
});

// then the route:
// router.post('/withdrawals/:id/verify', authMiddleware, requireAdmin, async (req, res) => {
//   try {
//     const id = req.params.id;
//     const w = await Withdrawal.findById(id);
//     if (!w) return res.status(404).json({ error: 'Not found' });
//     if (w.status !== 'pending') return res.status(400).json({ error: 'Not pending' });

//     const user = await User.findById(w.userId);
//     if (!user) return res.status(404).json({ error: 'User not found' });

//     const now = new Date();
//     const since = new Date(now.getTime() - 24 * 3600 * 1000);

//       w.verifiedBy = req.user && req.user._id ? req.user._id : wd.verifiedBy;

//     let verified24 = 0;
//     try {
//       const agg = await Withdrawal.aggregate([
//         { $match: { userId: toOid(user._id), requestedAt: { $gte: since }, status: 'verified' } },
//         { $group: { _id: null, total: { $sum: '$amount' } } }
//       ]);
//       verified24 = (agg[0] && agg[0].total) ? Number(agg[0].total) : 0;
//     } catch (aggErr) {
//       console.warn('verify: aggregation failed', aggErr && aggErr.stack ? aggErr.stack : aggErr);
//       verified24 = 0;
//     }

//     const remaining = Math.max(0, WITHDRAWAL_24H_CAP - verified24);

//     if (Number(w.amount) > remaining) {
//       const oldest = await Withdrawal.findOne({ userId: user._id, requestedAt: { $gte: since }, status: 'verified' }).sort({ requestedAt: 1 }).lean();
//       let nextAllowedAt = null;
//       if (oldest && verified24 >= WITHDRAWAL_24H_CAP) nextAllowedAt = new Date(new Date(oldest.requestedAt).getTime() + 24 * 3600 * 1000).toISOString();

//       return res.status(400).json({
//         error: 'Verifying this withdrawal would exceed the 24h verified cap.',
//         remaining: Number(remaining.toFixed(3)),
//         cap: WITHDRAWAL_24H_CAP,
//         nextAllowedAt
//       });
//     }

//     const balance = Number(user.balanceDollar || 0);
//     const deduct = Math.min(balance, Number(w.amount || 0));
//     user.balanceDollar = Number((balance - deduct).toFixed(6));

//     w.status = 'verified';
//     w.verifiedAt = new Date();
//     // before saving, ensure verifiedBy is set properly
//     try {
//       w.verifiedBy = new mongoose.Types.ObjectId(req.user._id);
//     } catch (e) {
//       w.verifiedBy = req.user._id;
//     }

//     await user.save();
//     await w.save();

//     const io = req.app.get('io');
//     if (io) io.emit('withdrawals:verified', { withdrawal: w });

//     return res.json({ ok: true, withdrawal: w, userBalance: user.balanceDollar });
//   } catch (err) {
//     console.error('admin.withdrawals.verify', err && err.stack ? err.stack : err);
//     return res.status(500).json({ error: 'Server error', message: err.message || String(err) });
//   }
// });




// POST /api/admin/withdrawals/:id/reject  -> mark rejected
router.post('/withdrawals/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const w = await Withdrawal.findById(id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'Can only reject pending requests' });

    w.status = 'rejected';
    w.verifiedAt = new Date();
    w.verifiedBy = req.user._id;
    w.note = (req.body.note || '').toString().slice(0, 200);
    await w.save();

    const io = req.app.get('io');
    if (io) io.emit('withdrawals:rejected', { withdrawal: w });

    return res.json({ ok: true, withdrawal: w });
  } catch (err) {
    console.error('admin.withdrawals.reject', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
