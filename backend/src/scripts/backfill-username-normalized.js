// backend/scripts/backfill-username-normalized.js
const mongoose = require('mongoose');
const User = require('../src/models/User'); // path relative from backend/scripts -> adjust if different
const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/your_db_name'; // replace db name

(async () => {
  try {
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('connected');

    const cursor = User.find({ $or: [{ usernameNormalized: { $exists: false } }, { usernameNormalized: null }, { usernameNormalized: '' }] }).cursor();
    let updated = 0;
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      doc.usernameNormalized = (doc.username || '').toLowerCase();
      await doc.save();
      updated++;
      if (updated % 200 === 0) console.log('updated', updated);
    }
    console.log('updated total', updated);

    console.log('ensuring usernameNormalized unique index');
    await User.collection.createIndex({ usernameNormalized: 1 }, { unique: true });
    console.log('done');
    process.exit(0);
  } catch (err) {
    console.error('backfill failed', err);
    process.exit(1);
  }
})();
