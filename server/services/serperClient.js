// Centralized Serper.dev (Google search) client — the single source of
// truth for the API key, request shape, and a daily call budget + health
// tracking. Every consumer (LinkedIn discovery, per-company job-board
// search, area-wide job-board search) used to have its own copy of this
// with errors swallowed silently — a "not enough credits" account state
// was completely invisible to both the user and the admin, they'd just see
// zero results with no explanation. Centralizing gives one place that:
//   1. Records every call so a runaway loop (or genuinely high real-user
//      traffic once this is live) can't blow through the account's credit
//      balance unnoticed — once SERPER_DAILY_BUDGET is hit, calls stop
//      short-circuiting locally instead of continuing to hit a failing
//      account for the rest of the day.
//   2. Tracks the last error so /api/health (and the admin dashboard) can
//      report *why* board search / LinkedIn lookup isn't working, not just
//      "0 results".

const axios = require('axios');

// Lazy-required (not at module top level): db.js requires linkedinService.js,
// which requires this module — a top-level `require('../db')` here would
// complete the cycle while db.js is still mid-load and get back an empty
// module.exports, silently turning getAllSettings/setSetting into
// undefined. Deferring the require until first actual use resolves after
// every module has finished loading.
function db() { return require('../db'); }

const SERPER_KEY = process.env.SERPER_API_KEY || '';
const TIMEOUT = parseInt(process.env.JOB_SEARCH_TIMEOUT_MS || '6000', 10);

function todayKey() {
  return `serper_calls_${new Date().toISOString().slice(0, 10)}`;
}

function budgetLimit() {
  return parseInt(process.env.SERPER_DAILY_BUDGET || '300', 10);
}

function getUsageToday() {
  const stored = db().getAllSettings();
  return parseInt(stored[todayKey()] || '0', 10);
}

function recordCall() {
  const key = todayKey();
  const n = getUsageToday() + 1;
  db().setSetting(key, n);
  return n;
}

function budgetExceeded() {
  return getUsageToday() >= budgetLimit();
}

function isConfigured() {
  return !!SERPER_KEY;
}

// Kept in-process only (not persisted) — this is "is the account healthy
// right now", not a historical log; a restart clearing it is fine, the
// next call re-establishes it within seconds either way.
let lastError = null;
let lastErrorAt = 0;
const ERROR_TTL_MS = 10 * 60 * 1000;

function status() {
  if (!isConfigured()) return { state: 'no-key', message: 'SERPER_API_KEY not set' };
  if (budgetExceeded()) {
    return { state: 'budget-exceeded', message: `Daily budget of ${budgetLimit()} Serper calls reached — resets at UTC midnight, or raise it in Settings` };
  }
  if (lastError && Date.now() - lastErrorAt < ERROR_TTL_MS) return { state: 'error', message: lastError };
  return { state: 'ok', message: '' };
}

async function serperSearch(query, { num = 10, gl, hl } = {}) {
  if (!isConfigured()) return [];
  if (budgetExceeded()) return [];
  try {
    const body = { q: query, num };
    if (gl) body.gl = gl;
    if (hl) body.hl = hl;
    const resp = await axios.post('https://google.serper.dev/search', body, {
      headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
      timeout: TIMEOUT,
      validateStatus: () => true,
    });
    recordCall();
    if (resp.status !== 200) {
      lastError = resp.data?.message || `HTTP ${resp.status}`;
      lastErrorAt = Date.now();
      return [];
    }
    lastError = null;
    return resp.data?.organic || [];
  } catch (err) {
    lastError = err.message;
    lastErrorAt = Date.now();
    return [];
  }
}

module.exports = { serperSearch, isConfigured, status, getUsageToday, budgetLimit };
