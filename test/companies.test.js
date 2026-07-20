// Company/job endpoints — status/notes/rating updates, job-applied toggle,
// and pipeline listing. Companies normally come from a real scan (external
// APIs), so this seeds one directly via db.js instead, the same way manual
// verification was done during the Postgres migration.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server/index.js');
const db = require('../server/db.js');

let server;
let baseUrl;
const TEST_COMPANY_ID = `test:companies-suite-${Date.now()}`;

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

before(async () => {
  await app.ready;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
  await db.upsertCompany({ id: TEST_COMPANY_ID, name: 'Companies Suite Co', lat: -37.81, lng: 144.96, website: 'https://example.com' });
});

after(async () => {
  // Companies are a shared discovery pool, not owned by any one user — clean
  // up the one this suite seeded so repeated CI runs don't accumulate dummy
  // rows in the (shared, real) database.
  await db.pool.query('DELETE FROM companies WHERE id = $1', [TEST_COMPANY_ID]);
  await new Promise((resolve) => server.close(resolve));
});

test('company status/notes/rating updates persist and list correctly', async () => {
  const email = `companies_suite_${Date.now()}@example.com`;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123', name: 'Companies Suite' }),
  });
  const cookie = cookieFrom(loginRes);
  assert.ok(cookie);

  const patchRes = await fetch(`${baseUrl}/api/companies/${encodeURIComponent(TEST_COMPANY_ID)}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'interested', notes: 'looks promising', user_rating: 4 }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.status, 'interested');
  assert.equal(patched.notes, 'looks promising');
  assert.equal(patched.user_rating, 4);

  const listRes = await fetch(`${baseUrl}/api/companies/pipeline?kind=interested`, { headers: { Cookie: cookie } });
  assert.equal(listRes.status, 200);
  const list = await listRes.json();
  assert.ok(list.companies.some(c => c.id === TEST_COMPANY_ID));

  // Cleanup — delete the account this test created (companies are a shared
  // pool, not owned by the user, so they're left for the `after` hook / a
  // future run to reuse the same seeded id).
  await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
});

test('job applied toggle', async () => {
  const email = `companies_suite_job_${Date.now()}@example.com`;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123', name: 'Job Toggle Test' }),
  });
  const cookie = cookieFrom(loginRes);

  await db.upsertJob({ company_id: TEST_COMPANY_ID, title: 'Test Role', url: 'https://example.com/jobs/1' });
  const job = (await db.listJobsForCompany(TEST_COMPANY_ID, null))[0];
  assert.ok(job);

  const markAppliedRes = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ applied: true }),
  });
  assert.equal(markAppliedRes.status, 200);
  const marked = await markAppliedRes.json();
  assert.equal(marked.applied, 1);

  const unmarkRes = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ applied: false }),
  });
  const unmarked = await unmarkRes.json();
  assert.equal(unmarked.applied, 0);

  await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
});
