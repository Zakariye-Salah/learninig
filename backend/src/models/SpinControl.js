// backend/src/models/SpinControl.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SpinControlSchema = new Schema({
  disabled: { type: Boolean, default: false },
  reason: { type: String, default: '' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  updatedAt: { type: Date, default: Date.now }
});

SpinControlSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('SpinControl', SpinControlSchema);
