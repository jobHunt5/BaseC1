// Area-wide job-board search.
//
// Company discovery (Google Places) only finds employers that have a Maps
// listing in the bbox. Many real jobs in an area belong to companies we never
// discover (no listing, head office elsewhere, agency-posted, etc.).
//
// This service searches Seek / Indeed / LinkedIn Jobs / Jora *by location*
// (reverse-geocoded suburb of the bbox) so we surface those roles too. Results
// are returned as standalone "area jobs" — not attached to a discovered
// company — and clearly labelled by source.

const axios = require('axios');
const cheerio = require('cheerio');
const { serperSearch, isConfigured: serperConfigured } = require('./serperClient');
const { detectVisaFlag } = require('./visaDetectionService');
const { getCached, setCached } = require('./apiCacheService');
const { enrichJobsWithDetail } = require('./jobDetailService');

const CACHE_TTL_MS = 1000 * 60 * 30;

const AREA_JOB_BOARDS = [
  { source: 'seek', site: 'site:seek.com.au/job', urlRe: /seek\.com\.au\/job\//i },
  { source: 'indeed', site: 'site:au.indeed.com', urlRe: /indeed\.com\/(viewjob|rc\/clk|pagead|job)/i },
  { source: 'linkedin-jobs', site: 'site:linkedin.com/jobs/view', urlRe: /linkedin\.com\/jobs\/view/i },
  { source: 'jora', site: 'site:jora.com', urlRe: /jora\.com\/(?:job|j)\//i },
  { source: 'careerone', site: 'site:careerone.com.au/jobview', urlRe: /careerone\.com\.au\/jobview\//i },
  // Victorian public sector jobs board — government/council roles, which
  // this app's company-discovery (Google Places) rarely surfaces well, so
  // it's area-wide only rather than per-company like the commercial boards.
  { source: 'careers-vic', site: 'site:careers.vic.gov.au', urlRe: /careers\.vic\.gov\.au\/jobtools\/jncustomsearch\.viewFullSingle/i },
];

const ROLE_RE = /\b(developer|engineer|designer|manager|lead|architect|analyst|scientist|consultant|specialist|director|intern|coordinator|producer|writer|editor|recruiter|strategist|associate|assistant|advisor|operator|administrator|officer|technician|marketer|programmer|executive|chef|cook|barista|nurse|driver|accountant|lawyer|paralegal|sales|support|customer|receptionist|cleaner|electrician|plumber|teacher|trainer|coach|therapist|physio|dentist|doctor|pharmacist|worker|labourer|laborer|supervisor|foreman|technologist|pathologist|radiographer|midwife|carer|caregiver|host|waiter|waitress|bartender|sous|analyst|administrator|head of|vp of|chief)\b/i;

const JUNK_TITLE = /^(jobs?|careers?|search results|hiring|apply|view all|see all|company profile|jobs in|.*\bjobs\b\s*$)/i;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Reverse-geocode the centre of the bbox to a suburb/locality via free Nominatim.
async function reverseGeocodeSuburb(bounds) {
  const lat = (bounds.south + bounds.north) / 2;
  const lng = (bounds.west + bounds.east) / 2;
  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { format: 'json', lat, lon: lng, zoom: 14, addressdetails: 1 },
      headers: { 'User-Agent': process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0' },
      timeout: 8000,
    });
    const a = resp.data?.address || {};
    const suburb = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.municipality || '';
    const state = a.state || '';
    return { suburb, state, lat, lng };
  } catch {
    return { suburb: '', state: '', lat, lng };
  }
}

function parseTitleCompany(serperTitle) {
  let t = String(serperTitle || '').trim();
  t = t.replace(/\s*[|\-–—]\s*(Seek\.?com\.?au|Indeed|LinkedIn|Jora|Glassdoor|CareerOne|Careers Vic).*$/i, '');

  // LinkedIn pattern: "Acme hiring Senior Engineer in Melbourne, Victoria…"
  const hiring = t.match(/^(.+?)\s+hiring\s+(.+?)\s+in\s+[A-Z]/i);
  if (hiring) {
    const company = hiring[1].trim();
    const title = hiring[2].trim();
    return { title: title.slice(0, 120), company: company.slice(0, 80) };
  }

  const parts = t.split(/\s*[|\-–—]\s*/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { title: t.slice(0, 120), company: '' };

  const titlePart = parts.find(p => ROLE_RE.test(p)) || parts[0];
  // Company is usually the last segment that isn't the title and isn't a location.
  let company = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p === titlePart) continue;
    if (/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/.test(p)) continue;
    if (/australia|remote|full.?time|part.?time|contract/i.test(p)) continue;
    company = p;
    break;
  }
  return { title: titlePart.slice(0, 120), company: company.slice(0, 80) };
}

function parseLocation(snippet, suburb, state) {
  const m = String(snippet || '').match(/\b([A-Za-z\s'.-]+)\s+(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/);
  if (m) return `${m[1].trim()} ${m[2].toUpperCase()}, Australia`;
  return [suburb, state, 'Australia'].filter(Boolean).join(', ');
}

function isPlausible(title, url, board) {
  if (!title || title.length < 6 || title.length > 120) return false;
  if (JUNK_TITLE.test(title)) return false;
  if (!board.urlRe.test(url || '')) return false;
  if (!ROLE_RE.test(title)) return false;
  return true;
}

async function searchAreaBoard(board, suburb, state, terms) {
  const loc = [suburb, state].filter(Boolean).join(' ');
  const queries = [`${board.site} jobs ${loc}`.trim()];
  // `terms` is a plain string for a single generic keyword filter, or an
  // array when the caller wants one targeted query per selected industry
  // (e.g. a user who picked Design + Dev + AI + VR gets one Seek/Indeed/
  // LinkedIn/Jora query per industry instead of one blended, weaker query).
  const termList = Array.isArray(terms) ? terms.filter(Boolean) : [terms].filter(Boolean);
  for (const t of termList) queries.push(`${board.site} ${t} jobs ${loc}`.trim());

  const out = [];
  const seen = new Set();
  for (const q of queries) {
    const results = await serperSearch(q, { num: 10, gl: 'au', hl: 'en' });
    for (const r of results) {
      const url = r.link || '';
      if (!board.urlRe.test(url)) continue;
      const { title, company } = parseTitleCompany(r.title);
      if (!isPlausible(title, url, board)) continue;
      const key = `${title.toLowerCase()}|${company.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        title,
        company_name: company || null,
        url,
        location: parseLocation(r.snippet, suburb, state),
        description: (r.snippet || '').slice(0, 240),
        remote: /\bremote\b/i.test(`${r.title} ${r.snippet}`),
        source: board.source,
        confidence: 'board',
        // Best-effort only — the search-snippet text is short, so this
        // often can't tell either way (comes back null), which is the
        // honest answer, not a false "no requirement" read.
        visa_flag: detectVisaFlag(`${r.title} ${r.snippet}`),
      });
    }
    await sleep(120);
  }
  return out;
}

// Only surface postings this fresh. Job boards are full of stale/evergreen
// listings that mislead a job seeker (the role's long gone) and poison a
// training corpus. Configurable; defaults to ~6 weeks.
const MAX_JOB_AGE_DAYS = parseInt(process.env.MAX_JOB_AGE_DAYS || '45', 10);
const MAX_JOB_AGE_MS = MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
// LinkedIn f_TPR bucket asking the board itself for recent posts only —
// r2592000 = past 30 days. Cheaper and more reliable than filtering after.
const LINKEDIN_TPR = process.env.LINKEDIN_TPR || 'r2592000';

// LinkedIn's public guest job search — the same unauthenticated endpoint the
// logged-out linkedin.com/jobs page uses. Unlike the Serper path this returns
// currently-live postings directly from the board (no search-index staleness,
// no Serper credits), which matters doubly since Google's index of job URLs
// goes stale fast — expired postings redirect to a generic search page.
// Plain fetch, the app's normal UA, no auth, public data only.
async function fetchLinkedInGuestJobs(suburb, state, terms) {
  const { isEvergreenPost } = require('./jobQualityService');
  const location = [suburb, state, 'Australia'].filter(Boolean).join(', ');
  const termList = (Array.isArray(terms) ? terms.filter(Boolean) : [terms].filter(Boolean));
  if (!termList.length) termList.push('');

  const staleBefore = Date.now() - MAX_JOB_AGE_MS;
  const out = [];
  for (const term of termList.slice(0, 4)) {
    try {
      const resp = await axios.get('https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search', {
        // f_TPR asks LinkedIn for recent posts only — the first line of
        // defence against year-old listings coming back at all.
        params: { keywords: term, location, start: 0, f_TPR: LINKEDIN_TPR },
        headers: { 'User-Agent': process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0' },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (resp.status !== 200 || typeof resp.data !== 'string') continue;
      const $ = cheerio.load(resp.data);
      $('.base-card, li').each((_, el) => {
        const $el = $(el);
        const url = ($el.find('a.base-card__full-link, a[href*="/jobs/view/"]').attr('href') || '').split('?')[0];
        const title = $el.find('.base-search-card__title').text().replace(/\s+/g, ' ').trim();
        const company = $el.find('.base-search-card__subtitle').text().replace(/\s+/g, ' ').trim();
        const loc = $el.find('.job-search-card__location').text().replace(/\s+/g, ' ').trim();
        if (!url || !title || !/linkedin\.com\/jobs\/view\//.test(url)) return;

        // Drop talent-pipeline / expression-of-interest posts outright —
        // exactly the "Express interest in joining our Team" case: never a
        // real fillable role, whatever its date.
        if (isEvergreenPost(title)) return;

        // Same title-plausibility gate the Serper board path uses: must read
        // like a real role, not a junk listing ("Car Maintenance Log Form",
        // "jobs at Warragul", a bare suburb name). LinkedIn's guest feed is
        // noisier than its logged-in one, especially on broad queries.
        if (JUNK_TITLE.test(title) || !ROLE_RE.test(title)) return;

        // The listing carries the post date in <time datetime="YYYY-MM-DD">.
        // Where present, drop anything past the freshness window (the f_TPR
        // filter above can still let a stragglers through on some queries).
        const dt = $el.find('time[datetime]').attr('datetime');
        const posted_at = dt ? Date.parse(dt) : null;
        if (posted_at && posted_at < staleBefore) return;

        out.push({
          title: title.slice(0, 120),
          company_name: company.slice(0, 80) || null,
          url,
          location: loc || location,
          description: '',
          posted_at: Number.isFinite(posted_at) ? posted_at : null,
          remote: /\bremote\b/i.test(title),
          source: 'linkedin-jobs',
          confidence: 'board',
          visa_flag: null,
        });
      });
    } catch { /* one failed term never kills the scan */ }
    await sleep(300);
  }
  return out;
}

/**
 * Find jobs across an area (bbox) from the major boards.
 *   bounds: { south, west, north, east }
 *   opts.terms: optional keyword filter — a string, or an array of terms
 *     (one query per term per board, e.g. the user's selected industries)
 */
async function findAreaJobs(bounds, { terms = '', limit = 100 } = {}) {
  const { suburb, state } = await reverseGeocodeSuburb(bounds);
  if (!suburb && !state) return { enabled: true, suburb: '', jobs: [] };

  const termKey = Array.isArray(terms) ? terms.slice().sort().join(',') : terms;
  const cacheKey = `areajobs:${suburb}|${state}|${termKey}`.toLowerCase();
  const cached = await getCached(cacheKey);
  if (cached) {
    return { enabled: true, suburb, jobs: cached.slice(0, limit) };
  }

  // Serper (Google-index) results for every board, plus LinkedIn's own live
  // guest search — the latter needs no Serper key/credits, so an exhausted
  // Serper account degrades area search to LinkedIn-only instead of to zero.
  const batches = await Promise.all([
    ...(serperConfigured()
      ? AREA_JOB_BOARDS.map(board => searchAreaBoard(board, suburb, state, terms))
      : []),
    fetchLinkedInGuestJobs(suburb, state, terms),
  ]);

  const { isEvergreenPost } = require('./jobQualityService');
  const merged = [];
  const seen = new Set();
  for (const batch of batches) {
    for (const j of batch) {
      // Evergreen/pipeline posts from any board, not just LinkedIn.
      if (isEvergreenPost(j.title)) continue;
      const key = `${j.title.toLowerCase()}|${(j.company_name || '').toLowerCase()}|${j.source}`;
      const urlKey = (j.url || '').toLowerCase();
      if (seen.has(key) || (urlKey && seen.has(urlKey))) continue;
      seen.add(key);
      if (urlKey) seen.add(urlKey);
      merged.push(j);
    }
  }

  // Upgrade snippet stubs to full postings before caching or persisting —
  // per-URL cached, so repeat scans of a suburb don't refetch anything.
  await enrichJobsWithDetail(merged);

  // Enrichment fills posted_at from each posting's JSON-LD (Seek/LinkedIn/
  // Indeed alike) — now drop anything past the freshness window with a known
  // date. A missing date is left in (no evidence it's stale) rather than
  // guessed at.
  const staleBefore = Date.now() - MAX_JOB_AGE_MS;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i].posted_at && merged[i].posted_at < staleBefore) merged.splice(i, 1);
  }

  // A full description gives visa detection real text to work with — the
  // search snippet was usually too short to tell either way.
  for (const j of merged) {
    if (j.description_full && !j.visa_flag) {
      j.visa_flag = detectVisaFlag(`${j.title} ${j.description_full}`);
    }
  }

  // Persist into the area_jobs corpus (previously these evaporated with the
  // cache — a training corpus needs them kept). Lazy require: db.js sits
  // upstream of some of this module's siblings; same pattern apiCacheService
  // uses for the identical reason.
  try {
    const db = require('../db');
    await db.saveAreaJobs(merged, suburb, state);
  } catch (err) {
    // Corpus persistence must never break a user-facing scan.
    console.error('area_jobs persist failed:', err.message);
  }

  // Full descriptions are corpus/DB payload, not list-UI payload — 40 jobs
  // × up to 20k chars would be a ~1MB scan response. Strip before caching so
  // cache hits serve the lean shape too (the table row keeps the full text).
  for (const j of merged) delete j.description_full;

  await setCached(cacheKey, merged, CACHE_TTL_MS);
  return { enabled: true, suburb, state, jobs: merged.slice(0, limit) };
}

function isAreaJobSearchEnabled() {
  // LinkedIn guest search works with no Serper key at all, so area job
  // search is always available — Serper just widens it to the other boards.
  return true;
}

module.exports = {
  findAreaJobs,
  isAreaJobSearchEnabled,
  fetchLinkedInGuestJobs,
  reverseGeocodeSuburb,
};
