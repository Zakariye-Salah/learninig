//File: backend/src/models/HelpConversation.js


const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// MessageSchema additions:
const MessageSchema = new Schema({
  sender: { type: String, enum: ['user','admin'], required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  readByAdmin: { type: Boolean, default: false },
  readByUser: { type: Boolean, default: false },

  // new optional metadata
  issueType: { type: String, default: null },      // helps store category for the message
  adminName: { type: String, default: null },      // for admin messages store author name
  adminRole: { type: String, default: null }       // for admin messages store role (admin/controller)
}, { _id: false });

// Top-level conversation additions:
const HelpConversationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String },
  userUsername: { type: String },
  isClosed: { type: Boolean, default: false },
  lastMessage: { type: String },
  messages: [MessageSchema],
  issueType: { type: String, default: null }, // new: primary issue for the conversation (first message)
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});



HelpConversationSchema.index({ userId: 1 });
HelpConversationSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('HelpConversation', HelpConversationSchema);