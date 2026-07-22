// Cutting Google Places / Serper call volume: the persisted api_cache
// key/value store, the Places bbox-covering-scan cache, and an end-to-end
// check that a covered POST /api/scan skips the (real, paid) provider call
// entirely and serves already-stored data instead.

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server/index.js');
const db = require('../server/db.js');
const { getCached, setCached } = require('../server/services/apiCacheService');

let server;
let baseUrl;

before(async () => {
  await app.ready;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie');
  return raw ? raw.split(';')[0] : null;
}

// --- generic api_cache key/value store --------------------------------------

test('apiCacheService round-trips a value and returns undefined for a miss', async () => {
  const key = `test:apicache-${Date.now()}`;
  assert.equal(await getCached(key), undefined);
  await setCached(key, { a: 1, list: [1, 2, 3] }, 60_000);
  assert.deepEqual(await getCached(key), { a: 1, list: [1, 2, 3] });
  await db.pool.query('DELETE FROM api_cache WHERE cache_key = $1', [key]);
});

test('apiCacheService distinguishes a cached null from a true miss', async () => {
  const key = `test:apicache-null-${Date.now()}`;
  await setCached(key, null, 60_000);
  const cached = await getCached(key);
  assert.equal(cached, null); // hit, value is null
  assert.notEqual(cached, undefined); // NOT a miss — findVerifiedLinkedIn depends on this distinction
  await db.pool.query('DELETE FROM api_cache WHERE cache_key = $1', [key]);
});

test('apiCacheService expires a value past its TTL', async () => {
  const key = `test:apicache-ttl-${Date.now()}`;
  await setCached(key, 'soon-to-expire', -1000); // already-expired ttl
  assert.equal(await getCached(key), undefined);
  await db.pool.query('DELETE FROM api_cache WHERE cache_key = $1', [key]);
});

// --- Places bbox-covering-scan cache -----------------------------------------

const SCAN_TEST_ID = Date.now();
const SCAN_USER_ID = `test:places-cache-user-${SCAN_TEST_ID}`;
const SCAN_COMPANY_ID = `test:places-cache-co-${SCAN_TEST_ID}`;
const SCAN_EMAIL = `places_cache_${SCAN_TEST_ID}@example.com`;

after(async () => {
  await db.pool.query('DELETE FROM scans WHERE user_id = $1', [SCAN_USER_ID]);
  await db.pool.query('DELETE FROM companies WHERE id = $1', [SCAN_COMPANY_ID]);
  await db.pool.query('DELETE FROM users WHERE id = $1', [SCAN_USER_ID]);
});

test('getRecentCoveringScan finds a fully-containing recent google scan, ignores a partial-overlap or stale one', async () => {
  await db.upsertUser({ id: SCAN_USER_ID, email: SCAN_EMAIL, profile: {} });
  const day = 24 * 60 * 60 * 1000;

  // Fully covers the test bbox.
  await db.pool.query(
    `INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at) VALUES ($1,$2,$3,$4,'google',1,$5,$6)`,
    [-38, 144, -37, 146, SCAN_USER_ID, Date.now()],
  );
  // Only partially overlaps — must not count as covering.
  await db.pool.query(
    `INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at) VALUES ($1,$2,$3,$4,'google',1,$5,$6)`,
    [-37.5, 144.5, -37.2, 144.8, SCAN_USER_ID, Date.now()],
  );
  // Fully covers but is old — must be excluded by the cutoff.
  await db.pool.query(
    `INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at) VALUES ($1,$2,$3,$4,'google',1,$5,$6)`,
    [-38, 144, -37, 146, SCAN_USER_ID, Date.now() - 10 * day],
  );

  const testBounds = { south: -37.9, west: 144.9, north: -37.8, east: 145.0 };
  const hit = await db.getRecentCoveringScan(testBounds, Date.now() - 7 * day);
  assert.ok(hit, 'expected a covering scan within the cutoff window');

  // A cutoff in the future — by definition nothing's created_at can be after it.
  const noHit = await db.getRecentCoveringScan(testBounds, Date.now() + 1000);
  assert.equal(noHit, undefined, 'no scan should pass a cutoff set in the future');
});

test('POST /api/scan serves cached data with provider "cache" instead of calling the real provider when the area was recently covered', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `scan_cache_${SCAN_TEST_ID}@example.com`, password: 'testpass123', name: 'Scan Cache Test' }),
  });
  const cookie = cookieFrom(loginRes);
  assert.ok(cookie);
  const me = await loginRes.json();
  const userId = me.user.id;

  const bounds = { south: -37.85, west: 144.95, north: -37.80, east: 145.00 };
  await db.upsertCompany({ id: SCAN_COMPANY_ID, name: 'Places Cache Test Co', lat: -37.82, lng: 144.97, website: 'https://example.com' });
  await db.pool.query(
    `INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at) VALUES ($1,$2,$3,$4,'google',1,$5,$6)`,
    [bounds.south - 1, bounds.west - 1, bounds.north + 1, bounds.east + 1, userId, Date.now()],
  );

  const scanRes = await fetch(`${baseUrl}/api/scan`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(bounds),
  });
  assert.equal(scanRes.status, 200);
  const body = await scanRes.json();
  assert.equal(body.provider, 'cache');
  assert.ok(body.companies.some(c => c.id === SCAN_COMPANY_ID), 'expected the pre-seeded company to be served from cache');

  await db.pool.query('DELETE FROM scans WHERE user_id = $1', [userId]);
  await fetch(`${baseUrl}/api/auth/me`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'testpass123' }),
  });
});
