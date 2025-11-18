// backend/src/routes/games.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const mongoose = require('mongoose');

const SelectionMatch = require('../models/SelectionMatch');
const { authMiddleware, requireAdmin } = require('../middleware/auth'); // use existing middleware

function makeId(){ return new mongoose.Types.ObjectId().toString(); }

function computeRanksFromElimination(match) {
  const allIds = match.players.map(p => p.playerId);
  const eliminated = Array.isArray(match.eliminationOrder) ? match.eliminationOrder.slice() : [];
  const remaining = allIds.filter(id => !eliminated.includes(id));
  const ranks = [];
  if (remaining.length === 1) {
    const winId = remaining[0];
    const winPlayer = match.players.find(p => p.playerId === winId);
    ranks.push({ playerId: winId, playerName: winPlayer && winPlayer.name, rank: 1 });
  }
  const rev = eliminated.slice().reverse();
  let curRank = ranks.length + 1;
  for (const id of rev) {
    const p = match.players.find(pp => pp.playerId === id);
    ranks.push({ playerId: id, playerName: p && p.name, rank: curRank++ });
  }
  if (!ranks.length) {
    let r = 1;
    for (const id of rev) {
      const p = match.players.find(pp => pp.playerId === id);
      ranks.push({ playerId: id, playerName: p && p.name, rank: r++ });
    }
  }
  return ranks;
}

function secureChance(okProbability) {
  const scale = 1000000;
  const threshold = Math.floor((okProbability || 0) * scale);
  return crypto.randomInt(0, scale) < threshold;
}

/* POST /api/games/selection/create  (authenticated) */
router.post('/selection/create', authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const playersRaw = Array.isArray(body.players) ? body.players : [];
    if (playersRaw.length < 2) return res.status(400).json({ error: 'At least 2 players required' });

    const mode = body.mode || 'eliminate';
    const settings = Object.assign({ lives: 1, autoContinue: false, animationMs: 1200, botChallengeChance: 0.15, botAutoSpin: true }, body.settings || {});
    const players = playersRaw.map((p, idx) => {
      const pid = makeId();
      const name = (p && p.name) ? String(p.name) : `Player ${idx+1}`;
      const isBot = !!(p && p.isBot);
      // allow passing userId when creating (optional)
      const userId = p && p.userId ? (mongoose.Types.ObjectId.isValid(p.userId) ? p.userId : null) : null;
      return { playerId: pid, userId, name, isBot, lives: (settings && Number(settings.lives || 0)) || 0, status: 'active' };
    });

    const m = await SelectionMatch.create({
      ownerId: req.user._id,
      mode,
      settings,
      players,
      history: [],
      eliminationOrder: [],
      result: null
    });
    return res.json({ ok: true, match: m });
  } catch (err) {
    console.error('selection.create', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* helper to check ownership */
async function loadMatchAndCheckOwner(req, res, next) {
  try {
    const m = await SelectionMatch.findById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Match not found' });
    req.match = m;
    const isOwner = req.user && m.ownerId && String(m.ownerId) === String(req.user._id);
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Not allowed' });
    return next();
  } catch (err) {
    console.error('ownership.check', err); return res.status(500).json({ error: 'Server error' });
  }
}

/* POST /api/games/selection/:id/spin  (auth & owner OR admin) */
router.post('/selection/:id/spin', authMiddleware, loadMatchAndCheckOwner, async (req, res) => {
  try {
    const match = req.match;
    if (match.result && match.result.winnerPlayerId) return res.status(400).json({ error: 'Match already finished', match });

    // build active players (skip those eliminated)
    const activeList = match.players.map((p, idx) => ({ p, idx })).filter(x => x.p.status === 'active');
    if (activeList.length < 2) {
      // finalize match
      if (!match.result || !match.result.winnerPlayerId) {
        const ranks = computeRanksFromElimination(match);
        const winner = ranks.find(r => r.rank === 1);
        match.result = { winnerPlayerId: winner ? winner.playerId : (match.players[0] && match.players[0].playerId), winnerPlayerIdName: winner ? winner.playerName : null, ranks };
        await match.save();
      }
      return res.json({ ok: true, match });
    }

    // secure RNG pick
    const rand = crypto.randomInt(0, activeList.length);
    const chosen = activeList[rand];
    const picked = chosen.p;
    const pickedIndex = chosen.idx;

    // bot challenge hook
    let effect = '';
    if (picked.isBot && (match.settings && match.settings.botChallengeChance)) {
      const chance = Number(match.settings.botChallengeChance || 0);
      if (secureChance(chance)) {
        effect = 'bot_challenge_saved';
      }
    }

    if (!effect) {
      // apply mode effect
      if (match.mode === 'eliminate') {
        picked.status = 'eliminated';
        match.eliminationOrder.push(picked.playerId);
        effect = 'eliminated';
      } else if (match.mode === 'lose_and_stay') {
        picked.lives = (typeof picked.lives === 'number' ? picked.lives : (match.settings && match.settings.lives) || 0) - 1;
        effect = 'lost_life';
        if (picked.lives <= 0) {
          picked.status = 'eliminated';
          match.eliminationOrder.push(picked.playerId);
          effect = 'eliminated';
        }
      } else if (match.mode === 'skip') {
        picked.metadata = picked.metadata || {};
        picked.metadata.skipNext = true;
        effect = 'skip_next';
      } else {
        // custom fallback: use lives
        picked.lives = (typeof picked.lives === 'number' ? picked.lives : (match.settings && match.settings.lives) || 0) - 1;
        effect = 'lost_life';
        if (picked.lives <= 0) {
          picked.status = 'eliminated';
          match.eliminationOrder.push(picked.playerId);
          effect = 'eliminated';
        }
      }
    }

    match.history.push({
      round: match.history.length + 1,
      pickedPlayerId: picked.playerId,
      pickedName: picked.name,
      action: 'selected',
      effect,
      remainingLives: picked.lives,
      timestamp: new Date()
    });

    match.updatedAt = new Date();

    // check for finish
    const activeRem = match.players.filter(p => p.status === 'active').map(p => p.playerId);
    if (activeRem.length === 1) {
      const ranks = computeRanksFromElimination(match);
      const winner = ranks.find(r => r.rank === 1);
      match.result = { winnerPlayerId: winner ? winner.playerId : activeRem[0], winnerPlayerIdName: winner ? winner.playerName : null, ranks };
    }

    await match.save();

    // emit socket
    try { const io = req.app.get('io'); if (io) io.emit('games:selection:update', { matchId: match._id.toString(), match }); } catch(e){}

    return res.json({
      ok: true,
      pickedPlayerId: picked.playerId,
      pickedIndex,
      pickedName: picked.name,
      effect,
      match
    });
  } catch (err) {
    console.error('selection.spin', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* POST continue - owner/admin only */
router.post('/selection/:id/continue', authMiddleware, loadMatchAndCheckOwner, async (req, res) => {
  try {
    const match = req.match;
    return res.json({ ok: true, match });
  } catch (err) {
    console.error('selection.continue', err); return res.status(500).json({ error: 'Server error' });
  }
});

/* POST finish - owner/admin */
router.post('/selection/:id/finish', authMiddleware, loadMatchAndCheckOwner, async (req, res) => {
  try {
    const match = req.match;
    if (!match.result || !match.result.winnerPlayerId) {
      const ranks = computeRanksFromElimination(match);
      const winner = ranks.find(r => r.rank === 1);
      match.result = { winnerPlayerId: winner ? winner.playerId : (match.players[0] && match.players[0].playerId), winnerPlayerIdName: winner ? winner.playerName : null, ranks };
      await match.save();
    }
    try { const io = req.app.get('io'); if (io) io.emit('games:selection:finished', { matchId: match._id.toString(), match }); } catch(e){}
    return res.json({ ok: true, match });
  } catch (err) {
    console.error('selection.finish', err); return res.status(500).json({ error: 'Server error' });
  }
});

/* GET results (public) */
router.get('/results', async (req, res) => {
  try {
    const rows = await SelectionMatch.find({}).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ ok: true, results: rows });
  } catch (err) {
    console.error('games.results', err);
    return res.status(500).json({ error: 'Server error' });
  }
});
router.get('/results/:id', async (req, res) => {
  try {
    const m = await SelectionMatch.findById(req.params.id).lean();
    if (!m) return res.status(404).json({ error: 'Not found' });
    return res.json({ ok: true, match: m });
  } catch (err) {
    console.error('games.result', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
