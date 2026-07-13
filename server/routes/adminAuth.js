// Admin auth — completely separate from the dummy per-email user auth in
// auth.js. There's exactly one admin identity (you), gated by a single
// password from .env, not a row in the users table. Tokens are HMAC-signed
// (unlike the deliberately-forgeable dummy user tokens) because an admin
// token grants read/suspend/delete access to every real user's account —
// that one has to actually be unforgeable.
//
//   POST /api/admin-auth/login   body: { password }  -> { token }

const express = require('express');
const crypto = require('crypto');
const { getAllSettings, setSetting } = require('../db');

const router = express.Router();

function getAdminAuthSecret() {
  if (process.env.ADMIN_AUTH_SECRET) return process.env.ADMIN_AUTH_SECRET;
  const stored = getAllSettings();
  if (stored.ADMIN_AUTH_SECRET) return stored.ADMIN_AUTH_SECRET;
  const generated = crypto.randomBytes(32).toString('hex');
  setSetting('ADMIN_AUTH_SECRET', generated);
  return generated;
}

function sign(payload) {
  return crypto.createHmac('sha256', getAdminAuthSecret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeAdminToken() {
  const payload = `admin|${Date.now()}`;
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
}

function isValidAdminToken(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const parts = raw.split('|');
    if (parts.length !== 3 || parts[0] !== 'admin') return false;
    const [marker, ts, sig] = parts;
    return safeEqual(sig, sign(`${marker}|${ts}`));
  } catch {
    return false;
  }
}

function getAdminFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  return isValidAdminToken(token);
}

router.post('/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD not configured on the server (.env)' });
  }
  const { password } = req.body || {};
  if (!password || !safeEqual(password, expected)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: makeAdminToken() });
});

module.exports = router;
module.exports.getAdminFromRequest = getAdminFromRequest;
