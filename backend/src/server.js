// backend/src/server.js
'use strict';

const path = require('path');
const http = require('http');
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');

const { PORT = 4000, MONGO_URI } = require('./config');
const job = require('./jobs/archiveJob');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const testsRoutes = require('./routes/tests');
const competitionsRoutes = require('./routes/competitions');
const leaderboardRoutes = require('./routes/leaderboard');

const Competition = require('./models/Competition');

// at top near other route imports
const lessonsRoutes = require('./routes/lessons');

const accountRoutes = require('./routes/account');

const helpRoutes = require('./routes/help');

// near other route mounts
const gamesRoutes = require('./routes/games');

// in backend/src/server.js or where you mount other routes
const storiesRoutes = require('./routes/stories');

const app = express();
const server = http.createServer(app);

// Socket.IO init
const io = require('socket.io')(server, { cors: { origin: process.env.CORS_ORIGIN || '*' } });
app.set('io', io);

// wire socket handlers (comments & auth)
const initSocket = require('./socket');
initSocket(io, app);

// Standard middleware
app.use(helmet());
app.use(express.json({ limit: '300kb' }));
app.use(express.urlencoded({ extended: true }));

const allowed = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'), false);
  }
}));

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// static public
const publicDir = path.join(__dirname, '../../public');
app.use(express.static(publicDir, { maxAge: '1h' }));

// rate limiter
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
}));

app.get('/health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

// mount routes (these use app.get/post paths you already created)
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/competitions', competitionsRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// later, after other mounts:
app.use('/api/lessons', lessonsRoutes);

// ...
app.use('/api/account', accountRoutes);

app.use('/api/help', helpRoutes);


app.use('/api/games', gamesRoutes);

app.use('/api/stories', storiesRoutes);

// mount users compatibility router at top-level /api
app.use('/api', require('./routes/users'));


// fallback 404 for api
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Not found' }));

// central error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err && err.stack ? err.stack : err);
  const status = err && err.status ? err.status : 500;
  const safe = { error: (status === 500 ? 'Server error' : err.message || 'Error') };
  res.status(status).json(safe);
});

// socket.io default handlers (already set in socket.js) - nothing else here

// startup helpers
async function ensureActiveCompetition() {
  const active = await Competition.findOne({ isActive: true }).sort({ startDate: -1 });
  if (!active) {
    const now = new Date();
    const name = now.toLocaleString('en-US', { year: 'numeric', month: 'long' }) + ' Competition';
    const comp = await Competition.create({ name, startDate: now, isActive: true });
    console.log('Created initial active competition:', comp.name);
    return comp;
  }
  console.log('Active competition exists:', active.name);
  return active;
}

function setupGracefulShutdown(httpServer) {
  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Closing server...`);
    try {
      httpServer.close(() => console.log('HTTP server closed'));
      await mongoose.disconnect();
      console.log('Mongo disconnected');
      io.close();
      console.log('Socket.IO closed');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown', err);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection', reason);
  });
}

async function start() {
  if (!MONGO_URI) {
    console.error('MONGO_URI not set; aborting');
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('MongoDB connected');

    await ensureActiveCompetition();

    // start archive job (job.start should set app.locals.runArchive)
    job.start(app);

    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
    setupGracefulShutdown(server);
  } catch (err) {
    console.error('Failed to start', err);
    process.exit(1);
  }
}

start();

module.exports = { app, server, io };
