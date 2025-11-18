// backend/src/models/Announcement.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AnnouncementSchema = new Schema({
  title: { type: String, default: '' },
  text: { type: String, required: true },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  authorName: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  isPublished: { type: Boolean, default: true }
});

AnnouncementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Announcement', AnnouncementSchema);
