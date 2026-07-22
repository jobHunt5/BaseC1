// Unit tests for the scrape-completeness work: new ATS adapter response
// mappers (pure functions, no network), subdomain-aware careers-page
// matching, transient-failure retry, and per-company scrape-status tracking.
// No mocking library exists in this repo, so network-dependent behavior
// (retry) is verified against a real local HTTP server instead of mocks.

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  mapSmartRecruitersJobs,
  mapRecruiteeJobs,
  mapBreezyJobs,
  mapTeamtailorJobs,
  mapBambooHrJobs,
  mapPersonioJobs,
  mapWorkdayJobs,
  matchAts,
} = require('../server/services/jobsService');
const { sameRegistrableDomain, extractTeam } = require('../server/services/enrichService');
const { scoreJobQuality, freshnessLabel } = require('../server/services/jobQualityService');
const { pickHiringContact, departmentSignal } = require('../server/services/companyProfileService');
const db = require('../server/db.js');

// --- ATS response mappers --------------------------------------------------

test('mapSmartRecruitersJobs maps postings to job fields', () => {
  const jobs = mapSmartRecruitersJobs({
    content: [{
      id: '123', name: 'Backend Engineer',
      location: { city: 'Melbourne', region: 'VIC', country: 'AU' },
      department: { label: 'Engineering' },
      typeOfEmployment: { label: 'Full-time' },
      releasedDate: '2024-01-01T00:00:00Z',
      actions: { apply: { url: 'https://jobs.smartrecruiters.com/acme/123' } },
    }],
  }, 'acme');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Backend Engineer');
  assert.equal(jobs[0].location, 'Melbourne, VIC, AU');
  assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/acme/123');
  assert.equal(jobs[0].department, 'Engineering');
});

test('mapSmartRecruitersJobs falls back to a constructed URL when no apply link is given', () => {
  const jobs = mapSmartRecruitersJobs({ content: [{ id: '9', name: 'Designer' }] }, 'acme');
  assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/acme/9');
});

test('mapRecruiteeJobs maps offers to job fields', () => {
  const jobs = mapRecruiteeJobs({
    offers: [{
      title: 'Product Manager', city: 'Sydney', country: 'Australia',
      careers_url: 'https://acme.recruitee.com/o/product-manager',
      employment_type_code: 'full_time', department: 'Product',
      created_at: '2024-02-01T00:00:00Z',
    }],
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Product Manager');
  assert.equal(jobs[0].url, 'https://acme.recruitee.com/o/product-manager');
  assert.ok(jobs[0].posted_at > 0);
});

test('mapBreezyJobs maps the raw array response', () => {
  const jobs = mapBreezyJobs([{
    name: 'QA Engineer', location: { name: 'Remote' }, type: 'Full-Time',
    department: { name: 'Quality' }, url: 'https://acme.breezy.hr/p/1-qa-engineer',
    published_date: '2024-03-01T00:00:00Z',
  }]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'QA Engineer');
  assert.equal(jobs[0].remote, true);
  assert.equal(jobs[0].department, 'Quality');
});

test('mapBreezyJobs handles a non-array payload gracefully', () => {
  assert.deepEqual(mapBreezyJobs(null), []);
  assert.deepEqual(mapBreezyJobs({ error: 'not found' }), []);
});

test('mapTeamtailorJobs maps the jobs.json response', () => {
  const jobs = mapTeamtailorJobs({
    jobs: [{
      title: 'Data Analyst', body: '<p>Join us</p>', regions: ['Melbourne', 'Remote'],
      'apply-url': 'https://acme.teamtailor.com/jobs/1-data-analyst',
      department: 'Data', 'created-at': '2024-04-01T00:00:00Z',
    }],
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Data Analyst');
  assert.equal(jobs[0].location, 'Melbourne, Remote');
  assert.equal(jobs[0].url, 'https://acme.teamtailor.com/jobs/1-data-analyst');
});

test('mapBambooHrJobs maps the careers/list response and builds a URL from the slug', () => {
  const jobs = mapBambooHrJobs({
    result: [{
      id: '42', jobOpeningName: 'Office Manager',
      location: { city: 'Brisbane', state: 'QLD', country: 'Australia' },
      employmentStatusLabel: 'Full-Time', departmentLabel: 'Operations',
    }],
  }, 'acme');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://acme.bamboohr.com/careers/42');
  assert.equal(jobs[0].department, 'Operations');
});

test('mapPersonioJobs parses the XML feed', () => {
  const xml = `<workzag-jobs>
    <position>
      <id>55</id>
      <name>Marketing Lead</name>
      <office>Berlin</office>
      <department>Marketing</department>
      <employmentType>Full-time</employmentType>
      <createdAt>2024-05-01T00:00:00Z</createdAt>
    </position>
  </workzag-jobs>`;
  const jobs = mapPersonioJobs(xml, 'acme');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'Marketing Lead');
  assert.equal(jobs[0].url, 'https://acme.jobs.personio.de/job/55');
  assert.equal(jobs[0].location, 'Berlin');
});

test('mapPersonioJobs returns nothing for an empty feed', () => {
  assert.deepEqual(mapPersonioJobs('', 'acme'), []);
  assert.deepEqual(mapPersonioJobs('<workzag-jobs></workzag-jobs>', 'acme'), []);
});

test('mapWorkdayJobs builds absolute URLs from externalPath', () => {
  const jobs = mapWorkdayJobs({
    jobPostings: [{ title: 'Site Reliability Engineer', locationsText: 'Melbourne, Australia', externalPath: '/en-US/acme/job/SRE_R123' }],
  }, { base: 'https://acme.wd3.myworkdayjobs.com', site: 'acme' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://acme.wd3.myworkdayjobs.com/acme/en-US/acme/job/SRE_R123');
  assert.equal(jobs[0].posted_at, null); // no reliable structured date from Workday's CXS API
});

// --- ATS URL detection ------------------------------------------------------

test('matchAts recognizes all newly-added ATS hosts', () => {
  const cases = [
    ['https://careers.smartrecruiters.com/Acme/123', 'smartrecruiters'],
    ['https://acme.recruitee.com/o/role', 'recruitee'],
    ['https://acme.breezy.hr/p/1-role', 'breezy'],
    ['https://acme.teamtailor.com/jobs/1-role', 'teamtailor'],
    ['https://acme.bamboohr.com/careers/1', 'bamboohr'],
    ['https://acme.jobs.personio.com/job/1', 'personio'],
    ['https://acme.wd3.myworkdayjobs.com/acme/job/1', 'workday'],
  ];
  for (const [url, expected] of cases) {
    const match = matchAts(url);
    assert.ok(match, `expected a match for ${url}`);
    assert.equal(match.name, expected);
  }
});

test('matchAts extractSlug rejects the ATS vendor\'s own reserved subdomains', () => {
  const breezyUrl = 'https://www.breezy.hr/pricing';
  assert.equal(matchAts(breezyUrl).extractSlug(breezyUrl), null);
  const recruiteeUrl = 'https://help.recruitee.com/en/articles/1';
  assert.equal(matchAts(recruiteeUrl).extractSlug(recruiteeUrl), null);
});

test('workday extractSlug packs tenant/wd-number/site into one string', () => {
  const match = matchAts('https://acme.wd3.myworkdayjobs.com/External/job/x');
  assert.equal(match.extractSlug('https://acme.wd3.myworkdayjobs.com/External/job/x'), 'acme|3|External');
});

// --- subdomain-aware domain matching ----------------------------------------

test('sameRegistrableDomain accepts an exact match and a subdomain', () => {
  assert.equal(sameRegistrableDomain('https://acme.com', 'https://acme.com'), true);
  assert.equal(sameRegistrableDomain('https://careers.acme.com', 'https://acme.com'), true);
  assert.equal(sameRegistrableDomain('https://acme.com', 'https://careers.acme.com'), true);
});

test('sameRegistrableDomain rejects a different domain', () => {
  assert.equal(sameRegistrableDomain('https://careers.acme-jobs.com', 'https://acme.com'), false);
});

test('sameRegistrableDomain handles compound TLDs like .com.au', () => {
  assert.equal(sameRegistrableDomain('https://careers.acme.com.au', 'https://acme.com.au'), true);
  assert.equal(sameRegistrableDomain('https://acme.com.au', 'https://acme.co.uk'), false);
});

// --- job freshness scoring ---------------------------------------------------

test('scoreJobQuality gives a bigger bonus to more recently posted jobs', () => {
  const day = 24 * 60 * 60 * 1000;
  const fresh = scoreJobQuality({ source: 'careers-page', title: 'Engineer', posted_at: Date.now() - 2 * day }, {});
  const stale = scoreJobQuality({ source: 'careers-page', title: 'Engineer', posted_at: Date.now() - 200 * day }, {});
  const none = scoreJobQuality({ source: 'careers-page', title: 'Engineer' }, {});
  assert.ok(fresh.score > stale.score);
  assert.ok(stale.score > none.score || stale.score === none.score);
});

test('freshnessLabel buckets by age', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.equal(freshnessLabel(null), null);
  assert.equal(freshnessLabel(Date.now() - 2 * day), 'new');
  assert.equal(freshnessLabel(Date.now() - 20 * day), 'recent');
  assert.equal(freshnessLabel(Date.now() - 200 * day), 'older');
});

// --- retry on transient failure ---------------------------------------------
// No mocking library in this repo — spin up a real local HTTP server instead.

test('fetchHtml retries once on a 5xx then succeeds', async () => {
  const { findWebsiteJobs } = require('../server/services/jobsService');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>ok</body></html>');
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  // fetchHtml isn't exported directly, but findWebsiteJobs exercises the same
  // code path when given a careers_url pointing at our local server.
  const jobs = await findWebsiteJobs({ careers_url: `http://localhost:${port}/careers`, website: null });
  assert.deepEqual(jobs, []); // no jobs on the stub page, but no crash/null either
  assert.equal(hits, 2, 'expected exactly one retry after the transient 500');

  await new Promise(resolve => server.close(resolve));
});

test('fetchHtml does not retry a 404 (a real answer, not a transient failure)', async () => {
  const { findWebsiteJobs } = require('../server/services/jobsService');
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.writeHead(404); res.end(); });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  await findWebsiteJobs({ careers_url: `http://localhost:${port}/careers`, website: null });
  assert.equal(hits, 1, 'a 404 should not be retried');

  await new Promise(resolve => server.close(resolve));
});

// --- direct hiring-manager contact -------------------------------------------

test('extractTeam picks up a personal email published next to a name on an about page', () => {
  const html = `<html><body>
    <h2>Jane Doe</h2>
    <p>Head of Talent</p>
    <p><a href="mailto:jane@acme.com">jane@acme.com</a></p>
  </body></html>`;
  const team = extractTeam(html, 'https://acme.com/about');
  const jane = team.find(m => m.name === 'Jane Doe');
  assert.ok(jane, 'expected Jane Doe to be extracted');
  assert.equal(jane.email, 'jane@acme.com');
  assert.equal(jane.title, 'Head of Talent');
});

test('extractTeam leaves email null when no mailto link is nearby', () => {
  const html = `<html><body>
    <h2>John Smith</h2>
    <p>Creative Director</p>
    <p>Loves good typography and long coffee breaks.</p>
  </body></html>`;
  const team = extractTeam(html, 'https://acme.com/about');
  const john = team.find(m => m.name === 'John Smith');
  assert.ok(john);
  assert.equal(john.email, null);
});

test('pickHiringContact prefers an HR/Talent title over a more senior but unrelated one', () => {
  const team = [
    { name: 'Alice CEO', title: 'CEO', email: null, linkedin_url: null },
    { name: 'Bob Talent', title: 'Head of Talent', email: 'bob@acme.com', linkedin_url: null },
  ];
  const contact = pickHiringContact(team, []);
  assert.equal(contact.name, 'Bob Talent');
  assert.equal(contact.reason, 'Handles hiring for this company');
});

test('pickHiringContact prefers a department match when no HR/Talent title exists', () => {
  const team = [
    { name: 'Carol Sales', title: 'Head of Sales', email: null, linkedin_url: null },
    { name: 'Dave Eng', title: 'Head of Engineering', email: 'dave@acme.com', linkedin_url: null },
  ];
  const jobRows = [{ department: 'Engineering' }, { department: 'Engineering' }, { department: 'Sales' }];
  const contact = pickHiringContact(team, jobRows);
  assert.equal(contact.name, 'Dave Eng');
  assert.match(contact.reason, /Engineering/);
});

test('pickHiringContact falls back to the most senior team member with no other signal', () => {
  const team = [
    { name: 'Random Person', title: 'Junior Designer', email: null, linkedin_url: null },
    { name: 'Founder Person', title: 'Founder', email: null, linkedin_url: null },
  ];
  const contact = pickHiringContact(team, []);
  assert.equal(contact.name, 'Founder Person');
});

test('pickHiringContact returns null for an empty team', () => {
  assert.equal(pickHiringContact([], []), null);
  assert.equal(pickHiringContact(null, []), null);
});

test('departmentSignal finds the most common department word across open jobs', () => {
  const jobRows = [{ department: 'Engineering' }, { department: 'Engineering' }, { department: 'Marketing' }];
  assert.equal(departmentSignal(jobRows), 'engineering');
  assert.equal(departmentSignal([]), null);
});

// --- careers-page pagination (one hop, same host only) ---------------------

test('findWebsiteJobs follows one "next page" link and merges results, capped at one hop', async () => {
  const { findWebsiteJobs } = require('../server/services/jobsService');
  let page3Hits = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/careers') {
      res.end(`<html><body>
        <a href="/careers/senior-widget-engineer">Senior Widget Engineer</a>
        <a rel="next" href="/careers?page=2">Next</a>
      </body></html>`);
    } else if (req.url === '/careers?page=2') {
      res.end(`<html><body>
        <a href="/careers/junior-widget-designer">Junior Widget Designer</a>
        <a rel="next" href="/careers?page=3">Next</a>
      </body></html>`);
    } else if (req.url === '/careers?page=3') {
      page3Hits++;
      res.end(`<html><body><a href="/careers/should-not-appear">Should Not Appear</a></body></html>`);
    } else {
      res.end('');
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;

  const jobs = await findWebsiteJobs({ careers_url: `http://localhost:${port}/careers`, website: null });
  const titles = jobs.map(j => j.title);
  assert.ok(titles.includes('Senior Widget Engineer'), 'should include page 1 job');
  assert.ok(titles.includes('Junior Widget Designer'), 'should include page 2 job via the next-page hop');
  assert.ok(!titles.includes('Should Not Appear'), 'should not follow a second hop to page 3');
  assert.equal(page3Hits, 0, 'page 3 should never be requested (capped at one hop)');

  await new Promise(resolve => server.close(resolve));
});

// --- per-company scrape status tracking -------------------------------------

const TEST_IDS = [
  `test:scrape-status-never-${Date.now()}`,
  `test:scrape-status-failed-${Date.now()}`,
  `test:scrape-status-stale-partial-${Date.now()}`,
  `test:scrape-status-fresh-partial-${Date.now()}`,
  `test:scrape-status-ok-${Date.now()}`,
];

before(async () => {
  await db.ready;
});

after(async () => {
  await db.pool.query('DELETE FROM companies WHERE id = ANY($1)', [TEST_IDS]);
});

test('getCompaniesNeedingRescan returns never/failed/stale-partial, not fresh-partial or ok', async () => {
  const [neverId, failedId, stalePartialId, freshPartialId, okId] = TEST_IDS;
  const day = 24 * 60 * 60 * 1000;

  for (const id of TEST_IDS) {
    await db.upsertCompany({ id, name: id, lat: -37.8, lng: 144.9, website: 'https://example.com' });
  }
  await db.updateScrapeStatus(failedId, { status: 'failed', attempted_at: Date.now() });
  await db.updateScrapeStatus(stalePartialId, { status: 'partial', attempted_at: Date.now() - 10 * day });
  await db.updateScrapeStatus(freshPartialId, { status: 'partial', attempted_at: Date.now() - 1 * day });
  await db.updateScrapeStatus(okId, { status: 'ok', ats: 'greenhouse', attempted_at: Date.now() });

  // Limit set well above the real (shared) database's company count — this
  // suite runs against the same live Postgres as dev/prod, and a small limit
  // would let unrelated real rows crowd out the handful this test seeded.
  const ids = await db.getCompaniesNeedingRescan(100000, 7 * day);
  assert.ok(ids.includes(neverId), 'never-scraped company should need a rescan');
  assert.ok(ids.includes(failedId), 'failed company should need a rescan');
  assert.ok(ids.includes(stalePartialId), 'stale partial company should need a rescan');
  assert.ok(!ids.includes(freshPartialId), 'recently-attempted partial company should not need a rescan yet');
  assert.ok(!ids.includes(okId), 'successfully scraped company should not need a rescan');
});
