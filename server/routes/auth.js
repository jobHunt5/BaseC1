// Email/password auth. Passwords are real (scrypt-hashed, see
// passwordService.js) — this used to accept any 4+ char string for an
// existing account with zero verification, which let anyone log into any
// account just by knowing its email. Fixed with one safe migration: an
// account created before this fix (no password_hash yet) has its very
// first post-fix login attempt hash and lock in whatever password is
// given, same as a fresh signup — every account in this DB at the time of
// the fix was confirmed dev/test data with no real external user in a
// position to race that first login, so this is a one-time, already-closed
// window, not an ongoing gap.
//
// Tokens are HMAC-signed and expire (see TOKEN_TTL_MS) — a token has to
// actually prove which account it belongs to and can't be replayed forever
// if it leaks.

const express = require('express');
const crypto = require('crypto');
const { upsertUser, getUserByEmail, getUserById, getAllSettings, setSetting, setPasswordHash, deleteUser } = require('../db');
const { encrypt } = require('../services/cryptoService');
const { hashPassword, verifyPassword } = require('../services/passwordService');

const router = express.Router();

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Minimal in-process login rate limiter — 10 attempts per email+IP per 15
// minutes. Not a substitute for a real distributed limiter if this ever
// runs multi-instance (state doesn't share across processes), but stops
// the trivial single-instance brute-force case at negligible cost.
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;

function rateLimitKey(req, email) {
  return `${req.ip}|${email}`;
}

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

// Prevents unbounded memory growth from the map above — sweeps stale
// windows every hour rather than on every request.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.windowStart > RATE_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60 * 60 * 1000).unref();

// The encrypted app password never leaves the server — every response that
// includes a profile gets this instead of the raw emailAccount object, so
// the client can render "configured / not configured" without ever seeing
// (or being able to leak back) the ciphertext.
function sanitizeProfile(profile) {
  if (!profile?.emailAccount) return profile;
  const { email, host, port, appPasswordEnc } = profile.emailAccount;
  return {
    ...profile,
    emailAccount: { email: email || '', host: host || '', port: port || '', configured: !!appPasswordEnc },
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function getAuthSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const stored = getAllSettings();
  if (stored.AUTH_SECRET) return stored.AUTH_SECRET;
  const generated = crypto.randomBytes(32).toString('hex');
  setSetting('AUTH_SECRET', generated);
  return generated;
}

function sign(payload) {
  return crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function makeToken(userId) {
  const payload = `${userId}|${Date.now()}`;
  return Buffer.from(`${payload}|${sign(payload)}`).toString('base64url');
}

function parseToken(token) {
  try {
    const raw = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep <= 0) return null;
    const sig = raw.slice(sep + 1);
    const payload = raw.slice(0, sep);
    const payloadSep = payload.lastIndexOf('|');
    if (payloadSep <= 0) return null;
    if (!safeEqual(sig, sign(payload))) return null;
    // The timestamp used to be embedded but never actually checked — a
    // leaked token stayed valid forever. Reject anything older than the TTL.
    const issuedAt = Number(payload.slice(payloadSep + 1));
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > TOKEN_TTL_MS) return null;
    return payload.slice(0, payloadSep);
  } catch {
    return null;
  }
}

async function getUserFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  if (!token) return null;
  const userId = parseToken(token);
  if (!userId) return null;
  return getUserById(userId);
}

router.post('/login', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const normalized = email.toLowerCase().trim();
  if (!checkRateLimit(rateLimitKey(req, normalized))) {
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes' });
  }

  let user = await getUserByEmail(normalized);

  if (!user) {
    const id = `user:${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
    user = await upsertUser({
      id,
      email: normalized,
      profile: { name: (name || '').trim(), email: normalized },
      onboardingComplete: false,
    });
    await setPasswordHash(user.id, hashPassword(password));
  } else if (!user.passwordHash) {
    // Pre-existing account from before real passwords existed — this
    // login claims it (see the file-header comment for why that's safe
    // here specifically, not as a general pattern).
    await setPasswordHash(user.id, hashPassword(password));
    if (name && !user.profile?.name) {
      user = await upsertUser({
        id: user.id,
        email: normalized,
        profile: { ...user.profile, name: name.trim(), email: normalized },
        onboardingComplete: user.onboardingComplete,
      });
    }
  } else if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }

  if (user.suspended) {
    return res.status(403).json({ error: 'Account suspended' });
  }

  const token = makeToken(user.id);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      profile: sanitizeProfile(user.profile),
      onboardingComplete: user.onboardingComplete,
    },
  });
});

router.get('/me', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({
    id: user.id,
    email: user.email,
    profile: sanitizeProfile(user.profile),
    onboardingComplete: user.onboardingComplete,
  });
});

router.put('/profile', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { profile, onboardingComplete } = req.body || {};
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ error: 'profile object required' });
  }

  // The client sends a plaintext appPassword only when the user actually
  // typed a new one (the field is always blank on load — see
  // sanitizeProfile). Encrypt it here and keep the existing encrypted value
  // when they left it blank, instead of overwriting a saved password with
  // nothing just because the form re-submitted an empty field.
  let mergedEmailAccount = user.profile?.emailAccount;
  if (profile.emailAccount) {
    const incoming = profile.emailAccount;
    mergedEmailAccount = {
      email: incoming.email ?? user.profile?.emailAccount?.email ?? '',
      host: incoming.host ?? user.profile?.emailAccount?.host ?? '',
      port: incoming.port ?? user.profile?.emailAccount?.port ?? '',
      appPasswordEnc: incoming.appPassword
        ? encrypt(incoming.appPassword)
        : user.profile?.emailAccount?.appPasswordEnc,
    };
  }

  const nextProfile = { ...user.profile, ...profile, email: user.email };
  if (mergedEmailAccount) nextProfile.emailAccount = mergedEmailAccount;
  else delete nextProfile.emailAccount;

  const updated = await upsertUser({
    id: user.id,
    email: user.email,
    profile: nextProfile,
    onboardingComplete: onboardingComplete !== undefined ? !!onboardingComplete : user.onboardingComplete,
  });

  res.json({
    id: updated.id,
    email: updated.email,
    profile: sanitizeProfile(updated.profile),
    onboardingComplete: updated.onboardingComplete,
  });
});

// Requires the current password as re-confirmation — a bearer token alone
// (e.g. left signed in on a shared device) shouldn't be enough to
// permanently destroy an account.
router.delete('/me', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { password } = req.body || {};
  if (user.passwordHash && !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  await deleteUser(user.id);
  res.json({ deleted: true });
});

module.exports = router;
module.exports.getUserFromRequest = getUserFromRequest;
