// Upgrade a board-search result (Seek / Indeed / LinkedIn / Jora / …) from a
// Google-snippet stub to the complete posting, by fetching the job's real URL
// and parsing the schema.org JobPosting JSON-LD every major board embeds for
// search engines: full description, salary range, posted/closing dates,
// employment type, precise location.
//
// Honest best-effort by design: fetches go out with the app's normal bot
// User-Agent, no identity rotation, no CAPTCHA solving. Some boards block
// datacenter requests (Indeed via Cloudflare, LinkedIn via 999s) — a job we
// can't fetch keeps its snippet and is marked detail_status='snippet', never
// padded to look complete. Per-source reach stats are tracked so the real
// hit-rate is measurable instead of guessed at.
//
// Results are cached in Postgres (api_cache) per URL — a posting's content
// is effectively immutable, so one successful fetch serves every later scan
// that surfaces the same job.

const {
  fetchHtml, stripHtml, decodeHtmlEntities, snippet, toMs, isRemoteText,
  formatSalaryRange,
} = require('./jobsService');
const { getCached, setCached } = require('./apiCacheService');

const DETAIL_TTL_MS = 1000 * 60 * 60 * 24 * 7; // full detail: postings don't change
const MISS_TTL_MS = 1000 * 60 * 60 * 12;       // blocked/no-data: retry twice a day
const MAX_DESCRIPTION_CHARS = 20000;           // full text for the training corpus, bounded
// Kept modest for the 512MB free tier: each in-flight fetch holds a full
// HTML page (LinkedIn/Seek pages run 0.5–1MB) plus its cheerio/JSON-LD parse.
// 4-wide × 40 pages per scan was a real memory spike that could OOM a live
// user scan. Raise both on a plan with more headroom.
const CONCURRENCY = parseInt(process.env.JOB_DETAIL_CONCURRENCY || '2', 10);
const MAX_PER_BATCH = parseInt(process.env.JOB_DETAIL_MAX_PER_BATCH || '15', 10);

// In-memory per-source reach counters since boot — surfaced via /api/health
// so "how often does LinkedIn actually let us in from Render" is a number,
// not a guess. Reset on redeploy; the api_cache hit-rate carries the rest.
const stats = {};
function recordAttempt(source, outcome) {
  const s = stats[source] || (stats[source] = { attempts: 0, full: 0, blocked: 0, no_data: 0 });
  s.attempts += 1;
  s[outcome] += 1;
}
function getDetailStats() {
  return Object.fromEntries(Object.entries(stats).map(([source, s]) => [source, {
    ...s,
    reach: s.attempts ? Math.round((s.full / s.attempts) * 100) + '%' : 'n/a',
  }]));
}

// --- JSON-LD JobPosting parsing (single-posting page) ---------------------
//
// jobsService's collectJobPostings exists for *careers pages* (many postings,
// snippet-truncated descriptions). A posting page is the opposite shape: one
// JobPosting, and the whole point is keeping the full description — so this
// is its own walker rather than a lossy reuse.

function findJobPostingNode(node) {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findJobPostingNode(n);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  if (types.some(t => t === 'JobPosting')) return node;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') {
      const hit = findJobPostingNode(v);
      if (hit) return hit;
    }
  }
  return null;
}

function parseSalary(node) {
  const base = node.baseSalary;
  if (!base) return { salary: '', salary_min: null, salary_max: null };
  const val = base.value || base;
  const min = Number(val.minValue ?? val.value ?? NaN);
  const max = Number(val.maxValue ?? NaN);
  const currency = base.currency || val.currency || '';
  const interval = (val.unitText || '').toLowerCase(); // HOUR / YEAR / …
  const salary_min = Number.isFinite(min) ? min : null;
  const salary_max = Number.isFinite(max) ? max : null;
  return {
    salary: formatSalaryRange(salary_min, salary_max, currency, interval ? 'per ' + interval : ''),
    salary_min,
    salary_max,
  };
}

function parseLocationNode(node) {
  const locs = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
  for (const loc of locs) {
    if (!loc) continue;
    if (typeof loc === 'string') return loc;
    const a = loc.address || {};
    const parts = [a.addressLocality, a.addressRegion].filter(Boolean);
    if (parts.length) return parts.join(', ');
    if (loc.name) return loc.name;
  }
  return '';
}

// Parse one posting page's HTML into a normalized detail record, or null if
// the page carries no JobPosting structured data.
function parseJobPostingHtml(html) {
  if (!html) return null;
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    const node = findJobPostingNode(parsed);
    if (!node) continue;

    const description_full = decodeHtmlEntities(stripHtml(node.description || ''))
      .slice(0, MAX_DESCRIPTION_CHARS);
    const { salary, salary_min, salary_max } = parseSalary(node);
    return {
      title: decodeHtmlEntities(String(node.title || node.name || '').trim()).slice(0, 160) || null,
      description_full: description_full || null,
      description: description_full ? snippet(description_full, 280) : null,
      salary: salary || null,
      salary_min,
      salary_max,
      job_type: Array.isArray(node.employmentType)
        ? node.employmentType.join(', ')
        : (node.employmentType || null),
      location: parseLocationNode(node) || null,
      posted_at: toMs(node.datePosted),
      closes_at: toMs(node.validThrough),
      remote: isRemoteText(node.jobLocationType) || isRemoteText(description_full) ? 1 : 0,
      company_name: decodeHtmlEntities(String(node.hiringOrganization?.name || '').trim()) || null,
    };
  }
  return null;
}

// --- fetching -------------------------------------------------------------

async function fetchJobDetail(url, source = 'unknown') {
  if (!url) return { status: 'no-data' };

  const cacheKey = `jobdetail:${url}`;
  const cached = await getCached(cacheKey);
  if (cached !== undefined) return cached;

  const html = await fetchHtml(url); // null on 4xx/network — how blocks show up
  if (html === null) {
    recordAttempt(source, 'blocked');
    const miss = { status: 'blocked' };
    await setCached(cacheKey, miss, MISS_TTL_MS);
    return miss;
  }

  const detail = parseJobPostingHtml(html);
  if (!detail) {
    recordAttempt(source, 'no_data');
    const miss = { status: 'no-data' };
    await setCached(cacheKey, miss, MISS_TTL_MS);
    return miss;
  }

  recordAttempt(source, 'full');
  const result = { status: 'full', ...detail };
  await setCached(cacheKey, result, DETAIL_TTL_MS);
  return result;
}

// Merge a fetched detail record into a snippet-stub job in place. Detail
// fields win only where they actually carry data — a blocked fetch never
// blanks out what the search snippet already gave us.
function mergeDetail(job, detail) {
  if (!detail || detail.status !== 'full') {
    job.detail_status = 'snippet';
    return job;
  }
  job.detail_status = 'full';
  if (detail.description_full) {
    job.description_full = detail.description_full;
    job.description = detail.description;
  }
  if (detail.salary) job.salary = detail.salary;
  if (detail.job_type) job.job_type = detail.job_type;
  if (detail.location) job.location = detail.location;
  if (detail.posted_at) job.posted_at = detail.posted_at;
  if (detail.closes_at) job.closes_at = detail.closes_at;
  if (detail.remote) job.remote = true;
  if (detail.company_name && !job.company_name) job.company_name = detail.company_name;
  return job;
}

// Enrich a batch of board jobs with full posting details, bounded both ways
// (at most `max` jobs, `CONCURRENCY` in flight). Mutates and returns `jobs`.
async function enrichJobsWithDetail(jobs, { max = MAX_PER_BATCH } = {}) {
  const targets = (jobs || []).filter(j => j && j.url).slice(0, max);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const job = targets[i++];
      const detail = await fetchJobDetail(job.url, job.source);
      mergeDetail(job, detail);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  // Anything beyond `max` stays an untouched snippet, marked honestly as such.
  for (const j of jobs || []) {
    if (j && !j.detail_status) j.detail_status = 'snippet';
  }
  return jobs;
}

module.exports = {
  fetchJobDetail,
  enrichJobsWithDetail,
  parseJobPostingHtml,
  mergeDetail,
  getDetailStats,
};
