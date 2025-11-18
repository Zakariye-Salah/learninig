// backend/src/models/Comment.js
'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const CommentSchema = new Schema({
  storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true },
  parentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
  userId: { type: String }, // free-form id
  userName: { type: String },
  isAdmin: { type: Boolean, default: false },
  content: { type: String },
  isDeleted: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  reactionCounts: { type: Map, of: Number, default: {} },
  reactionsByUser: { type: Map, of: String, default: {} }, // userId => reaction key
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

CommentSchema.methods.applyReaction = function(userId, reaction){
  const prev = this.reactionsByUser.get(String(userId));
  if (prev){
    this.reactionCounts.set(prev, Math.max(0, (this.reactionCounts.get(prev)||0) - 1));
  }
  if (reaction){
    this.reactionsByUser.set(String(userId), reaction);
    this.reactionCounts.set(reaction, (this.reactionCounts.get(reaction)||0) + 1);
  } else {
    this.reactionsByUser.delete(String(userId));
  }
};

module.exports = mongoose.model('Comment', CommentSchema);
