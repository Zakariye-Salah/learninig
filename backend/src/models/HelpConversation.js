//File: backend/src/models/HelpConversation.js


const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MessageSchema = new Schema({
  sender: { type: String, enum: ['user','admin'], required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  readByAdmin: { type: Boolean, default: false },
  readByUser: { type: Boolean, default: false }
}, { _id: false });

const HelpConversationSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String },
  userUsername: { type: String },
  isClosed: { type: Boolean, default: false },
  lastMessage: { type: String },
  messages: [MessageSchema],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

HelpConversationSchema.index({ userId: 1 });
HelpConversationSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('HelpConversation', HelpConversationSchema);