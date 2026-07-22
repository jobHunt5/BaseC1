// POST /api/scan
//   body: { south, west, north, east }
//
// FAST PATH: this endpoint now returns the raw places list immediately.
//   - All sync enrichment was moved to the client, which calls
//     /api/companies/:id/enrich with concurrency on its own.
//   - This drops scan time from ~50–60s to ~3–8s (just the time the places
//     provider needs).
//
// The frontend then drives "deep-scanning" against every returned company,
// updating cards as data arrives.

const express = require('express');

const { findPlacesInBounds } = require('../services/placesService');
const {
  upsertCompany, listJobsForCompany, listCompaniesInBounds, jobsGroupedFor, recordScan, getRecentCoveringScan,
} = require('../db');
const { getUserFromRequest } = require('./auth');
const { enqueueMany } = require('../services/deepScanQueue');
const { findAreaJobs, isAreaJobSearchEnabled } = require('../services/areaJobSearchService');
const { rateLimit, byUser } = require('../services/rateLimit');
const { attachProfiles } = require('../services/companyProfileService');

const router = express.Router();

// A map scan fans out to several paid Google Places calls (GOOGLE_GRID x
// GOOGLE_MAX_PAGES) plus queues a deep-scan per company found — by far the
// most expensive endpoint in the app per request. area-jobs hits Serper
// directly. Neither had a cap before, unlike the PDF/send/AI endpoints below.
const scanRateLimit = rateLimit({ max: 20, windowMs: 60 * 60 * 1000, keyFn: byUser });
const areaJobsRateLimit = rateLimit({ max: 30, windowMs: 60 * 60 * 1000, keyFn: byUser });

// Real-world business listings don't change hour to hour — if a Google scan
// already fully covered this area recently, skip the ~480-call worst-case
// Places sweep entirely and serve what's already stored. Marked 'cache' (not
// 'google') in `scans` so a cache hit can never itself extend the freshness
// window for the next lookup.
const PLACES_CACHE_MS = parseInt(process.env.PLACES_SCAN_CACHE_HOURS || '24', 10) * 60 * 60 * 1000;

router.use(async (req, res, next) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (user.suspended) return res.status(403).json({ error: 'Account suspended' });
  req.user = user;
  next();
});

router.post('/', scanRateLimit, async (req, res) => {
  const { south, west, north, east } = req.body || {};
  if ([south, west, north, east].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'south, west, north, east (numbers) required' });
  }
  if (south >= north || west >= east) {
    return res.status(400).json({ error: 'invalid bbox: need south<north and west<east' });
  }

  const bounds = { south, west, north, east };

  const covering = await getRecentCoveringScan(bounds, Date.now() - PLACES_CACHE_MS);
  if (covering) {
    const cached = await listCompaniesInBounds(bounds, req.user.id);
    await recordScan({ ...bounds, provider: 'cache', resultCount: cached.length }, req.user.id);
    const jobsMap = await jobsGroupedFor(cached.map(c => c.id), req.user.id);
    const out = await attachProfiles(cached, jobsMap, req.user.id);
    return res.json({
      provider: 'cache',
      fellBack: false,
      fallbackReason: null,
      bounds,
      count: out.length,
      enriched: 0,
      companies: out,
      areaJobsEnabled: isAreaJobSearchEnabled(),
    });
  }

  let places, provider, fellBack, fallbackReason;
  try {
    ({ places, provider, fellBack, fallbackReason } = await findPlacesInBounds(bounds));
  } catch (err) {
    console.error('[scan] provider failed:', err.message);
    return res.status(502).json({ error: `places provider failed: ${err.message}` });
  }

  await Promise.all(places.map(p => upsertCompany(p)));
  await recordScan({ ...bounds, provider, resultCount: places.length }, req.user.id);

  // Queue background deep scans (website, jobs, LinkedIn) for companies with
  // websites — admin-tunable (Settings → Deep-scan coverage), read live so
  // a change takes effect on the very next scan, no restart needed.
  const withSites = places.filter(p => p.website).map(p => p.id);
  const deepScanCap = parseInt(process.env.DEEP_SCAN_MAX_COMPANIES || '80', 10);
  if (withSites.length) enqueueMany(withSites.slice(0, deepScanCap));

  // Re-fetch hydrated (companies already upserted above) so each result
  // carries this user's own status/notes/rating, not the raw provider row.
  const hydratedById = new Map((await listCompaniesInBounds(bounds, req.user.id)).map(c => [c.id, c]));
  const jobsMap = await jobsGroupedFor(places.map(p => p.id), req.user.id);
  const out = await attachProfiles(places.map(p => hydratedById.get(p.id) || p), jobsMap, req.user.id);
  res.json({
    provider,
    fellBack,
    fallbackReason,
    bounds,
    count: out.length,
    enriched: 0, // legacy field; frontend doesn't rely on this anymore
    companies: out,
    areaJobsEnabled: isAreaJobSearchEnabled(),
  });
});

// Area-wide job-board search — catches roles whose employer was NOT discovered
// in the Places sweep. Separate endpoint so the map scan stays fast.
//   POST /api/scan/area-jobs  body: { south, west, north, east, terms? }
//   terms: a string, or an array of role terms (e.g. one per selected
//   industry) — capped to 4 so a user with many industries picked can't
//   blow up Serper usage on a single area scan (4 terms x 4 boards = 16
//   queries, on top of the 4 baseline "just show me jobs here" queries).
router.post('/area-jobs', areaJobsRateLimit, async (req, res) => {
  const { south, west, north, east, terms } = req.body || {};
  if ([south, west, north, east].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'south, west, north, east (numbers) required' });
  }
  if (!isAreaJobSearchEnabled()) {
    return res.json({ enabled: false, jobs: [], suburb: '', count: 0 });
  }
  const cleanTerms = (Array.isArray(terms) ? terms : [terms])
    .map(t => String(t || '').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 4);
  try {
    const result = await findAreaJobs({ south, west, north, east }, { terms: cleanTerms });
    res.json({ ...result, count: result.jobs.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
