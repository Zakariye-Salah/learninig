// backend/src/routes/tests.js
const express = require('express');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const Test = require('../models/Test');
const Attempt = require('../models/Attempt');
const User = require('../models/User');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// create test (admin)
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const t = await Test.create({ ...req.body, createdBy: req.user._id });
    return res.status(201).json({ test: t });
  } catch (err) {
    console.error('tests.post', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// get tests by folderId or lessonId
router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.folderId && mongoose.Types.ObjectId.isValid(req.query.folderId)) q.folderId = req.query.folderId;
    if (req.query.lessonId && mongoose.Types.ObjectId.isValid(req.query.lessonId)) q.lessonId = req.query.lessonId;
    const tests = await Test.find(q).lean();
    return res.json(tests);
  } catch (err) {
    console.error('tests.get', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// get test details
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const test = await Test.findById(id).lean();
    if (!test) return res.status(404).json({ error: 'Not found' });
    return res.json({ test });
  } catch (err) {
    console.error('tests.get.id', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// update & delete (admin)
router.put('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const updated = await Test.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    return res.json({ test: updated });
  } catch (err) {
    console.error('tests.put', err);
    return res.status(500).json({ error: 'Server error' });
  }
});
router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    await Test.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('tests.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tests/:id/start  (user starts, create Attempt)
router.post('/:id/start', authMiddleware, async (req, res) => {
  try {
    const t = await Test.findById(req.params.id).lean();
    if (!t) return res.status(404).json({ error: 'Not found' });
    const attemptToken = uuidv4();
    const a = await Attempt.create({ userId: req.user._id, testId: t._id, attemptToken, startTime: new Date(), answers: [] });
    return res.json({ attemptId: a._id, attemptToken, questionCount: t.questions.length });
  } catch (err) {
    console.error('tests.start', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/tests/:id/submit  - compute score, save attempt, update user points
// POST /api/tests/:id/submit  - compute score, save attempt, update user points
router.post('/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { attemptId, answers } = req.body;
    if (!attemptId || !Array.isArray(answers)) return res.status(400).json({ error: 'Missing data' });
    const attempt = await Attempt.findById(attemptId);
    if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
    if (!attempt.userId.equals(req.user._id)) return res.status(403).json({ error: 'Not your attempt' });
    const test = await Test.findById(req.params.id).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    // --- NEW: load user and compute previously-correct question ids after pointsResetAt ---
    const user = await User.findById(req.user._id).lean();
    const resetAt = user && user.pointsResetAt ? new Date(user.pointsResetAt) : new Date(0);

    // find previous attempts for the same user & test that started AFTER resetAt
    const prevAttempts = await Attempt.find({
      userId: req.user._id,
      testId: req.params.id,
      startTime: { $gt: resetAt }
    }).lean();

    const prevCorrectSet = new Set();
    for (const pa of (prevAttempts || [])) {
      if (!Array.isArray(pa.answers)) continue;
      for (const a of pa.answers) {
        if (a && a.questionId && a.correct) prevCorrectSet.add(String(a.questionId));
      }
    }
    // ---------------------------------------------------------

    // Build question map
    const qMap = {};
    test.questions.forEach(q => qMap[q.id] = q);

    let scoreDelta = 0;
    const recs = [];

    // For each answer provided in this submission:
    answers.forEach(ans => {
      const q = qMap[ans.questionId];
      if (!q) return;
      // If the question was already answered correctly in prior accepted attempts, skip scoring for it
      if (prevCorrectSet.has(String(ans.questionId))) {
        // record answer but mark as "skipped" (no score change)
        recs.push({ questionId: ans.questionId, selectedOptionId: ans.selectedOptionId || null, answerTime: new Date(), correct: false, skippedAlreadyScored: true });
        return;
      }
      // normal evaluation
      const opt = (q.options||[]).find(o => o.id === ans.selectedOptionId);
      const correct = !!(opt && opt.isCorrect);
      if (correct) scoreDelta += (q.pointsValue || 3);
      else scoreDelta -= 1;
      recs.push({ questionId: ans.questionId, selectedOptionId: ans.selectedOptionId || null, answerTime: new Date(), correct, skippedAlreadyScored: false });
    });

    // missing answers: treat as wrong (-1) only if not previously correctly answered
    const answeredIds = new Set(answers.map(a => String(a.questionId)));
    test.questions.forEach(q => {
      if (!answeredIds.has(String(q.id))) {
        if (prevCorrectSet.has(String(q.id))) {
          // previously correct -> skip
          recs.push({ questionId: q.id, selectedOptionId: null, answerTime: new Date(), correct: false, timedOut: true, skippedAlreadyScored: true });
        } else {
          // penalize as before
          scoreDelta -= 1;
          recs.push({ questionId: q.id, selectedOptionId: null, answerTime: new Date(), correct: false, timedOut: true, skippedAlreadyScored: false });
        }
      }
    });

    // Save attempt record (append recs)
    attempt.answers = recs;
    attempt.scoreDelta = scoreDelta;
    await attempt.save();

    // Update user's points
    const updatedUser = await User.findByIdAndUpdate(req.user._id, { $inc: { pointsCurrent: scoreDelta } }, { new: true });

    // emit socket update
    const io = req.app.get('io');
    if (io) io.emit('leaderboard:update', { userId: updatedUser._id, points: updatedUser.pointsCurrent });

    return res.json({ scoreDelta, totalAfter: updatedUser.pointsCurrent });
  } catch (err) {
    console.error('tests.submit', err);
    return res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;
