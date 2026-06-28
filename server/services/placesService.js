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

async function findPlacesInBounds(bounds) {
  // Google returns 10–50× more businesses than OSM. Use it whenever a key exists.
  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      return await findViaGoogle(bounds);
    } catch (err) {
      console.warn('[places] Google scan failed, falling back to OSM:', err.message);
    }
  }
  if (provider === 'google' && !process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error(
      'PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set. ' +
      'Add a key to .env or switch PLACES_PROVIDER to "osm".'
    );
  }
  return findViaOSM(bounds);
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
  // ── tech / creative (most likely to have public job openings) ──
  'design agency',
  'creative studio',
  'web design',
  'software development company',
  'ai company',
  'digital marketing agency',
  'branding agency',
  'tech company',
  // ── general businesses (cold-email targets for freelancers) ──
  'restaurant',
  'cafe',
  'retail store',
  'real estate agency',
  'medical clinic',
  'gym fitness',
  'professional services',
  'hotel',
];

async function findViaGoogle(bounds) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    throw new Error(
      'PLACES_PROVIDER=google but GOOGLE_MAPS_API_KEY is not set. ' +
      'Add a key to .env or switch PLACES_PROVIDER to "osm".'
    );
  }

  const locationRestriction = {
    rectangle: {
      low:  { latitude: bounds.south, longitude: bounds.west },
      high: { latitude: bounds.north, longitude: bounds.east },
    },
  };

  const results = new Map();
  const errors = [];

  async function runTextQuery(q) {
    try {
      const resp = await axios.post(
        'https://places.googleapis.com/v1/places:searchText',
        {
          textQuery: q,
          locationRestriction,
          maxResultCount: 20,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': key,
            'X-Goog-FieldMask': [
              'places.id',
              'places.displayName',
              'places.formattedAddress',
              'places.location',
              'places.websiteUri',
              'places.rating',
              'places.types',
              'places.primaryType',
              'places.primaryTypeDisplayName',
            ].join(','),
          },
          timeout: 12000,
        }
      );
      return { places: resp.data?.places || [], error: null };
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.warn('[google] text search failed:', q, msg);
      return { places: [], error: msg };
    }
  }

  const CONCURRENCY = 4;
  for (let i = 0; i < GOOGLE_TEXT_QUERIES.length; i += CONCURRENCY) {
    const batch = GOOGLE_TEXT_QUERIES.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(runTextQuery));
    for (const { places, error } of batchResults) {
      if (error) errors.push(error);
      for (const p of places) {
        if (!p.id || !p.location) continue;
        if (results.has(p.id)) continue;
        if (isIrrelevantGooglePlace(p)) continue;
        results.set(p.id, normalizeGoogle(p));
      }
    }
  }

  // If EVERY query failed, surface the Google error to the caller so the user
  // sees the real reason (e.g. "Places API (New) is disabled in project X").
  if (results.size === 0 && errors.length === GOOGLE_TEXT_QUERIES.length) {
    throw new Error(`Google Places API rejected every query: ${errors[0]}`);
  }

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
