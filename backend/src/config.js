require('dotenv').config();
module.exports = {
  PORT: process.env.PORT || 4000,
  MONGO_URI: process.env.MONGO_URI,
  JWT_SECRET: process.env.JWT_SECRET || 'change_me',
  TOKEN_EXPIRY: '7d',
  SERVER_TZ: process.env.SERVER_TZ || 'UTC',
  QUESTION_SECONDS: parseInt(process.env.QUESTION_SECONDS || '20', 10)
};
