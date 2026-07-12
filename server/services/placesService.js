// Find businesses inside a lat/lng bounding box.
//
// Two providers are supported:
//
//   1. "google" — uses the Google Places API (New) "Search Nearby" + "Search
//      Text" endpoints, restricted to the supplied bounding box. Best data,
//      requires an API key (set PLACES_PROVIDER=google and GOOGLE_MAPS_API_KEY).
//
//   2. "osm" — uses the free OpenStreetMap Overpass API. No key required, but
//      coverage of small businesses is patchy.
//
// Both providers return a normalized list of:
//   { id, name, type, lat, lng, address, website, rating }
// which is then classified + enriched + persisted by the scan route.

const axios = require('axios');
const { classify, inferOpportunities } = require('./classifyService');

const provider = (process.env.PLACES_PROVIDER || 'osm').toLowerCase();

// Returns { places, provider, fellBack, fallbackReason }. The `provider`
// field reflects what ACTUALLY produced the results for this call, not just
// whether a Google key is configured — the caller previously reported
// "google" any time a key existed, even on a scan that silently fell back
// to OSM (e.g. once the Google Places daily quota is exhausted), so users
// had no way to know they were looking at OSM's much sparser data.
async function findPlacesInBounds(bounds) {
  // Google returns 10–50× more businesses than OSM. Use it whenever a key exists.
  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      const places = await findViaGoogle(bounds);
      return { places, provider: 'google', fellBack: false, fallbackReason: null };
    } catch (err) {
      console.warn('[places] Google scan failed, falling back to OSM:', err.message);
      const places = await findViaOSM(bounds);
      return { places, provider: 'osm', fellBack: true, fallbackReason: err.message };
    }
  }
  if (provider === 'google' && !process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error(
      'PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set. ' +
      'Add a key to .env or switch PLACES_PROVIDER to "osm".'
    );
  }
  const places = await findViaOSM(bounds);
  return { places, provider: 'osm', fellBack: false, fallbackReason: null };
}

function getProvider() {
  if (process.env.GOOGLE_MAPS_API_KEY) return 'google';
  return provider;
}

function getCoverageHint() {
  if (process.env.GOOGLE_MAPS_API_KEY) return null;
  return 'Using OpenStreetMap — coverage is sparse. Add GOOGLE_MAPS_API_KEY to .env for full results.';
}

// --- Google Places API (New) ----------------------------------------------

// We query a handful of business-type keywords to widen coverage of the
// categories we care about. Each call is location-restricted to the bbox.
const GOOGLE_INCLUDED_TYPES = [
  'graphic_designer', 'consultant',
  // Most "industries" we care about are not first-class Google place types,
  // so we lean on text search below.
];
// Each query returns up to 20 places per call. We sweep a mix of "obvious
// target" companies (design/dev/AI/marketing — most likely to actually hire)
// AND general businesses (restaurants/retail/services/etc.) which are
// excellent cold-email targets for freelance design / web / marketing work.
const GOOGLE_TEXT_QUERIES = [
  // ── tech / creative ──
  'design agency',
  'creative studio',
  'web design',
  'software development company',
  'ai company',
  'digital marketing agency',
  'branding agency',
  'tech company',
  'startup',
  'saas company',
  // ── finance / insurance / professional ──
  'insurance company',
  'financial services',
  'comparison website',
  'fintech',
  'accounting firm',
  'law firm',
  'consulting firm',
  'recruitment agency',
  'staffing agency',
  // ── healthcare / education ──
  'medical clinic',
  'healthcare',
  'dental clinic',
  'pharmacy',
  'university',
  'training provider',
  // ── hospitality / retail / trades ──
  'restaurant',
  'cafe',
  'hotel',
  'retail store',
  'supermarket',
  'gym fitness',
  'beauty salon',
  'construction company',
  'real estate agency',
  'warehouse',
  'logistics company',
  // ── catch-all professional ──
  'professional services',
  'corporate office',
  'head office',
  'company office',
];

const GOOGLE_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.websiteUri',
  'places.rating',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'nextPageToken',
].join(',');

// Google Text Search (New) returns max 20 results per call but supports
// pagination via nextPageToken (up to 3 pages = 60 results per query).
const GOOGLE_MAX_PAGES = parseInt(process.env.GOOGLE_MAX_PAGES || '3', 10);
// Split the bbox into a grid so each cell stays under the 60-result ceiling;
// dense CBD areas otherwise silently drop businesses past the cap.
const GOOGLE_GRID = Math.max(1, parseInt(process.env.GOOGLE_GRID || '2', 10));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tileBounds(bounds, grid) {
  if (grid <= 1) return [bounds];
  const latStep = (bounds.north - bounds.south) / grid;
  const lngStep = (bounds.east - bounds.west) / grid;
  const tiles = [];
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      tiles.push({
        south: bounds.south + r * latStep,
        north: bounds.south + (r + 1) * latStep,
        west: bounds.west + c * lngStep,
        east: bounds.west + (c + 1) * lngStep,
      });
    }
  }
  return tiles;
}

async function findViaGoogle(bounds) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      'PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set. ' +
      'Add a key to .env or switch PLACES_PROVIDER to "osm".'
    );
  }

  const results = new Map();
  const errors = [];
  let queryCount = 0;

  // Fetch up to GOOGLE_MAX_PAGES of results for a single (query, tile) pair.
  async function runTextQuery(q, tile) {
    const locationRestriction = {
      rectangle: {
        low:  { latitude: tile.south, longitude: tile.west },
        high: { latitude: tile.north, longitude: tile.east },
      },
    };
    let pageToken = null;
    for (let page = 0; page < GOOGLE_MAX_PAGES; page++) {
      queryCount++;
      try {
        const body = { textQuery: q, locationRestriction, maxResultCount: 20 };
        if (pageToken) body.pageToken = pageToken;
        const resp = await axios.post(
          'https://places.googleapis.com/v1/places:searchText',
          body,
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': key,
              'X-Goog-FieldMask': GOOGLE_FIELD_MASK,
            },
            timeout: 12000,
          },
        );
        for (const p of resp.data?.places || []) {
          if (!p.id || !p.location) continue;
          if (results.has(p.id)) continue;
          if (isIrrelevantGooglePlace(p)) continue;
          results.set(p.id, normalizeGoogle(p));
        }
        pageToken = resp.data?.nextPageToken || null;
        if (!pageToken) break;
        // Google requires a short delay before a page token becomes valid.
        await sleep(2000);
      } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        console.warn('[google] text search failed:', q, msg);
        errors.push(msg);
        break;
      }
    }
  }

  const tiles = tileBounds(bounds, GOOGLE_GRID);
  // Build all (query, tile) tasks, then run with bounded concurrency.
  const tasks = [];
  for (const tile of tiles) {
    for (const q of GOOGLE_TEXT_QUERIES) tasks.push({ q, tile });
  }

  const CONCURRENCY = parseInt(process.env.GOOGLE_CONCURRENCY || '8', 10);
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(t => runTextQuery(t.q, t.tile)));
  }

  // If literally every request failed, surface the real Google error.
  if (results.size === 0 && errors.length >= tasks.length) {
    throw new Error(`Google Places API rejected every query: ${errors[0]}`);
  }

  console.log(`[google] ${results.size} unique places from ${tiles.length} tile(s) × ${GOOGLE_TEXT_QUERIES.length} queries (${queryCount} API calls)`);
  return Array.from(results.values());
}

function normalizeGoogle(p) {
  const type =
    p.primaryTypeDisplayName?.text ||
    prettifyType(p.primaryType) ||
    (Array.isArray(p.types) ? prettifyType(p.types[0]) : '') ||
    'Business';
  const base = {
    id: `google:${p.id}`,
    name: p.displayName?.text || 'Unknown',
    type,
    lat: p.location.latitude,
    lng: p.location.longitude,
    address: p.formattedAddress || '',
    website: cleanUrl(p.websiteUri || ''),
    rating: p.rating || null,
  };
  const cls = classify({ name: base.name, type: base.type });
  const opportunities = inferOpportunities({ name: base.name, type: base.type });
  return { ...base, ...cls, opportunities };
}

// We keep almost every business — even restaurants, retail, hotels — because
// in practice they're all valid cold-email targets (a restaurant needs a
// menu redesign, a real estate agency needs better photography, a dentist
// needs a new website). The only things blocked here are non-business POIs
// or things that obviously have no procurement/hiring need.
const IRRELEVANT_TYPES = new Set([
  'atm', 'gas_station', 'parking', 'car_wash',
  'transit_station', 'bus_station', 'train_station', 'subway_station',
  'taxi_stand', 'light_rail_station', 'airport', 'ferry_terminal',
  'post_box', 'post_office', 'public_bathroom', 'rest_stop',
  'cemetery', 'funeral_home',
  'park', 'tourist_attraction', 'natural_feature',
  'place_of_worship', 'church', 'mosque', 'synagogue', 'hindu_temple',
]);

function isIrrelevantGooglePlace(p) {
  const t = (p.primaryType || '').toLowerCase();
  if (IRRELEVANT_TYPES.has(t)) return true;
  const all = (p.types || []).map(s => s.toLowerCase());
  if (all.length && all.every(x => IRRELEVANT_TYPES.has(x))) return true;
  return false;
}

// Drop tracking junk from URLs we got out of Google — Google often hands us a
// website like "https://example.com/?utm_source=google&utm_medium=...".
// We keep the canonical origin + path.
function cleanUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    const trackingPrefixes = ['utm_', 'fbclid', 'gclid', 'mc_', 'msclkid', '_ga', '_gl'];
    for (const k of Array.from(url.searchParams.keys())) {
      if (trackingPrefixes.some(p => k.toLowerCase().startsWith(p))) {
        url.searchParams.delete(k);
      }
    }
    url.hash = '';
    return url.toString().replace(/\?$/, '');
  } catch {
    return u;
  }
}

function prettifyType(t) {
  if (!t) return '';
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- OpenStreetMap / Overpass ---------------------------------------------

// Overpass QL: pull anything tagged as an office / company / studio inside the
// bbox. The OSM tag schema is messy, so we cast a wide net and then classify.
//
// Docs: https://wiki.openstreetmap.org/wiki/Overpass_API
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];

const UA = process.env.ENRICH_USER_AGENT || 'AreaHuntBot/1.0';

async function findViaOSM(bounds) {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  const query = `
    [out:json][timeout:45];
    (
      node["office"](${bbox});
      way["office"](${bbox});
      node["company"](${bbox});
      way["company"](${bbox});
      node["shop"](${bbox});
      way["shop"](${bbox});
      node["craft"](${bbox});
      way["craft"](${bbox});
      node["amenity"~"restaurant|cafe|fast_food|bar|pub|bank|clinic|dentist|doctors|pharmacy|gym|coworking_space|marketplace"](${bbox});
      way["amenity"~"restaurant|cafe|fast_food|bar|pub|bank|clinic|dentist|doctors|pharmacy|gym|coworking_space|marketplace"](${bbox});
      node["healthcare"](${bbox});
      way["healthcare"](${bbox});
      node["tourism"="hotel"](${bbox});
      way["tourism"="hotel"](${bbox});
      node["leisure"~"fitness_centre|sports_centre"](${bbox});
      way["leisure"~"fitness_centre|sports_centre"](${bbox});
      node["shop"="computer"](${bbox});
      way["shop"="computer"](${bbox});
    );
    out center tags;
  `.trim();

  let lastErr;
  for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
    const url = OVERPASS_ENDPOINTS[attempt];
    try {
      // Overpass accepts the query either form-encoded as `data=...` or as a
      // raw text body. Both work; raw body avoids encoding edge cases.
      const resp = await axios.post(url, query, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Accept': 'application/json',
          'User-Agent': UA,
        },
        timeout: 30000,
      });
      const elements = resp.data?.elements || [];
      const out = [];
      for (const el of elements) {
        const norm = normalizeOSM(el);
        if (norm) out.push(norm);
      }
      return dedupeByName(out);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      console.warn('[osm] overpass endpoint failed:', url, status || err.message);
      // Rate-limited? Wait a bit before trying the next mirror.
      if (status === 429) await sleep(1500);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${lastErr?.response?.status || lastErr?.message}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeOSM(el) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'] || tags['operator'];
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;

  const type =
    prettifyType(tags.office) ||
    prettifyType(tags.craft) ||
    prettifyType(tags.shop) ||
    prettifyType(tags.amenity) ||
    'Business';

  const address = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:suburb'] || tags['addr:city'],
  ].filter(Boolean).join(', ');

  const base = {
    id: `osm:${el.type}/${el.id}`,
    name,
    type,
    lat,
    lng,
    address,
    website: cleanUrl(tags.website || tags['contact:website'] || ''),
    rating: null,
  };
  const cls = classify({ name, type });
  const opportunities = inferOpportunities({ name, type });
  return { ...base, ...cls, opportunities };
}

function dedupeByName(list) {
  const seen = new Map();
  for (const p of list) {
    const key = `${p.name.trim().toLowerCase()}|${p.lat?.toFixed(4)}|${p.lng?.toFixed(4)}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return Array.from(seen.values());
}

module.exports = { findPlacesInBounds, getProvider, getCoverageHint };
