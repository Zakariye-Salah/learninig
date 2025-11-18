const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Folder schema now stores bilingual name:
 * name: { en: String, som: String }
 * en is required (frontend uses English as default).
 */
const FolderSchema = new Schema({
  name: {
    en: { type: String, required: true },
    som: { type: String, default: '' }
  },
  parentId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  icon: { type: String, default: '' }, // emoji or image URL
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  isDeleted: { type: Boolean, default: false },
  authorId: { type: Schema.Types.ObjectId, ref: 'User', default: null }
});

FolderSchema.index({ parentId: 1 });

module.exports = mongoose.model('Folder', FolderSchema);
