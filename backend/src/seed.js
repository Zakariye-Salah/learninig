// backend/src/seed.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

const { MONGO_URI } = require('./config');
const User = require('./models/User');
const Test = require('./models/Test');

async function run() {
  try {
    console.log("Connecting to DB...");
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log("Connected.");

    // -------- FIX: Remove old admin if exists --------
    await User.deleteOne({ username: "admin" });
    await User.deleteOne({ username: "admin1" });

    console.log("Old admin removed if existed.");

    // -------- FIX: add unique email to prevent E11000 error --------
    const passwordHash = await bcrypt.hash("adminpass", 10);

    await User.create({
      username: "admin1",
      fullName: "Admin User",
      email: "admin1@example.com",   // FIXED: Avoid dup null emails
      passwordHash,
      role: "admin"
    });

    console.log("New admin created: admin1 / adminpass");

    // -------- Create demo test only if it does NOT exist --------
    const existing = await Test.findOne({ title: "Demo Test" });
    if (!existing) {
      await Test.create({
        title: "Demo Test",
        questions: [
          {
            id: "q1",
            text: { en: "2+2=?" },
            options: [
              { id: "a", text: { en: "3" } },
              { id: "b", text: { en: "4" }, isCorrect: true }
            ],
            pointsValue: 3
          },
          {
            id: "q2",
            text: { en: "Capital of France?" },
            options: [
              { id: "a", text: { en: "Paris" }, isCorrect: true },
              { id: "b", text: { en: "Berlin" } }
            ],
            pointsValue: 3
          }
        ]
      });

      console.log("Demo Test created.");
    } else {
      console.log("Demo Test already exists, skipped.");
    }

    console.log("Seed completed.");
    process.exit(0);

  } catch (err) {
    console.error("[SEED ERROR] ➜", err);
    process.exit(1);
  }
}

run();
