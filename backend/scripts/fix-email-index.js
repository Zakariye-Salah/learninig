require('dotenv').config();
const mongoose = require('mongoose');

const MONGO = process.env.MONGO_URI || 'mongodb://localhost:27017/learninghub';

(async () => {
  try {
    console.log('Connecting to', MONGO);
    await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
    const conn = mongoose.connection;
    const coll = conn.db.collection('users');

    const idxs = await coll.indexes();
    console.log('Indexes before:', idxs);

    // Drop any existing index that keys on email
    for (const ix of idxs) {
      if (ix.key && ix.key.email === 1) {
        console.log('Dropping index', ix.name);
        await coll.dropIndex(ix.name);
      }
    }

    // Create partial unique index for email so multiple nulls are allowed
    console.log('Creating partial unique index for email...');
    await coll.createIndex(
      { email: 1 },
      { unique: true, partialFilterExpression: { email: { $exists: true, $ne: null } }, background: true }
    );
    console.log('Partial unique index created for email.');

    // Ensure usernameNormalized unique index exists
    try {
      await coll.createIndex({ usernameNormalized: 1 }, { unique: true, background: true });
      console.log('Ensured usernameNormalized unique index.');
    } catch (e) {
      console.log('usernameNormalized ensure error (ok if already present):', e.message);
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Script failed:', err);
    process.exit(1);
  }
})();
