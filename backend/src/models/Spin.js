// backend/src/models/Spin.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SpinSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  bet: { type: Number, required: true },
  won: { type: Number, required: true },
  outcome: Schema.Types.Mixed, // the outcome value (number) and any metadata
  createdAt: { type: Date, default: Date.now }
});

SpinSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Spin', SpinSchema);
