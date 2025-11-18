// backend/src/models/Attempt.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AnswerSchema = new Schema({
  questionId: String,
  selectedOptionId: String,
  answerTime: Date,
  correct: Boolean,
  timedOut: Boolean
}, { _id: false });

const AttemptSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  testId: { type: Schema.Types.ObjectId, ref: 'Test' },
  attemptToken: String,
  startTime: Date,
  scoreDelta: Number,
  answers: [AnswerSchema],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Attempt', AttemptSchema);
