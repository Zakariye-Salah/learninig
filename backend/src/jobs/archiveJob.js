const cron = require('node-cron');
const Competition = require('../models/Competition');
const User = require('../models/User');

function formatCompetitionName(date) {
  return date.toLocaleString('en-US', { year: 'numeric', month: 'long' }) + ' Competition';
}

async function runArchive(io) {
  const active = await Competition.findOne({ isActive: true }).sort({ startDate: -1 });
  if (!active) {
    console.log('No active competition found for archive.');
    return;
  }
  const users = await User.find({ isDeleted: { $ne: true } }).sort({ pointsCurrent: -1 }).lean();
  const finalResults = users.map((u, i) => ({ rank: i + 1, userId: u._id, fullName: u.fullName, points: u.pointsCurrent }));
  active.finalResults = finalResults;
  active.endDate = new Date();
  active.isActive = false;
  active.updatedAt = new Date();
  await active.save();

  const nextStart = new Date();
  const nextName = formatCompetitionName(nextStart);
  const comp = new Competition({ name: nextName, startDate: nextStart, isActive: true });
  await comp.save();

  await User.updateMany({}, { $set: { pointsCurrent: 0 } });

  if (io) io.emit('competition:archived', { archivedId: active._id, name: active.name });
  console.log('Archived competition', active.name, '-> created', nextName);
}

module.exports = {
  start: (app) => {
    const io = app.get('io');
    // run at 00:00 on day 1 of every month UTC
    cron.schedule('0 0 1 * *', () => {
      runArchive(io).catch(console.error);
    }, { timezone: 'UTC' });
    app.locals.runArchive = () => runArchive(io);
  }
};
