// Generic Postgres-backed key/value cache with a TTL — used to persist the
// Serper-lookup caches (jobBoardSearchService, areaJobSearchService,
// linkedinService) across process restarts. Those were previously plain
// in-memory Maps, which reset to empty on every Render redeploy — right
// when a burst of scan/deep-scan activity often follows, defeating the
// point of caching.
//
// `require('../db')` is deliberately lazy (inside each function, not at
// module load time) — db.js requires linkedinService.js at its own top
// (for sanitizeTeam), and linkedinService.js is one of this module's
// callers. A top-level require here would create a real circular-require
// cycle (db.js -> linkedinService.js -> apiCacheService.js -> db.js) that
// would hand back db.js's still-empty module.exports at that point in its
// own execution. db.js itself already avoids this exact class of problem
// elsewhere (scoreJobsForCompany's lazy require of jobQualityService).

// Returns `undefined` for a true cache miss (nothing stored, or expired) —
// deliberately distinct from a legitimately cached `null`/`false`/`[]`
// value, which some callers (e.g. linkedinService's negative-result
// caching) need to tell apart from "haven't looked yet".
async function getCached(key) {
  const db = require('../db');
  await db.ready;
  const row = await db.pool.query(
    'SELECT value FROM api_cache WHERE cache_key = $1 AND expires_at > $2',
    [key, Date.now()],
  );
  if (!row.rows.length) return undefined;
  try { return JSON.parse(row.rows[0].value); }
  catch { return undefined; }
}

async function setCached(key, value, ttlMs) {
  const db = require('../db');
  await db.ready;
  const now = Date.now();
  await db.pool.query(
    `INSERT INTO api_cache (cache_key, value, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
    [key, JSON.stringify(value), now + ttlMs],
  );
  // Opportunistic cleanup — no cron needed at this app's scale, a stray
  // expired row or two just gets swept out on the next unrelated write.
  await db.pool.query('DELETE FROM api_cache WHERE expires_at < $1', [now]);
}

module.exports = { getCached, setCached };
