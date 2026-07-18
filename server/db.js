const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { sanitizeTeam } = require('./services/linkedinService');
const { isBlockedEmail, pickTrustedEmail, sanitizeDescription } = require('./services/trustService');

// Defaults to a folder next to this file (fine for local dev), but must be
// overridden to a mounted persistent-disk path in production — on a
// platform with an ephemeral filesystem (e.g. Render without a disk), the
// default path gets wiped on every restart/redeploy, silently deleting
// every user account, saved company, and encrypted email password.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
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
    suspended            INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL
  );

  -- Per-user pipeline state for a (shared, globally-discovered) company:
  -- everyone sees the same scanned businesses, but each person's own
  -- saved/applied/skipped status, notes and star rating are private to them.
  CREATE TABLE IF NOT EXISTS user_company_status (
    user_id      TEXT NOT NULL,
    company_id   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'none',
    notes        TEXT NOT NULL DEFAULT '',
    user_rating  INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, company_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ucs_user_status ON user_company_status(user_id, status);

  -- Per-user "I applied to this specific job" flag (jobs themselves, like
  -- companies, are a shared discovery pool).
  CREATE TABLE IF NOT EXISTS user_job_applied (
    user_id     TEXT NOT NULL,
    job_id      INTEGER NOT NULL,
    applied_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, job_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  -- Full history of save/apply/skip actions, kept even after the company's
  -- own current .status changes again — this is what the learning-based
  -- match scorer trains on. A single company can appear many times (saved,
  -- then later unsaved, then applied, etc).
  CREATE TABLE IF NOT EXISTS interactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL DEFAULT '',
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

  -- LLM fit-score cache, keyed by (user, company, job, profile snapshot) so
  -- it only recomputes when that candidate's own profile meaningfully
  -- changes, and two users never share a cached score.
  CREATE TABLE IF NOT EXISTS ai_fit_scores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT NOT NULL DEFAULT '',
    company_id    TEXT NOT NULL,
    job_id        INTEGER,               -- null = company-level fit (no specific job yet)
    profile_hash  TEXT NOT NULL,
    score         INTEGER NOT NULL,      -- 0-100
    reason        TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE(user_id, company_id, job_id, profile_hash),
    FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ai_fit_company ON ai_fit_scores(company_id);

  -- Learned preference weights driving the "gets smarter the more you use
  -- it" ranking boost — private per user. One row per (user, feature)
  -- (industry:dev, employment:full-time, has_email, verified, etc);
  -- updated after every interaction.
  CREATE TABLE IF NOT EXISTS learned_weights (
    user_id       TEXT NOT NULL DEFAULT '',
    feature_key   TEXT NOT NULL,
    weight        REAL NOT NULL DEFAULT 0,
    sample_count  INTEGER NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, feature_key)
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
addColumnIfMissing('scans', 'user_id', 'TEXT');
addColumnIfMissing('users', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'password_hash', 'TEXT');
addColumnIfMissing('interactions', 'user_id', "TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE INDEX IF NOT EXISTS idx_interactions_user ON interactions(user_id)`);

// One-time upgrade (2026-07) from single-tenant global pipeline state to
// per-user pipeline state: companies.status/notes/user_rating and
// jobs.applied used to be shared columns (fine for a personal tool, wrong
// once other people can sign up). learned_weights/ai_fit_scores need a
// user_id in their key, which SQLite can't ALTER onto an existing
// PRIMARY KEY/UNIQUE, so those two are dropped and recreated by the
// CREATE TABLE IF NOT EXISTS above. Everything this touches was confirmed
// disposable dev/QA data (never had a real user), so it's cleared rather
// than migrated to a guessed owner.
if (!db.prepare(`PRAGMA table_info(learned_weights)`).all().some(c => c.name === 'user_id')) {
  db.exec(`
    DROP TABLE IF EXISTS learned_weights;
    CREATE TABLE learned_weights (
      user_id       TEXT NOT NULL DEFAULT '',
      feature_key   TEXT NOT NULL,
      weight        REAL NOT NULL DEFAULT 0,
      sample_count  INTEGER NOT NULL DEFAULT 0,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (user_id, feature_key)
    );
    DROP TABLE IF EXISTS ai_fit_scores;
    CREATE TABLE ai_fit_scores (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL DEFAULT '',
      company_id    TEXT NOT NULL,
      job_id        INTEGER,
      profile_hash  TEXT NOT NULL,
      score         INTEGER NOT NULL,
      reason        TEXT,
      created_at    INTEGER NOT NULL,
      UNIQUE(user_id, company_id, job_id, profile_hash),
      FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_fit_company ON ai_fit_scores(company_id);
  `);
  db.exec(`DELETE FROM interactions`);
  db.exec(`UPDATE companies SET status = 'none', notes = '', user_rating = 0`);
  db.exec(`UPDATE jobs SET applied = 0, applied_at = NULL`);
  db.exec(`DELETE FROM users`);
  console.log('[migrate] Upgraded to per-user pipeline data; cleared prior unattributed test/dev data.');
}

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

// Per-user status/notes/rating for a (shared) company — see
// user_company_status in the schema block for why this isn't a plain
// column on companies anymore.
const upsertUcsStmt = db.prepare(`
  INSERT INTO user_company_status (user_id, company_id, status, notes, user_rating, updated_at)
  VALUES (@user_id, @company_id, @status, @notes, @user_rating, @now)
  ON CONFLICT(user_id, company_id) DO UPDATE SET
    status      = @status,
    notes       = @notes,
    user_rating = @user_rating,
    updated_at  = @now
`);
const getUcsStmt = db.prepare(`SELECT status, notes, user_rating FROM user_company_status WHERE user_id = ? AND company_id = ?`);

function getUserCompanyStatus(userId, companyId) {
  return getUcsStmt.get(userId, companyId) || { status: 'none', notes: '', user_rating: 0 };
}

function upsertUserCompanyStatus(userId, companyId, patch) {
  const current = getUserCompanyStatus(userId, companyId);
  const merged = { ...current, ...patch };
  upsertUcsStmt.run({
    user_id: userId,
    company_id: companyId,
    status: merged.status,
    notes: merged.notes,
    user_rating: merged.user_rating,
    now: nowMs(),
  });
}

function setCompanyStatus(userId, companyId, status) {
  upsertUserCompanyStatus(userId, companyId, { status });
}
function setCompanyNotes(userId, companyId, notes) {
  upsertUserCompanyStatus(userId, companyId, { notes });
}
function setCompanyUserRating(userId, companyId, rating) {
  upsertUserCompanyStatus(userId, companyId, { user_rating: rating });
}

// --- interactions (learning signal) ---

const insertInteractionStmt = db.prepare(`
  INSERT INTO interactions (user_id, company_id, action, created_at) VALUES (@user_id, @company_id, @action, @now)
`);
function recordInteraction(userId, companyId, action) {
  insertInteractionStmt.run({ user_id: userId, company_id: companyId, action, now: nowMs() });
}

const allInteractionsStmt = db.prepare(`
  SELECT i.company_id, i.action, i.created_at, c.cats, c.opportunities, c.type,
         c.email IS NOT NULL AND c.email != '' AS has_email,
         c.email_verified, c.careers_url IS NOT NULL AS has_careers_url
  FROM interactions i
  JOIN companies c ON c.id = i.company_id
  WHERE i.user_id = ?
  ORDER BY i.created_at ASC
`);
function getAllInteractionsWithCompany(userId) {
  return allInteractionsStmt.all(userId);
}

const interactionsForCompanyStmt = db.prepare(`
  SELECT action, created_at FROM interactions WHERE user_id = ? AND company_id = ? ORDER BY created_at DESC
`);
function getInteractionsForCompany(userId, companyId) {
  return interactionsForCompanyStmt.all(userId, companyId);
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
  WHERE user_id = @user_id AND company_id = @company_id AND (job_id IS @job_id) AND profile_hash = @profile_hash
`);
function getAiFitScore(userId, companyId, jobId, profileHash) {
  return getAiFitScoreStmt.get({ user_id: userId, company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash }) || null;
}

const setAiFitScoreStmt = db.prepare(`
  INSERT INTO ai_fit_scores (user_id, company_id, job_id, profile_hash, score, reason, created_at)
  VALUES (@user_id, @company_id, @job_id, @profile_hash, @score, @reason, @now)
  ON CONFLICT(user_id, company_id, job_id, profile_hash) DO UPDATE SET score = excluded.score, reason = excluded.reason, created_at = excluded.created_at
`);
function setAiFitScore(userId, companyId, jobId, profileHash, score, reason) {
  setAiFitScoreStmt.run({ user_id: userId, company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash, score, reason: reason || null, now: nowMs() });
}

// --- learned preference weights ---

const allWeightsStmt = db.prepare(`SELECT feature_key, weight, sample_count FROM learned_weights WHERE user_id = ?`);
function getLearnedWeights(userId) {
  const out = {};
  for (const row of allWeightsStmt.all(userId || '')) out[row.feature_key] = { weight: row.weight, sample_count: row.sample_count };
  return out;
}

const upsertWeightStmt = db.prepare(`
  INSERT INTO learned_weights (user_id, feature_key, weight, sample_count, updated_at)
  VALUES (@user_id, @feature_key, @weight, @sample_count, @now)
  ON CONFLICT(user_id, feature_key) DO UPDATE SET weight = excluded.weight, sample_count = excluded.sample_count, updated_at = excluded.updated_at
`);
function setLearnedWeight(userId, featureKey, weight, sampleCount) {
  upsertWeightStmt.run({ user_id: userId, feature_key: featureKey, weight, sample_count: sampleCount, now: nowMs() });
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

// Every SELECT below joins in the requesting user's own status/notes/
// rating (user_company_status is per-user; companies itself is a shared
// discovery pool — see schema block). userId is required.
const UCS_JOIN = `LEFT JOIN user_company_status ucs ON ucs.company_id = c.id AND ucs.user_id = @user_id`;
const UCS_COLS = `COALESCE(ucs.status, 'none') AS ucs_status, COALESCE(ucs.notes, '') AS ucs_notes, COALESCE(ucs.user_rating, 0) AS ucs_rating`;

const getCompanyStmt = db.prepare(`SELECT c.*, ${UCS_COLS} FROM companies c ${UCS_JOIN} WHERE c.id = @id`);
function getCompany(id, userId) {
  const row = getCompanyStmt.get({ id, user_id: userId || '' });
  return row ? hydrateCompany(row) : null;
}

const listCompaniesInBoundsStmt = db.prepare(`
  SELECT c.*, ${UCS_COLS} FROM companies c
  ${UCS_JOIN}
  WHERE c.lat BETWEEN @south AND @north AND c.lng BETWEEN @west AND @east
`);
function listCompaniesInBounds({ south, west, north, east }, userId) {
  return listCompaniesInBoundsStmt.all({ south, west, north, east, user_id: userId || '' }).map(hydrateCompany);
}

const listAllCompaniesStmt = db.prepare(`SELECT c.*, ${UCS_COLS} FROM companies c ${UCS_JOIN} ORDER BY c.updated_at DESC`);
function listAllCompanies(userId) {
  return listAllCompaniesStmt.all({ user_id: userId || '' }).map(hydrateCompany);
}

const listInterestedStmt = db.prepare(`
  SELECT c.*, ${UCS_COLS} FROM companies c
  ${UCS_JOIN}
  WHERE ucs.status = 'interested' ORDER BY ucs.updated_at DESC
`);
const listAppliedStmt = db.prepare(`
  SELECT DISTINCT c.*, ${UCS_COLS} FROM companies c
  ${UCS_JOIN}
  LEFT JOIN jobs j ON j.company_id = c.id
  LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id
  WHERE ucs.status = 'applied' OR uja.user_id IS NOT NULL
  ORDER BY c.updated_at DESC
`);

function listCompaniesByPipeline(kind, userId) {
  const params = { user_id: userId || '' };
  const rows = kind === 'applied'
    ? listAppliedStmt.all(params)
    : listInterestedStmt.all(params);
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
    // Per-user pipeline state, joined in via user_company_status — see
    // getCompany/listCompaniesInBounds/etc. Falls back to defaults when
    // the query didn't join it in (e.g. admin-side global company lookups).
    status: row.ucs_status ?? row.status ?? 'none',
    notes: row.ucs_notes ?? row.notes ?? '',
    user_rating: row.ucs_rating ?? row.user_rating ?? 0,
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

// "applied" is per-user (user_job_applied); jobs themselves are shared.
const JOB_UJA_JOIN = `LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id`;
const JOB_UJA_COLS = `(uja.user_id IS NOT NULL) AS uja_applied, uja.applied_at AS uja_applied_at`;

function hydrateJob(row) {
  if (!row) return row;
  return { ...row, applied: row.uja_applied ? 1 : 0, applied_at: row.uja_applied_at ?? null };
}

const listJobsForCompanyStmt = db.prepare(`
  SELECT j.*, ${JOB_UJA_COLS} FROM jobs j
  ${JOB_UJA_JOIN}
  WHERE j.company_id = @company_id ORDER BY j.id ASC
`);
function listJobsForCompany(companyId, userId) {
  return listJobsForCompanyStmt.all({ company_id: companyId, user_id: userId || '' }).map(hydrateJob);
}

// Batch-load jobs for many companies in one query instead of N round-trips.
// Returns a Map of company_id -> jobs[]. Chunked to stay well under SQLite's
// bound-parameter limit.
function jobsGroupedFor(ids, userId) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter(v => v != null))];
  if (!unique.length) return map;
  const CHUNK = 500;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT j.*, ${JOB_UJA_COLS} FROM jobs j
        LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = ?
        WHERE j.company_id IN (${placeholders}) ORDER BY j.company_id, j.id ASC
      `)
      .all(userId || '', ...slice)
      .map(hydrateJob);
    for (const r of rows) {
      let arr = map.get(r.company_id);
      if (!arr) { arr = []; map.set(r.company_id, arr); }
      arr.push(r);
    }
  }
  return map;
}

const upsertUjaStmt = db.prepare(`
  INSERT INTO user_job_applied (user_id, job_id, applied_at) VALUES (@user_id, @job_id, @now)
  ON CONFLICT(user_id, job_id) DO UPDATE SET applied_at = @now
`);
const deleteUjaStmt = db.prepare(`DELETE FROM user_job_applied WHERE user_id = @user_id AND job_id = @job_id`);
function setJobApplied(userId, id, applied) {
  if (applied) upsertUjaStmt.run({ user_id: userId, job_id: id, now: nowMs() });
  else deleteUjaStmt.run({ user_id: userId, job_id: id });
}

const getJobStmt = db.prepare(`SELECT j.*, ${JOB_UJA_COLS} FROM jobs j ${JOB_UJA_JOIN} WHERE j.id = @id`);
function getJob(id, userId) {
  return hydrateJob(getJobStmt.get({ id, user_id: userId || '' }));
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
  INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function recordScan({ south, west, north, east, provider, resultCount }, userId) {
  recordScanStmt.run(south, west, north, east, provider, resultCount, userId || null, nowMs());
}

const recentScansStmt = db.prepare(`
  SELECT s.*, u.email AS user_email FROM scans s
  LEFT JOIN users u ON u.id = s.user_id
  ORDER BY s.created_at DESC LIMIT 10
`);
const scanTotalsStmt = db.prepare(`SELECT COUNT(*) AS scan_count, COALESCE(SUM(result_count), 0) AS total_found FROM scans`);
function getScanStats() {
  return { recent: recentScansStmt.all(), totals: scanTotalsStmt.get() };
}

// Pipeline funnel across every user (admin overview) — status now lives in
// user_company_status, one row per (user, company) they've touched; "none"
// is everyone who saw a company but never set a status, i.e. everything
// else in the shared discovery pool.
const statusCountsStmt = db.prepare(`SELECT status, COUNT(*) AS n FROM user_company_status GROUP BY status`);
const companyCountStmt = db.prepare(`SELECT COUNT(*) AS n FROM companies`);
function getStatusCounts() {
  const out = { none: 0, interested: 0, applied: 0, skipped: 0 };
  let touched = 0;
  for (const row of statusCountsStmt.all()) {
    if (row.status !== 'none') { out[row.status] = row.n; touched += row.n; }
  }
  out.none = Math.max(0, (companyCountStmt.get().n || 0) - touched);
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

// --- admin analytics (time series + breakdowns for the dashboard) ---

// Builds one row per day for the trailing `days` days (UTC calendar days),
// filling in zero for days with no matching rows, so the chart never has to
// guess at gaps in the x-axis.
function fillDays(rows, days) {
  const byDay = new Map(rows.map(r => [r.day, r.n]));
  const out = [];
  const now = nowMs();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, n: byDay.get(day) || 0 });
  }
  return out;
}

function getSignupsSeries(days) {
  const since = nowMs() - days * 86400000;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, COUNT(*) AS n
    FROM users WHERE created_at >= ? GROUP BY day
  `).all(since);
  return fillDays(rows, days);
}

function getScansSeries(days) {
  const since = nowMs() - days * 86400000;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, COUNT(*) AS n
    FROM scans WHERE created_at >= ? GROUP BY day
  `).all(since);
  return fillDays(rows, days);
}

function getInteractionsSeries(days, action) {
  const since = nowMs() - days * 86400000;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day, COUNT(*) AS n
    FROM interactions WHERE created_at >= ? AND action = ? GROUP BY day
  `).all(since, action);
  return fillDays(rows, days);
}

// Parses companies.cats (JSON array of category slugs) in JS since SQLite
// has no native JSON array aggregation; folds everything past `limit` into
// a single "other" bucket rather than a long tail of 1-count categories.
function getIndustryBreakdown(limit = 8) {
  const rows = db.prepare(`SELECT cats FROM companies`).all();
  const counts = new Map();
  for (const r of rows) {
    for (const cat of safeJSON(r.cats, [])) {
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit).map(([cat, n]) => ({ cat, n }));
  const restTotal = sorted.slice(limit).reduce((s, [, n]) => s + n, 0);
  if (restTotal > 0) top.push({ cat: 'other', n: restTotal });
  return top;
}

function getProviderBreakdown() {
  return db.prepare(`SELECT provider, COUNT(*) AS n FROM scans GROUP BY provider ORDER BY n DESC`).all();
}

function getJobSourceBreakdown() {
  return db.prepare(`
    SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS n
    FROM jobs GROUP BY source ORDER BY n DESC
  `).all();
}

function getDataQualityStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) AS with_email,
      SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified_email,
      SUM(CASE WHEN team IS NOT NULL AND team != '[]' THEN 1 ELSE 0 END) AS with_team,
      SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS with_website
    FROM companies
  `).get();
  const jobsRow = db.prepare(`SELECT COUNT(DISTINCT company_id) AS n FROM jobs`).get();
  return {
    total: row.total || 0,
    with_email: row.with_email || 0,
    verified_email: row.verified_email || 0,
    with_team: row.with_team || 0,
    with_website: row.with_website || 0,
    with_jobs: jobsRow.n || 0,
  };
}

// Buckets job_quality.score (0..1) into the four fixed status tiers so the
// admin chart can reuse the same reserved status palette as the rest of the
// product instead of an arbitrary sequential ramp.
function getQualityBuckets() {
  const rows = db.prepare(`SELECT score FROM job_quality`).all();
  const b = { critical: 0, serious: 0, warning: 0, good: 0 };
  for (const { score } of rows) {
    if (score < 0.25) b.critical++;
    else if (score < 0.5) b.serious++;
    else if (score < 0.75) b.warning++;
    else b.good++;
  }
  return b;
}

function getAiFitBuckets() {
  const rows = db.prepare(`SELECT score FROM ai_fit_scores`).all();
  const b = { critical: 0, serious: 0, warning: 0, good: 0 };
  for (const { score } of rows) {
    if (score < 25) b.critical++;
    else if (score < 50) b.serious++;
    else if (score < 75) b.warning++;
    else b.good++;
  }
  return b;
}

function getTopCompaniesByInterest(limit = 8) {
  return db.prepare(`
    SELECT c.name AS name, COUNT(*) AS n
    FROM user_company_status ucs JOIN companies c ON c.id = ucs.company_id
    WHERE ucs.status IN ('interested', 'applied')
    GROUP BY ucs.company_id ORDER BY n DESC LIMIT ?
  `).all(limit);
}

function getAnalytics(days = 30) {
  days = Math.max(1, Math.min(90, Number(days) || 30));
  return {
    days,
    signups_series: getSignupsSeries(days),
    scans_series: getScansSeries(days),
    applied_series: getInteractionsSeries(days, 'applied'),
    industries: getIndustryBreakdown(8),
    providers: getProviderBreakdown(),
    job_sources: getJobSourceBreakdown(),
    data_quality: getDataQualityStats(),
    quality_buckets: getQualityBuckets(),
    ai_fit_buckets: getAiFitBuckets(),
    top_companies: getTopCompaniesByInterest(8),
  };
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
    // Never exposed to a client — routes must not include this in any
    // response. Kept on the hydrated object (not a separate lookup) so
    // auth.js can verify a login in one query instead of two.
    passwordHash: row.password_hash || null,
    onboardingComplete: !!row.onboarding_complete,
    suspended: !!row.suspended,
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

const setPasswordHashStmt = db.prepare(`UPDATE users SET password_hash = @password_hash, updated_at = @now WHERE id = @id`);
function setPasswordHash(userId, hash) {
  setPasswordHashStmt.run({ id: userId, password_hash: hash, now: nowMs() });
}

// --- admin: user management ---

const allUsersWithStatsStmt = db.prepare(`
  SELECT u.id, u.email, u.profile_json, u.onboarding_complete, u.suspended, u.created_at, u.updated_at,
    (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'interested') AS saved_count,
    (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'applied') AS applied_count,
    (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'skipped') AS skipped_count,
    (SELECT COUNT(*) FROM interactions i WHERE i.user_id = u.id) AS interaction_count
  FROM users u
  ORDER BY u.created_at DESC
`);
function getAllUsersWithStats() {
  return allUsersWithStatsStmt.all().map(row => ({
    ...hydrateUser(row),
    savedCount: row.saved_count,
    appliedCount: row.applied_count,
    skippedCount: row.skipped_count,
    interactionCount: row.interaction_count,
  }));
}

const setUserSuspendedStmt = db.prepare(`UPDATE users SET suspended = @suspended, updated_at = @now WHERE id = @id`);
function setUserSuspended(id, suspended) {
  setUserSuspendedStmt.run({ id, suspended: suspended ? 1 : 0, now: nowMs() });
}

const deleteUserStmt = db.prepare(`DELETE FROM users WHERE id = ?`);
const deleteUserUcsStmt = db.prepare(`DELETE FROM user_company_status WHERE user_id = ?`);
const deleteUserInteractionsStmt = db.prepare(`DELETE FROM interactions WHERE user_id = ?`);
const deleteUserWeightsStmt = db.prepare(`DELETE FROM learned_weights WHERE user_id = ?`);
const deleteUserAiFitStmt = db.prepare(`DELETE FROM ai_fit_scores WHERE user_id = ?`);
const deleteUserAppliedStmt = db.prepare(`DELETE FROM user_job_applied WHERE user_id = ?`);
const deleteUserTx = db.transaction((id) => {
  deleteUserUcsStmt.run(id);
  deleteUserInteractionsStmt.run(id);
  deleteUserWeightsStmt.run(id);
  deleteUserAiFitStmt.run(id);
  deleteUserAppliedStmt.run(id);
  deleteUserStmt.run(id);
});
function deleteUser(id) {
  deleteUserTx(id);
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
  setPasswordHash,
  getAllUsersWithStats,
  setUserSuspended,
  deleteUser,
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
  getAnalytics,
};
