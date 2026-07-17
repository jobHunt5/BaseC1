// Admin-tunable scan defaults. Every one of these already reads from
// process.env somewhere (placesService.js, jobsService.js) — rather than
// re-plumb every call site to check a settings store first, DB-stored
// overrides are applied directly onto process.env at boot and whenever
// they're changed, so existing code keeps working unmodified and changes
// take effect immediately with no restart.

const { getAllSettings, setSetting } = require('../db');

const TUNABLE = {
  GOOGLE_GRID: {
    label: 'Scan grid size', default: '2', min: 1, max: 4,
    hint: 'Splits a scan area into GRID×GRID cells to beat Google\'s per-query result cap. Higher = more coverage, more API calls.',
  },
  GOOGLE_MAX_PAGES: {
    label: 'Pages per query', default: '3', min: 1, max: 3,
    hint: '1 page = 20 results. Lower this to conserve your Google Places daily quota.',
  },
  GOOGLE_CONCURRENCY: {
    label: 'Parallel Google calls', default: '8', min: 1, max: 20,
    hint: 'How many Google Places requests run at once during a scan.',
  },
  DEEP_SCAN_MAX_COMPANIES: {
    label: 'Deep-scan coverage', default: '80', min: 20, max: 400,
    hint: 'How many scanned companies (per scan) get a full pass — website jobs, Seek/Indeed/LinkedIn/Jora search, LinkedIn team lookup. Higher = far more thorough, far more outbound requests.',
  },
  DEEP_SCAN_CONCURRENCY: {
    label: 'Parallel deep-scans', default: '4', min: 1, max: 16,
    hint: 'How many companies get deep-scanned at once in the background after a map scan.',
  },
  SERPER_DAILY_BUDGET: {
    label: 'Serper daily call budget', default: '300', min: 10, max: 5000,
    hint: 'Caps LinkedIn lookup + Seek/Indeed/LinkedIn/Jora search to this many Serper calls per day, so a busy day fails safely at a known cost instead of exhausting your account balance unnoticed.',
  },
  // Deliberately not including ENRICH_LIMIT / ENRICH_CONCURRENCY here: they're
  // currently only ever read for the /api/health report, not actually
  // wired into any enrichment code path — exposing them as "tunable" would
  // make a setting that silently does nothing when changed.
};

function applyToProcessEnv() {
  const stored = getAllSettings();
  for (const key of Object.keys(TUNABLE)) {
    if (stored[key] != null) process.env[key] = stored[key];
  }
}

function getSettingsWithMeta() {
  const stored = getAllSettings();
  return Object.entries(TUNABLE).map(([key, meta]) => ({
    key,
    ...meta,
    value: Number(process.env[key] ?? meta.default),
    is_override: stored[key] != null,
  }));
}

function updateSetting(key, value) {
  const meta = TUNABLE[key];
  if (!meta) throw new Error(`Unknown setting: ${key}`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < meta.min || n > meta.max) {
    throw new Error(`${key} must be a number between ${meta.min} and ${meta.max}`);
  }
  setSetting(key, n);
  process.env[key] = String(n);
  return getSettingsWithMeta();
}

module.exports = { applyToProcessEnv, getSettingsWithMeta, updateSetting, TUNABLE };
