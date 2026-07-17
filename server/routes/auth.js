// Dummy auth — accepts any valid email + password (min 4 chars).
// Persists onboarding profile server-side for future real auth swap-in.
//
// Tokens ARE HMAC-signed, though: now that real users' saved/applied
// pipelines and notes are private per-account, a token has to actually
// prove which account it belongs to, not just assert a userId nobody
// checks (a plain base64(userId|ts) would let anyone impersonate any
// account they can guess/derive the id for).

const express = require('express');
const crypto = require('crypto');
const { upsertUser, getUserByEmail, getUserById, getAllSettings, setSetting } = require('../db');
const { encrypt } = require('../services/cryptoService');

const router = express.Router();

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
    return payload.slice(0, payloadSep);
  } catch {
    return null;
  }
}

function getUserFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.query.token;
  if (!token) return null;
  const userId = parseToken(token);
  if (!userId) return null;
  return getUserById(userId);
}

router.post('/login', (req, res) => {
  const { email, password, name } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!password || String(password).length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters (dummy auth)' });
  }

  const normalized = email.toLowerCase().trim();
  let user = getUserByEmail(normalized);
  const id = user?.id || `user:${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;

  if (!user) {
    user = upsertUser({
      id,
      email: normalized,
      profile: { name: (name || '').trim(), email: normalized },
      onboardingComplete: false,
    });
  } else if (name && !user.profile?.name) {
    user = upsertUser({
      id: user.id,
      email: normalized,
      profile: { ...user.profile, name: name.trim(), email: normalized },
      onboardingComplete: user.onboardingComplete,
    });
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
    dummy: true,
  });
});

router.get('/me', (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  res.json({
    id: user.id,
    email: user.email,
    profile: sanitizeProfile(user.profile),
    onboardingComplete: user.onboardingComplete,
  });
});

router.put('/profile', (req, res) => {
  const user = getUserFromRequest(req);
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

  const updated = upsertUser({
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

module.exports = router;
module.exports.getUserFromRequest = getUserFromRequest;
