const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { sanitizeTeam } = require('./services/linkedinService');
const { isBlockedEmail, pickTrustedEmail, sanitizeDescription } = require('./services/trustService');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id            TEXT PRIMARY KEY,           -- stable provider id (e.g. google place_id, "osm:way/123")
    name          TEXT NOT NULL,
    type          TEXT,                       -- human-readable business type
    cats          TEXT NOT NULL DEFAULT '[]', -- JSON array of category slugs
    skills        TEXT NOT NULL DEFAULT '[]', -- JSON array of skill tags
    lat           REAL NOT NULL,
    lng           REAL NOT NULL,
    address       TEXT,
    website       TEXT,
    email         TEXT,
    careers_url   TEXT,
    rating        REAL,                       -- google rating
    user_rating   INTEGER DEFAULT 0,          -- 0-5 stars set by user
    notes         TEXT DEFAULT '',
    status        TEXT DEFAULT 'none',        -- 'none' | 'interested' | 'applied' | 'skipped'
    icon          TEXT,
    color         TEXT,
    enriched_at   INTEGER,                    -- unix ms
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
  CREATE INDEX IF NOT EXISTS idx_companies_latlng ON companies(lat, lng);

  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id   TEXT NOT NULL,
    title        TEXT NOT NULL,
    job_type     TEXT,
    location     TEXT,
    url          TEXT,
    salary       TEXT,
    source       TEXT,                         -- 'greenhouse' | 'lever' | 'workable' | 'ashby' | 'careers-page'
    department   TEXT,
    description  TEXT,                         -- short snippet, plain text
    posted_at    INTEGER,                      -- unix ms when posting was created (if known)
    closes_at    INTEGER,                      -- unix ms application deadline (rarely known)
    remote       INTEGER NOT NULL DEFAULT 0,   -- 0/1, best-effort
    applied      INTEGER NOT NULL DEFAULT 0,   -- 0/1
    applied_at   INTEGER,
    fetched_at   INTEGER NOT NULL,
    UNIQUE(company_id, title, url),
    FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_applied ON jobs(applied);

  CREATE TABLE IF NOT EXISTS scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    south       REAL NOT NULL,
    west        REAL NOT NULL,
    north       REAL NOT NULL,
    east        REAL NOT NULL,
    provider    TEXT NOT NULL,
    result_count INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE,
    profile_json         TEXT NOT NULL DEFAULT '{}',
    onboarding_complete  INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );

  -- Full history of save/apply/skip actions, kept even after the company's
  -- own current .status changes again — this is what the learning-based
  -- match scorer trains on. A single company can appear many times (saved,
  -- then later unsaved, then applied, etc).
  CREATE TABLE IF NOT EXISTS interactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  TEXT NOT NULL,
    action      TEXT NOT NULL,  -- 'saved' | 'unsaved' | 'applied' | 'unapplied' | 'skipped' | 'unskipped'
    created_at  INTEGER NOT NULL,
    FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_company ON interactions(company_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_action ON interactions(action);

  -- Cached "is this a genuine posting" assessment per job. Recomputing on
  -- every list render would be wasteful (and, for the LLM-assisted checks,
  -- slow/costly) so this is written once by jobQualityService and reused
  -- until the job row itself changes.
  CREATE TABLE IF NOT EXISTS job_quality (
    job_id        INTEGER PRIMARY KEY,
    score         REAL NOT NULL,          -- 0 (looks fake) .. 1 (looks genuine)
    flags         TEXT NOT NULL DEFAULT '[]', -- JSON array of short reason codes
    checked_at    INTEGER NOT NULL,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  -- LLM fit-score cache, keyed by (company, job, profile snapshot) so it
  -- only recomputes when the candidate's own profile meaningfully changes.
  CREATE TABLE IF NOT EXISTS ai_fit_scores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    TEXT NOT NULL,
    job_id        INTEGER,               -- null = company-level fit (no specific job yet)
    profile_hash  TEXT NOT NULL,
    score         INTEGER NOT NULL,      -- 0-100
    reason        TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE(company_id, job_id, profile_hash),
    FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ai_fit_company ON ai_fit_scores(company_id);

  -- Learned preference weights driving the "gets smarter the more you use
  -- it" ranking boost. One row per feature (industry:dev, employment:
  -- full-time, has_email, verified, etc); updated after every interaction.
  CREATE TABLE IF NOT EXISTS learned_weights (
    feature_key   TEXT PRIMARY KEY,
    weight        REAL NOT NULL DEFAULT 0,
    sample_count  INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );

  -- Admin-tunable scan defaults (grid size, concurrency, etc). Overrides the
  -- .env value for that key once set, without needing a redeploy/restart —
  -- see settingsService.js for the whitelist and how this gets applied.
  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

// --- migrations ----------------------------------------------------------
// Add columns introduced after v0.1.0 to pre-existing databases so users
// don't have to delete their app.db (and lose their application history).
function addColumnIfMissing(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

addColumnIfMissing('jobs', 'department',  'TEXT');
addColumnIfMissing('jobs', 'description', 'TEXT');
addColumnIfMissing('jobs', 'posted_at',   'INTEGER');
addColumnIfMissing('jobs', 'closes_at',   'INTEGER');
addColumnIfMissing('jobs', 'remote',      'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('companies', 'opportunities', "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('companies', 'phone',         'TEXT');
addColumnIfMissing('companies', 'description',   'TEXT');
addColumnIfMissing('companies', 'socials',       "TEXT NOT NULL DEFAULT '{}'");
addColumnIfMissing('companies', 'all_emails',    "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('companies', 'team',          "TEXT NOT NULL DEFAULT '[]'");
addColumnIfMissing('companies', 'logo_url',      'TEXT');
addColumnIfMissing('companies', 'email_source',  'TEXT');
addColumnIfMissing('companies', 'email_verified','INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('companies', 'enrich_error',  'TEXT');
addColumnIfMissing('companies', 'enrich_depth',  "TEXT DEFAULT 'contact'");

function nowMs() {
  return Date.now();
}

// --- companies ---

const upsertCompanyStmt = db.prepare(`
  INSERT INTO companies
    (id, name, type, cats, skills, opportunities, lat, lng, address, website, rating, icon, color, created_at, updated_at)
  VALUES
    (@id, @name, @type, @cats, @skills, @opportunities, @lat, @lng, @address, @website, @rating, @icon, @color, @now, @now)
  ON CONFLICT(id) DO UPDATE SET
    name          = excluded.name,
    type          = excluded.type,
    cats          = excluded.cats,
    skills        = excluded.skills,
    opportunities = excluded.opportunities,
    lat           = excluded.lat,
    lng           = excluded.lng,
    address       = COALESCE(excluded.address, companies.address),
    website       = COALESCE(excluded.website, companies.website),
    rating        = COALESCE(excluded.rating, companies.rating),
    icon          = excluded.icon,
    color         = excluded.color,
    updated_at    = excluded.updated_at
`);

function upsertCompany(c) {
  upsertCompanyStmt.run({
    id: c.id,
    name: c.name,
    type: c.type || null,
    cats: JSON.stringify(c.cats || []),
    skills: JSON.stringify(c.skills || []),
    opportunities: JSON.stringify(c.opportunities || []),
    lat: c.lat,
    lng: c.lng,
    address: c.address || null,
    website: c.website || null,
    rating: c.rating ?? null,
    icon: c.icon || '🏢',
    color: c.color || 'rgba(108,99,255,0.15)',
    now: nowMs(),
  });
}

const getTeamStmt = db.prepare(`SELECT team FROM companies WHERE id = ?`);

const updateEnrichmentStmt = db.prepare(`
  UPDATE companies
  SET email          = @email,
      email_source   = @email_source,
      email_verified = @email_verified,
      careers_url    = @careers_url,
      phone          = @phone,
      description    = @description,
      socials        = @socials,
      all_emails     = @all_emails,
      team           = @team,
      logo_url       = COALESCE(@logo_url, logo_url),
      enrich_error   = @enrich_error,
      enrich_depth   = COALESCE(@enrich_depth, enrich_depth),
      enriched_at    = COALESCE(@enriched_at, enriched_at),
      updated_at     = @now
  WHERE id = @id
`);

const updateEnrichErrorStmt = db.prepare(`
  UPDATE companies SET enrich_error = @enrich_error, updated_at = @now WHERE id = @id
`);

function updateEnrichment(id, e = {}) {
  if (e.fetched === false) {
    updateEnrichErrorStmt.run({
      id,
      enrich_error: e.fetch_error || e.enrich_error || 'Could not reach website',
      now: nowMs(),
    });
    return;
  }

  let team = e.team || [];
  if (!team.length) {
    const row = getTeamStmt.get(id);
    if (row?.team) team = safeJSON(row.team, []);
  }

  updateEnrichmentStmt.run({
    id,
    email:          e.email || null,
    email_source:   e.email_source || null,
    email_verified: e.email_verified ? 1 : 0,
    careers_url:    e.careers_url || null,
    phone:          e.phone || null,
    description:    e.description || null,
    socials:        JSON.stringify(e.socials || {}),
    all_emails:     JSON.stringify(e.all_emails || []),
    team:           JSON.stringify(team),
    logo_url:       e.logo_url || null,
    enrich_error:   e.enrich_error || null,
    enrich_depth:   e.enrich_depth || (e.fetched ? 'contact' : null),
    enriched_at:    e.fetched ? nowMs() : null,
    now:            nowMs(),
  });
}

// Used after a successful LinkedIn lookup: merges new linkedin URLs into the
// stored team array without re-running the full enrichment.
const setTeamStmt = db.prepare(`UPDATE companies SET team = @team, updated_at = @now WHERE id = @id`);
function updateTeam(id, team) {
  setTeamStmt.run({ id, team: JSON.stringify(team || []), now: nowMs() });
}
function getTeam(id) {
  const row = getTeamStmt.get(id);
  if (!row) return null;
  return safeJSON(row.team, []);
}

const setCompanyFieldStmt = (field) =>
  db.prepare(`UPDATE companies SET ${field} = @val, updated_at = @now WHERE id = @id`);
const setStatusStmt = setCompanyFieldStmt('status');
const setNotesStmt = setCompanyFieldStmt('notes');
const setUserRatingStmt = setCompanyFieldStmt('user_rating');

function setCompanyStatus(id, status) {
  setStatusStmt.run({ id, val: status, now: nowMs() });
}
function setCompanyNotes(id, notes) {
  setNotesStmt.run({ id, val: notes, now: nowMs() });
}
function setCompanyUserRating(id, rating) {
  setUserRatingStmt.run({ id, val: rating, now: nowMs() });
}

// --- interactions (learning signal) ---

const insertInteractionStmt = db.prepare(`
  INSERT INTO interactions (company_id, action, created_at) VALUES (@company_id, @action, @now)
`);
function recordInteraction(companyId, action) {
  insertInteractionStmt.run({ company_id: companyId, action, now: nowMs() });
}

const allInteractionsStmt = db.prepare(`
  SELECT i.company_id, i.action, i.created_at, c.cats, c.opportunities, c.type,
         c.email IS NOT NULL AND c.email != '' AS has_email,
         c.email_verified, c.careers_url IS NOT NULL AS has_careers_url
  FROM interactions i
  JOIN companies c ON c.id = i.company_id
  ORDER BY i.created_at ASC
`);
function getAllInteractionsWithCompany() {
  return allInteractionsStmt.all();
}

const interactionsForCompanyStmt = db.prepare(`
  SELECT action, created_at FROM interactions WHERE company_id = ? ORDER BY created_at DESC
`);
function getInteractionsForCompany(companyId) {
  return interactionsForCompanyStmt.all(companyId);
}

// --- job quality (fake/scam detection) ---

const upsertJobQualityStmt = db.prepare(`
  INSERT INTO job_quality (job_id, score, flags, checked_at)
  VALUES (@job_id, @score, @flags, @now)
  ON CONFLICT(job_id) DO UPDATE SET score = excluded.score, flags = excluded.flags, checked_at = excluded.checked_at
`);
function setJobQuality(jobId, score, flags = []) {
  upsertJobQualityStmt.run({ job_id: jobId, score, flags: JSON.stringify(flags), now: nowMs() });
}

const getJobQualityStmt = db.prepare(`SELECT * FROM job_quality WHERE job_id = ?`);
function getJobQuality(jobId) {
  const row = getJobQualityStmt.get(jobId);
  if (!row) return null;
  return { score: row.score, flags: safeJSON(row.flags, []), checked_at: row.checked_at };
}

const jobQualityForCompanyStmt = db.prepare(`SELECT job_id, score, flags FROM job_quality WHERE job_id IN (SELECT id FROM jobs WHERE company_id = ?)`);
function getJobQualityForCompany(companyId) {
  return jobQualityForCompanyStmt.all(companyId).map(r => ({ job_id: r.job_id, score: r.score, flags: safeJSON(r.flags, []) }));
}

// --- AI fit scores (LLM cache) ---

const getAiFitScoreStmt = db.prepare(`
  SELECT score, reason, created_at FROM ai_fit_scores
  WHERE company_id = @company_id AND (job_id IS @job_id) AND profile_hash = @profile_hash
`);
function getAiFitScore(companyId, jobId, profileHash) {
  return getAiFitScoreStmt.get({ company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash }) || null;
}

const setAiFitScoreStmt = db.prepare(`
  INSERT INTO ai_fit_scores (company_id, job_id, profile_hash, score, reason, created_at)
  VALUES (@company_id, @job_id, @profile_hash, @score, @reason, @now)
  ON CONFLICT(company_id, job_id, profile_hash) DO UPDATE SET score = excluded.score, reason = excluded.reason, created_at = excluded.created_at
`);
function setAiFitScore(companyId, jobId, profileHash, score, reason) {
  setAiFitScoreStmt.run({ company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash, score, reason: reason || null, now: nowMs() });
}

// --- learned preference weights ---

const allWeightsStmt = db.prepare(`SELECT * FROM learned_weights`);
function getLearnedWeights() {
  const out = {};
  for (const row of allWeightsStmt.all()) out[row.feature_key] = { weight: row.weight, sample_count: row.sample_count };
  return out;
}

const upsertWeightStmt = db.prepare(`
  INSERT INTO learned_weights (feature_key, weight, sample_count, updated_at)
  VALUES (@feature_key, @weight, @sample_count, @now)
  ON CONFLICT(feature_key) DO UPDATE SET weight = excluded.weight, sample_count = excluded.sample_count, updated_at = excluded.updated_at
`);
function setLearnedWeight(featureKey, weight, sampleCount) {
  upsertWeightStmt.run({ feature_key: featureKey, weight, sample_count: sampleCount, now: nowMs() });
}

// --- admin-tunable settings ---

const allSettingsStmt = db.prepare(`SELECT key, value FROM settings`);
function getAllSettings() {
  const out = {};
  for (const row of allSettingsStmt.all()) out[row.key] = row.value;
  return out;
}

const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @now)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
function setSetting(key, value) {
  upsertSettingStmt.run({ key, value: String(value), now: nowMs() });
}

const setEmailStmt = db.prepare(`
  UPDATE companies
  SET email = @email,
      email_source = @email_source,
      email_verified = @email_verified,
      updated_at = @now
  WHERE id = @id
`);
function setCompanyEmail(id, { email, email_source, email_verified }) {
  setEmailStmt.run({
    id,
    email: email || null,
    email_source: email_source || null,
    email_verified: email_verified ? 1 : 0,
    now: nowMs(),
  });
}

const getCompanyStmt = db.prepare('SELECT * FROM companies WHERE id = ?');
function getCompany(id) {
  const row = getCompanyStmt.get(id);
  return row ? hydrateCompany(row) : null;
}

const listCompaniesInBoundsStmt = db.prepare(`
  SELECT * FROM companies
  WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
`);
function listCompaniesInBounds({ south, west, north, east }) {
  return listCompaniesInBoundsStmt.all(south, north, west, east).map(hydrateCompany);
}

const listAllCompaniesStmt = db.prepare('SELECT * FROM companies ORDER BY updated_at DESC');
function listAllCompanies() {
  return listAllCompaniesStmt.all().map(hydrateCompany);
}

const listInterestedStmt = db.prepare(`
  SELECT * FROM companies WHERE status = 'interested' ORDER BY updated_at DESC
`);
const listAppliedStmt = db.prepare(`
  SELECT DISTINCT c.* FROM companies c
  LEFT JOIN jobs j ON j.company_id = c.id AND j.applied = 1
  WHERE c.status = 'applied' OR j.applied = 1
  ORDER BY c.updated_at DESC
`);

function listCompaniesByPipeline(kind) {
  const rows = kind === 'applied'
    ? listAppliedStmt.all()
    : listInterestedStmt.all();
  return rows.map(hydrateCompany);
}

function sanitizeStoredEmail(row) {
  const allEmails = safeJSON(row.all_emails, []).filter(e => e && !isBlockedEmail(e));
  const pool = [...new Set([row.email, ...allEmails].filter(Boolean))]
    .map(e => String(e).toLowerCase().trim())
    .filter(e => !isBlockedEmail(e));
  if (!pool.length) return { email: null, email_source: null, email_verified: false };
  return pickTrustedEmail(pool, row.website);
}

function hydrateCompany(row) {
  const emailFields = sanitizeStoredEmail(row);
  if (row.email_verified && row.email) {
    emailFields.email_verified = true;
    emailFields.email = row.email;
    if (row.email_source) emailFields.email_source = row.email_source;
  }
  const allEmails = safeJSON(row.all_emails, []).filter(e => e && !isBlockedEmail(e));
  return {
    ...row,
    ...emailFields,
    description: sanitizeDescription(row.description, row.name),
    cats: safeJSON(row.cats, []),
    skills: safeJSON(row.skills, []),
    opportunities: safeJSON(row.opportunities, []),
    socials: safeJSON(row.socials, {}),
    all_emails: allEmails,
    team: sanitizeTeam(safeJSON(row.team, [])),
  };
}

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// --- jobs ---

const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (
    company_id, title, job_type, location, url, salary, source,
    department, description, posted_at, closes_at, remote, fetched_at
  )
  VALUES (
    @company_id, @title, @job_type, @location, @url, @salary, @source,
    @department, @description, @posted_at, @closes_at, @remote, @now
  )
  ON CONFLICT(company_id, title, url) DO UPDATE SET
    job_type    = excluded.job_type,
    location    = excluded.location,
    salary      = excluded.salary,
    source      = excluded.source,
    department  = excluded.department,
    description = excluded.description,
    posted_at   = COALESCE(excluded.posted_at, jobs.posted_at),
    closes_at   = COALESCE(excluded.closes_at, jobs.closes_at),
    remote      = excluded.remote,
    fetched_at  = excluded.fetched_at
`);

function upsertJob(j) {
  upsertJobStmt.run({
    company_id: j.company_id,
    title: j.title,
    job_type: j.job_type || null,
    location: j.location || null,
    url: j.url || null,
    salary: j.salary || null,
    source: j.source || 'careers-page',
    department: j.department || null,
    description: j.description || null,
    posted_at: j.posted_at || null,
    closes_at: j.closes_at || null,
    remote: j.remote ? 1 : 0,
    now: nowMs(),
  });
}

const listJobsForCompanyStmt = db.prepare('SELECT * FROM jobs WHERE company_id = ? ORDER BY id ASC');
function listJobsForCompany(companyId) {
  return listJobsForCompanyStmt.all(companyId);
}

// Batch-load jobs for many companies in one query instead of N round-trips.
// Returns a Map of company_id -> jobs[]. Chunked to stay well under SQLite's
// bound-parameter limit.
function jobsGroupedFor(ids) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter(v => v != null))];
  if (!unique.length) return map;
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT * FROM jobs WHERE company_id IN (${placeholders}) ORDER BY company_id, id ASC`)
      .all(...slice);
    for (const r of rows) {
      let arr = map.get(r.company_id);
      if (!arr) { arr = []; map.set(r.company_id, arr); }
      arr.push(r);
    }
  }
  return map;
}

const setJobAppliedStmt = db.prepare(
  'UPDATE jobs SET applied = @applied, applied_at = @applied_at WHERE id = @id'
);
function setJobApplied(id, applied) {
  setJobAppliedStmt.run({
    id,
    applied: applied ? 1 : 0,
    applied_at: applied ? nowMs() : null,
  });
}

const getJobStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
function getJob(id) {
  return getJobStmt.get(id);
}

const deleteUnappliedJobsStmt = db.prepare(
  'DELETE FROM jobs WHERE company_id = ? AND applied = 0',
);
function syncJobsForCompany(companyId, jobs, { ok = true, replace = false } = {}) {
  if (!ok) return;
  if (replace) deleteUnappliedJobsStmt.run(companyId);
  if (!jobs || jobs.length === 0) return;
  if (!replace) deleteUnappliedJobsStmt.run(companyId);
  for (const j of jobs) {
    upsertJob({ company_id: companyId, ...j });
  }
  scoreJobsForCompany(companyId);
}

// Runs the (cheap, local, no network) fake/scam-signal scorer over every job
// currently stored for a company and persists the result. Called right
// after jobs are synced so a quality score/flags are ready by the time the
// frontend asks for them — never on the request path itself.
function scoreJobsForCompany(companyId) {
  const { scoreJobQuality } = require('./services/jobQualityService');
  const company = getCompanyStmt.get(companyId);
  const freshJobs = listJobsForCompanyStmt.all(companyId);
  for (const job of freshJobs) {
    const { score, flags } = scoreJobQuality(job, company);
    setJobQuality(job.id, score, flags);
  }
}

// --- scans ---

const recordScanStmt = db.prepare(`
  INSERT INTO scans (south, west, north, east, provider, result_count, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
function recordScan({ south, west, north, east, provider, resultCount }) {
  recordScanStmt.run(south, west, north, east, provider, resultCount, nowMs());
}

const recentScansStmt = db.prepare(`SELECT * FROM scans ORDER BY created_at DESC LIMIT 10`);
const scanTotalsStmt = db.prepare(`SELECT COUNT(*) AS scan_count, COALESCE(SUM(result_count), 0) AS total_found FROM scans`);
function getScanStats() {
  return { recent: recentScansStmt.all(), totals: scanTotalsStmt.get() };
}

const statusCountsStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM companies GROUP BY status`);
function getStatusCounts() {
  const out = { none: 0, interested: 0, applied: 0, skipped: 0 };
  for (const row of statusCountsStmt.all()) out[row.status] = row.n;
  return out;
}

const jobQualityStatsStmt = db.prepare(`
  SELECT COUNT(*) AS total, AVG(score) AS avg_score, SUM(CASE WHEN score < 0.4 THEN 1 ELSE 0 END) AS suspicious_count
  FROM job_quality
`);
function getJobQualityStats() {
  const row = jobQualityStatsStmt.get();
  return { total: row.total || 0, avg_score: row.avg_score || null, suspicious_count: row.suspicious_count || 0 };
}

const aiFitUsageStmt = db.prepare(`SELECT COUNT(*) AS total, AVG(score) AS avg_score FROM ai_fit_scores`);
function getAiFitUsageStats() {
  const row = aiFitUsageStmt.get();
  return { total: row.total || 0, avg_score: row.avg_score || null };
}

// One-time repair: local businesses (restaurants, shops) were sometimes tagged
// ai/marketing from Linktree promos in scraped page text. Re-derive sector tags
// from name + type only.
function repairBogusScrapedJobs() {
  const { isFakeMarketingTitle, isSpecificJobUrl } = require('./services/jobsService');
  const rows = db.prepare(`
    SELECT j.id, j.title, j.url, j.applied, c.website
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    WHERE j.source = 'careers-page' AND j.applied = 0
  `).all();
  const del = db.prepare('DELETE FROM jobs WHERE id = ?');
  let removed = 0;
  for (const r of rows) {
    const base = r.website || r.url || '';
    if (isFakeMarketingTitle(r.title) || !isSpecificJobUrl(r.url, base)) {
      del.run(r.id);
      removed++;
    }
  }
  if (removed) console.log(`[repair] removed ${removed} bogus scraped job listing(s)`);
}

function repairBogusTeamMembers() {
  const { isValidTeamMember } = require('./services/teamTrustService');
  const rows = db.prepare('SELECT id, team FROM companies WHERE team IS NOT NULL AND team != \'[]\'').all();
  const update = db.prepare('UPDATE companies SET team = ?, updated_at = ? WHERE id = ?');
  let fixed = 0;
  for (const row of rows) {
    const team = safeJSON(row.team, []);
    const cleaned = team.filter(isValidTeamMember);
    if (cleaned.length !== team.length) {
      update.run(JSON.stringify(cleaned), nowMs(), row.id);
      fixed += team.length - cleaned.length;
    }
  }
  if (fixed) console.log(`[repair] removed ${fixed} bogus team/location entr${fixed === 1 ? 'y' : 'ies'}`);
}

function repairOpportunityTargetClassification() {
  const { reclassifyStored, isOpportunityTarget, inferOpportunities } = require('./services/classifyService');
  const rows = db.prepare('SELECT id, name, type, cats, opportunities FROM companies').all();
  const update = db.prepare(`
    UPDATE companies SET cats = ?, skills = ?, icon = ?, color = ?, opportunities = ?, updated_at = ?
    WHERE id = ?
  `);
  let fixed = 0;
  for (const row of rows) {
    if (!isOpportunityTarget({ name: row.name, type: row.type })) continue;
    const storedCats = safeJSON(row.cats, []);
    const storedOpps = safeJSON(row.opportunities, []);
    const fresh = reclassifyStored(row);
    const freshOpps = inferOpportunities({ name: row.name, type: row.type });
    if (
      JSON.stringify(storedCats) !== JSON.stringify(fresh.cats) ||
      JSON.stringify(storedOpps) !== JSON.stringify(freshOpps)
    ) {
      update.run(
        JSON.stringify(fresh.cats),
        JSON.stringify(fresh.skills),
        fresh.icon,
        fresh.color,
        JSON.stringify(freshOpps),
        nowMs(),
        row.id,
      );
      fixed++;
    }
  }
  if (fixed) console.log(`[db] Reclassified ${fixed} local businesses`);
  return fixed;
}

// --- users (dummy auth / onboarding profiles) ---

const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');

const upsertUserStmt = db.prepare(`
  INSERT INTO users (id, email, profile_json, onboarding_complete, created_at, updated_at)
  VALUES (@id, @email, @profile_json, @onboarding_complete, @now, @now)
  ON CONFLICT(email) DO UPDATE SET
    profile_json        = excluded.profile_json,
    onboarding_complete = excluded.onboarding_complete,
    updated_at          = excluded.updated_at
`);

function hydrateUser(row) {
  if (!row) return null;
  let profile = {};
  try { profile = JSON.parse(row.profile_json || '{}'); } catch {}
  return {
    id: row.id,
    email: row.email,
    profile,
    onboardingComplete: !!row.onboarding_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertUser({ id, email, profile = {}, onboardingComplete = false }) {
  upsertUserStmt.run({
    id,
    email: email.toLowerCase().trim(),
    profile_json: JSON.stringify(profile),
    onboarding_complete: onboardingComplete ? 1 : 0,
    now: nowMs(),
  });
  return getUserByEmail(email);
}

function getUserByEmail(email) {
  return hydrateUser(getUserByEmailStmt.get(String(email || '').toLowerCase().trim()));
}

function getUserById(id) {
  return hydrateUser(getUserByIdStmt.get(id));
}

module.exports = {
  db,
  upsertCompany,
  updateEnrichment,
  setCompanyStatus,
  setCompanyNotes,
  setCompanyUserRating,
  setCompanyEmail,
  getCompany,
  listCompaniesInBounds,
  listAllCompanies,
  listCompaniesByPipeline,
  upsertJob,
  syncJobsForCompany,
  listJobsForCompany,
  jobsGroupedFor,
  setJobApplied,
  getJob,
  recordScan,
  getTeam,
  updateTeam,
  repairBogusScrapedJobs,
  repairBogusTeamMembers,
  repairOpportunityTargetClassification,
  upsertUser,
  getUserByEmail,
  getUserById,
  recordInteraction,
  getAllInteractionsWithCompany,
  getInteractionsForCompany,
  setJobQuality,
  getJobQuality,
  getJobQualityForCompany,
  getAiFitScore,
  setAiFitScore,
  getLearnedWeights,
  setLearnedWeight,
  getAllSettings,
  setSetting,
  getScanStats,
  getStatusCounts,
  getJobQualityStats,
  getAiFitUsageStats,
};
