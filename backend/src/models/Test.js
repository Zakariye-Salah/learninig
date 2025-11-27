'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Test model
 * - questions.text/en and text/som are stored as plain strings (preserve newlines).
 * - explanation.en / explanation.som included for detailed answer text.
 */

const OptionSchema = new Schema({
  id: { type: String, default: null }, // friendly id (frontend uses)
  text: {
    en: { type: String, default: '' },
    som: { type: String, default: '' }
  },
  isCorrect: { type: Boolean, default: false }
}, { _id: false });

const QuestionSchema = new Schema({
  id: { type: String, default: null },
  text: {
    en: { type: String, default: '' },
    som: { type: String, default: '' }
  },
  explanation: {                  // shown when user selects correct option (or used as explanation)
    en: { type: String, default: '' },
    som: { type: String, default: '' }
  },
  options: [OptionSchema],
  pointsValue: { type: Number, default: 3 } // correct => +pointsValue ; incorrect => -1 ; unanswered => 0
}, { _id: false });

const TestSchema = new Schema({
  title: { type: String, required: true },
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  lessonId: { type: Schema.Types.ObjectId, ref: 'Lesson', default: null },
  questions: [QuestionSchema],
  shuffle: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  isDeleted: { type: Boolean, default: false },

  bestStreak: { type: Number, default: 0 },
  bestHolderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  bestHolderName: { type: String, default: '' },
  bestStreakUpdatedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Test', TestSchema);
