// backend/src/routes/tests.streak.js
const express = require('express');
const mongoose = require('mongoose');
const { authMiddleware, optionalAuthenticate } = require('../middleware/auth'); // adapt paths
const Test = require('../models/Test'); // adjust path
const User = require('../models/User'); // adjust path

const router = express.Router();

/**
 * GET /api/tests/:testId/streak
 * - optionalAuthenticate: returns server best and the personal best for the current user (if logged in)
 */
router.get('/:testId/streak', optionalAuthenticate, async (req, res) => {
  try {
    const testId = req.params.testId;
    if (!mongoose.Types.ObjectId.isValid(testId)) return res.status(400).json({ error: 'Invalid test id' });

    const test = await Test.findById(testId).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    const serverBest = {
      streak: Number(test.bestStreak || 0),
      name: test.bestHolderName || null,
      userId: test.bestHolderId ? String(test.bestHolderId) : null,
      updatedAt: test.bestStreakUpdatedAt || null
    };

    let personalBest = { streak: 0, updatedAt: null };
    if (req.user) {
      // If User has a per-test map (array or object) - adapt to your schema; below we assume user.testBest is [{ testId, streak, updatedAt }]
      const u = await User.findById(req.user._id).lean();
      if (u) {
        const tb = Array.isArray(u.testBest) ? u.testBest.find(x => String(x.testId) === String(testId)) : null;
        if (tb) personalBest = { streak: Number(tb.streak || 0), updatedAt: tb.updatedAt || null };
      }
    }

    return res.json({ ok: true, serverBest, personalBest });
  } catch (err) {
    console.error('GET /api/tests/:id/streak', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tests/:testId/streak
 * - auth required so users have persistent personal best across devices
 * - body: { streak: number }
 */
router.post('/:testId/streak', authMiddleware, async (req, res) => {
  try {
    const testId = req.params.testId;
    if (!mongoose.Types.ObjectId.isValid(testId)) return res.status(400).json({ error: 'Invalid test id' });
    const streak = Number(req.body.streak || 0);
    if (streak < 0) return res.status(400).json({ error: 'Invalid streak' });

    const userId = req.user._id;
    const userName = req.user.fullName || req.user.username || `${req.user.firstName||''} ${req.user.lastName||''}`.trim() || 'Unknown';

    // Load test
    const test = await Test.findById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    let updatedTest = null;
    // Update test.bestStreak if this is a new global best
    if (!test.bestStreak || streak > test.bestStreak) {
      test.bestStreak = streak;
      test.bestHolderId = userId;
      test.bestHolderName = userName;
      test.bestStreakUpdatedAt = new Date();
      await test.save();
      updatedTest = { streak: test.bestStreak, name: test.bestHolderName, userId: String(userId), updatedAt: test.bestStreakUpdatedAt };
    }

    // Update user's personal best (upsert in user.testBest array)
    // Assume User model has: testBest: [{ testId: ObjectId, streak: Number, updatedAt: Date }]
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!Array.isArray(user.testBest)) user.testBest = [];

    const existing = user.testBest.find(x => String(x.testId) === String(testId));
    if (!existing) {
      user.testBest.push({ testId: testId, streak: streak, updatedAt: new Date() });
    } else if (streak > (Number(existing.streak) || 0)) {
      existing.streak = streak;
      existing.updatedAt = new Date();
    }
    await user.save();

    const personal = user.testBest.find(x => String(x.testId) === String(testId));
    const personalBest = { streak: Number(personal.streak || 0), updatedAt: personal.updatedAt || null };

    return res.json({ ok: true, updatedTest: updatedTest || null, personalBest });
  } catch (err) {
    console.error('POST /api/tests/:id/streak', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
