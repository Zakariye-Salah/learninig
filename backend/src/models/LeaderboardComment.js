const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CommentSchema = new Schema({
  competitionId: Schema.Types.ObjectId,
  userId: Schema.Types.ObjectId,
  userName: String,
  content: String,
  createdAt: { type: Date, default: Date.now },
  isDeleted: { type: Boolean, default: false },
  deletedBy: { type: Schema.Types.ObjectId, default: null }
});

CommentSchema.index({ competitionId: 1 });

module.exports = mongoose.model('LeaderboardComment', CommentSchema);
