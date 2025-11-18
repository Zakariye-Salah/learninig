// backend/src/models/Test.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const OptionSchema = new Schema({
  id: String,
  text: { en: String, som: String },
  isCorrect: { type: Boolean, default: false }
}, { _id: false });

const QuestionSchema = new Schema({
  id: String,
  text: { en: String, som: String },
  options: [OptionSchema],
  pointsValue: { type: Number, default: 3 }
}, { _id: false });

const TestSchema = new Schema({
  title: { type: String, required: true },
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder' },
  lessonId: { type: Schema.Types.ObjectId, ref: 'Lesson' },
  questions: [QuestionSchema],
  shuffle: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
});

module.exports = mongoose.model('Test', TestSchema);
