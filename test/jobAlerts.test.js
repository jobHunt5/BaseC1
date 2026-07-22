// Proactive job-alert emails — skill matching, the location-based candidate
// query, dedup idempotency, and an end-to-end run of the check job (with
// SMTP unset locally, so sending is a safe no-op — same pattern already
// relied on elsewhere for systemMailService, see test/smoke.test.js's
// "SMTP not configured" skip path).

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db.js');
const { companyMatchesProfile } = require('../server/services/skillMatchService');
const { runJobAlertsCheck } = require('../server/services/jobAlertService');
const { buildJobAlertEmailContent } = require('../server/services/systemMailService');

before(async () => {
  await db.ready;
});

// --- skill matching ---------------------------------------------------------

test('companyMatchesProfile matches when a skill overlaps an opportunity tag', () => {
  const company = { opportunities: ['graphic design', 'branding'] };
  assert.equal(companyMatchesProfile(company, { skills: ['Graphic Design'] }), true);
  assert.equal(companyMatchesProfile(company, { skills: ['plumbing'] }), false);
});

test('companyMatchesProfile is false when the profile has no skills', () => {
  const company = { opportunities: ['graphic design'] };
  assert.equal(companyMatchesProfile(company, { skills: [] }), false);
  assert.equal(companyMatchesProfile(company, {}), false);
});

// --- email content escaping (a scraped job title is untrusted input) -------

test('buildJobAlertEmailContent escapes a hostile scraped job title instead of injecting raw HTML', () => {
  const jobs = [{
    title: '<img src=x onerror=alert(1)>',
    company_name: 'Evil & Co <script>',
    location: 'Melbourne "quote" city',
    url: 'https://example.com/jobs/1',
  }];
  const { html } = buildJobAlertEmailContent(jobs, 'https://areahunt.onrender.com/api/auth/unsubscribe-alerts?token=abc');
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'), 'raw hostile title must not appear unescaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'title should be HTML-escaped');
  assert.ok(html.includes('Evil &amp; Co &lt;script&gt;'), 'company name should be HTML-escaped');
  assert.ok(html.includes('Melbourne &quot;quote&quot; city'), 'location should be HTML-escaped');
});

test('buildJobAlertEmailContent drops a non-http(s) job URL instead of linking it', () => {
  const jobs = [{ title: 'Designer', company_name: 'Acme', location: '', url: 'javascript:alert(1)' }];
  const { html } = buildJobAlertEmailContent(jobs, 'https://areahunt.onrender.com/unsub');
  assert.ok(!html.includes('javascript:alert'), 'a javascript: URL must never be emitted as a link href');
});

test('buildJobAlertEmailContent escapes a quote in the job URL so it cannot break out of the href attribute', () => {
  const jobs = [{ title: 'Designer', company_name: 'Acme', location: '', url: 'https://example.com/jobs/1?x="><script>alert(1)</script>' }];
  const { html } = buildJobAlertEmailContent(jobs, 'https://areahunt.onrender.com/unsub');
  assert.ok(!html.includes('"><script>'), 'unescaped quote must not allow breaking out of the href attribute');
});

// --- location-based candidate lookup + end-to-end check job ----------------

const TEST_ID = Date.now();
const COMPANY_ID = `test:job-alerts-co-${TEST_ID}`;
const IN_AREA_USER_ID = `test:job-alerts-in-${TEST_ID}`;
const OUT_OF_AREA_USER_ID = `test:job-alerts-out-${TEST_ID}`;
const UNVERIFIED_USER_ID = `test:job-alerts-unverified-${TEST_ID}`;
const IN_AREA_EMAIL = `job_alerts_in_${TEST_ID}@example.com`;
const OUT_OF_AREA_EMAIL = `job_alerts_out_${TEST_ID}@example.com`;
const UNVERIFIED_EMAIL = `job_alerts_unverified_${TEST_ID}@example.com`;
const LAT = -37.80;
const LNG = 144.95;

after(async () => {
  await db.pool.query('DELETE FROM job_alerts WHERE user_id = ANY($1)', [[IN_AREA_USER_ID, OUT_OF_AREA_USER_ID, UNVERIFIED_USER_ID]]);
  await db.pool.query('DELETE FROM scans WHERE user_id = ANY($1)', [[IN_AREA_USER_ID, OUT_OF_AREA_USER_ID, UNVERIFIED_USER_ID]]);
  await db.pool.query('DELETE FROM jobs WHERE company_id = $1', [COMPANY_ID]);
  await db.pool.query('DELETE FROM companies WHERE id = $1', [COMPANY_ID]);
  await db.pool.query('DELETE FROM users WHERE id = ANY($1)', [[IN_AREA_USER_ID, OUT_OF_AREA_USER_ID, UNVERIFIED_USER_ID]]);
});

test('getCandidateUsersForLocation returns only verified, non-suspended, alerts-on users who scanned this area', async () => {
  await db.upsertUser({ id: IN_AREA_USER_ID, email: IN_AREA_EMAIL, profile: { skills: ['graphic design'] } });
  await db.upsertUser({ id: OUT_OF_AREA_USER_ID, email: OUT_OF_AREA_EMAIL, profile: { skills: ['graphic design'] } });
  await db.upsertUser({ id: UNVERIFIED_USER_ID, email: UNVERIFIED_EMAIL, profile: { skills: ['graphic design'] } });

  // upsertUser doesn't set email_verified — flip it directly the same way
  // other test suites reach past the public API for setup-only convenience.
  await db.pool.query('UPDATE users SET email_verified = 1 WHERE id = ANY($1)', [[IN_AREA_USER_ID, OUT_OF_AREA_USER_ID]]);

  // In-area user scanned a box containing (LAT, LNG); out-of-area user's box
  // is somewhere else entirely; unverified user's box also contains the point
  // but should still be excluded for lacking email verification.
  await db.recordScan({ south: LAT - 1, north: LAT + 1, west: LNG - 1, east: LNG + 1, provider: 'test', resultCount: 1 }, IN_AREA_USER_ID);
  await db.recordScan({ south: 10, north: 11, west: 10, east: 11, provider: 'test', resultCount: 1 }, OUT_OF_AREA_USER_ID);
  await db.recordScan({ south: LAT - 1, north: LAT + 1, west: LNG - 1, east: LNG + 1, provider: 'test', resultCount: 1 }, UNVERIFIED_USER_ID);

  const candidates = await db.getCandidateUsersForLocation(LAT, LNG);
  const ids = candidates.map(c => c.id);
  assert.ok(ids.includes(IN_AREA_USER_ID), 'in-area verified user should be a candidate');
  assert.ok(!ids.includes(OUT_OF_AREA_USER_ID), 'user who scanned elsewhere should not be a candidate');
  assert.ok(!ids.includes(UNVERIFIED_USER_ID), 'unverified user should not be a candidate even if their scan area matches');
});

test('recordJobAlertMatch is idempotent — inserting the same pair twice does not duplicate or error', async () => {
  await db.upsertCompany({ id: COMPANY_ID, name: 'Job Alerts Test Co', lat: LAT, lng: LNG, opportunities: ['graphic design'] });
  await db.upsertJob({ company_id: COMPANY_ID, title: 'Graphic Designer', url: 'https://example.com/jobs/graphic-designer' });
  const job = (await db.listJobsForCompany(COMPANY_ID, null))[0];
  assert.ok(job);

  await db.recordJobAlertMatch(IN_AREA_USER_ID, job.id);
  await db.recordJobAlertMatch(IN_AREA_USER_ID, job.id);

  const { rows } = await db.pool.query('SELECT COUNT(*) AS n FROM job_alerts WHERE user_id = $1 AND job_id = $2', [IN_AREA_USER_ID, job.id]);
  assert.equal(Number(rows[0].n), 1);

  // Clean up this row so the end-to-end test below starts from a clean slate.
  await db.pool.query('DELETE FROM job_alerts WHERE user_id = $1 AND job_id = $2', [IN_AREA_USER_ID, job.id]);
});

test('runJobAlertsCheck matches a fresh job to the right user and records it unsent (SMTP not configured locally)', async () => {
  assert.equal(!!process.env.SMTP_HOST, false, 'this test assumes local SMTP is unconfigured, same as the rest of the suite');

  await runJobAlertsCheck();

  const job = (await db.listJobsForCompany(COMPANY_ID, null))[0];
  const { rows } = await db.pool.query(
    'SELECT * FROM job_alerts WHERE user_id = $1 AND job_id = $2',
    [IN_AREA_USER_ID, job.id],
  );
  assert.equal(rows.length, 1, 'expected a match to be recorded for the in-area user with matching skills');
  assert.equal(rows[0].sent_at, null, 'should not be marked sent since SMTP is not configured');

  const { rows: outRows } = await db.pool.query(
    'SELECT * FROM job_alerts WHERE user_id = $1 AND job_id = $2',
    [OUT_OF_AREA_USER_ID, job.id],
  );
  assert.equal(outRows.length, 0, 'user who scanned a different area should not get a match');
});
