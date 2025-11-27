// backend/src/seed.js
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
require('dotenv').config();

const { MONGO_URI } = require('./config');
const User = require('./models/User');

async function run() {
  try {
    console.log("Connecting to DB...");
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

    console.log("Connected to DB:", mongoose.connection.db.databaseName);

    // -------- Remove old admin if exists --------
    console.log("Removing old admin user (if exists)...");
    await User.deleteOne({ username: "zaki@gmail.com" });

    // -------- Create new admin --------
    console.log("Creating new admin user...");

    const passwordHash = await bcrypt.hash("adminpass", 10);

    await User.create({
      username: "zaki@gmail.com",            // username login
      usernameNormalized: "zaki@gmail.com".toLowerCase(),
      fullName: "zakariye salah ali",
      email: "zaki@gmail.com",               // use same email to be safe
      emailNormalized: "zaki@gmail.com".toLowerCase(),
      passwordHash,
      role: "admin",
      country: "SO",                          // optional
      isDeleted: false
    });

    console.log("✔ Admin user created successfully!");
    console.log("Login with:");
    console.log("   Username: zaki@gmail.com");
    console.log("   Password: adminpass");
    console.log("   Role: admin");

    console.log("Seed completed.");
    process.exit(0);

  } catch (err) {
    console.error("[SEED ERROR] =>", err);
    process.exit(1);
  }
}

run();
