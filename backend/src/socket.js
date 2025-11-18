// backend/src/socket.js
'use strict';

const jwt = require('jsonwebtoken');
const sanitizeHtml = require('sanitize-html');
const LeaderboardComment = require('./models/LeaderboardComment');
const Competition = require('./models/Competition');
const User = require('./models/User');
const { JWT_SECRET } = require('./config');

/**
 * Initialize Socket.IO handlers.
 * @param {import('socket.io').Server} io
 * @param {import('express').Express} app
 */
module.exports = function initSocket(io, app) {
  // Middleware on connection: optional token auth from handshake
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth && socket.handshake.auth.token) || socket.handshake.query.token;
      if (!token) {
        // allow anonymous socket connections (read-only), so don't reject; attach no user
        return next();
      }
      const data = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(data.id).lean();
      if (!user || user.isDeleted) return next(new Error('Invalid user'));
      // attach minimal user info to socket
      socket.user = { id: user._id.toString(), role: user.role, fullName: user.fullName };
      return next();
    } catch (err) {
      // if token invalid, allow connection (but socket.user won't be set); or reject by passing error:
      // next(new Error('Authentication error'));
      return next(); // make socket anonymous if you prefer
    }
  });

  io.on('connection', (socket) => {
    // join a competition room
    socket.on('joinCompetition', (competitionId) => {
      if (!competitionId) return;
      socket.join(`competition:${competitionId}`);
    });

    // Post a comment via socket (client should call with token in handshake.auth.token or query)
    // payload: { competitionId, content }
    socket.on('postComment', async (payload) => {
      try {
        if (!socket.user) return socket.emit('error', { error: 'Authentication required to post comments' });
        const { competitionId, content } = payload || {};
        if (!competitionId || !content || !String(content).trim()) {
          return socket.emit('error', { error: 'Missing fields' });
        }
        const comp = await Competition.findById(competitionId);
        if (!comp) return socket.emit('error', { error: 'Competition not found' });

        const safeContent = sanitizeHtml(String(content).trim(), { allowedTags: [], allowedAttributes: {} }).slice(0, 1000);
        const commentDoc = await LeaderboardComment.create({
          competitionId,
          userId: socket.user.id,
          userName: socket.user.fullName || 'Unknown',
          content: safeContent
        });

        // emit to room
        io.to(`competition:${competitionId}`).emit('comments:new', { comment: commentDoc });
      } catch (err) {
        console.error('socket.postComment', err);
        socket.emit('error', { error: 'Failed to post comment' });
      }
    });

    // Delete comment via socket (payload: { commentId })
    socket.on('deleteComment', async (payload) => {
      try {
        if (!socket.user) return socket.emit('error', { error: 'Authentication required to delete comments' });
        const { commentId } = payload || {};
        if (!commentId) return socket.emit('error', { error: 'Missing commentId' });
        const c = await LeaderboardComment.findById(commentId);
        if (!c) return socket.emit('error', { error: 'Comment not found' });

        // check permission: owner or admin
        if (c.userId.toString() !== socket.user.id && socket.user.role !== 'admin') {
          return socket.emit('error', { error: 'Not allowed' });
        }

        c.isDeleted = true;
        c.deletedBy = socket.user.id;
        await c.save();

        // notify all watchers of this competition
        io.to(`competition:${c.competitionId}`).emit('comments:deleted', { id: c._id });

        socket.emit('ok', { id: c._id });
      } catch (err) {
        console.error('socket.deleteComment', err);
        socket.emit('error', { error: 'Failed to delete comment' });
      }
    });

    // Optionally allow client to listen for leaderboard updates (no-op here)
    // socket.on('subscribeLeaderboard', (payload) => { ... });

    socket.on('disconnect', (reason) => {
      // cleanup (if needed)
    });
  });
};
