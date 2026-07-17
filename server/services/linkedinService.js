// LinkedIn profile resolution — verified sources ONLY.
//
// We never guess /in/ URL slugs. Wrong links destroy trust.
//
// Trusted sources:
//   website         — direct linkedin.com/in/ link on the company's own site
//   linkedin_company — profile URL scraped from the company's LinkedIn page
//   serper          — Google result where title names the person AND mentions the company
//
// Everyone else gets a LinkedIn *search* link in the UI, not a direct profile URL.

const axios = require('axios');
const cheerio = require('cheerio');

const SERPER_KEY = process.env.SERPER_API_KEY || '';
const TIMEOUT = parseInt(process.env.LINKEDIN_TIMEOUT_MS || '10000', 10);
const UA = process.env.ENRICH_USER_AGENT ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const TRUSTED_SOURCES = new Set(['website', 'linkedin_company', 'serper']);

const cache = new Map();
const peopleCache = new Map();
const CACHE_MAX = 800;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24;

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return undefined;
  if (Date.now() - v.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return v.url;
}
function cacheSet(key, url) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { url, at: Date.now() });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function searchUrl(name, company, address) {
  const loc = formatAustralianLocation(address);
  const q = encodeURIComponent([name, company, loc].filter(Boolean).join(' ').trim());
  return `https://www.linkedin.com/search/results/people/?keywords=${q}`;
}

function companyPeopleSearchUrl(companyName, address) {
  const loc = formatAustralianLocation(address);
  const q = encodeURIComponent([companyName, loc].filter(Boolean).join(' ').trim());
  return `https://www.linkedin.com/search/results/people/?keywords=${q}&origin=FACETED_SEARCH`;
}

function extractLinkedInCompanySlug(url) {
  const m = (url || '').match(/linkedin\.com\/company\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

function linkedinCompanyPeopleUrl(linkedinCompanyUrl) {
  const slug = extractLinkedInCompanySlug(linkedinCompanyUrl);
  if (!slug) return null;
  return `https://www.linkedin.com/company/${encodeURIComponent(slug)}/people/`;
}

function extractCityFromAddress(address) {
  if (!address) return '';
  const parts = address.split(',').map(s => s.trim());
  for (const p of parts) {
    const m = p.match(/^([A-Za-z\s'.-]+)\s+(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\s+\d+/i);
    if (m) return m[1].trim();
  }
  if (parts.length >= 2) {
    return parts[parts.length - 2]
      .replace(/\s+(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\s+\d+.*$/i, '')
      .trim();
  }
  return '';
}

const AU_STATE_NAMES = {
  VIC: 'Victoria', NSW: 'New South Wales', QLD: 'Queensland', WA: 'Western Australia',
  SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory',
};

function extractStateFromAddress(address) {
  if (!address) return '';
  const m = String(address).match(/\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/i);
  return m ? (AU_STATE_NAMES[m[1].toUpperCase()] || m[1]) : '';
}

function formatAustralianLocation(address) {
  const city = extractCityFromAddress(address);
  const state = extractStateFromAddress(address);
  return [city, state, 'Australia'].filter(Boolean).join(' ');
}

function normalizeName(n) {
  return (n || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanLinkedInUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return u; }
}

function extractProfileUrl(link) {
  const m = (link || '').match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]+)/i);
  if (!m) return null;
  return { url: cleanLinkedInUrl(m[0]), slug: m[1] };
}

function slugMatchesName(slug, fullName) {
  if (!slug || !fullName) return false;
  const parts = normalizeName(fullName).split(' ').filter(p => p.length > 1);
  if (parts.length < 2) return false;
  const slugNorm = slug.toLowerCase().replace(/-[0-9a-f]{6,}$/i, '');
  return parts.every(p => slugNorm.includes(p));
}

function profileTitleMatchesName(title, personName) {
  const t = normalizeName((title || '').replace(/\s*[|\-–—].*$/, ''));
  const n = normalizeName(personName);
  if (!t || !n) return false;
  if (t.startsWith(n) || t.includes(n)) return true;
  const tp = t.split(' ');
  const np = n.split(' ');
  if (tp.length >= 2 && np.length >= 2) {
    return tp[0] === np[0] && tp[tp.length - 1] === np[np.length - 1];
  }
  return false;
}

function resultMentionsCompany(title, snippet, companyName) {
  const text = `${title || ''} ${snippet || ''}`.toLowerCase();
  const name = (companyName || '').toLowerCase().trim();
  if (!name) return false;
  if (text.includes(name)) return true;
  const words = name.split(/\s+/).filter(w => w.length > 3);
  return words.length > 0 && words.every(w => text.includes(w));
}

function isTrustedSource(source) {
  return TRUSTED_SOURCES.has(source);
}

// Strip guessed / unverified URLs saved by older versions of the app.
// Drop office locations mistaken for people (e.g. "New South Wales" + street address).
const { isValidTeamMember } = require('./teamTrustService');

function sanitizeTeamMember(m, companyName) {
  if (!m || !isValidTeamMember(m, companyName)) return null;
  const out = { ...m };
  if (out.linkedin_url && !isTrustedSource(out.linkedin_source)) {
    delete out.linkedin_url;
    out.linkedin_source = null;
  }
  if (out.linkedin_url && !out.linkedin_source) {
    out.linkedin_source = 'website';
  }
  return out;
}

function sanitizeTeam(team, companyName) {
  return (team || []).map(m => sanitizeTeamMember(m, companyName)).filter(Boolean);
}

function parseSerperPersonResult(link, title, snippet, companyName) {
  const extracted = extractProfileUrl(link);
  if (!extracted) return null;

  let name = '';
  let jobTitle = '';
  const t = (title || '')
    .replace(/\s*[|\-–—]\s*LinkedIn.*$/i, '')
    .replace(/\s*\|\s*LinkedIn.*$/i, '')
    .trim();

  const dashParts = t.split(/\s[-–—]\s+/);
  if (dashParts.length >= 1) name = dashParts[0].trim();
  if (dashParts.length >= 2) {
    jobTitle = dashParts.slice(1).join(' - ').trim();
    const atRe = new RegExp(`\\s+at\\s+${companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    jobTitle = jobTitle.replace(atRe, '').trim();
    if (jobTitle.toLowerCase().endsWith(companyName.toLowerCase())) {
      jobTitle = jobTitle.slice(0, -companyName.length).replace(/\s[-–—]\s*$/, '').trim();
    }
  }

  if (!name || name.length < 2) return null;
  if (/^(linkedin|profiles?|people|search)/i.test(name)) return null;

  if (!resultMentionsCompany(title, snippet, companyName)) return null;
  // Title must explicitly tie person to company — snippet-only matches are too loose.
  if (!resultMentionsCompany(title, '', companyName)) return null;

  return {
    name,
    title: jobTitle || '',
    bio: (snippet || '').slice(0, 200),
    linkedin_url: extracted.url,
    linkedin_source: 'serper',
    source: 'linkedin',
  };
}

async function scrapeLinkedInCompanyProfiles(linkedinCompanyUrl) {
  if (!linkedinCompanyUrl || !/linkedin\.com\/company\//i.test(linkedinCompanyUrl)) return [];
  const slug = extractLinkedInCompanySlug(linkedinCompanyUrl);
  if (!slug) return [];

  const pages = [
    `https://www.linkedin.com/company/${encodeURIComponent(slug)}/`,
    `https://www.linkedin.com/company/${encodeURIComponent(slug)}/people/`,
  ];

  const profiles = [];
  const seen = new Set();

  for (const pageUrl of pages) {
    try {
      const resp = await axios.get(pageUrl, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-AU,en;q=0.9', Accept: 'text/html' },
        timeout: TIMEOUT,
        validateStatus: () => true,
      });
      if (resp.status >= 400) continue;
      const html = String(resp.data || '');
      const re = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]+)/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const profileSlug = m[1];
        const linkedin_url = cleanLinkedInUrl(`https://www.linkedin.com/in/${profileSlug}`);
        if (seen.has(linkedin_url)) continue;
        seen.add(linkedin_url);
        profiles.push({ linkedin_url, slug: profileSlug });
      }
    } catch { /* ignore */ }
    await sleep(250);
  }
  return profiles;
}

// Attach verified profile URLs from the company LinkedIn page to known team members.
function attachCompanyLinkedInProfiles(team, scrapedProfiles) {
  const out = (team || []).map(m => sanitizeTeamMember({ ...m }));

  for (const m of out) {
    if (m.linkedin_url && isTrustedSource(m.linkedin_source)) continue;
    const match = (scrapedProfiles || []).find(p => slugMatchesName(p.slug, m.name));
    if (match) {
      m.linkedin_url = match.linkedin_url;
      m.linkedin_source = 'linkedin_company';
    } else if (m.linkedin_url && !isTrustedSource(m.linkedin_source)) {
      delete m.linkedin_url;
      m.linkedin_source = null;
    }
  }
  return out;
}

async function serperSearch(query, num = 10) {
  if (!SERPER_KEY) return [];
  try {
    const resp = await axios.post(
      'https://google.serper.dev/search',
      { q: query, num },
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

function mergeTeamMembers(existing, incoming) {
  const out = sanitizeTeam(existing || []);
  const seen = new Set();
  for (const m of out) {
    if (m.linkedin_url) seen.add(m.linkedin_url.toLowerCase());
    const n = normalizeName(m.name);
    if (n) seen.add(n);
  }
  for (const m of sanitizeTeam(incoming || [])) {
    if (!m || !m.name) continue;
    if (m.linkedin_url && !isTrustedSource(m.linkedin_source)) continue;
    // Serper-discovered people must match an existing website team member by name.
    const nameKey = normalizeName(m.name);
    const hasWebsiteMatch = out.some(existing =>
      normalizeName(existing.name) === nameKey && existing.name,
    );
    if (m.linkedin_source === 'serper' && !hasWebsiteMatch) continue;
    const urlKey = m.linkedin_url ? m.linkedin_url.toLowerCase() : '';
    if ((urlKey && seen.has(urlKey)) || (nameKey && seen.has(nameKey))) continue;
    if (urlKey) seen.add(urlKey);
    if (nameKey) seen.add(nameKey);
    out.push(m);
  }
  return out;
}

async function discoverCompanyPeople(company, { limit = 12 } = {}) {
  const name = company.name || '';
  if (!name) return [];

  const linkedinCo = company.socials?.linkedin || '';
  const cacheKey = `${name}|${extractCityFromAddress(company.address)}|${linkedinCo}`.toLowerCase();
  const cached = peopleCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.people;

  const people = [];

  // Serper-only discovery — title must name the person AND mention the company.
  if (SERPER_KEY) {
    const location = formatAustralianLocation(company.address);
    const city = extractCityFromAddress(company.address);
    const queries = [
      `site:linkedin.com/in/ "${name}" ${location}`.trim(),
      `site:linkedin.com/in/ "${name}" ${city} Australia`.trim(),
      `site:linkedin.com/in/ "${name}" Australia`.trim(),
    ];
    const coSlug = extractLinkedInCompanySlug(linkedinCo);
    if (coSlug) queries.unshift(`site:linkedin.com/in/ "${name}" "${coSlug}" Australia`);

    const seen = new Set();
    for (const q of queries) {
      if (people.length >= limit) break;
      const results = await serperSearch(q, 10);
      for (const r of results) {
        const p = parseSerperPersonResult(r.link, r.title, r.snippet, name);
        if (!p) continue;
        const key = p.linkedin_url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        people.push(p);
      }
      await sleep(200);
    }
  }

  const out = people.slice(0, limit);
  peopleCache.set(cacheKey, { people: out, at: Date.now() });
  return out;
}

async function findVerifiedLinkedIn(name, companyName, { address } = {}) {
  if (!name || !SERPER_KEY) return null;

  const location = formatAustralianLocation(address);
  const city = extractCityFromAddress(address);
  const cacheKey = `${name.toLowerCase()}|${(companyName || '').toLowerCase()}|${location.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const queries = [
    `site:linkedin.com/in/ "${name}" "${companyName}" ${location}`.trim(),
    `site:linkedin.com/in/ "${name}" ${companyName} ${city} Australia`.trim(),
    `site:linkedin.com/in/ "${name}" "${companyName}" Australia`.trim(),
    `site:linkedin.com/in/ "${name}" ${companyName}`.trim(),
  ].filter(q => q.replace(/"/g, '').trim().length > 20);

  for (const q of queries) {
    const results = await serperSearch(q, 8);
    for (const r of results) {
      if (!profileTitleMatchesName(r.title, name)) continue;
      if (!resultMentionsCompany(r.title, r.snippet, companyName)) continue;
      const extracted = extractProfileUrl(r.link);
      if (extracted) {
        cacheSet(cacheKey, extracted.url);
        return extracted.url;
      }
    }
    await sleep(150);
  }

  cacheSet(cacheKey, null);
  return null;
}

async function resolveTeamLinkedIn(team, companyName, { limit = 12, linkedinCompanyUrl, address } = {}) {
  if (!team || !team.length) return sanitizeTeam(team, companyName);

  let out = sanitizeTeam(team, companyName);

  // 1. Match against profiles listed on the company's LinkedIn page.
  if (linkedinCompanyUrl) {
    const scraped = await scrapeLinkedInCompanyProfiles(linkedinCompanyUrl);
    out = attachCompanyLinkedInProfiles(out, scraped);
  }

  // 2. Serper lookup for remaining members — strict match only, never guess.
  const slice = out.slice(0, limit);
  for (let i = 0; i < slice.length; i++) {
    const m = out[i];
    if (!m || !m.name || (m.linkedin_url && isTrustedSource(m.linkedin_source))) continue;
    const url = await findVerifiedLinkedIn(m.name, companyName, { address });
    if (url) {
      m.linkedin_url = url;
      m.linkedin_source = 'serper';
    } else {
      delete m.linkedin_url;
      m.linkedin_source = null;
    }
    await sleep(SERPER_KEY ? 200 : 0);
  }

  return out;
}

function isAutomaticLookupEnabled() {
  return !!SERPER_KEY;
}

module.exports = {
  searchUrl,
  companyPeopleSearchUrl,
  linkedinCompanyPeopleUrl,
  extractLinkedInCompanySlug,
  formatAustralianLocation,
  extractCityFromAddress,
  extractStateFromAddress,
  scrapeLinkedInCompanyProfiles,
  attachCompanyLinkedInProfiles,
  discoverCompanyPeople,
  mergeTeamMembers,
  sanitizeTeam,
  sanitizeTeamMember,
  resolveTeamLinkedIn,
  isTrustedSource,
  isAutomaticLookupEnabled,
};
