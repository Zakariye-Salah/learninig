// backend/src/models/Lesson.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const LessonSchema = new Schema({
  subjectId: { type: Schema.Types.ObjectId, default: null },
  topicId: { type: Schema.Types.ObjectId, default: null },
  folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  // bilingual title & content
  title: {
    en: { type: String, default: '' },
    som: { type: String, default: '' }
  },
  content: {
    en: { type: String, default: '' },
    som: { type: String, default: '' }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  isPublished: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false },
  authorId: { type: Schema.Types.ObjectId, default: null },

  // NEW: View counters / optional viewers history
  viewsCount: { type: Number, default: 0 },            // persistent counter of total views
  viewers: [{ type: Schema.Types.ObjectId, ref: 'User' }] // optional: a list of user IDs (may contain duplicates if you push each view)
});

LessonSchema.index({ subjectId: 1 });

module.exports = mongoose.model('Lesson', LessonSchema);
