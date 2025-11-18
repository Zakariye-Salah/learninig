// backend/src/models/Withdrawal.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const WithdrawalSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  amount: { type: Number, required: true }, // dollars (store as float)
  phone: { type: String, required: true },
  status: { type: String, enum: ['pending','verified','rejected'], default: 'pending', index: true },
  requestedAt: { type: Date, default: Date.now, index: true },
  verifiedAt: Date,
  verifiedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  note: { type: String, default: '' }
}, {
  timestamps: true, // createdAt, updatedAt
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Compound index for queries by user and time
WithdrawalSchema.index({ userId: 1, requestedAt: -1 });
WithdrawalSchema.index({ userId: 1, status: 1, requestedAt: -1 });

// Safe output transform
WithdrawalSchema.options.toJSON.transform = function (doc, ret) {
  delete ret.__v;
  // keep id as string
  ret.id = String(ret._id);
  return ret;
};

module.exports = mongoose.model('Withdrawal', WithdrawalSchema);
