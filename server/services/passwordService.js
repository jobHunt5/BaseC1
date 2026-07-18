// Real password hashing — scrypt (Node's built-in, no extra dependency),
// each password salted independently. Stored as "salt:hash", both hex.

const crypto = require('crypto');

const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuf = Buffer.from(hash, 'hex');
  const candidate = crypto.scryptSync(String(password), salt, KEY_LEN);
  if (candidate.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(candidate, hashBuf);
}

module.exports = { hashPassword, verifyPassword };
