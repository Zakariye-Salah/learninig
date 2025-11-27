// backend/src/models/User.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const UserSchema = new Schema({
  username: { type: String, required: true, unique: true, index: true },
  usernameNormalized: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

  fullName: { type: String, required: true },
  email: { type: String, default: null, trim: true }, // unique index created below (partial)

  phoneNumber: { type: String, default: null },

  country: { type: String, default: null, index: true },
  countryName: { type: String, default: null },
  countryFlagEmoji: { type: String, default: null },
  countryFlagUrl: { type: String, default: null },
  countryCallingCode: { type: String, default: null },

  city: { type: String, default: null },

  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin','controller','user'], default: 'user' },

  pointsCurrent: { type: Number, default: 0 },
  pointsHistory: [{ competitionId: Schema.Types.ObjectId, points: Number }],
  createdAt: { type: Date, default: Date.now },
  lastLogin: Date,
  isDeleted: { type: Boolean, default: false },
  pointsResetAt: { type: Date, default: null },

  balanceDollar: { type: Number, default: 0 },
  testBest: [
    {
      testId: { type: mongoose.Schema.Types.ObjectId, ref: 'Test' },
      streak: { type: Number, default: 0 },
      updatedAt: { type: Date, default: null }
    }
  ]
});

// usernameNormalized unique index
UserSchema.index({ usernameNormalized: 1 }, { unique: true, background: true });

// create a partial unique index for email so multiple nulls are allowed.
// This ensures uniqueness only for documents that have a non-null email.
UserSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true, $ne: null } }, background: true }
);

// leaderboard index
UserSchema.index({ pointsCurrent: -1 });

module.exports = mongoose.model('User', UserSchema);
