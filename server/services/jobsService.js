// Given a company's careers URL (and home page), try to return a list of real
// job postings.
//
// Modern companies almost always use a third-party Applicant Tracking System
// (ATS). When we can detect one, we hit its public JSON API for clean data.
// Detection is done by looking at:
//   - the careers URL (e.g. boards.greenhouse.io/acme)
//   - links on the careers page (lever, workable, ashby, …)
//   - the home page HTML
//
// When no ATS is found, we fall back to scraping headings on the careers page
// itself. That gives noisier results but at least surfaces something.

const axios = require('axios');
const cheerio = require('cheerio');
const { atsSlugMatchesCompany } = require('./trustService');

const TIMEOUT = parseInt(process.env.ENRICH_TIMEOUT_MS || '8000', 10);
const UA = process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0';

// Several ATS APIs (Workable, SmartRecruiters, Teamtailor, Workday) paginate
// server-side and only return one page unless we ask for more — this caps
// how many pages we'll follow per company so one huge job board can't turn
// a single scrape into dozens of sequential requests.
const MAX_ATS_PAGE_JOBS = 300;

// Subdomains that are the ATS vendor's own marketing/help/app surface, not a
// tenant company — a bare host match would otherwise misfire on these.
const RESERVED_ATS_SLUGS = new Set(['www', 'app', 'help', 'support', 'status', 'docs', 'blog', 'api', 'mail', 'careers', 'jobs']);

function slugOrNull(m) {
  const s = m?.[1]?.toLowerCase();
  return s && !RESERVED_ATS_SLUGS.has(s) ? s : null;
}

const ATS_PATTERNS = [
  {
    name: 'greenhouse',
    test: (u) => /boards\.greenhouse\.io\/[a-z0-9-]+/i.test(u),
    extractSlug: (u) => u.match(/boards\.greenhouse\.io\/([a-z0-9-]+)/i)?.[1],
    fetch: fetchGreenhouse,
  },
  {
    name: 'lever',
    test: (u) => /jobs\.lever\.co\/[a-z0-9-]+/i.test(u),
    extractSlug: (u) => u.match(/jobs\.lever\.co\/([a-z0-9-]+)/i)?.[1],
    fetch: fetchLever,
  },
  {
    name: 'workable',
    test: (u) => /apply\.workable\.com\/[a-z0-9-]+/i.test(u),
    extractSlug: (u) => u.match(/apply\.workable\.com\/([a-z0-9-]+)/i)?.[1],
    fetch: fetchWorkable,
  },
  {
    name: 'ashby',
    test: (u) => /jobs\.ashbyhq\.com\/[a-z0-9-]+/i.test(u),
    extractSlug: (u) => u.match(/jobs\.ashbyhq\.com\/([a-z0-9-]+)/i)?.[1],
    fetch: fetchAshby,
  },
  {
    name: 'smartrecruiters',
    test: (u) => /smartrecruiters\.com\/[a-z0-9._-]+/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/smartrecruiters\.com\/([a-z0-9._-]+)/i)),
    fetch: fetchSmartRecruiters,
  },
  {
    name: 'recruitee',
    test: (u) => /[a-z0-9-]+\.recruitee\.com/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/([a-z0-9-]+)\.recruitee\.com/i)),
    fetch: fetchRecruitee,
  },
  {
    name: 'breezy',
    test: (u) => /[a-z0-9-]+\.breezy\.hr/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/([a-z0-9-]+)\.breezy\.hr/i)),
    fetch: fetchBreezy,
  },
  {
    name: 'teamtailor',
    test: (u) => /[a-z0-9-]+\.teamtailor\.com/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/([a-z0-9-]+)\.teamtailor\.com/i)),
    fetch: fetchTeamtailor,
  },
  {
    name: 'bamboohr',
    test: (u) => /[a-z0-9-]+\.bamboohr\.com/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/([a-z0-9-]+)\.bamboohr\.com/i)),
    fetch: fetchBambooHr,
  },
  {
    name: 'personio',
    test: (u) => /[a-z0-9-]+\.jobs\.personio\.(?:com|de)/i.test(u),
    extractSlug: (u) => slugOrNull(u.match(/([a-z0-9-]+)\.jobs\.personio\.(?:com|de)/i)),
    fetch: fetchPersonio,
  },
  {
    name: 'workday',
    // Tenant/wd-number/site all live in the URL itself, so extractSlug packs
    // them into one delimited string — atsSlugMatchesCompany and safeAts
    // both treat the slug as an opaque string, so this needs no changes
    // downstream; fetchWorkday just splits it back apart.
    test: (u) => /[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[a-z0-9_-]+/i.test(u),
    extractSlug: (u) => {
      const m = u.match(/([a-z0-9-]+)\.wd(\d+)\.myworkdayjobs\.com\/([a-z0-9_-]+)/i);
      return m ? `${m[1]}|${m[2]}|${m[3]}` : null;
    },
    fetch: fetchWorkday,
  },
];

async function findJobsForCompany(company, { external = true } = {}) {
  const { findExternalBoardJobs, isExternalJobSearchEnabled } = require('./jobBoardSearchService');

  const websitePromise = findWebsiteJobs(company);
  const externalPromise = (external && isExternalJobSearchEnabled())
    ? findExternalBoardJobs(company)
    : Promise.resolve([]);

  const [websiteJobs, externalJobs] = await Promise.all([websitePromise, externalPromise]);
  // Prefer the company's own careers page / ATS — never mix in Seek/Indeed when
  // we already found real listings on their site.
  if (websiteJobs.length > 0) return websiteJobs;
  return externalJobs;
}

async function findWebsiteJobs(company) {
  const candidateUrls = [];
  if (company.careers_url) candidateUrls.push(company.careers_url);
  if (company.website) candidateUrls.push(company.website);

  // 1) Check the URLs themselves for ATS hosting.
  for (const url of candidateUrls) {
    const match = matchAts(url);
    if (match) {
      const slug = match.extractSlug(url);
      if (slug && !atsSlugMatchesCompany(slug, company)) continue;
      if (slug) {
        const jobs = await safeAts(match, slug);
        if (jobs && jobs.length) return tag(jobs, match.name);
      }
    }
  }

  // 2) Deep-scrape the careers page (ATS links, JSON-LD, cards, inline prose).
  if (company.careers_url) {
    const html = await fetchHtml(company.careers_url);
    if (html) {
      const jobs = await scrapeHtmlForJobs(html, company.careers_url, company);
      if (jobs.length) return jobs;
    }
  }

  // 3) Many agencies embed hiring copy or ATS links only on the home page.
  if (company.website) {
    const homeHtml = await fetchHtml(company.website);
    if (homeHtml) {
      const jobs = await scrapeHtmlForJobs(homeHtml, company.website, company);
      if (jobs.length) return jobs;
    }
  }

  return [];
}

function mergeJobLists(primary, secondary) {
  const byTitle = new Map();
  const byUrl = new Set();
  for (const j of [...(primary || []), ...(secondary || [])]) {
    if (!j?.title) continue;
    const titleKey = j.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const urlKey = (j.url || '').split('?')[0].toLowerCase();
    if (urlKey && byUrl.has(urlKey)) continue;
    if (byTitle.has(titleKey)) continue;
    if (urlKey) byUrl.add(urlKey);
    byTitle.set(titleKey, j);
  }
  return [...byTitle.values()].slice(0, 25);
}

// One page of a paginated careers listing is easy to mistake for the whole
// board (e.g. a WordPress/Webflow site showing "20 of 60 roles"). Following
// a single next-page link at least catches the common 2-page case without
// risking a runaway crawl — capped at MAX_PAGINATION_HOPS regardless of how
// many "next" links a site chains together.
const MAX_PAGINATION_HOPS = 1;

const NEXT_PAGE_TEXT_RE = /^(next|older( (jobs|roles|posts))?|more (jobs|roles)|load more|»|›|>)$/i;

function findNextPageUrl($, baseUrl) {
  const relNext = $('a[rel~="next"]').first().attr('href');
  if (relNext) return absolutize(relNext, baseUrl);

  let found = null;
  $('a[href]').each((_, a) => {
    const $a = $(a);
    const text = ($a.text() || '').replace(/\s+/g, ' ').trim();
    if (NEXT_PAGE_TEXT_RE.test(text)) {
      found = absolutize($a.attr('href'), baseUrl);
      return false;
    }
  });
  return found;
}

async function scrapeHtmlForJobs(html, baseUrl, company, depth = 0) {
  const jsonLdJobs = filterPlausibleJobs(extractJsonLdJobs(html, baseUrl), baseUrl);
  if (jsonLdJobs.length) return tag(jsonLdJobs, 'json-ld');

  const jobAdderJobs = await fetchJobAdderFromHtml(html, baseUrl);
  if (jobAdderJobs.length) return tag(jobAdderJobs, 'jobadder');

  const $ = cheerio.load(html);
  const links = [];
  $('a[href]').each((_, a) => links.push($(a).attr('href') || ''));
  for (const link of links) {
    const abs = absolutize(link, baseUrl);
    if (!abs) continue;
    const match = matchAts(abs);
    if (match) {
      const slug = match.extractSlug(abs);
      if (slug && company && !atsSlugMatchesCompany(slug, company)) continue;
      if (slug) {
        const jobs = await safeAts(match, slug);
        if (jobs && jobs.length) return tag(jobs, match.name);
      }
    }
  }

  const scraped = filterPlausibleJobs(scrapeCareersHtml($, baseUrl), baseUrl);
  const cards = scraped.length ? [] : filterPlausibleJobs(scrapeJobCards($, baseUrl), baseUrl);
  const listed = scraped.length ? scraped : cards;

  if (listed.length) {
    const merged = await withNextPage(listed, $, baseUrl, company, depth);
    return tag(merged, 'careers-page');
  }

  const prose = filterPlausibleJobs(extractProseJobs($, baseUrl), baseUrl);
  if (prose.length) return tag(prose, 'careers-page');

  return [];
}

async function withNextPage(jobs, $, baseUrl, company, depth) {
  if (depth >= MAX_PAGINATION_HOPS) return jobs;
  const nextUrl = findNextPageUrl($, baseUrl);
  if (!nextUrl || nextUrl === baseUrl || !sameHostname(nextUrl, baseUrl)) return jobs;

  const nextHtml = await fetchHtml(nextUrl);
  if (!nextHtml) return jobs;

  const nextJobs = await scrapeHtmlForJobs(nextHtml, nextUrl, company, depth + 1);
  return mergeJobLists(jobs, nextJobs);
}

function sameHostname(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); }
  catch { return false; }
}

function matchAts(url) {
  if (!url) return null;
  return ATS_PATTERNS.find(p => p.test(url));
}

async function safeAts(pattern, slug) {
  try { return await pattern.fetch(slug); }
  catch (err) {
    console.warn(`[${pattern.name}] fetch failed for ${slug}:`, err.message);
    return [];
  }
}

function tag(jobs, source) {
  return jobs.map(j => ({ ...j, source }));
}

// --- JobAdder embedded widget (e.g. Compare Club) -------------------------
// Many AU companies render careers via apps.jobadder.com — jobs only appear
// after JavaScript runs, so static HTML scraping returns nothing.

const JOBADDER_KEY_RE = /_jaJobsSettings\s*=\s*\{[^}]*\bkey\s*:\s*["']([A-Za-z0-9_]+)["']/;
const JOBADDER_KEY_INLINE_RE = /\bkey\s*:\s*["']([A-Za-z0-9_]+)["']/;

async function fetchJobAdderFromHtml(html, careersUrl) {
  const key = await findJobAdderWidgetKey(html, careersUrl);
  if (!key) return [];
  return fetchJobAdderJobs(key, careersUrl);
}

async function findJobAdderWidgetKey(html, baseUrl) {
  if (!html) return null;
  let m = html.match(JOBADDER_KEY_RE);
  if (m) return m[1];

  const shouldScanScripts = /ja-jobs-widget|jobadder|_jaJobsSettings/i.test(html);
  if (!shouldScanScripts) return null;

  const scripts = [...html.matchAll(/(?:src|href)=["']([^"']*\/_nuxt\/[^"']+\.js)["']/gi)]
    .map((x) => x[1]);
  const unique = [...new Set(scripts)];
  const prioritized = [
    ...unique.filter((s) => /career|job|ja-jobs/i.test(s)),
    ...unique.filter((s) => !/career|job|ja-jobs/i.test(s)),
  ];
  for (const src of prioritized.slice(0, 60)) {
    const js = await fetchHtml(absolutize(src, baseUrl));
    if (!js || !js.includes('_jaJobsSettings')) continue;
    m = js.match(JOBADDER_KEY_RE) || js.match(JOBADDER_KEY_INLINE_RE);
    if (m) return m[1];
  }
  return null;
}

function parseJobAdderJsonp(body) {
  const raw = String(body || '').trim();
  const m = raw.match(/^[a-zA-Z_$][\w$]*\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return raw;
  try { return JSON.parse(m[1]); } catch { return m[1]; }
}

async function fetchJobAdderJobs(widgetKey, careersUrl) {
  try {
    const resp = await axios.get('https://apps.jobadder.com/widgets/V1/Jobs/RenderJobList', {
      timeout: TIMEOUT,
      params: {
        key: widgetKey,
        jobsPerPage: 50,
        titleIsLink: true,
        showDatePosted: true,
        showClassifications: true,
        renderPoweredByJobAdder: false,
        callback: 'cb',
      },
      headers: { 'User-Agent': UA, Accept: '*/*' },
      transformResponse: [(data) => parseJobAdderJsonp(data)],
    });
    const html = typeof resp.data === 'string' ? resp.data : '';
    if (!html || !/ja-job-list|class="job"/i.test(html)) return [];

    const $ = cheerio.load(html);
    const jobs = [];
    const seen = new Set();
    const base = (careersUrl || '').replace(/\/+$/, '');

    $('.ja-job-list .job, .ja-job-list-container .job').each((_, el) => {
      const $el = $(el);
      const $link = $el.find('a[data-job-id], h2.title a, h2 a').first();
      const jobId = ($link.attr('data-job-id') || '').trim();
      const title = ($link.attr('title') || $link.text() || '').replace(/\s+/g, ' ').trim();
      if (!title || title.length < 4) return;

      const key = title.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      const classes = $el.find('.classifications li, .meta li')
        .map((__, li) => $(li).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean);
      const location = classes.find((c) =>
        /\b(sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|remote|australia)\b/i.test(c) ||
        /\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/.test(c),
      ) || '';
      const jobType = classes.find((c) =>
        /permanent|contract|full.?time|part.?time|temp/i.test(c),
      ) || '';
      const summary = $el.find('.summary').text().replace(/\s+/g, ' ').trim();
      const posted = $el.find('.date-posted').text().replace(/\s+/g, ' ').trim();

      const url = jobId && base
        ? `${base}${base.includes('?') ? '&' : '?'}ja-job=${jobId}`
        : base || careersUrl;

      jobs.push({
        title,
        url,
        location,
        job_type: jobType,
        salary: '',
        description: snippet(summary),
        posted_at: posted ? Date.parse(posted) || null : null,
      });
    });

    return jobs.slice(0, 25);
  } catch (err) {
    console.warn('[jobadder] fetch failed:', err.message);
    return [];
  }
}

// --- ATS adapters ---------------------------------------------------------

async function fetchGreenhouse(slug) {
  // ?content=true returns the full HTML job description; we strip it to a
  // short plain-text snippet for the UI.
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA } });
  return (resp.data?.jobs || []).map(j => {
    const location = j.location?.name || '';
    return {
      title: j.title,
      location,
      url: j.absolute_url,
      job_type: '',
      salary: '',
      department: (j.departments || []).map(d => d.name).join(' / '),
      description: snippet(stripHtml(decodeHtmlEntities(j.content || ''))),
      posted_at: toMs(j.updated_at || j.first_published),
      closes_at: null,
      remote: isRemoteText(location),
    };
  });
}

async function fetchLever(slug) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA } });
  return (Array.isArray(resp.data) ? resp.data : []).map(j => {
    const c = j.categories || {};
    const sr = j.salaryRange || {};
    return {
      title: j.text,
      location: c.location || '',
      url: j.hostedUrl,
      job_type: c.commitment || '',
      salary: formatSalaryRange(sr.min, sr.max, sr.currency, sr.interval),
      department: c.department || c.team || '',
      description: snippet(j.descriptionPlain || stripHtml(j.description || '')),
      posted_at: toMs(j.createdAt),
      closes_at: null,
      remote: /remote/i.test(c.allLocations?.join(' ') || c.location || c.commitment || ''),
    };
  });
}

function mapWorkableJob(j, slug) {
  const loc = [j.city, j.region, j.country].filter(Boolean).join(', ');
  const sal = j.salary || {};
  return {
    title: j.title,
    location: loc,
    url: `https://apply.workable.com/${slug}/j/${j.shortcode}/`,
    job_type: j.employment_type || '',
    salary: formatSalaryRange(sal.salary_from, sal.salary_to, sal.salary_currency, 'year'),
    department: j.department || '',
    description: snippet(stripHtml(j.description || '')),
    posted_at: toMs(j.created_at || j.published_on),
    closes_at: null,
    remote: !!(j.remote || j.telecommuting || isRemoteText(loc)),
  };
}

// Workable's own board UI paginates past ~50 results, but the API silently
// returns only its first page unless offset/limit are set explicitly —
// looping here is the difference between "we saw 50 roles" and "we saw all
// of them" for any account with a bigger board. Capped at MAX_ATS_PAGE_JOBS
// so one huge account can't turn a single scrape into a slow API hammering.
async function fetchWorkable(slug) {
  const url = `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`;
  const pageSize = 50;
  const all = [];
  for (let offset = 0; offset < MAX_ATS_PAGE_JOBS; offset += pageSize) {
    const resp = await axios.post(url, {
      query: '', location: {}, department: [], workplace: [], remote: [], limit: pageSize, offset,
    }, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    });
    const page = resp.data?.results || [];
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all.map(j => mapWorkableJob(j, slug));
}

async function fetchAshby(slug) {
  const url = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams';
  const body = {
    operationName: 'ApiJobBoardWithTeams',
    variables: { organizationHostedJobsPageName: slug },
    query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
      jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
        jobPostings {
          id title locationName employmentType jobUrl
          teamName departmentName
          publishedDate applicationDeadline
          isRemote compensationTierSummary
        }
      }
    }`,
  };
  const resp = await axios.post(url, body, {
    timeout: TIMEOUT,
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
  });
  const postings = resp.data?.data?.jobBoard?.jobPostings || [];
  return postings.map(j => ({
    title: j.title,
    location: j.locationName || '',
    url: j.jobUrl,
    job_type: j.employmentType || '',
    salary: j.compensationTierSummary || '',
    department: j.departmentName || j.teamName || '',
    description: '',
    posted_at: toMs(j.publishedDate),
    closes_at: toMs(j.applicationDeadline),
    remote: !!j.isRemote || isRemoteText(j.locationName),
  }));
}

function mapSmartRecruitersJobs(data, slug) {
  return (data?.content || []).map(j => {
    const loc = j.location || {};
    const location = [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    return {
      title: j.name,
      location,
      url: j.actions?.apply?.url || `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
      job_type: j.typeOfEmployment?.label || '',
      salary: '',
      department: j.department?.label || j.function?.label || '',
      description: '',
      posted_at: toMs(j.releasedDate),
      closes_at: null,
      remote: !!loc.remote || isRemoteText(location),
    };
  });
}

async function fetchSmartRecruiters(slug) {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`;
  const pageSize = 100;
  const all = [];
  let totalFound = Infinity;
  for (let offset = 0; offset < Math.min(totalFound, MAX_ATS_PAGE_JOBS); offset += pageSize) {
    const resp = await axios.get(url, {
      timeout: TIMEOUT, headers: { 'User-Agent': UA }, params: { limit: pageSize, offset },
    });
    const page = resp.data?.content || [];
    totalFound = resp.data?.totalFound ?? page.length;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return mapSmartRecruitersJobs({ content: all }, slug);
}

function mapRecruiteeJobs(data) {
  return (data?.offers || []).map(j => {
    const location = [j.city, j.country].filter(Boolean).join(', ');
    return {
      title: j.title,
      location,
      url: j.careers_url || j.careers_apply_url || '',
      job_type: j.employment_type_code || '',
      salary: '',
      department: j.department || '',
      description: snippet(stripHtml(j.description || '')),
      posted_at: toMs(j.created_at || j.published_at),
      closes_at: null,
      remote: !!j.remote || isRemoteText(location),
    };
  });
}

async function fetchRecruitee(slug) {
  const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA } });
  return mapRecruiteeJobs(resp.data);
}

function mapBreezyJobs(data) {
  return (Array.isArray(data) ? data : []).map(j => {
    const location = j.location?.name || '';
    return {
      title: j.name,
      location,
      url: j.url || '',
      job_type: j.type || '',
      salary: '',
      department: typeof j.department === 'string' ? j.department : (j.department?.name || ''),
      description: '',
      posted_at: toMs(j.published_date),
      closes_at: null,
      remote: isRemoteText(location) || isRemoteText(j.type),
    };
  });
}

async function fetchBreezy(slug) {
  const url = `https://${encodeURIComponent(slug)}.breezy.hr/json`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA } });
  return mapBreezyJobs(resp.data);
}

function mapTeamtailorJobs(data) {
  return (data?.jobs || []).map(j => {
    const location = Array.isArray(j.regions) ? j.regions.join(', ') : (j.regions || '');
    return {
      title: j.title,
      location,
      url: j['apply-url'] || j.url || '',
      job_type: j.role || '',
      salary: '',
      department: j.department || '',
      description: snippet(stripHtml(j.body || '')),
      posted_at: toMs(j['created-at'] || j.created_at),
      closes_at: null,
      remote: !!j.remote || isRemoteText(location),
    };
  });
}

async function fetchTeamtailor(slug) {
  const url = `https://${encodeURIComponent(slug)}.teamtailor.com/jobs.json`;
  const pageSize = 50;
  const all = [];
  for (let page = 1; all.length < MAX_ATS_PAGE_JOBS; page++) {
    const resp = await axios.get(url, {
      timeout: TIMEOUT, headers: { 'User-Agent': UA },
      params: { 'page[number]': page, 'page[size]': pageSize },
    });
    const jobs = resp.data?.jobs || [];
    all.push(...jobs);
    if (jobs.length < pageSize) break;
  }
  return mapTeamtailorJobs({ jobs: all });
}

function mapBambooHrJobs(data, slug) {
  return (data?.result || []).map(j => {
    const loc = j.location || {};
    const location = [loc.city, loc.state, loc.country].filter(Boolean).join(', ');
    return {
      title: j.jobOpeningName,
      location,
      url: `https://${slug}.bamboohr.com/careers/${j.id}`,
      job_type: j.employmentStatusLabel || '',
      salary: '',
      department: j.departmentLabel || '',
      description: '',
      posted_at: null,
      closes_at: null,
      remote: !!loc.isRemote || isRemoteText(location),
    };
  });
}

async function fetchBambooHr(slug) {
  const url = `https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  return mapBambooHrJobs(resp.data, slug);
}

function mapPersonioJobs(xml, slug) {
  if (!xml) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const jobs = [];
  $('position').each((_, el) => {
    const $el = $(el);
    const id = $el.find('id').first().text().trim();
    const title = $el.find('name').first().text().trim();
    if (!title) return;
    const office = $el.find('office').first().text().trim();
    jobs.push({
      title,
      location: office,
      url: id ? `https://${slug}.jobs.personio.de/job/${id}` : `https://${slug}.jobs.personio.de/`,
      job_type: $el.find('employmenttype').first().text().trim() || '',
      salary: '',
      department: $el.find('department').first().text().trim() || '',
      description: '',
      posted_at: toMs($el.find('createdat').first().text().trim()),
      closes_at: null,
      remote: isRemoteText(office),
    });
  });
  return jobs;
}

// Personio's public feed is XML, not JSON — https://{slug}.jobs.personio.{de,com}/xml
// is the documented public job feed, no auth required.
async function fetchPersonio(slug) {
  const url = `https://${encodeURIComponent(slug)}.jobs.personio.de/xml`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: { 'User-Agent': UA } });
  const xml = typeof resp.data === 'string' ? resp.data : '';
  return mapPersonioJobs(xml, slug);
}

function mapWorkdayJobs(data, { base, site }) {
  return (data?.jobPostings || []).map(j => ({
    title: j.title,
    location: j.locationsText || '',
    url: j.externalPath ? `${base}/${site}${j.externalPath}` : base,
    job_type: '',
    salary: '',
    department: '',
    description: '',
    // Workday's CXS response only gives a relative string ("Posted 3 Days
    // Ago"), not a parseable date — leaving this null avoids a wrong
    // freshness score rather than guessing at one.
    posted_at: null,
    closes_at: null,
    remote: isRemoteText(j.locationsText),
  }));
}

async function fetchWorkday(compositeSlug) {
  const [tenant, wdNum, site] = String(compositeSlug || '').split('|');
  if (!tenant || !wdNum || !site) return [];
  const base = `https://${tenant}.wd${wdNum}.myworkdayjobs.com`;
  const url = `${base}/wday/cxs/${tenant}/${site}/jobs`;
  const pageSize = 20;
  const all = [];
  let total = Infinity;
  for (let offset = 0; offset < Math.min(total, MAX_ATS_PAGE_JOBS); offset += pageSize) {
    const resp = await axios.post(url, { appliedFacets: {}, limit: pageSize, offset, searchText: '' }, {
      timeout: TIMEOUT,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    });
    const page = resp.data?.jobPostings || [];
    total = resp.data?.total ?? page.length;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return mapWorkdayJobs({ jobPostings: all }, { base, site });
}

// --- generic careers-page scraping fallback -------------------------------

// Words that strongly indicate an anchor / heading is a real job title.
const JOB_TITLE_WORDS = /\b(developer|engineer|designer|manager|lead|architect|analyst|scientist|consultant|specialist|director|intern|coordinator|producer|writer|editor|recruiter|strategist|associate|assistant|advisor|operator|administrator|officer|technician|marketer|copywriter|illustrator|animator|artist|programmer|founder|head of|vp of|chief)\b/i;

const ROLE_NOUN = /\b(designer|developer|engineer|manager|analyst|specialist|coordinator|director|architect|consultant|strategist|writer|producer|officer|administrator|technician|marketer|recruiter|partner|programmer|scientist|advisor|assistant|executive|editor|copywriter|illustrator|animator)\b/i;

const HIRING_BLOCK = /(?:we'?re hiring|currently looking for|now hiring|open (?:roles?|positions?)|join (?:our|the) team|positions? available|roles? available|vacancies|think you might have|looking for a|seeking a|hiring a|roles? we(?:'re| are)|recruit for)/i;

// Common non-job link text we want to throw away.
const JUNK_TEXT = /^(careers?|jobs?|apply|apply now|open positions?|career opportunit(y|ies)|job opportunit(y|ies)|(current |latest )?(open(ings?)?|opportunit(y|ies)|vacancies|vacancy|positions?|roles?)|work (with|for) us|join (our team|the team|us)|view (all )?jobs?|view (all )?roles?|see (all )?jobs?|browse (all )?(jobs|roles|positions)|all (jobs|roles|positions)|home|about|contact|english|español|français|deutsch|italiano|português|globally?|brazil|argentina|canada|chile|colombia|mexico|spain|france|germany|italy|usa|united kingdom|australia|new zealand)$/i;

// Generic call-to-action link text that is NOT a real job title. Catches the
// "Apply at Greenhouse" / "Apply on Lever" / "View on Seek" hallucination where
// an ATS link's anchor text gets scraped as if it were a role.
const CTA_TEXT_RE = /^(apply|view|see|open|read|learn|find out|explore|browse|check|click|go|join|start|register|sign\s*up|submit|get\s+started)\b.*\b(now|here|more|job|jobs|role|roles|position|positions|posting|application|greenhouse|lever|workable|ashby|seek|indeed|linkedin|breezy|smartrecruiters|workday|us|team|details?)\b|^(apply|view|see|open|read more|learn more|find out more|view details?|view job|view role|view posting|apply now|apply here|join (us|our team))$/i;

// Careers-page "about the company" links that are easy to mistake for a job
// title because they're short and title-cased, e.g. "Life at CommBank",
// "Careers at ANZ", "Working at Google", "Meet the Team", "Our Culture",
// "Why Work Here". These come up constantly on large companies' careers
// pages (linking to a culture/benefits page, not an actual opening) and
// nothing above catches them since they contain no role noun and pass the
// title-case check.
const CULTURE_PAGE_RE = /^(life at|careers? at|working at|culture at|about (us|our|the)|our story|why work|meet (the|our)|our culture|our values|our mission|our people|who we are|behind the scenes|day in the life|graduate program(me)?s?|early careers?)\b/i;

function isCtaLinkText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (CTA_TEXT_RE.test(t)) return true;
  // "Apply at <Company/ATS>", "Apply on <ATS>", "Apply via <ATS>"
  if (/^apply\s+(at|on|via|with|through|using)\b/i.test(t)) return true;
  return false;
}

// Broad, multi-industry role vocabulary so the positive title gate works for
// tech, trades, hospitality, healthcare, retail, finance, etc. — not just dev.
// Deliberately excludes bare department/domain nouns like "sales", "support",
// "engineering", "finance", "legal", "operations", "hr" — verified live
// against Commonwealth Bank and ANZ's real careers pages, where division
// landing pages ("Engineering", "Support Hub", "Guidance & Support
// Services") matched these just as easily as an actual job title did. A
// real compound title using one of those words (e.g. "Support Engineer",
// "Sales Manager", "Legal Counsel") still matches via the specific role
// noun paired with it.
const ROLE_NOUN_ANY = /\b(developer|engineer|designer|manager|lead|architect|analyst|scientist|consultant|specialist|director|intern|coordinator|producer|writer|editor|recruiter|strategist|associate|assistant|advis[eo]r|operator|administrator|officer|technician|marketer|copywriter|illustrator|animator|artist|programmer|founder|chief|president|supervisor|agent|representative|rep|executive|clerk|cashier|barista|bartender|chef|cook|waiter|waitress|server|baker|cleaner|driver|courier|rider|nurse|doctor|physician|therapist|teacher|tutor|trainer|instructor|lecturer|electrician|plumber|carpenter|mechanic|technologist|accountant|bookkeeper|paralegal|solicitor|lawyer|attorney|counsel|receptionist|secretary|stylist|barber|labourer|laborer|welder|fitter|installer|estimator|surveyor|planner|buyer|merchandiser|controller|auditor|teller|underwriter|broker|trader|pharmacist|dentist|hygienist|physiotherapist|optometrist|radiographer|paramedic|carer|caregiver|gardener|landscaper|painter|roofer|plasterer|tiler|machinist|foreman|apprentice|graduate|trainee|partner|principal|nanny|housekeeper|concierge|guard|dispatcher|picker|packer|forklift|storeperson|sre|customer success)\b/i;

const SENTENCE_STOPWORDS = /\b(we|our|us|you|your|let'?s|come|why|how|what|discover|explore|learn|please|click|here|today|now|the best|world['’]s|leading|trusted|award|passionate about)\b/i;

// Positive gate: does this anchor/heading text actually look like a job title?
// Conservative — when unsure we drop it (zero fake jobs beats one hallucination).
function looksLikeJobTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 3 || t.length > 90) return false;
  if (JUNK_TEXT.test(t)) return false;
  if (CULTURE_PAGE_RE.test(t)) return false;
  if (isCtaLinkText(t)) return false;
  if (/[.?!]$/.test(t)) return false;          // sentences / questions
  if (/^\d/.test(t)) return false;             // dates / numbers
  const words = t.split(/\s+/);
  if (words.length > 9) return false;          // marketing copy, not a title

  // Require a recognised role noun. This used to also accept any short,
  // mostly-Title-Cased phrase with no role noun (e.g. to catch "Customer
  // Success", which is already covered by ROLE_NOUN_ANY directly) — but on
  // real corporate careers pages that fallback matched constantly: section
  // links like "Support Hub", "Business Banking", "CommBank India", or
  // "Belonging at ANZ" are exactly as title-cased and exactly as short as a
  // real job title, and there were far more of them than real postings.
  // Verified against Commonwealth Bank and ANZ's actual careers pages, which
  // is why the role-noun list below is broad — it needs to cover retail,
  // trades, healthcare and hospitality roles too, not just tech.
  if (!ROLE_NOUN_ANY.test(t)) return false;
  // ...unless it's clearly a conversational sentence wrapped around one.
  if (SENTENCE_STOPWORDS.test(t) && words.length > 5) return false;
  return true;
}

function findApplyUrl($, $el, baseUrl) {
  const container = $el.closest('section, article, main, [class*="hire"], [class*="career"], [class*="job"]').first();
  const scope = container.length ? container : $el.parent();
  let found = baseUrl;
  scope.find('a[href]').each((_, a) => {
    const t = $(a).text().replace(/\s+/g, ' ').trim();
    const h = $(a).attr('href') || '';
    if (/apply|submit|expression of interest|send (your )?cv|get in touch/i.test(t) ||
        /apply|recruit|breezy\.hr|greenhouse|lever\.co|workable|ashby/i.test(h)) {
      found = absolutize(h, baseUrl) || found;
      return false;
    }
  });
  return found;
}

function parseHiringSentence(text) {
  const jobs = [];
  const t = text.replace(/\s+/g, ' ').trim();
  const seg = t.match(
    /(?:looking for|we'?re hiring|now hiring|seeking|open (?:roles?|positions?):|roles?(?: we'?re)?(?: currently)?(?: recruiting for)?(?: include)?)\s+(.+?)(?:\.|Think|Apply|Please note|Click|$)/i,
  );
  if (!seg) return jobs;

  for (const chunk of seg[1].split(/\s+and\s+|\s*,\s*|\s*&\s*/i)) {
    let part = chunk.replace(/^(?:a|an)\s+/i, '').trim();
    if (part.length < 8 || part.length > 100) continue;
    const m = part.match(/^(.+?)\s*(\([^)]{3,70}\))?\s*$/);
    if (!m) continue;
    const title = m[1].trim();
    const detail = (m[2] || '').replace(/[()]/g, '').trim();
    if (!ROLE_NOUN.test(title)) continue;
    if (/^(?:our|the|these|those|various|multiple|great|good)\b/i.test(title)) continue;
    jobs.push({ title, job_type: detail });
  }
  return jobs;
}

// Many agencies (e.g. Luminary) list open roles inline on their careers page:
// "We're currently looking for a Senior UX Designer (6 month contract) and …"
function extractProseJobs($, baseUrl) {
  const jobs = [];
  const seen = new Set();

  $('p, li, h2, h3, h4, td, blockquote, [class*="hire"], [class*="career"], [class*="job"], [class*="vacancy"]').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 25 || text.length > 1200) return;
    if (!HIRING_BLOCK.test(text)) return;

    const applyUrl = findApplyUrl($, $el, baseUrl);

    for (const parsed of parseHiringSentence(text)) {
      const key = parsed.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        title: parsed.title,
        url: applyUrl || baseUrl,
        location: '',
        job_type: parsed.job_type || '',
        salary: '',
        description: parsed.job_type || snippet(text, 180),
      });
    }
  });

  return jobs.slice(0, 25);
}

function scrapeCareersHtml($, baseUrl) {
  const jobs = [];
  const seen = new Set();

  // Look for anchors that link to a specific job: the href must have a slug
  // *after* one of the job/career path segments (e.g. /jobs/senior-engineer).
  // A bare /careers/ link is the careers page itself, not a job.
  $('a[href]').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').trim();
    const text = ($a.text() || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6 || text.length > 110) return;

    const looksLikeJobUrl = /\/(jobs?|careers?|positions?|roles?|openings?|vacancies?)\/[a-z0-9][a-z0-9\-_/]+/i.test(href);
    if (!looksLikeJobUrl) return;
    // Skip locale paths like /en-au/careers/ where the slug is just a country.
    if (/\/(careers?|jobs?)\/[a-z]{2}([-_][a-z]{2})?\/?$/i.test(href)) return;
    // Skip "about the company" content pages that happen to live under
    // /careers/ (e.g. /careers/commbank-life.html, /careers/our-culture) —
    // these have a job-shaped URL but are not a job.
    if (/\/(careers?|jobs?)\/[a-z0-9-]*(life|culture|story|about|diversity|benefits|values|why-work|our-people|behind-the-scenes)[a-z0-9-]*(\.html?)?\/?$/i.test(href)) return;

    // Positive gate: the link text must actually look like a role title.
    // A job-like URL alone is not enough — anchors such as "Apply at
    // Greenhouse" or "Career Opportunities" point at job URLs but are not
    // titles. We'd rather show zero jobs than a fabricated one.
    if (!looksLikeJobTitle(text)) return;

    const abs = absolutize(href, baseUrl) || href;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ title: text, url: abs, location: '', job_type: '', salary: '' });
  });

  // We intentionally do NOT fall back to harvesting headings or list items.
  // In practice that produces too many false positives (section headers,
  // benefit list items, marketing copy) that look enough like job titles to
  // fool a regex. Showing zero jobs + the careers URL is more honest than
  // showing fake jobs.

  return jobs.slice(0, 25);
}

// Pull JobPosting entries from JSON-LD (schema.org) blocks — many modern
// careers pages embed these even when they don't use a public ATS API.
function extractJsonLdJobs(html, baseUrl) {
  const jobs = [];
  const seen = new Set();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      collectJobPostings(parsed, baseUrl, jobs, seen);
    } catch {}
  }
  return jobs.slice(0, 25);
}

function collectJobPostings(node, baseUrl, out, seen) {
  if (!node) return;
  if (Array.isArray(node)) {
    node.forEach(n => collectJobPostings(n, baseUrl, out, seen));
    return;
  }
  if (typeof node !== 'object') return;

  const type = node['@type'];
  const types = Array.isArray(type) ? type : [type];
  if (types.some(t => t === 'JobPosting')) {
    const title = (node.title || node.name || '').trim();
    if (title && title.length >= 4 && !seen.has(title.toLowerCase())) {
      seen.add(title.toLowerCase());
      out.push({
        title,
        url: absolutize(node.url || node.sameAs || '', baseUrl) || baseUrl,
        location: node.jobLocation?.address?.addressLocality ||
          node.jobLocation?.name ||
          (typeof node.jobLocation === 'string' ? node.jobLocation : '') ||
          '',
        job_type: node.employmentType || '',
        salary: node.baseSalary?.value?.value
          ? String(node.baseSalary.value.value)
          : '',
        description: snippet(stripHtml(node.description || ''), 280),
        posted_at: toMs(node.datePosted),
        closes_at: toMs(node.validThrough),
        remote: isRemoteText(node.jobLocationType) || isRemoteText(node.description),
      });
    }
  }

  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') collectJobPostings(v, baseUrl, out, seen);
  }
}

// WordPress / Webflow job cards: anchors inside listing containers only —
// never bare [class*="job"] (matches marketing .job-title case-study labels).
function scrapeJobCards($, baseUrl) {
  const jobs = [];
  const seen = new Set();

  $('a[href]').each((_, a) => {
    const $a = $(a);
    const href = ($a.attr('href') || '').trim();
    if (!href || href === '#' || /^javascript:/i.test(href)) return;

    // Skip testimonial / case-study / carousel role labels (e.g. orbital8.com.au).
    if ($a.closest('.job-title, [class*="testimonial"], [class*="case-study"], [class*="case_study"], [class*="carousel"], [class*="slider"], [class*="client-story"]').length) {
      return;
    }

    const inListing = $a.closest(
      '[class*="job-list"], [class*="job-card"], [class*="job-item"], [class*="job-post"], ' +
      '[class*="vacancy"], [class*="opening"], [class*="career-list"], [class*="posting"], ' +
      '[class*="positions-list"], [class*="roles-list"]',
    ).length;
    const hrefLooksJob = /\/(job|jobs|career|careers|position|positions|role|roles|vacancy|opening|apply)\//i.test(href);
    if (!inListing && !hrefLooksJob) return;

    const text = ($a.text() || '').replace(/\s+/g, ' ').trim();
    // A job-shaped href used to be enough on its own even when the text had
    // no role noun in it — that's exactly how division/culture pages like
    // "Life at CommBank" (under /careers/) slipped through here even after
    // scrapeCareersHtml's own text gate was tightened. Always require the
    // link text itself to look like a real title now.
    if (!looksLikeJobTitle(text)) return;

    const abs = absolutize(href, baseUrl) || href;
    if (!isSpecificJobUrl(abs, baseUrl)) return;

    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ title: text, url: abs, location: '', job_type: '', salary: '' });
  });

  return jobs.slice(0, 25);
}

// --- job listing quality filters -------------------------------------------

/** Reject marketing case-study labels scraped as fake "jobs" (e.g. "Director of ProductHR Industry"). */
function isFakeMarketingTitle(title) {
  const compact = String(title || '').replace(/\s+/g, '');
  if (/DirectorofProduct(?:HR|Health|Insurance|Manager)/i.test(compact)) return true;
  if (/HeadofDigital(?:Insurance|Health)/i.test(compact)) return true;
  if (/ProductManager(?:Health|Insurance)/i.test(compact)) return true;
  if (/ManagingDirector(?:Tech|Insurance|Startup)/i.test(compact)) return true;
  // Title immediately followed by industry word with no space
  if (/(?:Director|Manager|Head|Lead|Product)[A-Z][a-z]{3,}(?:Industry|Insurance|Startup|Sector|Tech)/.test(compact)) {
    return true;
  }
  return false;
}

function isSpecificJobUrl(jobUrl, baseUrl) {
  if (!jobUrl) return false;
  try {
    const job = new URL(jobUrl);
    const base = new URL(baseUrl);

    // External ATS / apply links are fine.
    if (job.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) {
      return /greenhouse|lever\.co|workable|ashby|breezy|smartrecruiters|myworkdayjobs|taleo|icims|jobvite|recruitee|teamtailor|bamboohr|personio/i.test(job.hostname);
    }

    const basePath = base.pathname.replace(/\/+$/, '') || '/';
    const jobPath = job.pathname.replace(/\/+$/, '') || '/';
    if (jobPath === '/' || jobPath === basePath) return false;

    // "About the company" pages that live under /careers/ (e.g.
    // /careers/commbank-life.html) have a job-shaped path but aren't a job.
    if (/(life|culture|story|about|diversity|benefits|values|why-work|our-people|behind-the-scenes)/i.test(jobPath)) {
      return false;
    }
    if (/\/(jobs?|careers?|positions?|roles?|openings?|vacancies?|apply|listing|posting)\//i.test(jobPath)) {
      return true;
    }
    if (/\/\d{4,}/.test(jobPath)) return true;
    if (/[?&](job|position|role|posting)=/i.test(job.search)) return true;
    return false;
  } catch {
    return false;
  }
}

function filterPlausibleJobs(jobs, baseUrl) {
  return (jobs || []).filter(j => {
    if (!j?.title || j.title.length < 6 || j.title.length > 120) return false;
    if (isCtaLinkText(j.title)) return false;
    if (isFakeMarketingTitle(j.title)) return false;
    if (!isSpecificJobUrl(j.url, baseUrl)) return false;
    return true;
  });
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await axios.get(url, {
        timeout: TIMEOUT,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      // Only retry transient 5xx/network errors — a 4xx is a real answer.
      if (resp.status >= 500 && attempt === 0) { await delay(300); continue; }
      if (resp.status >= 400) return null;
      return typeof resp.data === 'string' ? resp.data : '';
    } catch {
      if (attempt === 0) { await delay(300); continue; }
      return null;
    }
  }
  return null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function absolutize(href, base) {
  try { return new URL(href, base).toString(); }
  catch { return null; }
}

// --- field helpers --------------------------------------------------------

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
  '&rdquo;': '”', '&ldquo;': '“', '&ndash;': '–', '&mdash;': '—',
};
function decodeHtmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|ndash|mdash|#39);/g, m => HTML_ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function snippet(s, n = 280) {
  if (!s) return '';
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

function isRemoteText(s) {
  return !!s && /\b(remote|anywhere|work from home|wfh)\b/i.test(s);
}

function formatSalaryRange(min, max, currency, interval) {
  if (!min && !max) return '';
  const sym = currencySymbol(currency);
  const fmt = (n) => {
    if (n == null) return '';
    if (n >= 1000) return sym + Math.round(n / 1000) + 'k';
    return sym + n;
  };
  const range = min && max ? `${fmt(min)}–${fmt(max)}` : fmt(min || max);
  const per = interval ? '/' + interval.replace(/ly$/, '').replace(/^per\s+/i, '') : '';
  return range + per;
}

function currencySymbol(c) {
  switch ((c || '').toUpperCase()) {
    case 'USD': return '$';
    case 'AUD': return 'A$';
    case 'CAD': return 'C$';
    case 'GBP': return '£';
    case 'EUR': return '€';
    case 'INR': return '₹';
    case 'JPY': return '¥';
    case 'NZD': return 'NZ$';
    default: return c ? c + ' ' : '$';
  }
}

module.exports = {
  looksLikeJobTitle,
  isCtaLinkText,
  findJobsForCompany,
  findWebsiteJobs,
  mergeJobLists,
  filterPlausibleJobs,
  isFakeMarketingTitle,
  isSpecificJobUrl,
  matchAts,
  mapSmartRecruitersJobs,
  mapRecruiteeJobs,
  mapBreezyJobs,
  mapTeamtailorJobs,
  mapBambooHrJobs,
  mapPersonioJobs,
  mapWorkdayJobs,
};
