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

const { findPlacesInBounds, getProvider } = require('../services/placesService');
const { upsertCompany, listJobsForCompany, jobsGroupedFor, recordScan } = require('../db');
const { enqueueMany } = require('../services/deepScanQueue');
const { findAreaJobs, isAreaJobSearchEnabled } = require('../services/areaJobSearchService');

const router = express.Router();

router.post('/', async (req, res) => {
  const { south, west, north, east } = req.body || {};
  if ([south, west, north, east].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'south, west, north, east (numbers) required' });
  }
  if (south >= north || west >= east) {
    return res.status(400).json({ error: 'invalid bbox: need south<north and west<east' });
  }

  const bounds = { south, west, north, east };
  const provider = getProvider();

  let places = [];
  try {
    places = await findPlacesInBounds(bounds);
  } catch (err) {
    console.error('[scan] provider failed:', err.message);
    return res.status(502).json({ error: `places provider failed: ${err.message}` });
  }

  for (const p of places) upsertCompany(p);
  recordScan({ ...bounds, provider, resultCount: places.length });

  // Queue background deep scans (website, jobs, LinkedIn) for companies with websites.
  const withSites = places.filter(p => p.website).map(p => p.id);
  if (withSites.length) enqueueMany(withSites.slice(0, 80));

  const { attachProfile } = require('../services/companyProfileService');
  const jobsMap = jobsGroupedFor(places.map(p => p.id));
  const out = places.map(p => attachProfile({ ...p, jobs: jobsMap.get(p.id) || [] }));
  res.json({
    provider,
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
router.post('/area-jobs', async (req, res) => {
  const { south, west, north, east, terms } = req.body || {};
  if ([south, west, north, east].some(v => typeof v !== 'number')) {
    return res.status(400).json({ error: 'south, west, north, east (numbers) required' });
  }
  if (!isAreaJobSearchEnabled()) {
    return res.json({ enabled: false, jobs: [], suburb: '', count: 0 });
  }
  try {
    const result = await findAreaJobs({ south, west, north, east }, {
      terms: String(terms || '').slice(0, 60),
    });
    res.json({ ...result, count: result.jobs.length });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
