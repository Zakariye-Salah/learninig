// backend/src/routes/spin.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Spin = require('../models/Spin');
const SpinControl = require('../models/SpinControl');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Tunables
const MIN_BET = 10;
const MAX_BET_SERVER = 100;
const DAILY_LIMIT = 5;
const TOP_PRIZE_BASE_PROB = 0.001; // 0.1% base for top prize (adjustable)

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0,0,0,0);
  return x;
}

// --- SINGLE doc get (upsert if missing) ---
async function getSpinControlDoc() {
  // Ensure there is exactly one control doc by upserting an initial doc if none exists.
  let ctrl = await SpinControl.findOne().lean();
  if (!ctrl) {
    const created = await SpinControl.create({ disabled: false, reason: '', updatedBy: null, updatedAt: new Date() });
    ctrl = created.toObject();
  }
  return ctrl;
}

// GET /api/leaderboard/spin-control
router.get('/spin-control', authMiddleware, async (req, res) => {
  try {
    const ctrl = await getSpinControlDoc();
    return res.json({ ok: true, data: ctrl });
  } catch (e) {
    console.error('spin-control.get', e);
    return res.status(500).json({ ok:false, error: 'Server error' });
  }
});

// POST /api/leaderboard/spin-control  -- admin only
router.post('/spin-control', authMiddleware, async (req, res) => {
  try {
    const me = req.user || {};
    const isAdmin = me.role === 'admin' || me.isAdmin === true || (me.roles && me.roles.indexOf('admin') !== -1);
    if (!isAdmin) return res.status(403).json({ ok:false, error: 'Not authorized' });

    const disabled = !!req.body.disabled;
    const reason = (req.body.reason || '').toString().slice(0, 1000);

    // Upsert a single document so we always read latest in findOne().sort() won't be sensitive to multiple docs.
    const updated = await SpinControl.findOneAndUpdate(
      {}, 
      { disabled, reason, updatedBy: me._id, updatedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    // Broadcast to sockets (if present)
    try {
      const io = req.app.get('io');
      if (io && typeof io.emit === 'function') {
        io.emit('spin:control', { disabled, reason });
      }
    } catch (e) {
      console.warn('spin-control emit failed', e);
    }

    return res.json({ ok: true, data: updated });
  } catch (e) {
    console.error('spin-control.post', e);
    return res.status(500).json({ ok:false, error: 'Server error' });
  }
});

// Weighted pick & genOutcomeWeights (unchanged logic but kept here)
function weightedPick(items, weights) {
  if (!Array.isArray(items) || !Array.isArray(weights) || items.length === 0) return null;
  const n = Math.min(items.length, weights.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.max(0, Number(weights[i]) || 0);
  if (sum <= 0) return items[Math.floor(Math.random() * n)];
  let r = Math.random() * sum;
  for (let i = 0; i < n; i++) {
    r -= Math.max(0, Number(weights[i]) || 0);
    if (r <= 0) return items[i];
  }
  return items[n - 1];
}

// server-side helper: preset options (mirrors client getPresetOptions)
function getPresetOptionsServer(bet) {
  bet = Math.max(1, Math.round(Number(bet) || 0));
  if (bet >= 9 && bet <= 11) return [0,3,5,7,8,10,15,20,50,80,100];
  if (bet >= 18 && bet <= 22) return [0,5,10,14,17,20,40,80,100,150,200];
  if (bet >= 28 && bet <= 32) return [0,5,10,15,20,25,30,40,60,100,150,300];
  if (bet >= 65 && bet <= 75) return [10,15,30,40,55,70,80,120,200,250,700];

  if (bet < 50) {
    const small = [0,3,5, Math.max(5, Math.round(bet * 0.6)), Math.round(bet * 0.85)];
    const core  = [Math.round(bet * 0.5), Math.round(bet * 0.75), bet];
    const big   = [Math.round(bet * 2), Math.round(bet * 4), Math.round(bet * 8)];
    return Array.from(new Set(small.concat(core, big))).sort((a,b)=>a-b);
  } else {
    const near = [Math.round(bet * 0.2), Math.round(bet * 0.5), Math.round(bet * 0.8)];
    const core = [Math.round(bet * 1), Math.round(bet * 1.5), Math.round(bet * 2)];
    const big  = [Math.round(bet * 3), Math.round(bet * 5), Math.round(bet * 7.5)];
    return Array.from(new Set([0,5].concat(near, core, big))).sort((a,b)=>a-b);
  }
}
function genOutcomeWeights(bet) {
  bet = Math.max(1, Math.round(Number(bet) || 0));
  const all = getPresetOptionsServer(bet);
  const topPrize = all[all.length - 1];

  const percents = {};
  all.forEach(v => percents[v] = 0.01);

  const templates = {
    10: { 0:10.26, 3:10.26, 5:10.26, 7:20.53, 8:25.66, 10:15.40, 15:3.18, 20:2.12, 50:1.69, 80:0.51, 100:0.10 },
    20: { 0:20.0, 5:60.0, 20:10.0, 30:3.2, 40:3.0, 60:2.8, 100:1.5, 150:0.7, 180:0.4, 200:0.1 }
  };

  if (Math.abs(bet - 10) <= 1 && templates[10]) {
    const raw = templates[10];
    let usedSum = 0, present = [];
    for (const kStr in raw) {
      const k = Number(kStr);
      if (all.includes(k)) { percents[k] = raw[k]; usedSum += raw[k]; present.push(k); }
    }
    if (usedSum > 0 && Math.abs(usedSum - 100) > 0.0001) {
      const scale = 100 / usedSum;
      present.forEach(v => percents[v] = +(percents[v] * scale));
    }
  } else if (Math.abs(bet - 20) <= 2 && templates[20]) {
    const raw = templates[20];
    let usedSum = 0, present = [];
    for (const kStr in raw) {
      const k = Number(kStr);
      if (all.includes(k)) { percents[k] = raw[k]; usedSum += raw[k]; present.push(k); }
    }
    if (usedSum > 0 && Math.abs(usedSum - 100) > 0.0001) {
      const scale = 100 / usedSum;
      present.forEach(v => percents[v] = +(percents[v] * scale));
    }
  } else {
    // generic
    if (bet <= 10) {
      if (all.includes(0)) percents[0] = 20;
      if (all.includes(5)) percents[5] = 60;
    } else if (bet <= 20) {
      if (all.includes(0)) percents[0] = 3;
      if (all.includes(5)) percents[5] = 6;
    } else if (bet < 50) {
      if (all.includes(0)) percents[0] = 1;
      if (all.includes(5)) percents[5] = 1;
    } else {
      if (all.includes(0)) percents[0] = 0.5;
      if (all.includes(5)) percents[5] = 0.5;
    }

    if (all.includes(topPrize)) percents[topPrize] = Math.max(0.01, TOP_PRIZE_BASE_PROB * 100);

    const rest = all.filter(v => v !== 0 && v !== 5 && v !== topPrize);
    if (rest.length) {
      const scores = rest.map(v => {
        const dist = Math.max(1, Math.abs(v - bet));
        const boost = (v >= bet) ? 1.25 : 1.0;
        const score = (1 / (1 + Math.log10(1 + dist))) * boost;
        return { v, score };
      });
      const totalScore = scores.reduce((s,x) => s + x.score, 0) || 1;
      const used = (percents[0] || 0) + (percents[5] || 0) + (percents[topPrize] || 0);
      const remaining = Math.max(0.0001, 100 - used);
      scores.forEach(x => { percents[x.v] = Math.max(0.01, (x.score / totalScore) * remaining); });
    }
  }

  // caps and normalize
  if (bet > 10) {
    if (all.includes(0)) percents[0] = Math.min(percents[0] || 0.01, 1.0);
    if (all.includes(5)) percents[5] = Math.min(percents[5] || 0.01, 1.0);
  }
  if (bet >= 50) {
    const smalls = all.filter(v => v < 20);
    if (smalls.length) {
      let totalSmalls = smalls.reduce((s, v) => s + (percents[v] || 0), 0);
      const cap = 1.0;
      if (totalSmalls > cap) {
        const factor = cap / totalSmalls;
        smalls.forEach(v => { percents[v] = (percents[v] || 0) * factor; });
      }
    }
  }

  all.forEach(v => { if (!Number.isFinite(percents[v]) || percents[v] < 0.01) percents[v] = 0.01; });
  let sum = all.reduce((s, v) => s + (percents[v] || 0), 0) || 1;
  const finalScale = 100 / sum;
  all.forEach(v => percents[v] = +(percents[v] * finalScale));

  const weights = all.map(v => Math.max(0.0001, (percents[v] || 0) * 10));
  return { options: all, percents, weights };
}



// GET /api/leaderboard/spin-status
router.get('/spin-status', authMiddleware, async (req, res) => {
  try {
    const uid = req.user._id;
    const since = startOfDay();
    const count = await Spin.countDocuments({ userId: uid, createdAt: { $gte: since } });
    return res.json({ ok: true, spinsToday: count, spinsRemaining: Math.max(0, DAILY_LIMIT - count), dailyLimit: DAILY_LIMIT });
  } catch (err) {
    console.error('spin.status', err);
    return res.status(500).json({ ok:false, error: 'Server error' });
  }
});

// GET /api/leaderboard/spins
router.get('/spins', authMiddleware, async (req, res) => {
  try {
    const uid = req.user._id;
    const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
    const spins = await Spin.find({ userId: uid }).sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ ok: true, spins });
  } catch (err) {
    console.error('spin.history', err);
    return res.status(500).json({ ok:false, error: 'Server error' });
  }
});

// POST /api/leaderboard/spin
router.post('/spin', authMiddleware, async (req, res) => {
  try {
    // Enforce server-side control as authoritative
    const ctrl = await getSpinControlDoc();
    if (ctrl && ctrl.disabled) {
      return res.status(403).json({ ok: false, error: 'Spins are disabled by admin', reason: (ctrl.reason || 'No reason provided') });
    }

    const uid = req.user._id;
    const betRaw = Number(req.body.bet || 0);
    const bet = Math.floor(betRaw);
    console.log(`[spin] request from ${String(uid)} bet=${bet}`);

    if (!Number.isFinite(bet) || bet < MIN_BET) {
      return res.status(400).json({ ok:false, error: `Invalid bet. Minimum is ${MIN_BET}.` });
    }
    if (bet > MAX_BET_SERVER) {
      return res.status(400).json({ ok:false, error: `Maximum bet is ${MAX_BET_SERVER}.` });
    }

    // daily limit check
    const since = startOfDay();
    const spinsToday = await Spin.countDocuments({ userId: uid, createdAt: { $gte: since } });
    if (spinsToday >= DAILY_LIMIT) {
      return res.status(429).json({ ok:false, error: `Daily spin limit reached (${DAILY_LIMIT} per day).` });
    }

    // load user and check balance
    const user = await User.findById(uid).lean();
    if (!user) return res.status(404).json({ ok:false, error: 'User not found' });
    const currentPoints = (typeof user.pointsCurrent === 'number') ? user.pointsCurrent : 0;
    if (bet > currentPoints) return res.status(400).json({ ok:false, error: 'Insufficient points.' });

    // compute server-side outcome distribution and pick
    const { options, percents, weights } = genOutcomeWeights(bet);
    const outcome = Number(weightedPick(options, weights));
    const delta = outcome - bet;

    // apply update
    const updated = await User.findByIdAndUpdate(uid, { $inc: { pointsCurrent: delta }, $set: { pointsUpdatedAt: new Date() } }, { new: true });
    if (!updated) {
      console.error('[spin] failed to update user points for', uid);
      return res.status(500).json({ ok:false, error: 'Failed to apply spin result' });
    }

    const spin = await Spin.create({ userId: uid, bet, won: outcome, outcome, createdAt: new Date() });

    console.log(`[spin] result for ${String(uid)}: outcome=${outcome} delta=${delta} newPoints=${updated.pointsCurrent}`);

    // emit socket events
    const io = req.app.get('io');
    try {
      if (io) {
        io.emit('spin:created', { userId: String(uid), bet, outcome, delta, newPoints: (updated.pointsCurrent || 0), spinId: spin._id });
        if (outcome >= Math.max(1000, bet * 5)) {
          io.emit('spin:big', { userId: String(uid), bet, outcome, delta, newPoints: (updated.pointsCurrent || 0) });
        }
        const newCount = await Spin.countDocuments({ userId: uid, createdAt: { $gte: since } });
        io.emit('spin:status', { userId: String(uid), spinsToday: newCount, spinsRemaining: Math.max(0, DAILY_LIMIT - newCount) });
      }
    } catch (e) {
      console.warn('spin socket emit failed', e);
    }

    return res.json({
      ok: true,
      bet,
      outcome,
      won: outcome,
      delta,
      newPoints: (updated.pointsCurrent || 0),
      spinId: spin._id,
      options,
      weights,
      percents
    });
  } catch (err) {
    console.error('spin.post', err);
    return res.status(500).json({ ok:false, error: 'Server error' });
  }
});

module.exports = router;
