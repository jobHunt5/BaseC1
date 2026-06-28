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
const { upsertCompany, listJobsForCompany, recordScan } = require('../db');

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

  // Return immediately — the client will background-enrich.
  const out = places.map(p => ({ ...p, jobs: listJobsForCompany(p.id) }));
  res.json({
    provider,
    bounds,
    count: out.length,
    enriched: 0, // legacy field; frontend doesn't rely on this anymore
    companies: out,
  });
});

module.exports = router;
