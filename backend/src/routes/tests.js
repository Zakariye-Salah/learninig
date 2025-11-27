'use strict';

const express = require('express');
const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');

const Test = require('../models/Test');
const Attempt = require('../models/Attempt');
const User = require('../models/User'); // your existing user model
// backend/src/routes/tests.js (top)
const { authMiddleware, requireAdmin, optionalAuthenticate } = require('../middleware/auth');



const router = express.Router();

/* --------- Helpers --------- */
function sanitizeBilingual(raw) {
  if (!raw) return { en: '', som: '' };
  if (typeof raw === 'string') return { en: sanitizeHtml(raw), som: '' };
  return {
    en: sanitizeHtml(String(raw.en || '')),
    som: sanitizeHtml(String(raw.som || ''))
  };
}

/* Default scoring params */
const DEFAULT_CORRECT_POINTS = 3;
const DEFAULT_INCORRECT_PENALTY = -1;

/* --------- CRUD (admin) --------- */

// create
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const title = (req.body.title || '').toString().trim();
    if (!title) return res.status(400).json({ error: 'Title required' });

    const questionsPayload = Array.isArray(req.body.questions) ? req.body.questions : [];
    const questions = questionsPayload.map(q => ({
      id: q.id || ('q_' + Math.random().toString(36).slice(2,8)),
      text: sanitizeBilingual(q.text || ''),
      explanation: sanitizeBilingual(q.explanation || ''),
      options: (Array.isArray(q.options) ? q.options : []).map(o => ({
        id: o.id || ('o_' + Math.random().toString(36).slice(2,8)),
        text: sanitizeBilingual(o.text || ''),
        isCorrect: !!o.isCorrect
      })),
      pointsValue: Number(q.pointsValue || DEFAULT_CORRECT_POINTS)
    }));

    const test = await Test.create({
      title: sanitizeHtml(title),
      folderId: req.body.folderId || null,
      lessonId: req.body.lessonId || null,
      questions,
      authorId: req.user._id
    });

    return res.status(201).json({ ok: true, test });
  } catch (err) {
    console.error('tests.create', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// update
router.put('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });

    const updates = {};
    if (req.body.title) updates.title = sanitizeHtml(String(req.body.title));
    if (req.body.folderId !== undefined) updates.folderId = req.body.folderId || null;
    if (req.body.lessonId !== undefined) updates.lessonId = req.body.lessonId || null;
    if (Array.isArray(req.body.questions)) {
      updates.questions = req.body.questions.map(q => ({
        id: q.id || ('q_' + Math.random().toString(36).slice(2,8)),
        text: sanitizeBilingual(q.text || ''),
        explanation: sanitizeBilingual(q.explanation || ''),
        options: (Array.isArray(q.options) ? q.options : []).map(o => ({
          id: o.id || ('o_' + Math.random().toString(36).slice(2,8)),
          text: sanitizeBilingual(o.text || ''),
          isCorrect: !!o.isCorrect
        })),
        pointsValue: Number(q.pointsValue || DEFAULT_CORRECT_POINTS)
      }));
    }
    updates.updatedAt = new Date();

    const updated = await Test.findByIdAndUpdate(id, updates, { new: true });
    return res.json({ ok: true, test: updated });
  } catch (err) {
    console.error('tests.update', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// delete (soft)
router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const test = await Test.findById(id);
    if (!test) return res.status(404).json({ error: 'Not found' });
    test.isDeleted = true;
    await test.save();
    return res.json({ ok: true });
  } catch (err) {
    console.error('tests.delete', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* --------- Public read --------- */
// GET /api/tests?lessonId=...&folderId=...
router.get('/', authMiddleware, async (req, res) => {
  try {
    const q = { isDeleted: { $ne: true } };
    if (req.query.lessonId) q.lessonId = req.query.lessonId;
    if (req.query.folderId) q.folderId = req.query.folderId;

    const arr = await Test.find(q).sort({ createdAt: -1 }).lean();
    // NOTE: We return isCorrect flags for now to support instant feedback on client.
    // If you want to hide correct options to prevent cheating, strip `isCorrect` for non-admins here.
    return res.json({ tests: arr });
  } catch (err) {
    console.error('tests.list', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/tests/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const t = await Test.findById(id).lean();
    if (!t) return res.status(404).json({ error: 'Not found' });
    return res.json({ test: t });
  } catch (err) {
    console.error('tests.get', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* --------- Attempt endpoints --------- */

/**
 * POST /api/tests/:id/start
 * Creates (or returns) a not-yet-submitted attempt for the user.
 */
router.post('/:id/start', authMiddleware, async (req, res) => {
  try {
    const testId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(testId)) return res.status(400).json({ error: 'Invalid id' });
    const test = await Test.findById(testId);
    if (!test) return res.status(404).json({ error: 'Test not found' });

    // reuse an in-progress attempt if exists
    let attempt = await Attempt.findOne({ testId: test._id, userId: req.user._id, submittedAt: { $exists: false } });
    if (!attempt) {
      attempt = await Attempt.create({ testId: test._id, userId: req.user._id, startedAt: new Date(), answers: [], score: 0 });
    }

    return res.json({ ok: true, attemptId: attempt._id, startedAt: attempt.startedAt });
  } catch (err) {
    console.error('tests.start', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /api/tests/:id/submit
 * Body: { attemptId, answers: [ { questionId, selectedOptionId, answeredAt } ] }
 * Server evaluates each question, computes attempt score, compares with previous best and returns:
 * { ok, attemptId, score, scoreDelta, totalAfter, perQuestion: [...] }
 */
router.post('/:id/submit', authMiddleware, async (req, res) => {
  try {
    const testId = req.params.id;
    const attemptId = req.body.attemptId;
    const answers = Array.isArray(req.body.answers) ? req.body.answers : [];

    if (!mongoose.Types.ObjectId.isValid(testId)) return res.status(400).json({ error: 'Invalid test id' });

    const test = await Test.findById(testId).lean();
    if (!test) return res.status(404).json({ error: 'Test not found' });

    // find or create attempt
    let attempt = null;
    if (attemptId && mongoose.Types.ObjectId.isValid(attemptId)) attempt = await Attempt.findById(attemptId);
    if (!attempt) {
      attempt = await Attempt.create({ testId: test._id, userId: req.user._id, startedAt: new Date(), answers: [], score: 0 });
    }
    // Prevent double submissions on same attempt
    if (attempt.submittedAt) {
      // still allow re-evaluation if you want, but by default return already submitted result
      return res.status(400).json({ error: 'Attempt already submitted' });
    }

    // --- Determine previously-correct question ids for this user & test (to avoid double counting) ---
    // Find previous submitted attempts for same user/test and collect questionIds they had correct
    const prevAttempts = await Attempt.find({ testId: test._id, userId: req.user._id, submittedAt: { $exists: true } }).lean();
    const prevCorrectSet = new Set();
    prevAttempts.forEach(pa => {
      if (!Array.isArray(pa.answers)) return;
      pa.answers.forEach(a => { if (a && a.questionId && a.correct) prevCorrectSet.add(String(a.questionId)); });
    });
    // ------------------------------------------------------------------

    // Build a map of questions by id (test.questions may store id or _id)
    const qMap = {};
    (test.questions || []).forEach(q => {
      qMap[String(q.id || q._id)] = q;
    });

    // Evaluate submitted answers
    let totalScore = 0;
    const answersOut = [];

    // map answers by questionId for convenience
    const givenMap = {};
    answers.forEach(a => { if (a && a.questionId) givenMap[String(a.questionId)] = a; });

    // Evaluate each question in test
    for (const q of (test.questions || [])) {
      const qid = String(q.id || q._id);
      const given = givenMap[qid] || null;
      const selectedOptionId = given ? (given.selectedOptionId || null) : null;

      // if previously answered correctly, mark as skippedAlreadyScored (do not change totalScore)
      if (prevCorrectSet.has(qid)) {
        answersOut.push({
          questionId: qid,
          selectedOptionId,
          correct: false,
          points: 0,
          answeredAt: given && given.answeredAt ? new Date(given.answeredAt) : new Date(),
          timedOut: !selectedOptionId,
          skippedAlreadyScored: true
        });
        continue;
      }

      let isCorrect = false;
      let pts = 0;
      const option = (q.options || []).find(o => String(o.id || o._id) === String(selectedOptionId));
      if (option && option.isCorrect) {
        isCorrect = true;
        pts = Number(q.pointsValue || DEFAULT_CORRECT_POINTS);
      } else if (selectedOptionId) {
        // selected something but incorrect
        pts = DEFAULT_INCORRECT_PENALTY;
      } else {
        // unanswered => 0 points (this matches your spec), but you had penalty counting local? keep 0 here
        pts = 0;
      }
      totalScore += pts;

      answersOut.push({
        questionId: qid,
        selectedOptionId,
        correct: isCorrect,
        points: pts,
        answeredAt: given && given.answeredAt ? new Date(given.answeredAt) : new Date(),
        timedOut: !selectedOptionId,
        skippedAlreadyScored: false
      });
    }

    // Save attempt record
    attempt.answers = answersOut;
    attempt.score = totalScore;
    attempt.submittedAt = new Date();
    await attempt.save();

    // Compare with previous best attempt score to compute scoreDelta (positive only)
    const prevBest = prevAttempts && prevAttempts.length ? (prevAttempts.reduce((acc, p) => Math.max(acc, p.score || 0), -Infinity) || 0) : 0;
    const scoreDelta = Math.max(0, totalScore - prevBest);

    // Update user.pointsCurrent only by positive delta to avoid farming
    let user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const prevTotal = Number(user.pointsCurrent || 0);
    if (scoreDelta > 0) {
      user.pointsCurrent = prevTotal + Number(scoreDelta);
      user.pointsUpdatedAt = new Date();
      await user.save();
    }

    // Build per-question feedback for response: explanation & correct option id
    const perQuestion = (test.questions || []).map(q => {
      const qid = String(q.id || q._id);
      const correctOpt = (q.options || []).find(o => o.isCorrect);
      return {
        questionId: qid,
        explanation: q.explanation || { en: '', som: '' },
        correctOptionId: correctOpt ? (correctOpt.id || null) : null,
        // include selected and correctness from answersOut if present
        selectedOptionId: (answersOut.find(a => String(a.questionId) === qid) || {}).selectedOptionId || null,
        isCorrect: !!((answersOut.find(a => String(a.questionId) === qid) || {}).correct)
      };
    });

    return res.json({
      ok: true,
      attemptId: attempt._id,
      score: totalScore,
      scoreDelta,
      totalAfter: user.pointsCurrent,
      perQuestion
    });
  } catch (err) {
    console.error('tests.submit', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Server error' });
  }
});

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
