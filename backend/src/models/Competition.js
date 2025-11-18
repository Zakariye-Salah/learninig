const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// CompetitionSchema changes (append snapshot field)
const CompetitionSchema = new Schema({
  name: String,
  startDate: Date,
  endDate: Date,
  isActive: { type: Boolean, default: true },
  finalResults: [{ rank: Number, userId: Schema.Types.ObjectId, fullName: String, points: Number }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date,
  // new optional snapshot field
  snapshot: {
    createdAt: Date,            // when snapshot created
    zeroed: { type: Boolean, default: false }, // whether points were zeroed at deactivate
    userPoints: [{ userId: Schema.Types.ObjectId, points: Number }], // preserved points
    note: String
  }
});

CompetitionSchema.index({ startDate: -1 });

module.exports = mongoose.model('Competition', CompetitionSchema);
