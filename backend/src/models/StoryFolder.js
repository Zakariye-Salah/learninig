'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const StoryFolderSchema = new Schema({
  nameEng: { type: String, required: true },
  nameSom: { type: String },
  createdBy: { type: String, index: true }, // user id who created this folder (optional)
  isDeleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() }
});

module.exports = mongoose.model('StoryFolder', StoryFolderSchema);
