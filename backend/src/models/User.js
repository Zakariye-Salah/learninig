// backend/src/models/User.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  username: { type: String, required: true, unique: true, index: true },
  fullName: { type: String, required: true },
  email: { type: String, default: null },
  // phoneNumber holds the number user entered (with country code)
  phoneNumber: { type: String, default: null },

  // country: ISO alpha-2 code or custom code (e.g. 'XS-SL' for Somaliland)
  country: { type: String, default: null, index: true },
  // optional human-friendly name and emoji/url for UI display
  countryName: { type: String, default: null },
  countryFlagEmoji: { type: String, default: null },
  countryFlagUrl: { type: String, default: null },
  countryCallingCode: { type: String, default: null },

  // city (free text; for some countries we populate a select client-side)
  city: { type: String, default: null },

  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin','user'], default: 'user' },
  pointsCurrent: { type: Number, default: 0 },
  pointsHistory: [{ competitionId: Schema.Types.ObjectId, points: Number }],
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  isDeleted: { type: Boolean, default: false },
  pointsResetAt: { type: Date, default: null },

  // NEW: balance in dollars (used by withdraw flow)
  balanceDollar: { type: Number, default: 0 }
});

// index for leaderboard sorting
UserSchema.index({ pointsCurrent: -1 });

module.exports = mongoose.model('User', UserSchema);
