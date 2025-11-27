'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Attempt - records a user's attempt on a test.
 * We store per-question evaluation results so server is authoritative.
 */

const AnswerSchema = new Schema({
  questionId: { type: String, required: true },
  selectedOptionId: { type: String, default: null },
  correct: { type: Boolean, default: false },
  points: { type: Number, default: 0 },
  answeredAt: { type: Date, default: Date.now },
  timedOut: { type: Boolean, default: false },        // true if user did not select before timer
  skippedAlreadyScored: { type: Boolean, default: false } // true if we skipped scoring because user previously answered that question correctly (prevents double-counting)
}, { _id: false });

const AttemptSchema = new Schema({
  testId: { type: Schema.Types.ObjectId, ref: 'Test', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  startedAt: { type: Date, default: Date.now },
  submittedAt: Date,
  score: { type: Number, default: 0 }, // total score (sum of points for this attempt)
  answers: [AnswerSchema]
});

AttemptSchema.index({ testId: 1, userId: 1 });

module.exports = mongoose.model('Attempt', AttemptSchema);
