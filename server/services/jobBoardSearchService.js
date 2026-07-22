// Find open roles on external job boards when a company has none on their website.
// Uses Serper (Google search) — requires SERPER_API_KEY in .env.
//
// Trusted sources only: listing title/snippet must mention the company; URL must
// be a real job posting on a known board (Seek, Indeed AU, LinkedIn Jobs, Jora).

const { formatAustralianLocation, extractCityFromAddress } = require('./linkedinService');
const { serperSearch, isConfigured: serperConfigured } = require('./serperClient');
const { getCached, setCached } = require('./apiCacheService');

const CACHE_TTL_MS = 1000 * 60 * 60 * 12;

const JOB_BOARDS = [
  { source: 'seek', site: 'site:seek.com.au', urlRe: /seek\.com\.au\/job\//i },
  { source: 'indeed', site: 'site:au.indeed.com', urlRe: /indeed\.com\/(viewjob|rc\/clk|pagead)/i },
  { source: 'linkedin-jobs', site: 'site:linkedin.com/jobs', urlRe: /linkedin\.com\/jobs\/view/i },
  { source: 'jora', site: 'site:jora.com', urlRe: /jora\.com\/(?:job|j)\//i },
  { source: 'careerone', site: 'site:careerone.com.au', urlRe: /careerone\.com\.au\/jobview\//i },
];

const ROLE_RE = /\b(developer|engineer|designer|manager|lead|architect|analyst|scientist|consultant|specialist|director|intern|coordinator|producer|writer|editor|recruiter|strategist|associate|assistant|advisor|operator|administrator|officer|technician|marketer|programmer|executive|chef|cook|barista|nurse|driver|accountant|lawyer|paralegal|sales|support|customer|receptionist|cleaner|electrician|plumber|teacher|trainer|coach|therapist|physio|dentist|doctor|pharmacist|worker|labourer|laborer|supervisor|foreman|technologist|pathologist|radiographer|midwife|carer|caregiver|host|waiter|waitress|bartender|sous|head of|vp of|chief)\b/i;

const JUNK_TITLE = /^(jobs?|careers?|search results|hiring|apply|view all|see all|company profile)$/i;

function companySearchTerms(name) {
  const cleaned = String(name || '')
    .replace(/\s*[-–—|]\s*.*/g, '')
    .replace(/\b(pty\.?\s*ltd\.?|limited|inc\.?|corp\.?|company|co\.?|group|services|solutions|australia|au|24\/7)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = cleaned.split(' ').filter(w => w.length > 2);
  return {
    full: cleaned || String(name || '').trim(),
    short: words.slice(0, 3).join(' ') || cleaned,
    tokens: words.filter(w => w.length > 3),
  };
}

function resultMentionsCompany(companyName, title, snippet) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  const { full, tokens } = companySearchTerms(companyName);
  if (full.length >= 4 && text.includes(full.toLowerCase())) return true;
  if (!tokens.length) {
    const raw = String(companyName || '').toLowerCase().trim();
    return raw.length >= 4 && text.includes(raw.slice(0, Math.min(raw.length, 12)));
  }
  const hits = tokens.filter(w => text.includes(w.toLowerCase()));
  if (tokens.length === 1) return hits.length >= 1;
  return hits.length >= Math.min(2, tokens.length);
}

function parseJobTitle(serperTitle, companyName) {
  let t = String(serperTitle || '').trim();
  t = t.replace(/\s*[|\-–—]\s*(Seek\.?com\.?au|Indeed|LinkedIn|Jora|Glassdoor|CareerOne|Careers Vic).*$/i, '');
  const co = companySearchTerms(companyName).full;
  if (co.length > 3) {
    t = t.replace(new RegExp(`\\s*[|\\-–—]\\s*${co.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '');
  }
  t = t.replace(/^[^:]+:\s*hiring\s+/i, '');
  t = t.replace(/\s+hiring\s+.+$/i, '');
  const parts = t.split(/\s*[|\-–—]\s*/);
  if (parts.length > 1) {
    const withRole = parts.find(p => ROLE_RE.test(p) && p.length >= 8 && p.length <= 100);
    if (withRole) t = withRole;
    else t = parts[0];
  }
  return t.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isPlausibleExternalJob(title, url, board) {
  if (!title || title.length < 6 || title.length > 120) return false;
  if (JUNK_TITLE.test(title)) return false;
  if (!board?.urlRe?.test(url || '')) return false;
  if (!ROLE_RE.test(title)) return false;
  return true;
}

function parseLocation(snippet, address) {
  const city = extractCityFromAddress(address);
  if (city && snippet && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(snippet)) {
    return `${city}, Australia`;
  }
  const m = String(snippet || '').match(/\b([A-Za-z\s'.-]+)\s+(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/i);
  if (m) return `${m[1].trim()} ${m[2].toUpperCase()}, Australia`;
  return city ? `${city}, Australia` : 'Australia';
}

async function searchBoard(board, company, terms, location) {
  const queries = [
    `${board.site} "${terms.short}" ${location}`.trim(),
    `${board.site} "${terms.full}" jobs ${extractCityFromAddress(company.address)}`.trim(),
  ].filter(q => q.length > 12);

  const jobs = [];
  const seen = new Set();

  for (const q of queries) {
    if (jobs.length >= 8) break;
    const results = await serperSearch(q, { num: 8, gl: 'au', hl: 'en' });
    for (const r of results) {
      const url = r.link || '';
      if (!board.urlRe.test(url)) continue;
      if (!resultMentionsCompany(company.name, r.title, r.snippet)) continue;
      const title = parseJobTitle(r.title, company.name);
      if (!isPlausibleExternalJob(title, url, board)) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        title,
        url,
        location: parseLocation(r.snippet, company.address),
        job_type: '',
        salary: '',
        department: '',
        description: (r.snippet || '').slice(0, 280),
        posted_at: null,
        closes_at: null,
        remote: /\bremote\b/i.test(`${r.title} ${r.snippet}`),
        source: board.source,
      });
    }
  }
  return jobs;
}

async function findExternalBoardJobs(company, { limit = 15 } = {}) {
  if (!serperConfigured() || !company?.name) return [];

  const terms = companySearchTerms(company.name);
  const location = formatAustralianLocation(company.address);
  const cacheKey = `boardjobs:${terms.full}|${location}`.toLowerCase();
  const cached = await getCached(cacheKey);
  if (cached) return cached.slice(0, limit);

  const boardResults = await Promise.all(
    JOB_BOARDS.map(board => searchBoard(board, company, terms, location)),
  );

  const merged = [];
  const seen = new Set();
  for (const batch of boardResults) {
    for (const j of batch) {
      const key = `${j.title.toLowerCase()}|${j.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(j);
    }
  }

  const out = merged.slice(0, limit);
  await setCached(cacheKey, out, CACHE_TTL_MS);
  return out;
}

function isExternalJobSearchEnabled() {
  return serperConfigured();
}

module.exports = {
  findExternalBoardJobs,
  isExternalJobSearchEnabled,
  companySearchTerms,
  resultMentionsCompany,
};
