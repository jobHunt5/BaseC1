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

// Shorter-lived than the regular user token — an admin token can read,
// suspend, or delete every real account, so it's worth re-authenticating
// more often than a normal session.
const ADMIN_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const ADMIN_SESSION_COOKIE = 'areahunt_admin_session';

function setAdminSessionCookie(res, token) {
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ADMIN_TOKEN_TTL_MS,
    path: '/',
  });
}

function clearAdminSessionCookie(res) {
  res.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
}

const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 8;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    loginAttempts.set(key, { windowStart: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.windowStart > RATE_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

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
    if (!safeEqual(sig, sign(`${marker}|${ts}`))) return false;
    // The timestamp was embedded but never checked — a leaked admin token
    // (arguably the most dangerous credential in this app) stayed valid
    // forever. Reject anything past the TTL.
    const issuedAt = Number(ts);
    return Number.isFinite(issuedAt) && Date.now() - issuedAt <= ADMIN_TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

function getAdminFromRequest(req) {
  const token = req.cookies?.[ADMIN_SESSION_COOKIE];
  return isValidAdminToken(token);
}

router.post('/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_PASSWORD not configured on the server (.env)' });
  }
  if (!checkRateLimit(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }
  const { password } = req.body || {};
  if (!password || !safeEqual(password, expected)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token = makeAdminToken();
  setAdminSessionCookie(res, token);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
module.exports.getAdminFromRequest = getAdminFromRequest;
