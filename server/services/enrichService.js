// Deep enrichment: given a company website, crawl several common pages in
// parallel and extract everything useful:
//
//   - Best careers / contact email (preferring careers@, jobs@, hr@, ...)
//   - ALL emails found across the crawled pages
//   - A careers page URL
//   - A primary phone number
//   - Social profile links (LinkedIn / Instagram / Twitter / Facebook / YouTube)
//   - A description (from <meta description>, og:description, or page text)
//   - extraText: scraped body text used to re-classify the company
//
// We deliberately keep this conservative — fetch at most ~6 pages, give each
// a short timeout, and never follow links to other domains. The goal is to
// turn a single homepage URL into a rich contact card without scraping the
// whole site.

const axios = require('axios');
const cheerio = require('cheerio');
const { isPlausibleEmail, pickTrustedEmail, isJunkDescription, sanitizeDescription, pickBestDescription } = require('./trustService');
const { isValidTeamMember, isPlaceName, looksLikeAddress, isServiceName, isSectionHeading, looksLikeOfferingHeading, looksLikeServiceBio, looksLikeServiceTitle, looksLikeServiceMenu } = require('./teamTrustService');
const { URL } = require('url');

const TIMEOUT = parseInt(process.env.ENRICH_TIMEOUT_MS || '8000', 10);
const FAST_TIMEOUT = parseInt(process.env.FAST_ENRICH_TIMEOUT_MS || '4500', 10);
const UA = process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0';

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// Phone numbers: be conservative. Looks for 8-15 digit sequences with common
// separators. International calling code optional.
const PHONE_REGEX = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g;

const CAREER_KEYWORDS = [
  'career', 'careers', 'job', 'jobs', 'work-with-us', 'work_with_us',
  'join-us', 'join_us', 'join-our-team', 'we-are-hiring', 'hiring',
  'opportunities', 'vacancies', 'positions', 'open-roles', 'open_roles',
];

const CAREER_EMAIL_PREFIXES = [
  'careers', 'career', 'jobs', 'job', 'hr', 'talent', 'recruit',
  'recruiting', 'recruitment', 'hiring', 'apply', 'work', 'people',
];

// Fast scan: homepage + contact pages only (background queue).
const FAST_CONTACT_PATHS = ['/contact', '/contact-us'];

// Full scan: about/team pages too.
const CRAWL_PATHS = [
  '/',
  '/about', '/about-us', '/contact', '/contact-us',
  '/team', '/our-team',
];

// Link text / href fragments that usually point at a team or about page.
const TEAM_LINK_RE = /\b(team|about\s*us|who\s*we\s*are|who\s*are\s*we|our\s*people|our\s*story|leadership|meet\s*(the|our)\s*team|staff)\b/i;
const TEAM_URL_RE  = /\/(about|team|people|staff|leadership|who-are-we|who-we-are|our-team|meet-the-team|meet-our-team|our-story)(\/|$)/i;

// Probed only when no careers page was linked from the home page.
const COMMON_CAREER_PATHS = [
  '/careers', '/career', '/jobs', '/join-us', '/work-with-us',
  '/about/careers', '/company/careers',
];

// Hosts where the "website" is really a social profile or marketplace — we
// can't enrich those, so we skip them entirely.
const SOCIAL_HOSTS = [
  'facebook.com', 'm.facebook.com', 'fb.com',
  'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'youtube.com', 'tiktok.com',
  'yelp.com', 'tripadvisor.com', 'foursquare.com',
  'pinterest.com', 'wa.me', 'whatsapp.com', 't.me',
];

function isSocialHost(host) {
  if (!host) return false;
  const h = host.replace(/^www\./, '').toLowerCase();
  return SOCIAL_HOSTS.some(s => h === s || h.endsWith('.' + s));
}

function emptyResult() {
  return {
    email: null,
    careers_url: null,
    phone: null,
    description: '',
    socials: {},
    all_emails: [],
    team: [],
    logo_url: null,
    extraText: '',
    fetched: false,
    fetch_error: null,
  };
}

// Pull the highest-quality icon a site exposes:
//   1. Largest <link rel="apple-touch-icon"> (usually 180x180 PNG)
//   2. <link rel="icon" sizes="32x32"> or larger
//   3. <meta property="og:image"> (often the company logo)
function extractLogoUrl($, baseUrl) {
  const cands = [];
  $('link[rel~="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => {
    const href = $(el).attr('href'); if (!href) return;
    const sizes = $(el).attr('sizes') || '';
    const m = sizes.match(/(\d+)x\d+/);
    const size = m ? parseInt(m[1], 10) : 180;
    cands.push({ url: absolutize(href, baseUrl), size, source: 'apple' });
  });
  $('link[rel~="icon"]').each((_, el) => {
    const href = $(el).attr('href'); if (!href) return;
    const sizes = $(el).attr('sizes') || '';
    if (/svg/i.test($(el).attr('type') || '')) {
      cands.push({ url: absolutize(href, baseUrl), size: 9999, source: 'svg' });
      return;
    }
    const m = sizes.match(/(\d+)x\d+/);
    const size = m ? parseInt(m[1], 10) : 32;
    cands.push({ url: absolutize(href, baseUrl), size, source: 'icon' });
  });
  const og = $('meta[property="og:image"], meta[name="og:image"]').attr('content');
  if (og) cands.push({ url: absolutize(og, baseUrl), size: 256, source: 'og' });

  if (!cands.length) return null;
  // Prefer apple-touch / svg (highest quality), then largest size.
  cands.sort((a, b) => {
    const rank = { svg: 3, apple: 2, og: 1, icon: 0 };
    if (rank[b.source] !== rank[a.source]) return rank[b.source] - rank[a.source];
    return b.size - a.size;
  });
  return cands[0].url;
}

async function enrichCompany(company, { mode = 'full' } = {}) {
  const result = emptyResult();
  if (!company.website) return result;

  const homeUrl = normalizeUrl(company.website);
  if (!homeUrl) return result;
  try {
    if (isSocialHost(new URL(homeUrl).hostname)) return result;
  } catch { return result; }

  const fast = mode === 'fast' || mode === 'contact';
  const fetchTimeout = fast ? FAST_TIMEOUT : TIMEOUT;
  result.enrich_depth = fast ? 'contact' : 'full';

  // ---- 1. Homepage (always) ----
  const homeFetch = await safeFetch(homeUrl, { timeout: fetchTimeout });
  if (!homeFetch) {
    result.fetch_error = 'Could not reach website';
    return result;
  }
  const home = { url: homeUrl, body: homeFetch.body };

  let pages = [home];
  if (fast) {
    const $home = cheerio.load(home.body);
    const homeEmails = extractEmails(home.body);
    const homePhones = extractPhones(home.body);
    const homeSocials = extractSocials(home.body, homeUrl);
    const pickedHome = pickTrustedEmail(homeEmails, homeUrl);
    const homePhone = pickBestPhone(homePhones, home.body);
    const homeDesc = sanitizeDescription(
      extractDescriptionFromPage($home, company.name),
      company.name,
    );

    // Contact pages when homepage has no trusted email yet.
    if (!pickedHome.email) {
      const extraUrls = FAST_CONTACT_PATHS
        .map(p => absolutize(p, homeUrl))
        .filter(u => u && u !== homeUrl);
      const extras = await Promise.all(
        extraUrls.map(u => safeFetch(u, { timeout: fetchTimeout }).then(r => r ? { url: u, body: r.body } : null)),
      );
      pages = [home, ...extras.filter(Boolean)];
    }
  } else {
    const discovered = discoverTeamPageUrls(home.body, homeUrl);
    const staticUrls = CRAWL_PATHS.map(p => absolutize(p, homeUrl)).filter(Boolean);
    const allUrls = [...new Set([homeUrl, ...staticUrls, ...discovered])].slice(0, 10);
    const pageResults = await Promise.all(
      allUrls.map(u => u === homeUrl ? home : safeFetch(u, { timeout: fetchTimeout }).then(r => r ? { url: u, body: r.body } : null)),
    );
    pages = pageResults.filter(Boolean);
  }

  // ---- 2. Aggregate emails / phones / socials / team across pages ----
  const emails = new Set();
  const phones = new Set();
  const socials = {};
  const teamSeen = new Map();
  let extraText = '';
  let description = '';

  for (const page of pages) {
    extractEmails(page.body).forEach(e => emails.add(e));
    extractPhones(page.body).forEach(p => phones.add(p));
    Object.assign(socials, extractSocials(page.body, homeUrl));

    if (!fast && (isTeamPageUrl(page.url) || isAboutPageUrl(page.url) || pageLooksLikeTeam(page.body))) {
      for (const person of extractTeam(page.body, page.url)) {
        const key = person.name.toLowerCase();
        const prev = teamSeen.get(key);
        if (!prev || (person.title && person.title.length > (prev.title || '').length) ||
            (person.bio && person.bio.length > (prev.bio || '').length)) {
          teamSeen.set(key, person);
        }
      }
    }

    if (page.url === homeUrl) {
      const $ = cheerio.load(page.body);
      description = extractDescriptionFromPage($, company.name);
      extraText = stripText($).slice(0, 4000);
      result.logo_url = extractLogoUrl($, homeUrl);
    } else if (!description && isAboutPageUrl(page.url)) {
      const $ = cheerio.load(page.body);
      const aboutDesc = extractDescriptionFromPage($, company.name);
      if (aboutDesc) description = aboutDesc;
    }
  }

  // ---- 3. Careers page (homepage links; full scan also probes common paths) ----
  const $home = cheerio.load(home.body);
  const candidates = new Set();
  $home('a[href]').each((_, a) => {
    const href = $home(a).attr('href');
    if (!href) return;
    const text = ($home(a).text() || '').toLowerCase();
    const lower = href.toLowerCase();
    if (
      CAREER_KEYWORDS.some(k => lower.includes(k)) ||
      CAREER_KEYWORDS.some(k => text.includes(k)) ||
      /work\s+with\s+us|join\s+(our\s+)?team|we['’]re\s+hiring/.test(text)
    ) {
      const abs = absolutize(href, homeUrl);
      if (abs && sameOrigin(abs, homeUrl)) candidates.add(abs);
    }
  });
  let careersUrl = pickBestCareers(Array.from(candidates));

  if (!careersUrl && !fast) {
    careersUrl = await probeCareerPaths(homeUrl, fetchTimeout);
  }

  if (careersUrl && !pages.find(p => p.url === careersUrl)) {
    const cr = await safeFetch(careersUrl, { timeout: fetchTimeout });
    if (cr) extractEmails(cr.body).forEach(e => emails.add(e));
  }

  // ---- 4. Pick best email + phone ----
  const allEmails = Array.from(emails);
  const picked = pickTrustedEmail(allEmails, homeUrl);
  result.email = picked.email;
  result.email_source = picked.email_source;
  result.email_verified = picked.email_verified;
  result.phone = pickBestPhone(Array.from(phones), home.body);
  result.careers_url = careersUrl;
  result.socials = socials;
  result.description = sanitizeDescription(description, company.name);
  result.all_emails = allEmails;
  result.team = fast ? [] : sortTeam(Array.from(teamSeen.values()).filter(isValidTeamMember)).slice(0, 12);
  result.extraText = extraText;
  result.fetched = true;

  return result;
}

async function probeCareerPaths(homeUrl, timeout = TIMEOUT) {
  const probes = await Promise.all(
    COMMON_CAREER_PATHS.map(async (p) => {
      const tryUrl = absolutize(p, homeUrl);
      if (!tryUrl) return null;
      const r = await safeFetch(tryUrl, { method: 'head', timeout });
      if (r && r.status >= 200 && r.status < 400) return tryUrl;
      return null;
    }),
  );
  return probes.find(Boolean) || null;
}

// --- team extraction -----------------------------------------------------

function discoverTeamPageUrls(html, baseUrl) {
  const urls = new Set();
  if (!html) return [];
  const $ = cheerio.load(html);
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const text = ($(a).text() || '').replace(/\s+/g, ' ').trim();
    const lower = href.toLowerCase();
    if (TEAM_URL_RE.test(lower) || TEAM_LINK_RE.test(text) || TEAM_LINK_RE.test(lower)) {
      const abs = absolutize(href, baseUrl);
      if (abs && sameOrigin(abs, baseUrl)) urls.add(abs);
    }
  });
  return Array.from(urls).slice(0, 6);
}

function isTeamPageUrl(url) {
  return TEAM_URL_RE.test(url || '');
}

function pageLooksLikeTeam(html) {
  if (!html) return false;
  if (/\bour team\b|meet (the|our) team|leadership team|who are we\b/i.test(html)) return true;
  // About pages that list people as h2 headings (e.g. timplates.com.au/about).
  const $ = cheerio.load(html);
  let personHeadings = 0;
  $('h2').each((_, el) => {
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    if (looksLikeName(name)) personHeadings++;
  });
  return personHeadings >= 2;
}

function extractTeamAboutHeadings($) {
  const out = [];
  const seen = new Set();
  $('h2').each((_, el) => {
    const $el = $(el);
    const name = $el.text().replace(/\s+/g, ' ').trim();
    if (!looksLikeName(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    const rec = buildPersonRecord($, $el, name);
    if (shouldSkipTeamHeading($el, name, rec)) return;
    if (isTestimonialTitle(rec.title)) return;
    if (looksLikeServiceBio(rec.bio)) return;
    // Accept name + bio and/or LinkedIn — many sites omit job titles on about pages.
    if (!rec.linkedin_url && !rec.bio && (!rec.title || !looksLikeTitleLine(rec.title))) return;
    seen.add(key);
    out.push(rec);
  });
  return out;
}

// Stop extracting names once we hit these section headings (testimonials, etc.).
const TEAM_STOP_RE = /\b(customers?\s+say|testimonial|what people say|our work|our service|case stud|portfolio|footer|get in touch|contact us|follow us|navigation|frequently asked)\b/i;
const TEAM_START_RE = /\b(our team|meet (the|our) team|leadership team|key people|our people|the team)\b/i;
const TEAM_START_LOOSE_RE = /\b(who we are|who are we)\b/i;

// Words that strongly suggest a string is a job title (not a person name).
const TITLE_WORDS = [
  'director', 'manager', 'lead', 'head', 'founder', 'co-founder', 'partner',
  'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cpo', 'cdo',
  'designer', 'developer', 'engineer', 'architect', 'producer',
  'strategist', 'consultant', 'analyst', 'specialist', 'coordinator',
  'principal', 'senior', 'junior', 'creative', 'art', 'design',
  'president', 'vp', 'vice', 'chief', 'owner', 'editor', 'writer',
  'account', 'marketing', 'brand', 'product', 'project', 'operations',
];
const TITLE_RE = new RegExp(`\\b(?:${TITLE_WORDS.join('|')})\\b`, 'i');

function isInFooterOrAddressBlock($el) {
  const hit = $el.closest(
    'footer, [class*="footer"], [class*="add_div"], [class*="address"], ' +
    '[class*="location"], [class*="office-loc"], [id*="footer"], [role="contentinfo"]',
  );
  if (!hit.length) return false;
  // Theme utility classes like "footer-on-bottom" on <body> are not the page footer.
  const tag = (hit[0]?.tagName || '').toLowerCase();
  if (tag === 'body' || tag === 'html') return false;
  return true;
}

function isInServiceBlock($el) {
  return $el.closest(
    '[class*="service"], [id*="service"], [class*="our-service"], [class*="offer"], [class*="what-we-do"]',
  ).length > 0;
}

function shouldSkipTeamHeading($el, name, rec) {
  if (isInFooterOrAddressBlock($el)) return true;
  if (isInServiceBlock($el)) return true;
  if (isPlaceName(name)) return true;
  if (isServiceName(name)) return true;
  if (isSectionHeading(name)) return true;
  if (looksLikeOfferingHeading(name)) return true;
  if (looksLikeServiceBio(rec?.bio)) return true;
  if (looksLikeServiceTitle(rec?.title)) return true;
  if (looksLikeServiceMenu(rec?.title)) return true;
  if (looksLikeAddress(rec?.bio)) return true;
  if (looksLikeAddress(rec?.title)) return true;
  return false;
}

// A "looks like a person name": 2–4 words, each starting with a capital,
// no digits, no excessive punctuation, no all-caps blobs.
function looksLikeName(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 4 || t.length > 60) return false;
  if (/\d/.test(t)) return false;
  if (/[\/@|]/.test(t)) return false;
  if (/[a-z]{2,}[A-Z]/.test(t)) return false; // camelCase / no-spaces
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  // Each word: starts with uppercase letter (allow unicode), no all-caps.
  const reWord = /^[A-Z\u00C0-\u024F][a-zA-Z'’\-\u00C0-\u024F.]+$/;
  for (const w of words) {
    if (!reWord.test(w)) return false;
    if (w === w.toUpperCase()) return false;
  }
  // Reject if the string itself contains title words — that's a role, not a name.
  if (TITLE_RE.test(t)) return false;
  // Reject generic section headings mistaken for names.
  if (/^(our|the|meet)\s+(team|people|staff|leadership|experts?)$/i.test(t)) return false;
  if (/^key\s+people$/i.test(t)) return false;
  if (/^leadership\s+team$/i.test(t)) return false;
  if (isPlaceName(t)) return false;
  if (isServiceName(t)) return false;
  if (isSectionHeading(t)) return false;
  if (looksLikeOfferingHeading(t)) return false;
  return true;
}

function cleanPersonTitle(raw) {
  if (!raw || isTestimonialTitle(raw)) return '';
  return raw
    .replace(/\b0\d[\d\s]{7,}\b/g, ' ')
    .replace(/\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g, ' ')
    .replace(/\bemail\b.*$/i, '')
    .replace(/\bagent\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function extractTeam(html, pageUrl = '') {
  if (!html) return [];
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();

  const onAboutOrTeam = isTeamPageUrl(pageUrl) || isAboutPageUrl(pageUrl);

  // About pages often use h2 name headings + bio + LinkedIn (no "Our team" section).
  if (onAboutOrTeam || pageLooksLikeTeam(html)) {
    const aboutHeadings = extractTeamAboutHeadings($);
    if (aboutHeadings.length >= 1) return aboutHeadings;
  }

  // Prefer scoped extraction inside an "Our team" section — avoids pulling
  // customer testimonial names (common on agency sites).
  const scoped = extractTeamScoped($);
  if (scoped.length >= 1) return scoped;

  // Fallback only when no scoped team section was found.
  const out = [];
  const seen = new Set();
  const headingSel = onAboutOrTeam ? 'h2, h3, h4' : 'h3, h4';

  $(headingSel).each((_, el) => {
    const $el = $(el);
    const name = $el.text().replace(/\s+/g, ' ').trim();
    if (!looksLikeName(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    const rec = buildPersonRecord($, $el, name);
    if (shouldSkipTeamHeading($el, name, rec)) return;
    if (isTestimonialTitle(rec.title)) return;
    if (looksLikeServiceBio(rec.bio)) return;
    if (onAboutOrTeam) {
      if (!rec.linkedin_url && !rec.bio && (!rec.title || !looksLikeTitleLine(rec.title))) return;
    } else if (!rec.title || !looksLikeTitleLine(rec.title)) {
      return;
    }
    seen.add(key);
    out.push(rec);
  });

  $('[itemprop="name"]').each((_, el) => {
    const $el = $(el);
    const name = $el.text().replace(/\s+/g, ' ').trim();
    if (!looksLikeName(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const container = $el.closest('[itemscope]');
    const title = cleanPersonTitle(container.find('[itemprop="jobTitle"]').first().text().trim());
    const liAttr = container.find('a[href*="linkedin.com/in/"]').first().attr('href');
    out.push({
      name,
      title: title || '',
      bio: '',
      linkedin_url: liAttr ? normalizeLinkedIn(liAttr) : null,
      linkedin_source: liAttr ? 'website' : null,
    });
  });

  return out;
}

function extractTeamScoped($) {
  const out = [];
  const seen = new Set();
  let inTeam = false;

  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const $el = $(el);
    const heading = $el.text().replace(/\s+/g, ' ').trim();
    const tag = (el.tagName || '').toLowerCase();

    if ((tag === 'h1' || tag === 'h2' || tag === 'h3') && TEAM_STOP_RE.test(heading)) {
      inTeam = false;
      return;
    }

    if (tag === 'h2' && TEAM_START_RE.test(heading)) {
      inTeam = true;
      return;
    }
    // "Who are we" pages: only start capturing after we see an explicit team sub-heading.
    if ((tag === 'h2' || tag === 'h3') && TEAM_START_LOOSE_RE.test(heading)) {
      return; // wait for h2 "Our team" below
    }

    if (!inTeam) return;
    if (!looksLikeName(heading)) return;
    const key = heading.toLowerCase();
    if (seen.has(key)) return;

    const rec = buildPersonRecord($, $el, heading);
    if (shouldSkipTeamHeading($el, heading, rec)) return;
    if (isTestimonialTitle(rec.title)) return;
    if (looksLikeServiceBio(rec.bio)) return;
    if (rec.title && !looksLikeTitleLine(rec.title)) return;

    seen.add(key);
    out.push(rec);
  });

  return out;
}

function isTestimonialTitle(title) {
  if (!title) return false;
  const t = title.toLowerCase();
  return /["'""]|working with|it's such a pleasure|i engaged|i have worked|^\d+["""]/.test(t);
}

function buildPersonRecord($, $el, name) {
  const title = cleanPersonTitle(findTitleNear($el));
  const bio = findBioNear($el);
  const linkedin_url = findLinkedInNear($el);
  return {
    name,
    title: title || '',
    bio: bio || '',
    linkedin_url: linkedin_url || null,
    linkedin_source: linkedin_url ? 'website' : null,
  };
}

function looksLikeTitleLine(txt) {
  if (!txt || txt.length > 100) return false;
  if (TITLE_RE.test(txt)) return true;
  // Agency sites often use ALL CAPS roles: "LEAD DESIGNER / CO-DIRECTOR"
  if (/^[A-Z0-9\s\/\-&,.()]+$/.test(txt) && txt.length >= 6 && txt.length <= 80) return true;
  return false;
}

function findBioNear($el) {
  let n = $el[0].nextSibling;
  let hops = 0;
  while (n && hops < 10) {
    if (n.type === 'tag') {
      const tag = (n.name || '').toLowerCase();
      const txt = collectText(n).replace(/\s+/g, ' ').trim();
      if (tag.match(/^h[1-6]$/) && looksLikeName(txt)) break;
      if ((tag === 'p' || tag === 'div') && txt.length >= 40 && txt.length <= 400 && !looksLikeTitleLine(txt)) {
        return txt.slice(0, 220);
      }
      hops++;
    }
    n = n.nextSibling;
  }
  return '';
}

// Search the team-card container around the heading for an inline LinkedIn
// profile link. Walks up to 4 levels of ancestors looking for any
// linkedin.com/in/* anchor.
function findLinkedInNear($el) {
  // LinkedIn usually sits in the same block as the heading — walk forward
  // until the next person heading so we don't grab a neighbour's profile URL.
  let next = $el.next();
  for (let i = 0; i < 12 && next.length; i++) {
    const tag = (next[0].tagName || '').toLowerCase();
    const txt = next.text().replace(/\s+/g, ' ').trim();
    if (tag.match(/^h[1-6]$/) && (looksLikeName(txt) || TEAM_STOP_RE.test(txt))) break;
    const a = next.find('a[href*="linkedin.com/in/"]').addBack('a[href*="linkedin.com/in/"]').first();
    if (a && a.attr('href')) return normalizeLinkedIn(a.attr('href'));
    next = next.next();
  }
  return null;
}

function normalizeLinkedIn(href) {
  try {
    const u = new URL(href, 'https://www.linkedin.com');
    u.search = '';
    u.hash = '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch { return null; }
}

function findTitleNear($el) {
  // Walk up to 6 forward-siblings looking for a short line containing a title word.
  let n = $el[0].nextSibling;
  let hops = 0;
  while (n && hops < 8) {
    if (n.type === 'tag') {
      const txt = collectText(n).replace(/\s+/g, ' ').trim();
      if (txt && looksLikeTitleLine(txt)) return txt;
      hops++;
    }
    n = n.nextSibling;
  }
  // Look at the parent container's text minus the heading itself.
  const parent = $el.parent();
  if (parent && parent.length) {
    const parentText = parent.clone()
      .find($el[0].tagName).remove().end()
      .text().replace(/\s+/g, ' ').trim();
    const lines = parentText.split(/[.\n]/).map(s => s.trim()).filter(Boolean);
    for (const line of lines) {
      if (looksLikeTitleLine(line) && !looksLikeName(line)) return line;
    }
  }
  return '';
}

function collectText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.data || '';
  if (!node.children) return '';
  return node.children.map(collectText).join(' ');
}

// Sort: people with explicit C-level / founder / director titles first.
const SENIORITY = [
  'founder', 'co-founder', 'ceo', 'cto', 'coo', 'cfo', 'cmo', 'cpo',
  'president', 'owner', 'principal', 'director', 'head', 'partner', 'vp',
];
function sortTeam(arr) {
  return arr.sort((a, b) => seniorityRank(a.title) - seniorityRank(b.title));
}
function seniorityRank(title) {
  if (!title) return 100;
  const t = title.toLowerCase();
  for (let i = 0; i < SENIORITY.length; i++) {
    if (t.includes(SENIORITY[i])) return i;
  }
  return 50;
}

// --- extraction helpers --------------------------------------------------

function isPlausibleEmailLocal(e) {
  return isPlausibleEmail(e);
}

function extractEmails(html) {
  if (!html) return [];
  const out = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    out.add(cleanEmail(m[1]));
  }
  for (const m of html.matchAll(EMAIL_REGEX)) {
    out.add(cleanEmail(m[0]));
  }
  return Array.from(out).filter(isPlausibleEmailLocal);
}

function cleanEmail(raw) {
  let e = (raw || '').toLowerCase().trim();
  // URL-decode prefixes like %20 from mailto links.
  try { e = decodeURIComponent(e); } catch {}
  // Strip leading whitespace / punctuation, trailing punctuation.
  e = e.replace(/^[^a-z0-9]+/, '').replace(/[.,;:]+$/, '');
  return e;
}

// We only accept phones found inside `tel:` links.
function extractPhones(html) {
  if (!html) return [];
  const out = new Set();
  for (const m of html.matchAll(/tel:([+\d\s().-]{6,})/gi)) {
    const raw = decodeURIComponent(m[1]).replace(/\s+/g, ' ').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    out.add(raw);
  }
  return Array.from(out);
}

const SOCIAL_PATTERNS = [
  { key: 'linkedin',  re: /https?:\/\/(?:www\.)?linkedin\.com\/company\/[^\s"'<>?#]+/i },
  { key: 'linkedin_person', re: /https?:\/\/(?:www\.)?linkedin\.com\/(?:in|school)\/[^\s"'<>?#]+/i },
  { key: 'instagram', re: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9_.\-]+\/?/i },
  { key: 'facebook',  re: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|tr\?|plugins\/)[a-zA-Z0-9_.\-/]+/i },
  { key: 'twitter',   re: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/(?!share|intent)[a-zA-Z0-9_]+/i },
  { key: 'youtube',   re: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel|c|user|@)[^\s"'<>?#]+/i },
  { key: 'tiktok',    re: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/i },
];

function extractSocials(html, homeUrl) {
  const found = {};
  if (!html) return found;
  for (const { key, re } of SOCIAL_PATTERNS) {
    if (found[key]) continue;
    const m = html.match(re);
    if (m && m[0]) found[key] = m[0].replace(/[)"'>,.;:]+$/, '');
  }
  return found;
}

function pickBestPhone(phones, homeHtml) {
  if (!phones.length) return null;
  // tel: phones are always reliable; prefer those.
  if (/tel:/i.test(homeHtml || '')) {
    return phones[0];
  }
  // Otherwise return the longest one (more likely to be a real full number).
  return phones.sort((a, b) => b.length - a.length)[0];
}

function pickBestCareers(urls) {
  if (!urls.length) return null;
  const scored = urls.map(u => ({
    u,
    score:
      (/(\/careers?\/?$|\/jobs?\/?$)/i.test(u) ? 100 : 0) +
      (/(careers|jobs)/i.test(u) ? 20 : 0) -
      u.length / 100,
  })).sort((a, b) => b.score - a.score);
  return scored[0].u;
}

// --- generic helpers ------------------------------------------------------

function normalizeUrl(u) {
  if (!u) return null;
  let url = u.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch { return null; }
}

function absolutize(href, base) {
  try { return new URL(href, base).toString(); }
  catch { return null; }
}

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; }
  catch { return false; }
}

async function safeFetch(url, { method = 'get', timeout = TIMEOUT } = {}) {
  try {
    const resp = await axios.request({
      url,
      method,
      timeout,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: method === 'head' ? undefined : 'text',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
    if (resp.status >= 400) return method === 'head' ? { status: resp.status, body: '' } : null;
    return { status: resp.status, body: typeof resp.data === 'string' ? resp.data : '' };
  } catch {
    return null;
  }
}

function stripText($) {
  $('script, style, noscript, nav, header, footer, aside').remove();
  return $('body').text().replace(/\s+/g, ' ').trim();
}

function isAboutPageUrl(url) {
  return /\/(about|about-us|our-story|who-we-are|who-are-we)(\/|$)/i.test(url || '');
}

const CHROME_SEL = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.nav', '.navbar', '.menu', '.site-header', '.site-footer',
  '#menu', '#nav', '.skip-link', '.screen-reader-text', '.elementor-location-header',
  '.elementor-location-footer', '.wp-block-navigation',
].join(', ');

const HERO_SEL = [
  'main h1 + p', 'main .entry-content p', 'main p',
  'article p', '.hero p', '.hero-text', '.tagline',
  '[class*="hero"] p', 'h1 + p',
  '.elementor-widget-text-editor p',
].join(', ');

function extractDescriptionFromPage($, companyName) {
  const candidates = [];

  const meta =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';
  if (meta) candidates.push(meta);

  const fromJsonLd = extractJsonLdDescription($, companyName);
  if (fromJsonLd) candidates.push(fromJsonLd);

  const clone = cheerio.load($.html());
  clone(CHROME_SEL).remove();

  for (const el of clone(HERO_SEL).toArray()) {
    candidates.push(clone(el).text());
  }

  clone('main p, article p, .content p, #content p, section p').each((_, el) => {
    candidates.push(clone(el).text());
  });

  return pickBestDescription(candidates, companyName);
}

function extractJsonLdDescription($, companyName) {
  const candidates = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || '{}');
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const desc = node?.description || node?.about?.description;
        if (typeof desc === 'string') candidates.push(desc);
      }
    } catch { /* ignore malformed JSON-LD */ }
  });
  return pickBestDescription(candidates, companyName);
}

module.exports = { enrichCompany };
