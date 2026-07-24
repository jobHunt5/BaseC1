// Full-posting enrichment (jobDetailService): JSON-LD JobPosting parsing
// keeps the FULL description (the whole point vs the old 280-char snippet),
// blocked fetches degrade honestly to detail_status='snippet' without
// blanking snippet data, enrichment consumes the per-URL cache, and the
// area_jobs corpus upsert dedupes by URL and upgrades snippet rows to full.

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db.js');
const {
  parseJobPostingHtml, mergeDetail, enrichJobsWithDetail,
} = require('../server/services/jobDetailService');
const { setCached } = require('../server/services/apiCacheService');

before(async () => { await db.ready; });

const TEST_ID = Date.now();
const AREA_URL_A = `https://seek.com.au/job/test-${TEST_ID}-a`;
const AREA_URL_B = `https://au.indeed.com/viewjob?jk=test-${TEST_ID}-b`;
const CACHED_URL = `https://seek.com.au/job/test-${TEST_ID}-cached`;

after(async () => {
  await db.pool.query('DELETE FROM area_jobs WHERE url = ANY($1)', [[AREA_URL_A, AREA_URL_B]]);
  await db.pool.query('DELETE FROM api_cache WHERE cache_key = $1', [`jobdetail:${CACHED_URL}`]);
});

const LONG_DESCRIPTION = 'We are looking for a senior software engineer to join our platform team. '.repeat(20);

function seekStyleHtml() {
  const posting = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: 'Senior Software Engineer',
    description: `<p>${LONG_DESCRIPTION}</p>`,
    datePosted: '2026-07-20',
    validThrough: '2026-08-20',
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: 'Acme Widgets Pty Ltd' },
    jobLocation: { '@type': 'Place', address: { addressLocality: 'Melbourne', addressRegion: 'VIC' } },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'AUD', value: { '@type': 'QuantitativeValue', minValue: 130000, maxValue: 155000, unitText: 'YEAR' } },
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body>x</body></html>`;
}

test('parseJobPostingHtml keeps the full description and extracts every structured field', () => {
  const d = parseJobPostingHtml(seekStyleHtml());
  assert.ok(d, 'expected a parsed posting');
  assert.equal(d.title, 'Senior Software Engineer');
  assert.ok(d.description_full.length > 1000, 'full description must NOT be snippet-truncated');
  assert.ok(d.description.length <= 280, 'the snippet field stays snippet-sized');
  assert.equal(d.salary_min, 130000);
  assert.equal(d.salary_max, 155000);
  assert.match(d.salary, /130k.*155k/);
  assert.equal(d.job_type, 'FULL_TIME');
  assert.equal(d.location, 'Melbourne, VIC');
  assert.equal(d.company_name, 'Acme Widgets Pty Ltd');
  assert.ok(d.posted_at < d.closes_at, 'posted/closing dates parsed as ordered timestamps');
});

test('parseJobPostingHtml finds a JobPosting nested inside an @graph array', () => {
  const graph = { '@context': 'https://schema.org', '@graph': [ { '@type': 'WebSite', name: 'x' }, { '@type': 'JobPosting', title: 'Registered Nurse', description: 'Care for patients.' } ] };
  const html = `<script type="application/ld+json">${JSON.stringify(graph)}</script>`;
  const d = parseJobPostingHtml(html);
  assert.equal(d.title, 'Registered Nurse');
});

test('parseJobPostingHtml returns null when a page has no JobPosting data', () => {
  assert.equal(parseJobPostingHtml('<html><body><h1>Sign in to continue</h1></body></html>'), null);
  assert.equal(parseJobPostingHtml(`<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>`), null);
});

test('mergeDetail on a blocked fetch keeps snippet data and marks the job honestly', () => {
  const job = { title: 'Chef', description: 'snippet text', salary: '', source: 'linkedin-jobs' };
  mergeDetail(job, { status: 'blocked' });
  assert.equal(job.detail_status, 'snippet');
  assert.equal(job.description, 'snippet text', 'a failed fetch must never blank existing data');
  assert.equal(job.description_full, undefined, 'nothing fabricated');
});

test('enrichJobsWithDetail serves a full detail straight from the per-URL cache (no network)', async () => {
  await setCached(`jobdetail:${CACHED_URL}`, {
    status: 'full', description_full: LONG_DESCRIPTION, description: LONG_DESCRIPTION.slice(0, 200),
    salary: 'A$130k–A$155k/year', job_type: 'FULL_TIME', location: 'Melbourne, VIC',
    posted_at: 1, closes_at: 2, remote: 0, company_name: 'Acme', title: 'Senior Software Engineer',
  }, 60000);

  const jobs = [{ title: 'Senior Software Engineer', url: CACHED_URL, description: 'old snippet', source: 'seek' }];
  await enrichJobsWithDetail(jobs);
  assert.equal(jobs[0].detail_status, 'full');
  assert.equal(jobs[0].description_full, LONG_DESCRIPTION);
  assert.equal(jobs[0].salary, 'A$130k–A$155k/year');
});

test('saveAreaJobs dedupes by URL and a later full fetch upgrades a snippet row', async () => {
  await db.saveAreaJobs([
    { url: AREA_URL_A, title: 'Barista', source: 'seek', description: 'short snippet', detail_status: 'snippet' },
    { url: AREA_URL_B, title: 'Sous Chef', source: 'indeed', description: 'another snippet', detail_status: 'snippet' },
  ], 'Fitzroy', 'Victoria');

  // Same URL seen again — now with full detail. Must update, not duplicate.
  await db.saveAreaJobs([
    { url: AREA_URL_A, title: 'Barista', source: 'seek', description: 'short snippet', description_full: LONG_DESCRIPTION, salary: 'A$35/hour', detail_status: 'full' },
  ], 'Fitzroy', 'Victoria');

  const { rows } = await db.pool.query('SELECT * FROM area_jobs WHERE url = ANY($1) ORDER BY url', [[AREA_URL_A, AREA_URL_B]]);
  assert.equal(rows.length, 2, 'no duplicate rows for a re-seen URL');
  const upgraded = rows.find(r => r.url === AREA_URL_A);
  assert.equal(upgraded.detail_status, 'full');
  assert.equal(upgraded.description_full, LONG_DESCRIPTION);
  assert.equal(upgraded.salary, 'A$35/hour');
  assert.equal(upgraded.suburb, 'Fitzroy');
});

test('a full detail_status never regresses to snippet on a later blocked re-scrape', async () => {
  await db.saveAreaJobs([
    { url: AREA_URL_A, title: 'Barista', source: 'seek', description: 'short snippet', detail_status: 'snippet' },
  ], 'Fitzroy', 'Victoria');
  const { rows } = await db.pool.query('SELECT detail_status, description_full FROM area_jobs WHERE url = $1', [AREA_URL_A]);
  assert.equal(rows[0].detail_status, 'full', 'once full, stays full');
  assert.ok(rows[0].description_full, 'full description survives the snippet re-save');
});
