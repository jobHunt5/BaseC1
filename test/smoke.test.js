// Minimal smoke tests for the endpoints a real user actually depends on:
// health, signup/login, session, scan auth-gating, and account deletion.
// Uses node:test (built into Node 20, no extra dependency) against a real
// server bound to an ephemeral port. Runs against the same Postgres
// (DATABASE_URL) as dev/prod — there's no cheap throwaway Postgres the way
// there was a throwaway SQLite file — so every test either writes nothing,
// or (the auth test) cleans up the one account it creates via the real
// delete-account flow.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server/index.js');

let server;
let baseUrl;

before(async () => {
  await app.ready;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// Node's fetch has no automatic cookie jar across separate calls (unlike a
// browser) — the session now lives in an httpOnly cookie, so tests have to
// carry it forward manually between requests.
function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

test('GET /api/health responds ok', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('POST /api/scan without auth is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ south: -38, west: 145, north: -37, east: 146 }),
  });
  assert.equal(res.status, 401);
});

test('signup, login, me, and account deletion', async () => {
  const email = `smoke_${Date.now()}@example.com`;
  const password = 'testpass123';

  // First call to /login creates the account (no separate signup endpoint).
  const signupRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Smoke Test' }),
  });
  assert.equal(signupRes.status, 200);
  const cookie = cookieFrom(signupRes);
  assert.ok(cookie);
  const { user } = await signupRes.json();
  assert.equal(user.email, email);

  // Wrong password on an existing account must be rejected.
  const wrongLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'not-the-password' }),
  });
  assert.equal(wrongLoginRes.status, 401);

  // Right password on an existing account logs back in.
  const reloginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(reloginRes.status, 200);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.email, email);
  assert.equal(me.alertsEnabled, true, 'alerts should default on');
  assert.equal(me.trainingDataConsent, false, 'training-data consent should default off (opt-in only)');

  // Alerts + training-consent toggles both round-trip through /me.
  const alertsPatchRes = await fetch(`${baseUrl}/api/auth/alerts`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(alertsPatchRes.status, 200);
  const consentPatchRes = await fetch(`${baseUrl}/api/auth/training-consent`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(consentPatchRes.status, 200);
  const meAfterToggles = await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(meAfterToggles.alertsEnabled, false);
  assert.equal(meAfterToggles.trainingDataConsent, true);

  // Deleting with the wrong password must fail and leave the account intact.
  const badDeleteRes = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'not-the-password' }),
  });
  assert.equal(badDeleteRes.status, 401);

  const deleteRes = await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(deleteRes.status, 200);

  const meAfterDeleteRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookie },
  });
  assert.equal(meAfterDeleteRes.status, 401);
});
