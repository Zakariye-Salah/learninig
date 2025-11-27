// backend/src/routes/account.js
const express = require('express');
const mongoose = require('mongoose');
const sanitizeHtml = require('sanitize-html');

const User = require('../models/User');
const Withdrawal = require('../models/Withdrawal');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Conversion rate: 1 point = 0.003 USD
const POINT_TO_USD = 0.003;

// Per-24-hour withdrawal cap (dollars)
const WITHDRAWAL_24H_CAP = 100.0; // change if needed
const MIN_WITHDRAW_AMOUNT = 30.0;

/** Helper: safe parse number */
function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Helper: robust user DB lookup
 * Accepts req.user that may contain _id (maybe not a real ObjectId), username, or email.
 * Returns user doc (lean) or null.
 */
async function findDbUserFromReqUser(reqUser) {
  if (!reqUser) return null;
  // prefer real ObjectId
  try {
    if (reqUser._id && mongoose.isValidObjectId(reqUser._id)) {
      const u = await User.findById(mongoose.Types.ObjectId(reqUser._id)).lean();
      if (u) return u;
    }
  } catch (e) {
    // ignore and fallback
    console.warn('findDbUserFromReqUser: id->ObjectId lookup failed', e && e.stack ? e.stack : e);
  }

  // fallback by username or email (useful for dev fallback tokens)
  if (reqUser.username || reqUser.email) {
    const q = {};
    if (reqUser.username) q.username = reqUser.username;
    if (reqUser.email) q.email = reqUser.email;
    const u = await User.findOne(q).lean();
    if (u) return u;
  }

  // final fallback: try direct _id as string (sometimes dev/local id maps)
  try {
    if (reqUser._id) {
      const u2 = await User.findOne({ _id: reqUser._id }).lean();
      if (u2) return u2;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

/**
 * GET /api/account/balance
 * Returns: { ok:true, data: { balance: { pointsCurrent, balanceDollar}, user: {...} } }
 */
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      console.warn('account.balance: missing req.user');
      return res.status(400).json({ ok: false, error: 'Invalid user' });
    }

    const u = await findDbUserFromReqUser(req.user);
    if (!u) {
      console.warn('account.balance: user not found for req.user', { reqUser: req.user });
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    return res.json({
      ok: true,
      data: {
        balance: {
          pointsCurrent: Number(u.pointsCurrent || 0),
          balanceDollar: Number((Number(u.balanceDollar || 0)).toFixed(3))
        },
        user: { id: u._id, fullName: u.fullName, username: u.username, email: u.email }
      }
    });
  } catch (err) {
    console.error('account.balance error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/**
 * GET /api/account/users/:id
 * Compatibility: return { user: {...} }
 */
router.get('/users/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    if (!mongoose.Types.ObjectId.isValid(id)) {
      // still allow non-ObjectId string ids if your DB uses string ids
      const u2 = await User.findOne({ _id: id }).select('-passwordHash -salt').lean();
      if (!u2) return res.status(404).json({ error: 'Not found' });
      return res.json({ user: publicizeUser(u2) });
    }
    const u = await User.findById(id).select('-passwordHash -salt').lean();
    if (!u) return res.status(404).json({ error: 'Not found' });
    return res.json({ user: publicizeUser(u) });
  } catch (err) {
    console.error('GET /api/account/users/:id error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});



/* POST /api/account/convert */
router.post('/convert', authMiddleware, async (req, res) => {
  try {
    let convertPoints = req.body.points === undefined ? null : Number(req.body.points);
    if (convertPoints !== null && (!Number.isFinite(convertPoints) || convertPoints < 0)) {
      return res.status(400).json({ ok: false, error: 'Invalid points' });
    }

    const u = await findDbUserFromReqUser(req.user);
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });

    const user = await User.findById(u._id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found on save' });

    const havePoints = Number(user.pointsCurrent || 0);
    if (convertPoints === null) convertPoints = havePoints;
    convertPoints = Math.min(convertPoints, havePoints);

    if (convertPoints <= 0) return res.status(400).json({ ok: false, error: 'No points to convert' });

    const addDollar = convertPoints * POINT_TO_USD;
    user.pointsCurrent = Math.max(0, havePoints - convertPoints);
    user.balanceDollar = Number((Number(user.balanceDollar || 0) + addDollar).toFixed(6));
    await user.save();

    return res.json({ ok: true, data: { convertedPoints: convertPoints, addedDollar: addDollar, balanceDollar: user.balanceDollar, pointsCurrent: user.pointsCurrent } });
  } catch (err) {
    console.error('account.convert error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* POST /api/account/convert-back */
router.post('/convert-back', authMiddleware, async (req, res) => {
  try {
    const amountRequested = req.body.amount === undefined ? null : Number(req.body.amount);
    if (amountRequested !== null && (!Number.isFinite(amountRequested) || amountRequested <= 0)) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }

    const u = await findDbUserFromReqUser(req.user);
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });

    const user = await User.findById(u._id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found on save' });

    const balance = Number(user.balanceDollar || 0);
    const amount = amountRequested === null ? balance : Math.min(amountRequested, balance);

    if (amount <= 0) return res.status(400).json({ ok: false, error: 'Insufficient balance' });

    const pointsToAdd = Math.floor(amount / POINT_TO_USD);
    if (pointsToAdd <= 0) return res.status(400).json({ ok: false, error: 'Amount too small to convert to any points' });

    const usedDollars = Number((pointsToAdd * POINT_TO_USD).toFixed(6));
    user.balanceDollar = Number((balance - usedDollars).toFixed(6));
    user.pointsCurrent = Number((user.pointsCurrent || 0) + pointsToAdd);
    await user.save();

    return res.json({
      ok: true,
      data: {
        addedPoints: pointsToAdd,
        deductedDollar: usedDollars,
        balanceDollar: user.balanceDollar,
        pointsCurrent: user.pointsCurrent
      }
    });
  } catch (err) {
    console.error('account.convert-back error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});


// GET /api/account/withdraw/summary
router.get('/withdraw/summary', authMiddleware, async (req, res) => {
  try {
    if (!req.user) {
      const payload = {
        spent24: 0,
        pending24: 0,
        remainingVerified: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
        remainingIncludingPending: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
        cap: WITHDRAWAL_24H_CAP,
        nextAllowedAt: null,
        requestCount24: 0,
        nextRequestAllowedAt: null
      };
      return res.json({ ok: true, data: payload, ...payload });
    }

    const dbUser = await findDbUserFromReqUser(req.user);
    if (!dbUser) {
      const payload = {
        spent24: 0,
        pending24: 0,
        remainingVerified: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
        remainingIncludingPending: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
        cap: WITHDRAWAL_24H_CAP,
        nextAllowedAt: null,
        requestCount24: 0,
        nextRequestAllowedAt: null
      };
      return res.json({ ok: true, data: payload, ...payload });
    }

    // tolerant userId query (ObjectId OR string)
    let userIdQuery;
    try {
      if (mongoose.isValidObjectId(dbUser._id)) {
        userIdQuery = { $or: [{ userId: mongoose.Types.ObjectId(dbUser._id) }, { userId: String(dbUser._id) }] };
      } else {
        userIdQuery = { userId: String(dbUser._id) };
      }
    } catch (e) {
      userIdQuery = { userId: String(dbUser._id) };
    }

    const now = Date.now();
    const sincePending = new Date(now - 24 * 3600 * 1000);   // requestedAt window
    const sinceVerified = new Date(now - 24 * 3600 * 1000);  // verifiedAt window

    let verifiedTotal = 0;
    let pendingTotal = 0;
    let requestCount24 = 0;
    let nextRequestAllowedAt = null;
    let nextAllowedAt = null;

    try {
      // verified amount
      const aggVerified = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggVerified && aggVerified.length) verifiedTotal = toNumber(aggVerified[0].total, 0);

      // pending amount (requestedAt)
      const aggPending = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggPending && aggPending.length) pendingTotal = toNumber(aggPending[0].total, 0);

      // request count in last 24h (any status, based on requestedAt)
      const aggCount = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { requestedAt: { $gte: sincePending } }) },
        { $group: { _id: null, count: { $sum: 1 } } }
      ]).allowDiskUse(true);
      requestCount24 = (aggCount && aggCount.length) ? toNumber(aggCount[0].count, 0) : 0;

      // compute nextRequestAllowedAt if count >= limit (we need the earliest to expire)
      if (requestCount24 >= WITHDRAWAL_REQUEST_COUNT_LIMIT /* define or use 5 */) {
        // compute index to skip = requestCount24 - limit
        const limit = WITHDRAWAL_REQUEST_COUNT_LIMIT || 5;
        const skipIdx = Math.max(0, requestCount24 - limit);
        const earliestToExpire = await Withdrawal.findOne(Object.assign({}, userIdQuery, { requestedAt: { $gte: sincePending } }))
          .sort({ requestedAt: 1 })
          .skip(skipIdx)
          .lean();
        if (earliestToExpire && earliestToExpire.requestedAt) {
          nextRequestAllowedAt = new Date(new Date(earliestToExpire.requestedAt).getTime() + 24 * 3600 * 1000).toISOString();
        }
      }

      // compute nextAllowedAt for money cap (existing logic)
      if ((verifiedTotal + pendingTotal) >= WITHDRAWAL_24H_CAP || verifiedTotal >= WITHDRAWAL_24H_CAP) {
        const earliestVerified = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } })).sort({ verifiedAt: 1 }).lean();
        const earliestPending = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } })).sort({ requestedAt: 1 }).lean();

        let earliestDate = null;
        if (earliestVerified && earliestVerified.verifiedAt) earliestDate = new Date(earliestVerified.verifiedAt);
        if (earliestPending && earliestPending.requestedAt) {
          const d = new Date(earliestPending.requestedAt);
          if (!earliestDate || d < earliestDate) earliestDate = d;
        }
        if (earliestDate) nextAllowedAt = new Date(earliestDate.getTime() + 24 * 3600 * 1000).toISOString();
      }

    } catch (aggErr) {
      console.warn('withdraw.summary: aggregation failed', aggErr && aggErr.stack ? aggErr.stack : aggErr);
      verifiedTotal = 0; pendingTotal = 0; requestCount24 = 0;
    }

    const remainingVerified = Math.max(0, WITHDRAWAL_24H_CAP - verifiedTotal);
    const remainingIncludingPending = Math.max(0, WITHDRAWAL_24H_CAP - (verifiedTotal + pendingTotal));

    const payload = {
      spent24: Number(verifiedTotal.toFixed(3)),
      pending24: Number(pendingTotal.toFixed(3)),
      remainingVerified: Number(remainingVerified.toFixed(3)),
      remainingIncludingPending: Number(remainingIncludingPending.toFixed(3)),
      cap: WITHDRAWAL_24H_CAP,
      nextAllowedAt,
      requestCount24,
      nextRequestAllowedAt
    };

    return res.json({ ok: true, data: payload, ...payload });
  } catch (err) {
    console.error('withdraw.summary unexpected error', err && err.stack ? err.stack : err);
    const payload = {
      spent24: 0,
      pending24: 0,
      remainingVerified: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
      remainingIncludingPending: Number(WITHDRAWAL_24H_CAP.toFixed(3)),
      cap: WITHDRAWAL_24H_CAP,
      nextAllowedAt: null,
      requestCount24: 0,
      nextRequestAllowedAt: null
    };
    return res.json({ ok: true, data: payload, ...payload });
  }
});
// DELETE /api/account/withdraw/:id  (user or admin)
router.delete('/withdraw/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });

    const dbUser = await findDbUserFromReqUser(req.user);
    if (!dbUser) return res.status(404).json({ ok: false, error: 'User not found' });

    const w = await Withdrawal.findById(id).lean();
    if (!w) return res.status(404).json({ ok: false, error: 'Withdrawal not found' });

    // only allow delete if pending OR user is admin
    const isOwner = String(w.userId) === String(dbUser._id) || (w.userId && String(w.userId) === String(dbUser._id));
    const isAdminUser = (String(req.user.role || '').toLowerCase() === 'admin' || !!req.user.isAdmin);

    if (!isOwner && !isAdminUser) return res.status(403).json({ ok: false, error: 'Not allowed' });

    // safe status check (avoid client-only helper)
    const statusLower = String(w.status || '').toLowerCase();
    if (!isAdminUser && statusLower !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Only pending withdrawals may be removed by the user' });
    }

    // delete document
    await Withdrawal.deleteOne({ _id: id });

    // emit socket event so other clients (admin) can update live
    try {
      const io = req.app.get('io');
      if (io) {
        io.emit('withdrawals:deleted', { id: String(id), userId: String(w.userId || '') });
      }
    } catch (e) {
      // don't fail the API if socket emit fails
      console.warn('withdraw.delete: socket emit failed', e && e.stack ? e.stack : e);
    }

    // recompute fresh summary and return (reuse logic similar to /summary)
    let userIdQuery;
    try {
      if (mongoose.isValidObjectId(dbUser._id)) {
        userIdQuery = { $or: [{ userId: mongoose.Types.ObjectId(dbUser._id) }, { userId: String(dbUser._id) }] };
      } else {
        userIdQuery = { userId: String(dbUser._id) };
      }
    } catch (e) {
      userIdQuery = { userId: String(dbUser._id) };
    }

    const now = Date.now();
    const sincePending = new Date(now - 24 * 3600 * 1000);
    const sinceVerified = new Date(now - 24 * 3600 * 1000);

       // existing vars: now we'll compute both total requestCount24 (all requests) AND verifiedRequestCount24 (only verified)
       let verified24 = 0, pending24 = 0, requestCount24 = 0, verifiedRequestCount24 = 0, nextAllowedAt = null, nextRequestAllowedAt = null;
       try {
         const aggV = await Withdrawal.aggregate([
           { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
           { $group: { _id: null, total: { $sum: '$amount' } } }
         ]).allowDiskUse(true);
         if (aggV && aggV.length) verified24 = toNumber(aggV[0].total, 0);
 
         const aggP = await Withdrawal.aggregate([
           { $match: Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } }) },
           { $group: { _id: null, total: { $sum: '$amount' } } }
         ]).allowDiskUse(true);
         if (aggP && aggP.length) pending24 = toNumber(aggP[0].total, 0);
 
         // original count: all requests in the last 24h (any status)
         const aggCount = await Withdrawal.aggregate([
           { $match: Object.assign({}, userIdQuery, { requestedAt: { $gte: sincePending } }) },
           { $group: { _id: null, count: { $sum: 1 } } }
         ]).allowDiskUse(true);
         requestCount24 = (aggCount && aggCount.length) ? toNumber(aggCount[0].count, 0) : 0;
 
         // additional: count verified-only (useful for admin decision/display)
         const aggVerifiedCount = await Withdrawal.aggregate([
           { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
           { $group: { _id: null, count: { $sum: 1 } } }
         ]).allowDiskUse(true);
         verifiedRequestCount24 = (aggVerifiedCount && aggVerifiedCount.length) ? toNumber(aggVerifiedCount[0].count, 0) : 0;
 
         // compute nextRequestAllowedAt (count limit) using all requests (this preserves user-facing count limit behavior)
         const limit = typeof WITHDRAWAL_REQUEST_COUNT_LIMIT !== 'undefined' ? WITHDRAWAL_REQUEST_COUNT_LIMIT : 5;
         if (requestCount24 >= limit) {
           const skipIdx = Math.max(0, requestCount24 - limit);
           const earliestToExpire = await Withdrawal.findOne(Object.assign({}, userIdQuery, { requestedAt: { $gte: sincePending } }))
             .sort({ requestedAt: 1 })
             .skip(skipIdx)
             .lean();
           if (earliestToExpire && earliestToExpire.requestedAt) {
             nextRequestAllowedAt = new Date(new Date(earliestToExpire.requestedAt).getTime() + 24 * 3600 * 1000).toISOString();
           }
         }
 
         // money-cap nextAllowedAt (existing logic)
         if ((verified24 + pending24) >= WITHDRAWAL_24H_CAP || verified24 >= WITHDRAWAL_24H_CAP) {
           const earliestVerified = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } })).sort({ verifiedAt: 1 }).lean();
           const earliestPending = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } })).sort({ requestedAt: 1 }).lean();
           let earliestDate = null;
           if (earliestVerified && earliestVerified.verifiedAt) earliestDate = new Date(earliestVerified.verifiedAt);
           if (earliestPending && earliestPending.requestedAt) {
             const d = new Date(earliestPending.requestedAt);
             if (!earliestDate || d < earliestDate) earliestDate = d;
           }
           if (earliestDate) nextAllowedAt = new Date(earliestDate.getTime() + 24 * 3600 * 1000).toISOString();
         }
       } catch (e) {
         console.warn('withdraw.delete: recompute failed', e && e.stack ? e.stack : e);
       }
 
       const payload = {
         spent24: Number(verified24.toFixed(3)),
         pending24: Number(pending24.toFixed(3)),
         remainingVerified: Number(Math.max(0, WITHDRAWAL_24H_CAP - verified24).toFixed(3)),
         remainingIncludingPending: Number(Math.max(0, WITHDRAWAL_24H_CAP - (verified24 + pending24)).toFixed(3)),
         cap: WITHDRAWAL_24H_CAP,
         nextAllowedAt,
         requestCount24,               // all requests in 24h (existing behavior)
         verifiedRequestCount24,      // verified-only requests in 24h (new, admin-friendly)
         nextRequestAllowedAt
       };
 

    return res.json({ ok: true, deletedId: id, data: payload, ...payload });
  } catch (err) {
    console.error('account.withdraw.delete error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});




// POST /api/account/withdraw
router.post('/withdraw', authMiddleware, async (req, res) => {
  try {
    const phone = sanitizeHtml((req.body.phone || '').toString().trim());
    if (!phone) return res.status(400).json({ ok: false, error: 'Phone required' });

    const amountRequested = req.body.amount === undefined ? null : Number(req.body.amount);
    if (amountRequested !== null && (!Number.isFinite(amountRequested) || amountRequested <= 0)) {
      return res.status(400).json({ ok: false, error: 'Invalid amount' });
    }

    const dbUser = await findDbUserFromReqUser(req.user);
    if (!dbUser) return res.status(404).json({ ok: false, error: 'User not found' });

    const user = await User.findById(dbUser._id);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found on save' });

    const balance = Number(user.balanceDollar || 0);
    const amount = amountRequested === null ? balance : Math.min(amountRequested, balance);

    if (amount <= 0) return res.status(400).json({ ok: false, error: 'Insufficient balance' });
    if (amount < MIN_WITHDRAW_AMOUNT) return res.status(400).json({ ok: false, error: `Minimum withdraw is $${MIN_WITHDRAW_AMOUNT}` });

    // tolerant userId query (ObjectId OR string)
    let userIdQuery;
    try {
      if (mongoose.isValidObjectId(dbUser._id)) {
        userIdQuery = { $or: [{ userId: mongoose.Types.ObjectId(dbUser._id) }, { userId: String(dbUser._id) }] };
      } else {
        userIdQuery = { userId: String(dbUser._id) };
      }
    } catch (e) {
      userIdQuery = { userId: String(dbUser._id) };
    }

    const now = Date.now();
    const sincePending = new Date(now - 24 * 3600 * 1000);
    const sinceVerified = new Date(now - 24 * 3600 * 1000);

    let verified24 = 0, pending24 = 0;
    try {
      const aggV = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggV && aggV.length) verified24 = toNumber(aggV[0].total, 0);

      const aggP = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggP && aggP.length) pending24 = toNumber(aggP[0].total, 0);
    } catch (e) {
      console.warn('withdraw.create: agg failed', e && e.stack ? e.stack : e);
      verified24 = 0; pending24 = 0;
    }

    const remainingVerified = Math.max(0, WITHDRAWAL_24H_CAP - verified24);
    const remainingIncludingPending = Math.max(0, WITHDRAWAL_24H_CAP - (verified24 + pending24));

    const isUserAdmin = (String(user.role || '').toLowerCase() === 'admin' || !!user.isAdmin);

    if (!isUserAdmin && amount > remainingIncludingPending) {
      let nextAllowedAt = null;
      try {
        const earliestVerified = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } })).sort({ verifiedAt: 1 }).lean();
        const earliestPending = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } })).sort({ requestedAt: 1 }).lean();
        let earliestDate = null;
        if (earliestVerified && earliestVerified.verifiedAt) earliestDate = new Date(earliestVerified.verifiedAt);
        if (earliestPending && earliestPending.requestedAt) {
          const d = new Date(earliestPending.requestedAt);
          if (!earliestDate || d < earliestDate) earliestDate = d;
        }
        if (earliestDate) nextAllowedAt = new Date(earliestDate.getTime() + 24 * 3600 * 1000).toISOString();
      } catch (e) { /* ignore */ }

      const payload = {
        remainingVerified: Number(remainingVerified.toFixed(3)),
        remainingIncludingPending: Number(remainingIncludingPending.toFixed(3)),
        cap: WITHDRAWAL_24H_CAP,
        nextAllowedAt
      };

      return res.status(400).json({
        ok: false,
        error: `Request would exceed your ${WITHDRAWAL_24H_CAP}$ verified cap in the last 24 hours.`,
        ...payload,
        data: payload
      });
    }

    // Create pending withdrawal - set requestedAt explicitly
    const w = await Withdrawal.create({
      userId: user._id,
      amount: Number(amount.toFixed(3)),
      phone,
      status: 'pending',
      requestedAt: new Date()
    });

    const io = req.app.get('io');
    if (io) io.emit('withdrawals:new', { withdrawal: w });

    // Recompute and return fresh summary
    try {
      const aggV2 = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      const aggP2 = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);

      const finalVerified = (aggV2 && aggV2.length) ? toNumber(aggV2[0].total, 0) : 0;
      const finalPending = (aggP2 && aggP2.length) ? toNumber(aggP2[0].total, 0) : 0;

      const remainingVerifiedAfter = Math.max(0, WITHDRAWAL_24H_CAP - finalVerified);
      const remainingIncludingPendingAfter = Math.max(0, WITHDRAWAL_24H_CAP - (finalVerified + finalPending));

      let nextAllowedAtAfter = null;
      if ((finalVerified + finalPending) >= WITHDRAWAL_24H_CAP) {
        const earliestVerified = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } })).sort({ verifiedAt: 1 }).lean();
        const earliestPending = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } })).sort({ requestedAt: 1 }).lean();
        let earliestDate = null;
        if (earliestVerified && earliestVerified.verifiedAt) earliestDate = new Date(earliestVerified.verifiedAt);
        if (earliestPending && earliestPending.requestedAt) {
          const d = new Date(earliestPending.requestedAt);
          if (!earliestDate || d < earliestDate) earliestDate = d;
        }
        if (earliestDate) nextAllowedAtAfter = new Date(earliestDate.getTime() + 24 * 3600 * 1000).toISOString();
      }

      const payload = {
        spent24: Number(finalVerified.toFixed(3)),
        pending24: Number(finalPending.toFixed(3)),
        remainingVerified: Number(remainingVerifiedAfter.toFixed(3)),
        remainingIncludingPending: Number(remainingIncludingPendingAfter.toFixed(3)),
        cap: WITHDRAWAL_24H_CAP,
        nextAllowedAt: nextAllowedAtAfter
      };

      return res.json({ ok: true, data: { withdrawal: w, summary: payload }, ...payload });
    } catch (innerErr) {
      console.warn('withdraw.create: summary recompute failed', innerErr && innerErr.stack ? innerErr.stack : innerErr);
      return res.json({ ok: true, data: { withdrawal: w }, cap: WITHDRAWAL_24H_CAP });
    }
  } catch (err) {
    console.error('account.withdraw error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/account/withdrawals
router.get('/withdrawals', authMiddleware, async (req, res) => {
  try {
    if (!req.user) return res.status(400).json({ ok: false, error: 'Invalid user' });
    const dbUser = await findDbUserFromReqUser(req.user);
    if (!dbUser) return res.status(404).json({ ok: false, error: 'User not found' });

    // tolerant userId query (ObjectId OR string)
    let userIdQuery;
    try {
      if (mongoose.isValidObjectId(dbUser._id)) {
        userIdQuery = { $or: [{ userId: mongoose.Types.ObjectId(dbUser._id) }, { userId: String(dbUser._id) }] };
      } else {
        userIdQuery = { userId: String(dbUser._id) };
      }
    } catch (e) {
      userIdQuery = { userId: String(dbUser._id) };
    }

    // fetch full list for display (use tolerant match)
    const list = await Withdrawal.find(userIdQuery).sort({ requestedAt: -1 }).lean();

    const now = Date.now();
    const sincePending = new Date(now - 24 * 3600 * 1000);
    const sinceVerified = new Date(now - 24 * 3600 * 1000);

    let spent24 = 0, pending24 = 0, nextAllowedAt = null;

    try {
      const aggV = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggV && aggV.length) spent24 = toNumber(aggV[0].total, 0);

      const aggP = await Withdrawal.aggregate([
        { $match: Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } }) },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]).allowDiskUse(true);
      if (aggP && aggP.length) pending24 = toNumber(aggP[0].total, 0);

      if ((spent24 + pending24) >= WITHDRAWAL_24H_CAP) {
        const earliestVerified = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'verified', verifiedAt: { $gte: sinceVerified } })).sort({ verifiedAt: 1 }).lean();
        const earliestPending = await Withdrawal.findOne(Object.assign({}, userIdQuery, { status: 'pending', requestedAt: { $gte: sincePending } })).sort({ requestedAt: 1 }).lean();
        let earliestDate = null;
        if (earliestVerified && earliestVerified.verifiedAt) earliestDate = new Date(earliestVerified.verifiedAt);
        if (earliestPending && earliestPending.requestedAt) {
          const d = new Date(earliestPending.requestedAt);
          if (!earliestDate || d < earliestDate) earliestDate = d;
        }
        if (earliestDate) nextAllowedAt = new Date(earliestDate.getTime() + 24 * 3600 * 1000).toISOString();
      }
    } catch (e) {
      console.warn('withdrawals.list: summary agg failed', e && e.stack ? e.stack : e);
      spent24 = 0; pending24 = 0;
    }

    const remainingVerified = Math.max(0, WITHDRAWAL_24H_CAP - spent24);
    const remainingIncludingPending = Math.max(0, WITHDRAWAL_24H_CAP - (spent24 + pending24));

    // Resolve verifiedBy user names (optional)
    try {
      const verifierIds = Array.from(new Set(list.map(w => {
        if (!w) return null;
        if (w.verifiedBy && typeof w.verifiedBy === 'object') return null;
        if (w.verifiedBy) return String(w.verifiedBy);
        return null;
      }).filter(Boolean)));

      let verifierMap = {};
      if (verifierIds.length) {
        const users = await User.find({ _id: { $in: verifierIds } }).lean();
        for (const u of users) {
          verifierMap[String(u._id)] = { id: String(u._id), fullName: (u.fullName || u.name || ''), username: (u.username || '') };
        }
      }

      for (const w of list) {
        if (!w) continue;
        if (w.verifiedBy && typeof w.verifiedBy === 'object') {
          w.verifiedBy = Object.assign({}, w.verifiedBy, {
            fullName: (w.verifiedBy.fullName || w.verifiedBy.name || w.verifiedBy.username || '')
          });
        } else if (w.verifiedBy) {
          const key = String(w.verifiedBy);
          if (verifierMap[key]) w.verifiedBy = verifierMap[key];
          else w.verifiedBy = { id: key, fullName: '', username: '' };
        } else {
          w.verifiedBy = null;
        }
      }
    } catch (e) {
      console.warn('withdrawals.list: resolver failed', e && e.stack ? e.stack : e);
    }

    const payload = {
      withdrawals: list,
      spent24: Number(spent24.toFixed(3)),
      pending24: Number(pending24.toFixed(3)),
      remainingVerified: Number(remainingVerified.toFixed(3)),
      remainingIncludingPending: Number(remainingIncludingPending.toFixed(3)),
      cap: WITHDRAWAL_24H_CAP,
      nextAllowedAt
    };

    return res.json({ ok: true, data: payload, ...payload });
  } catch (err) {
    console.error('account.withdrawals.list error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});


module.exports = router;


