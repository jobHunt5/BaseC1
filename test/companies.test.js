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

test('application-tracking stages (interviewing/offer/rejected) can be set and show up in the applied pipeline', async () => {
  const email = `companies_suite_stages_${Date.now()}@example.com`;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123', name: 'Stages Suite' }),
  });
  const cookie = cookieFrom(loginRes);
  assert.ok(cookie);

  for (const stage of ['interviewing', 'offer', 'rejected']) {
    const patchRes = await fetch(`${baseUrl}/api/companies/${encodeURIComponent(TEST_COMPANY_ID)}`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: stage }),
    });
    assert.equal(patchRes.status, 200, `PATCHing status to '${stage}' should be accepted`);
    const patched = await patchRes.json();
    assert.equal(patched.status, stage);

    const listRes = await fetch(`${baseUrl}/api/companies/pipeline?kind=applied`, { headers: { Cookie: cookie } });
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.ok(list.companies.some(c => c.id === TEST_COMPANY_ID), `'${stage}' should count as part of the applied pipeline`);
  }

  const badRes = await fetch(`${baseUrl}/api/companies/${encodeURIComponent(TEST_COMPANY_ID)}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'not-a-real-stage' }),
  });
  assert.equal(badRes.status, 400);

  await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
});

test('syncJobsForCompany tracks an exact-URL repost after the job vanishes and reappears', async () => {
  const companyId = `test:repost-exact-${Date.now()}`;
  await db.upsertCompany({ id: companyId, name: 'Repost Exact Co', lat: -37.81, lng: 144.96 });

  await db.syncJobsForCompany(companyId, [{ title: 'Nurse', url: 'https://example.com/jobs/1', posted_at: Date.now() }]);
  const [firstRow] = await db.listJobsForCompany(companyId, null);
  assert.ok(firstRow);
  const firstSeenAt = firstRow.first_seen_at;

  await db.syncJobsForCompany(companyId, []); // job vanishes from a rescan
  const [removedRow] = await db.listJobsForCompany(companyId, null);
  assert.ok(removedRow.removed_at, 'a vanished job should be soft-removed, not deleted');

  await db.syncJobsForCompany(companyId, [{ title: 'Nurse', url: 'https://example.com/jobs/1', posted_at: Date.now() }]);
  const [repostedRow] = await db.listJobsForCompany(companyId, null);
  assert.equal(repostedRow.repost_count, 1);
  assert.equal(Number(repostedRow.first_seen_at), Number(firstSeenAt));
  assert.equal(repostedRow.removed_at, null);

  await db.pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
});

test('syncJobsForCompany tracks a repost under a new listing URL via normalized title, without forking history', async () => {
  const companyId = `test:repost-newurl-${Date.now()}`;
  await db.upsertCompany({ id: companyId, name: 'Repost New URL Co', lat: -37.81, lng: 144.96 });

  await db.syncJobsForCompany(companyId, [{ title: 'Senior Data Analyst', url: 'https://example.com/jobs/1', posted_at: Date.now() }]);
  const [firstRow] = await db.listJobsForCompany(companyId, null);
  const firstSeenAt = firstRow.first_seen_at;

  await db.syncJobsForCompany(companyId, []); // vanishes
  await db.syncJobsForCompany(companyId, [{ title: 'Data Analyst', url: 'https://example.com/jobs/2', posted_at: Date.now() }]); // reposted, new URL, slightly different title text

  const rows = await db.listJobsForCompany(companyId, null);
  assert.equal(rows.length, 1, 'the stale row should be merged into the new one, not left forked');
  assert.equal(rows[0].repost_count, 1);
  assert.equal(Number(rows[0].first_seen_at), Number(firstSeenAt));
  assert.equal(rows[0].url, 'https://example.com/jobs/2');

  await db.pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
});

test('a rescan never touches a job a user has applied to (regression test for the old hard-delete cascade bug)', async () => {
  const companyId = `test:applied-guard-${Date.now()}`;
  await db.upsertCompany({ id: companyId, name: 'Applied Guard Co', lat: -37.81, lng: 144.96 });

  const email = `companies_suite_applied_guard_${Date.now()}@example.com`;
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'testpass123', name: 'Applied Guard Test' }),
  });
  const cookie = cookieFrom(loginRes);
  const { user } = await loginRes.json();

  await db.syncJobsForCompany(companyId, [{ title: 'Backend Engineer', url: 'https://example.com/jobs/applied' }]);
  const [job] = await db.listJobsForCompany(companyId, null);
  await db.setJobApplied(user.id, job.id, true);

  // Simulate a rescan where the job no longer appears in the fresh scrape.
  await db.syncJobsForCompany(companyId, []);

  const stillThere = await db.getJob(job.id, user.id);
  assert.ok(stillThere, 'an applied job must survive a rescan even if it disappeared from the site');
  assert.equal(stillThere.applied, 1, 'the applied flag must survive too');
  assert.equal(stillThere.removed_at, null, 'an applied job should not even be soft-removed');

  await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
  await db.pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
});

test('a repost match outside the retention window is treated as an unrelated new posting', async () => {
  const companyId = `test:repost-stale-${Date.now()}`;
  await db.upsertCompany({ id: companyId, name: 'Repost Stale Co', lat: -37.81, lng: 144.96 });

  await db.upsertJob({ company_id: companyId, title: 'Old Role', url: 'https://example.com/jobs/old', title_norm: 'old role' });
  const beyondRetention = Date.now() - (200 * 24 * 60 * 60 * 1000); // past the 150-day window
  await db.pool.query('UPDATE jobs SET removed_at = $1 WHERE company_id = $2', [beyondRetention, companyId]);

  await db.syncJobsForCompany(companyId, [{ title: 'Old Role', url: 'https://example.com/jobs/old-2', posted_at: Date.now() }]);
  const rows = await db.listJobsForCompany(companyId, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repost_count, 0, 'a match outside the retention window should not count as a repost');

  await db.pool.query('DELETE FROM companies WHERE id = $1', [companyId]);
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
