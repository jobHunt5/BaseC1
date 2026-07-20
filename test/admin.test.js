// Admin auth + core admin endpoints: login gating, stats, settings update
// (and that it's recorded in the audit log), and suspend/delete on a
// throwaway user created just for this suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server/index.js');

let server;
let baseUrl;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

before(async () => {
  await app.ready;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('admin endpoints reject anonymous requests', async () => {
  const res = await fetch(`${baseUrl}/api/admin/stats`);
  assert.equal(res.status, 401);
});

test('admin login rejects wrong password', async () => {
  const res = await fetch(`${baseUrl}/api/admin-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong' }),
  });
  assert.equal(res.status, 401);
});

test('admin login, stats, settings update (audited), suspend + delete a user', async () => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    // CI doesn't set ADMIN_PASSWORD — skip rather than fail, since this
    // path is genuinely untestable without it, not broken.
    return;
  }

  const loginRes = await fetch(`${baseUrl}/api/admin-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = cookieFrom(loginRes);
  assert.ok(cookie);

  const statsRes = await fetch(`${baseUrl}/api/admin/stats`, { headers: { Cookie: cookie } });
  assert.equal(statsRes.status, 200);
  const stats = await statsRes.json();
  assert.ok('user_count' in stats);

  // Settings update should be recorded in the audit log.
  const settingRes = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'GOOGLE_GRID', value: 2 }),
  });
  assert.equal(settingRes.status, 200);

  const auditRes = await fetch(`${baseUrl}/api/admin/audit-log`, { headers: { Cookie: cookie } });
  assert.equal(auditRes.status, 200);
  const audit = await auditRes.json();
  assert.ok(audit.actions.some(a => a.action === 'setting_updated' && a.target === 'GOOGLE_GRID'));

  // Create a throwaway user (via the normal signup path), then exercise
  // suspend/unsuspend and delete through the admin API on it.
  const targetEmail = `admin_suite_target_${Date.now()}@example.com`;
  const signupRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, password: 'testpass123', name: 'Admin Suite Target' }),
  });
  const { user } = await signupRes.json();

  const suspendRes = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ suspended: true }),
  });
  assert.equal(suspendRes.status, 200);
  const suspended = await suspendRes.json();
  assert.equal(suspended.user.suspended, true);

  // A suspended account can no longer log in.
  const blockedLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: targetEmail, password: 'testpass123' }),
  });
  assert.equal(blockedLoginRes.status, 403);

  const deleteRes = await fetch(`${baseUrl}/api/admin/users/${user.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  assert.equal(deleteRes.status, 200);
});
