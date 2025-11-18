'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const ReactionCountsSchema = new Schema({
  like: { type: Number, default: 0 },
  love: { type: Number, default: 0 },
  haha: { type: Number, default: 0 },
  wow:  { type: Number, default: 0 },
  angry:{ type: Number, default: 0 },
  sad:  { type: Number, default: 0 }
}, { _id: false });

const StorySchema = new Schema({
  folderId: { type: Schema.Types.ObjectId, ref: 'StoryFolder' },
  titleEng: String,
  titleSom: String,
  contentEng: String,
  contentSom: String,
  isDeleted: { type: Boolean, default: false },

  // new publish / approval fields:
  published: { type: Boolean, default: false },         // visible to all when true
  pendingApproval: { type: Boolean, default: false },   // needs admin verification
  pendingDelete: { type: Boolean, default: false },     // user asked to delete; needs admin approval

  reactionCounts: { type: ReactionCountsSchema, default: () => ({}) },
  reactionsByUser: { type: Map, of: String, default: {} },
  readBy: { type: [String], default: [] },
  pinned: { type: Boolean, default: false },

  // who submitted the story (user-submitted)
  authorId: { type: String },
  authorName: { type: String },

  createdBy: { type: String }, // legacy/admin-created
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

// maintain older behavior for reaction toggling
StorySchema.methods.applyReaction = function(userId, reaction){
  const prev = this.reactionsByUser.get(String(userId));
  if (prev){
    if (this.reactionCounts[prev] > 0) this.reactionCounts[prev] = Math.max(0, this.reactionCounts[prev]-1);
  }
  if (reaction){
    this.reactionsByUser.set(String(userId), reaction);
    this.reactionCounts[reaction] = (this.reactionCounts[reaction]||0) + 1;
  } else {
    this.reactionsByUser.delete(String(userId));
  }
};

module.exports = mongoose.model('Story', StorySchema);
