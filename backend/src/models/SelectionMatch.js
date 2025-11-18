// backend/src/models/SelectionMatch.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PlayerSchema = new Schema({
  playerId: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // optional reference to real user
  name: { type: String, required: true },
  isBot: { type: Boolean, default: false },
  lives: { type: Number, default: 0 },
  status: { type: String, default: 'active' },
  metadata: { type: Schema.Types.Mixed, default: {} }
}, { _id: false });

const HistorySchema = new Schema({
  round: Number,
  pickedPlayerId: String,
  pickedName: String,
  action: String,
  effect: String,
  remainingLives: Number,
  timestamp: { type: Date, default: Date.now }
}, { _id: false });

const ResultSchema = new Schema({
  winnerPlayerId: String,
  winnerPlayerIdName: String,
  ranks: [{ playerId: String, playerName: String, rank: Number }]
}, { _id: false });

const SelectionMatchSchema = new Schema({
  game: { type: String, default: 'selection' },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  mode: { type: String, enum: ['eliminate','lose_and_stay','skip','custom'], default: 'eliminate' },
  settings: { type: Schema.Types.Mixed, default: { lives: 1, autoContinue: false, botChallengeChance: 0.15, botAutoSpin: true } },
  players: [ PlayerSchema ],
  history: [ HistorySchema ],
  eliminationOrder: [ String ],
  result: ResultSchema,
  createdAt: { type: Date, default: Date.now },
  updatedAt: Date
});

SelectionMatchSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SelectionMatch', SelectionMatchSchema);
