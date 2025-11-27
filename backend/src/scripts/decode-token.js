// scripts/decode-token.js
require('dotenv').config();
const jwt = require('jsonwebtoken');

const token = process.argv[2];
if (!token) {
  console.error('Usage: node decode-token.js <token>');
  process.exit(2);
}

try {
  // decode without verifying to inspect payload
  const payload = jwt.decode(token, { complete: false });
  console.log('Token payload (decoded):', payload);
} catch (err) {
  console.error('Failed to decode token:', err.message || err);
}
