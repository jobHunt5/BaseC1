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

const SERPER_KEY = process.env.SERPER_API_KEY || '';
const TIMEOUT = parseInt(process.env.JOB_SEARCH_TIMEOUT_MS || '6000', 10);
const CACHE_TTL_MS = 1000 * 60 * 30;
const cache = new Map();

const AREA_JOB_BOARDS = [
  { source: 'seek', site: 'site:seek.com.au/job', urlRe: /seek\.com\.au\/job\//i },
  { source: 'indeed', site: 'site:au.indeed.com', urlRe: /indeed\.com\/(viewjob|rc\/clk|pagead|job)/i },
  { source: 'linkedin-jobs', site: 'site:linkedin.com/jobs/view', urlRe: /linkedin\.com\/jobs\/view/i },
  { source: 'jora', site: 'site:jora.com', urlRe: /jora\.com\/(?:job|j)\//i },
];

const ROLE_RE = /\b(developer|engineer|designer|manager|lead|architect|analyst|scientist|consultant|specialist|director|intern|coordinator|producer|writer|editor|recruiter|strategist|associate|assistant|advisor|operator|administrator|officer|technician|marketer|programmer|executive|chef|cook|barista|nurse|driver|accountant|lawyer|paralegal|sales|support|customer|receptionist|cleaner|electrician|plumber|teacher|trainer|coach|therapist|physio|dentist|doctor|pharmacist|worker|labourer|laborer|supervisor|foreman|technologist|pathologist|radiographer|midwife|carer|caregiver|host|waiter|waitress|bartender|sous|analyst|administrator|head of|vp of|chief)\b/i;

const JUNK_TITLE = /^(jobs?|careers?|search results|hiring|apply|view all|see all|company profile|jobs in|.*\bjobs\b\s*$)/i;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function serperSearch(query, num = 10) {
  if (!SERPER_KEY) return [];
  try {
    const resp = await axios.post(
      'https://google.serper.dev/search',
      { q: query, num, gl: 'au', hl: 'en' },
      {
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        timeout: TIMEOUT,
        validateStatus: () => true,
      },
    );
    if (resp.status !== 200) return [];
    return resp.data?.organic || [];
  } catch {
    return [];
  }
}

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
  t = t.replace(/\s*[|\-–—]\s*(Seek\.?com\.?au|Indeed|LinkedIn|Jora|Glassdoor).*$/i, '');

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
  if (terms) queries.push(`${board.site} ${terms} jobs ${loc}`.trim());

  const out = [];
  const seen = new Set();
  for (const q of queries) {
    const results = await serperSearch(q, 10);
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
      });
    }
    await sleep(120);
  }
  return out;
}

/**
 * Find jobs across an area (bbox) from the major boards.
 *   bounds: { south, west, north, east }
 *   opts.terms: optional keyword filter (e.g. "developer")
 */
async function findAreaJobs(bounds, { terms = '', limit = 60 } = {}) {
  if (!SERPER_KEY) return { enabled: false, suburb: '', jobs: [] };

  const { suburb, state } = await reverseGeocodeSuburb(bounds);
  if (!suburb && !state) return { enabled: true, suburb: '', jobs: [] };

  const cacheKey = `${suburb}|${state}|${terms}`.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { enabled: true, suburb, jobs: cached.jobs.slice(0, limit) };
  }

  const batches = await Promise.all(
    AREA_JOB_BOARDS.map(board => searchAreaBoard(board, suburb, state, terms)),
  );

  const merged = [];
  const seen = new Set();
  for (const batch of batches) {
    for (const j of batch) {
      const key = `${j.title.toLowerCase()}|${(j.company_name || '').toLowerCase()}|${j.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(j);
    }
  }

  cache.set(cacheKey, { jobs: merged, at: Date.now() });
  return { enabled: true, suburb, state, jobs: merged.slice(0, limit) };
}

function isAreaJobSearchEnabled() {
  return !!SERPER_KEY;
}

module.exports = {
  findAreaJobs,
  isAreaJobSearchEnabled,
  reverseGeocodeSuburb,
};
