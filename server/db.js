const { Pool, types } = require('pg');
const { sanitizeTeam } = require('./services/linkedinService');
const { isBlockedEmail, pickTrustedEmail, sanitizeDescription } = require('./services/trustService');

// node-postgres returns BIGINT (int8, OID 20) columns as strings by default,
// to avoid silently losing precision above Number.MAX_SAFE_INTEGER. Every
// BIGINT column in this schema is a unix-ms timestamp or row id, both
// comfortably within safe-integer range for the foreseeable future (unix ms
// doesn't overflow it until the year ~2255) — parsing as a number here keeps
// every existing call site (arithmetic, JSON responses, Date construction)
// working exactly as it did against better-sqlite3, which returned these as
// plain JS numbers.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

// Supabase's pooler needs TLS but presents a cert chain Node's default trust
// store doesn't fully validate in this environment — rejectUnauthorized:
// false keeps the connection encrypted without failing on that chain.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// --- query helpers ---------------------------------------------------------
// Converts `@name` placeholders (the shape almost every query below was
// already written in, ported from the better-sqlite3 original) into
// Postgres's positional $1/$2/... form, reusing the same index for repeated
// occurrences of the same name.
function toPositional(sql, params = {}) {
  const values = [];
  const seen = new Map();
  const text = sql.replace(/@(\w+)/g, (_, key) => {
    if (seen.has(key)) return `$${seen.get(key)}`;
    values.push(params[key]);
    const idx = values.length;
    seen.set(key, idx);
    return `$${idx}`;
  });
  return { text, values };
}

async function run(sql, params) {
  await ready;
  const { text, values } = toPositional(sql, params);
  return pool.query(text, values);
}
async function get(sql, params) {
  const res = await run(sql, params);
  return res.rows[0];
}
async function all(sql, params) {
  const res = await run(sql, params);
  return res.rows;
}

// --- settings: synchronous in-memory cache, write-through to Postgres -----
// Kept synchronous deliberately — getAllSettings/setSetting are called from
// deep inside otherwise-sync helpers (cryptoService's encrypt/decrypt,
// serperClient's per-call budget check, adminAuth's token secret lookup)
// that would otherwise all need to become async, and from a hot loop
// (one budget check per external search call). This table is small
// (a few dozen admin/system keys) and low-write-frequency, so a full
// in-memory mirror loaded once at boot — refreshed on every write, both
// in-memory and in Postgres — is a safe trade: at worst, a crash in the
// same instant as a write loses that one write, never user data.
let settingsCache = {};

function getAllSettings() {
  return { ...settingsCache };
}

function setSetting(key, value) {
  settingsCache[key] = String(value);
  pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(value), nowMs()],
  ).catch((err) => console.error('[db] failed to persist setting', key, err.message));
}

// --- schema + bootstrap -----------------------------------------------------
// Runs once at process start. Every other exported function awaits `ready`
// (via run/get/all above) before touching the pool, so requiring this module
// and immediately calling one of its functions is safe regardless of how
// long schema setup takes — no separate explicit init call is needed from
// callers, except where a caller itself needs to block on it directly
// (server/index.js applying settings to process.env before routes are hit,
// and the test suite before its first request).
const ready = (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      type          TEXT,
      cats          TEXT NOT NULL DEFAULT '[]',
      skills        TEXT NOT NULL DEFAULT '[]',
      opportunities TEXT NOT NULL DEFAULT '[]',
      lat           DOUBLE PRECISION NOT NULL,
      lng           DOUBLE PRECISION NOT NULL,
      address       TEXT,
      website       TEXT,
      email         TEXT,
      careers_url   TEXT,
      phone         TEXT,
      description   TEXT,
      socials       TEXT NOT NULL DEFAULT '{}',
      all_emails    TEXT NOT NULL DEFAULT '[]',
      team          TEXT NOT NULL DEFAULT '[]',
      logo_url      TEXT,
      email_source  TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      enrich_error  TEXT,
      enrich_depth  TEXT DEFAULT 'contact',
      rating        DOUBLE PRECISION,
      user_rating   INTEGER DEFAULT 0,
      notes         TEXT DEFAULT '',
      status        TEXT DEFAULT 'none',
      icon          TEXT,
      color         TEXT,
      enriched_at   BIGINT,
      created_at    BIGINT NOT NULL,
      updated_at    BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
    CREATE INDEX IF NOT EXISTS idx_companies_latlng ON companies(lat, lng);

    CREATE TABLE IF NOT EXISTS jobs (
      id           SERIAL PRIMARY KEY,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      job_type     TEXT,
      location     TEXT,
      url          TEXT,
      salary       TEXT,
      source       TEXT,
      department   TEXT,
      description  TEXT,
      posted_at    BIGINT,
      closes_at    BIGINT,
      remote       INTEGER NOT NULL DEFAULT 0,
      applied      INTEGER NOT NULL DEFAULT 0,
      applied_at   BIGINT,
      fetched_at   BIGINT NOT NULL,
      visa_flag    TEXT,
      UNIQUE(company_id, title, url)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_applied ON jobs(applied);

    CREATE TABLE IF NOT EXISTS scans (
      id          SERIAL PRIMARY KEY,
      south       DOUBLE PRECISION NOT NULL,
      west        DOUBLE PRECISION NOT NULL,
      north       DOUBLE PRECISION NOT NULL,
      east        DOUBLE PRECISION NOT NULL,
      provider    TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      user_id     TEXT,
      created_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id                   TEXT PRIMARY KEY,
      email                TEXT NOT NULL UNIQUE,
      profile_json         TEXT NOT NULL DEFAULT '{}',
      onboarding_complete  INTEGER NOT NULL DEFAULT 0,
      suspended            INTEGER NOT NULL DEFAULT 0,
      password_hash        TEXT,
      email_verified       INTEGER NOT NULL DEFAULT 0,
      email_verify_token   TEXT,
      email_verify_expires BIGINT,
      created_at           BIGINT NOT NULL,
      updated_at           BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_company_status (
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      status       TEXT NOT NULL DEFAULT 'none',
      notes        TEXT NOT NULL DEFAULT '',
      user_rating  INTEGER NOT NULL DEFAULT 0,
      updated_at   BIGINT NOT NULL,
      PRIMARY KEY (user_id, company_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ucs_user_status ON user_company_status(user_id, status);

    CREATE TABLE IF NOT EXISTS user_job_applied (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      applied_at  BIGINT NOT NULL,
      PRIMARY KEY (user_id, job_id)
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL DEFAULT '',
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interactions_company ON interactions(company_id);
    CREATE INDEX IF NOT EXISTS idx_interactions_action ON interactions(action);
    CREATE INDEX IF NOT EXISTS idx_interactions_user ON interactions(user_id);

    CREATE TABLE IF NOT EXISTS job_quality (
      job_id        INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      score         DOUBLE PRECISION NOT NULL,
      flags         TEXT NOT NULL DEFAULT '[]',
      checked_at    BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_fit_scores (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL DEFAULT '',
      company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      job_id        INTEGER,
      profile_hash  TEXT NOT NULL,
      score         INTEGER NOT NULL,
      reason        TEXT,
      created_at    BIGINT NOT NULL,
      UNIQUE(user_id, company_id, job_id, profile_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_fit_company ON ai_fit_scores(company_id);

    CREATE TABLE IF NOT EXISTS learned_weights (
      user_id       TEXT NOT NULL DEFAULT '',
      feature_key   TEXT NOT NULL,
      weight        DOUBLE PRECISION NOT NULL DEFAULT 0,
      sample_count  INTEGER NOT NULL DEFAULT 0,
      updated_at    BIGINT NOT NULL,
      PRIMARY KEY (user_id, feature_key)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  BIGINT NOT NULL
    );

    -- There's one shared admin password rather than per-admin accounts, so
    -- this can't attribute an action to a specific admin — but it still
    -- gives a record of what happened and when, plus the requesting IP as
    -- the best available signal, instead of admin mutations leaving no
    -- trace at all.
    CREATE TABLE IF NOT EXISTS admin_actions (
      id          SERIAL PRIMARY KEY,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      actor_ip    TEXT,
      created_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at);
  `);

  // Columns added after the table's first CREATE — unlike CREATE TABLE IF
  // NOT EXISTS above (a no-op once the table already exists), this runs
  // against a real users table with real accounts in it.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires BIGINT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS scrape_status TEXT NOT NULL DEFAULT 'never';
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS ats_detected TEXT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_scrape_attempt_at BIGINT;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS scrape_attempts INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_companies_scrape_status ON companies(scrape_status);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_alert_sent_at BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS training_data_consent INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS job_alerts (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      matched_at BIGINT NOT NULL,
      sent_at    BIGINT,
      PRIMARY KEY (user_id, job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_job_alerts_unsent ON job_alerts(user_id) WHERE sent_at IS NULL;
    CREATE TABLE IF NOT EXISTS api_cache (
      cache_key  TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS first_seen_at BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS removed_at BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS repost_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS title_norm TEXT;
    CREATE INDEX IF NOT EXISTS idx_jobs_company_removed ON jobs(company_id, removed_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_company_titlenorm ON jobs(company_id, title_norm);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_preference TEXT NOT NULL DEFAULT 'dark';
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description_full TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS detail_status TEXT;

    -- Area-wide board jobs (Seek/Indeed/LinkedIn/… found by suburb, not tied
    -- to a discovered company). Previously computed live and thrown away with
    -- the cache — persisted now so the enriched postings accumulate into the
    -- training corpus instead of evaporating on every cache expiry.
    CREATE TABLE IF NOT EXISTS area_jobs (
      id            SERIAL PRIMARY KEY,
      url           TEXT NOT NULL UNIQUE,
      title         TEXT NOT NULL,
      company_name  TEXT,
      location      TEXT,
      suburb        TEXT,
      state         TEXT,
      description   TEXT,
      description_full TEXT,
      salary        TEXT,
      job_type      TEXT,
      posted_at     BIGINT,
      closes_at     BIGINT,
      remote        INTEGER NOT NULL DEFAULT 0,
      source        TEXT NOT NULL,
      visa_flag     TEXT,
      detail_status TEXT,
      first_seen_at BIGINT NOT NULL,
      last_seen_at  BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_area_jobs_suburb ON area_jobs(suburb, state);
  `);

  const { rows } = await pool.query('SELECT key, value FROM settings');
  for (const row of rows) settingsCache[row.key] = row.value;
})();

function nowMs() {
  return Date.now();
}

// --- companies ---

async function upsertCompany(c) {
  await run(`
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
  `, {
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

async function getTeam(id) {
  const row = await get(`SELECT team FROM companies WHERE id = @id`, { id });
  if (!row) return null;
  return safeJSON(row.team, []);
}

async function updateEnrichment(id, e = {}) {
  if (e.fetched === false) {
    await run(
      `UPDATE companies SET enrich_error = @enrich_error, updated_at = @now WHERE id = @id`,
      { id, enrich_error: e.fetch_error || e.enrich_error || 'Could not reach website', now: nowMs() },
    );
    return;
  }

  let team = e.team || [];
  if (!team.length) {
    const row = await get(`SELECT team FROM companies WHERE id = @id`, { id });
    if (row?.team) team = safeJSON(row.team, []);
  }

  await run(`
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
  `, {
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

// 'never' | 'ok' | 'partial' | 'failed' — distinct from enrich_error/enriched_at,
// which only ever record the *last successful* fetch. This tracks every
// attempt (success or not) so we can query "who still needs a (re)scan".
async function updateScrapeStatus(id, { status, ats = null, attempted_at } = {}) {
  await run(`
    UPDATE companies
    SET scrape_status          = @status,
        ats_detected           = @ats,
        last_scrape_attempt_at = @attempted_at,
        scrape_attempts        = scrape_attempts + 1,
        updated_at             = @attempted_at
    WHERE id = @id
  `, { id, status, ats, attempted_at: attempted_at || nowMs() });
}

// Companies that have never been scraped, permanently failed, or were only
// partially scraped (fetched OK but zero jobs found) more than `staleMs` ago —
// i.e. candidates to (re)enqueue for a deep scan.
async function getCompaniesNeedingRescan(limit = 200, staleMs = 7 * 24 * 60 * 60 * 1000) {
  const rows = await all(`
    SELECT id FROM companies
    WHERE website IS NOT NULL AND website != ''
      AND (
        scrape_status IN ('never', 'failed')
        OR (scrape_status = 'partial' AND (last_scrape_attempt_at IS NULL OR last_scrape_attempt_at < @cutoff))
      )
    ORDER BY last_scrape_attempt_at ASC NULLS FIRST
    LIMIT @limit
  `, { cutoff: nowMs() - staleMs, limit });
  return rows.map(r => r.id);
}

async function updateTeam(id, team) {
  await run(`UPDATE companies SET team = @team, updated_at = @now WHERE id = @id`, {
    id, team: JSON.stringify(team || []), now: nowMs(),
  });
}

async function getUserCompanyStatus(userId, companyId) {
  const row = await get(
    `SELECT status, notes, user_rating FROM user_company_status WHERE user_id = @user_id AND company_id = @company_id`,
    { user_id: userId, company_id: companyId },
  );
  return row || { status: 'none', notes: '', user_rating: 0 };
}

async function upsertUserCompanyStatus(userId, companyId, patch) {
  const current = await getUserCompanyStatus(userId, companyId);
  const merged = { ...current, ...patch };
  await run(`
    INSERT INTO user_company_status (user_id, company_id, status, notes, user_rating, updated_at)
    VALUES (@user_id, @company_id, @status, @notes, @user_rating, @now)
    ON CONFLICT(user_id, company_id) DO UPDATE SET
      status      = excluded.status,
      notes       = excluded.notes,
      user_rating = excluded.user_rating,
      updated_at  = excluded.updated_at
  `, {
    user_id: userId, company_id: companyId,
    status: merged.status, notes: merged.notes, user_rating: merged.user_rating,
    now: nowMs(),
  });
}

async function setCompanyStatus(userId, companyId, status) {
  await upsertUserCompanyStatus(userId, companyId, { status });
}
async function setCompanyNotes(userId, companyId, notes) {
  await upsertUserCompanyStatus(userId, companyId, { notes });
}
async function setCompanyUserRating(userId, companyId, rating) {
  await upsertUserCompanyStatus(userId, companyId, { user_rating: rating });
}

// --- interactions (learning signal) ---

async function recordInteraction(userId, companyId, action) {
  await run(
    `INSERT INTO interactions (user_id, company_id, action, created_at) VALUES (@user_id, @company_id, @action, @now)`,
    { user_id: userId, company_id: companyId, action, now: nowMs() },
  );
}

async function getAllInteractionsWithCompany(userId) {
  return all(`
    SELECT i.company_id, i.action, i.created_at, c.cats, c.opportunities, c.type,
           c.email IS NOT NULL AND c.email != '' AS has_email,
           c.email_verified, c.careers_url IS NOT NULL AS has_careers_url
    FROM interactions i
    JOIN companies c ON c.id = i.company_id
    WHERE i.user_id = @user_id
    ORDER BY i.created_at ASC
  `, { user_id: userId });
}

async function getInteractionsForCompany(userId, companyId) {
  return all(
    `SELECT action, created_at FROM interactions WHERE user_id = @user_id AND company_id = @company_id ORDER BY created_at DESC`,
    { user_id: userId, company_id: companyId },
  );
}

// --- job quality (fake/scam detection) ---

async function setJobQuality(jobId, score, flags = []) {
  await run(`
    INSERT INTO job_quality (job_id, score, flags, checked_at)
    VALUES (@job_id, @score, @flags, @now)
    ON CONFLICT(job_id) DO UPDATE SET score = excluded.score, flags = excluded.flags, checked_at = excluded.checked_at
  `, { job_id: jobId, score, flags: JSON.stringify(flags), now: nowMs() });
}

async function getJobQuality(jobId) {
  const row = await get(`SELECT * FROM job_quality WHERE job_id = @job_id`, { job_id: jobId });
  if (!row) return null;
  return { score: row.score, flags: safeJSON(row.flags, []), checked_at: row.checked_at };
}

async function getJobQualityForCompany(companyId) {
  const rows = await all(
    `SELECT job_id, score, flags FROM job_quality WHERE job_id IN (SELECT id FROM jobs WHERE company_id = @company_id)`,
    { company_id: companyId },
  );
  return rows.map(r => ({ job_id: r.job_id, score: r.score, flags: safeJSON(r.flags, []) }));
}

// --- AI fit scores (LLM cache) ---

async function getAiFitScore(userId, companyId, jobId, profileHash) {
  const row = await get(`
    SELECT score, reason, created_at FROM ai_fit_scores
    WHERE user_id = @user_id AND company_id = @company_id AND job_id IS NOT DISTINCT FROM @job_id AND profile_hash = @profile_hash
  `, { user_id: userId, company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash });
  return row || null;
}

async function setAiFitScore(userId, companyId, jobId, profileHash, score, reason) {
  await run(`
    INSERT INTO ai_fit_scores (user_id, company_id, job_id, profile_hash, score, reason, created_at)
    VALUES (@user_id, @company_id, @job_id, @profile_hash, @score, @reason, @now)
    ON CONFLICT(user_id, company_id, job_id, profile_hash) DO UPDATE SET score = excluded.score, reason = excluded.reason, created_at = excluded.created_at
  `, { user_id: userId, company_id: companyId, job_id: jobId ?? null, profile_hash: profileHash, score, reason: reason || null, now: nowMs() });
}

// --- learned preference weights ---

async function getLearnedWeights(userId) {
  const rows = await all(`SELECT feature_key, weight, sample_count FROM learned_weights WHERE user_id = @user_id`, { user_id: userId || '' });
  const out = {};
  for (const row of rows) out[row.feature_key] = { weight: row.weight, sample_count: row.sample_count };
  return out;
}

async function setLearnedWeight(userId, featureKey, weight, sampleCount) {
  await run(`
    INSERT INTO learned_weights (user_id, feature_key, weight, sample_count, updated_at)
    VALUES (@user_id, @feature_key, @weight, @sample_count, @now)
    ON CONFLICT(user_id, feature_key) DO UPDATE SET weight = excluded.weight, sample_count = excluded.sample_count, updated_at = excluded.updated_at
  `, { user_id: userId, feature_key: featureKey, weight, sample_count: sampleCount, now: nowMs() });
}

async function setCompanyEmail(id, { email, email_source, email_verified }) {
  await run(`
    UPDATE companies
    SET email = @email, email_source = @email_source, email_verified = @email_verified, updated_at = @now
    WHERE id = @id
  `, { id, email: email || null, email_source: email_source || null, email_verified: email_verified ? 1 : 0, now: nowMs() });
}

// Every SELECT below joins in the requesting user's own status/notes/rating
// (user_company_status is per-user; companies itself is a shared discovery
// pool). userId is required.
const UCS_JOIN = `LEFT JOIN user_company_status ucs ON ucs.company_id = c.id AND ucs.user_id = @user_id`;
const UCS_COLS = `COALESCE(ucs.status, 'none') AS ucs_status, COALESCE(ucs.notes, '') AS ucs_notes, COALESCE(ucs.user_rating, 0) AS ucs_rating`;

async function getCompany(id, userId) {
  const row = await get(`SELECT c.*, ${UCS_COLS} FROM companies c ${UCS_JOIN} WHERE c.id = @id`, { id, user_id: userId || '' });
  return row ? hydrateCompany(row) : null;
}

async function listCompaniesInBounds({ south, west, north, east }, userId) {
  const rows = await all(`
    SELECT c.*, ${UCS_COLS} FROM companies c
    ${UCS_JOIN}
    WHERE c.lat BETWEEN @south AND @north AND c.lng BETWEEN @west AND @east
  `, { south, west, north, east, user_id: userId || '' });
  return rows.map(hydrateCompany);
}

async function listAllCompanies(userId) {
  const rows = await all(`SELECT c.*, ${UCS_COLS} FROM companies c ${UCS_JOIN} ORDER BY c.updated_at DESC`, { user_id: userId || '' });
  return rows.map(hydrateCompany);
}

async function listCompaniesByPipeline(kind, userId) {
  const params = { user_id: userId || '' };
  const rows = kind === 'applied'
    ? await all(`
        SELECT DISTINCT c.*, ${UCS_COLS} FROM companies c
        ${UCS_JOIN}
        LEFT JOIN jobs j ON j.company_id = c.id
        LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id
        WHERE ucs.status IN ('applied', 'interviewing', 'offer', 'rejected') OR uja.user_id IS NOT NULL
        ORDER BY c.updated_at DESC
      `, params)
    : await all(`
        SELECT c.*, ${UCS_COLS} FROM companies c
        ${UCS_JOIN}
        WHERE ucs.status = 'interested' ORDER BY ucs.updated_at DESC
      `, params);
  return rows.map(hydrateCompany);
}

function sanitizeStoredEmail(row) {
  const allEmails = safeJSON(row.all_emails, []).filter(e => e && !isBlockedEmail(e));
  const pool2 = [...new Set([row.email, ...allEmails].filter(Boolean))]
    .map(e => String(e).toLowerCase().trim())
    .filter(e => !isBlockedEmail(e));
  if (!pool2.length) return { email: null, email_source: null, email_verified: false };
  return pickTrustedEmail(pool2, row.website);
}

function hydrateCompany(row) {
  const emailFields = sanitizeStoredEmail(row);
  if (row.email_verified && row.email) {
    emailFields.email_verified = true;
    emailFields.email = row.email;
    if (row.email_source) emailFields.email_source = row.email_source;
  } else if (row.email_source === 'user_edited' && row.email) {
    // A human deliberately typed this in — the scraped-noise blocklist
    // (example.com, admin@, etc.) exists to filter auto-detected garbage,
    // not to second-guess an explicit manual entry.
    emailFields.email = row.email;
    emailFields.email_source = row.email_source;
    emailFields.email_verified = false;
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
    status: row.ucs_status ?? row.status ?? 'none',
    notes: row.ucs_notes ?? row.notes ?? '',
    user_rating: row.ucs_rating ?? row.user_rating ?? 0,
  };
}

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// --- jobs ---

async function upsertJob(j) {
  const { normalizeTitle } = require('./services/jobQualityService');
  const now = nowMs();
  await run(`
    INSERT INTO jobs (
      company_id, title, job_type, location, url, salary, source,
      department, description, description_full, detail_status,
      posted_at, closes_at, remote, fetched_at,
      title_norm, first_seen_at, removed_at, repost_count
    )
    VALUES (
      @company_id, @title, @job_type, @location, @url, @salary, @source,
      @department, @description, @description_full, @detail_status,
      @posted_at, @closes_at, @remote, @now,
      @title_norm, @first_seen_at, NULL, @repost_count
    )
    ON CONFLICT(company_id, title, url) DO UPDATE SET
      job_type      = excluded.job_type,
      location      = excluded.location,
      salary        = excluded.salary,
      source        = excluded.source,
      department    = excluded.department,
      description   = excluded.description,
      description_full = COALESCE(excluded.description_full, jobs.description_full),
      detail_status = COALESCE(excluded.detail_status, jobs.detail_status),
      posted_at     = COALESCE(excluded.posted_at, jobs.posted_at),
      closes_at     = COALESCE(excluded.closes_at, jobs.closes_at),
      remote        = excluded.remote,
      fetched_at    = excluded.fetched_at,
      title_norm    = excluded.title_norm,
      first_seen_at = COALESCE(jobs.first_seen_at, excluded.first_seen_at),
      repost_count  = jobs.repost_count + CASE WHEN jobs.removed_at IS NOT NULL THEN 1 ELSE 0 END,
      removed_at    = NULL
  `, {
    company_id: j.company_id,
    title: j.title,
    job_type: j.job_type || null,
    location: j.location || null,
    url: j.url || null,
    salary: j.salary || null,
    source: j.source || 'careers-page',
    department: j.department || null,
    description: j.description || null,
    description_full: j.description_full || null,
    detail_status: j.detail_status || null,
    posted_at: j.posted_at || null,
    closes_at: j.closes_at || null,
    remote: j.remote ? 1 : 0,
    now,
    title_norm: j.title_norm ?? normalizeTitle(j.title),
    first_seen_at: j.first_seen_at ?? (j.posted_at || now),
    repost_count: j.repost_count ?? 0,
  });
}

const JOB_UJA_JOIN = `LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id`;
const JOB_UJA_COLS = `(uja.user_id IS NOT NULL) AS uja_applied, uja.applied_at AS uja_applied_at`;

function hydrateJob(row) {
  if (!row) return row;
  const out = { ...row, applied: row.uja_applied ? 1 : 0, applied_at: row.uja_applied_at ?? null };
  // Training-corpus payload, not UI payload — up to 20k chars per job would
  // bloat every company panel open. The corpus export reads it by its own
  // query (getJobCorpus); the UI keeps the snippet `description`.
  delete out.description_full;
  return out;
}

async function listJobsForCompany(companyId, userId) {
  const rows = await all(`
    SELECT j.*, ${JOB_UJA_COLS} FROM jobs j
    ${JOB_UJA_JOIN}
    WHERE j.company_id = @company_id ORDER BY j.id ASC
  `, { company_id: companyId, user_id: userId || '' });
  return rows.map(hydrateJob);
}

// Batch-loads jobs for many companies in one query. Returns a Map of
// company_id -> jobs[].
async function jobsGroupedFor(ids, userId) {
  const map = new Map();
  const unique = [...new Set((ids || []).filter(v => v != null))];
  if (!unique.length) return map;
  const rows = await all(`
    SELECT j.*, (uja.user_id IS NOT NULL) AS uja_applied, uja.applied_at AS uja_applied_at
    FROM jobs j
    LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id
    WHERE j.company_id = ANY(@ids) ORDER BY j.company_id, j.id ASC
  `, { user_id: userId || '', ids: unique });
  for (const r of rows.map(hydrateJob)) {
    let arr = map.get(r.company_id);
    if (!arr) { arr = []; map.set(r.company_id, arr); }
    arr.push(r);
  }
  return map;
}

async function setJobApplied(userId, id, applied) {
  if (applied) {
    await run(`
      INSERT INTO user_job_applied (user_id, job_id, applied_at) VALUES (@user_id, @job_id, @now)
      ON CONFLICT(user_id, job_id) DO UPDATE SET applied_at = excluded.applied_at
    `, { user_id: userId, job_id: id, now: nowMs() });
  } else {
    await run(`DELETE FROM user_job_applied WHERE user_id = @user_id AND job_id = @job_id`, { user_id: userId, job_id: id });
  }
}

async function getJob(id, userId) {
  const row = await get(`SELECT j.*, ${JOB_UJA_COLS} FROM jobs j ${JOB_UJA_JOIN} WHERE j.id = @id`, { id, user_id: userId || '' });
  return hydrateJob(row);
}

// A job still counts as "applied" if any user has an application row for it
// — jobs.applied itself is dead (never written; applied-tracking lives in
// user_job_applied) and must never gate deletion/removal decisions.
const JOB_NOT_APPLIED = `NOT EXISTS (SELECT 1 FROM user_job_applied uja WHERE uja.job_id = jobs.id)`;

// Soft-removes jobs missing from a fresh scrape instead of hard-deleting
// them, so a later repost (possibly under a new listing URL) can still be
// recognized as the same underlying role rather than scored as brand new.
// Applied jobs are never touched, soft-removed, or pruned.
async function syncJobsForCompany(companyId, jobs, { ok = true } = {}) {
  if (!ok) return;
  const { normalizeTitle, REPOST_RETENTION_MS } = require('./services/jobQualityService');
  const now = nowMs();
  const cutoff = now - REPOST_RETENTION_MS;
  const incoming = jobs || [];
  const keyOf = j => `${j.title || ''} ${j.url || ''}`;
  const incomingKeys = new Set(incoming.map(keyOf));

  const active = await all(`
    SELECT id, title, url FROM jobs
    WHERE company_id = @company_id AND removed_at IS NULL AND ${JOB_NOT_APPLIED}
  `, { company_id: companyId });
  const staleIds = active.filter(r => !incomingKeys.has(keyOf(r))).map(r => r.id);
  if (staleIds.length) {
    await run(`UPDATE jobs SET removed_at = @now WHERE id = ANY(@ids)`, { now, ids: staleIds });
  }

  for (const j of incoming) {
    const title_norm = normalizeTitle(j.title);
    // Same role, reposted under a new URL: only ever matched against rows
    // that have already vanished from a scan, so two concurrently-open
    // jobs with similar titles never collide with each other.
    const prior = await get(`
      SELECT id, first_seen_at, repost_count FROM jobs
      WHERE company_id = @company_id
        AND title_norm = @title_norm
        AND removed_at IS NOT NULL
        AND removed_at >= @cutoff
        AND NOT (title = @title AND url IS NOT DISTINCT FROM @url)
      ORDER BY removed_at DESC LIMIT 1
    `, { company_id: companyId, title_norm, cutoff, title: j.title, url: j.url || null });

    await upsertJob({
      company_id: companyId,
      ...j,
      title_norm,
      first_seen_at: prior ? prior.first_seen_at : undefined,
      repost_count: prior ? prior.repost_count + 1 : undefined,
    });
    // Merge the stale lineage into the new row rather than forking history.
    if (prior) await run(`DELETE FROM jobs WHERE id = @id`, { id: prior.id });
  }

  // Opportunistic pruning bounds table growth without a separate cron —
  // rides along on every sync instead.
  await run(`
    DELETE FROM jobs
    WHERE company_id = @company_id AND removed_at IS NOT NULL AND removed_at < @cutoff AND ${JOB_NOT_APPLIED}
  `, { company_id: companyId, cutoff });

  await scoreJobsForCompany(companyId);
}

// Runs the (cheap, local, no network) fake/scam-signal scorer over every job
// currently stored for a company and persists the result. Called right
// after jobs are synced so a quality score/flags are ready by the time the
// frontend asks for them — never on the request path itself. Also
// self-heals title_norm/first_seen_at on any row predating those columns.
async function scoreJobsForCompany(companyId) {
  const { scoreJobQuality, normalizeTitle } = require('./services/jobQualityService');
  const { detectVisaFlagForJob } = require('./services/visaDetectionService');
  const company = await get(`SELECT * FROM companies WHERE id = @id`, { id: companyId });
  const freshJobs = await all(`SELECT * FROM jobs WHERE company_id = @company_id ORDER BY id ASC`, { company_id: companyId });
  for (const job of freshJobs) {
    const { score, flags } = scoreJobQuality(job, company);
    await setJobQuality(job.id, score, flags);
    await run(`
      UPDATE jobs SET
        visa_flag     = @visa_flag,
        title_norm    = COALESCE(title_norm, @title_norm),
        first_seen_at = COALESCE(first_seen_at, posted_at, fetched_at)
      WHERE id = @id
    `, { visa_flag: detectVisaFlagForJob(job), id: job.id, title_norm: normalizeTitle(job.title) });
  }
}

// --- scans ---

async function recordScan({ south, west, north, east, provider, resultCount }, userId) {
  await run(`
    INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at)
    VALUES (@south, @west, @north, @east, @provider, @result_count, @user_id, @now)
  `, { south, west, north, east, provider, result_count: resultCount, user_id: userId || null, now: nowMs() });
}

// Most recent Google-provider scan whose bbox fully contains the requested
// one, within the last `sinceMs`. A hit means "we already have fresh data
// for this exact area" — deliberately simple containment (not partial-
// overlap merging): if the new request extends beyond any single prior
// scan's coverage, that's correctly a miss and a real provider call happens.
async function getRecentCoveringScan({ south, west, north, east }, sinceMs) {
  return get(`
    SELECT * FROM scans
    WHERE provider = 'google'
      AND south <= @south AND north >= @north
      AND west <= @west AND east >= @east
      AND created_at > @since
    ORDER BY created_at DESC
    LIMIT 1
  `, { south, west, north, east, since: sinceMs });
}

async function getScanStats() {
  const recent = await all(`
    SELECT s.*, u.email AS user_email FROM scans s
    LEFT JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC LIMIT 10
  `);
  const totals = await get(`SELECT COUNT(*) AS scan_count, COALESCE(SUM(result_count), 0) AS total_found FROM scans`);
  return { recent, totals };
}

// --- job alerts ---

// Users eligible for a job-alert email about something at (lat,lng): email
// verified, not suspended, alerts on, and — the actual "right place" signal
// — they've previously scanned an area whose bounding box contains this
// point. Mirrors listCompaniesInBounds's bbox-containment check, just in
// the other direction (scans containing a point, not companies inside a box).
async function getCandidateUsersForLocation(lat, lng) {
  return all(`
    SELECT DISTINCT u.id, u.email, u.profile_json, u.last_alert_sent_at, u.unsubscribe_token
    FROM users u
    JOIN scans s ON s.user_id = u.id
    WHERE u.email_verified = 1 AND u.alerts_enabled = 1 AND u.suspended = 0
      AND @lat BETWEEN s.south AND s.north
      AND @lng BETWEEN s.west AND s.east
  `, { lat, lng });
}

// One row per (user, job) match, forever — ON CONFLICT DO NOTHING makes this
// safe to call repeatedly across overlapping check windows, and a job is
// never re-notified to the same user even after it's been part of a sent
// digest (sent_at is set once and never cleared).
async function recordJobAlertMatch(userId, jobId) {
  await run(`
    INSERT INTO job_alerts (user_id, job_id, matched_at)
    VALUES (@user_id, @job_id, @now)
    ON CONFLICT (user_id, job_id) DO NOTHING
  `, { user_id: userId, job_id: jobId, now: nowMs() });
}

async function getUsersWithUnsentAlerts() {
  return all(`
    SELECT DISTINCT u.id, u.email, u.last_alert_sent_at, u.unsubscribe_token
    FROM users u
    JOIN job_alerts ja ON ja.user_id = u.id AND ja.sent_at IS NULL
  `);
}

async function getUnsentAlertsForUser(userId) {
  return all(`
    SELECT j.id AS job_id, j.title, j.location, j.url, c.name AS company_name
    FROM job_alerts ja
    JOIN jobs j ON j.id = ja.job_id
    JOIN companies c ON c.id = j.company_id
    WHERE ja.user_id = @user_id AND ja.sent_at IS NULL
    ORDER BY ja.matched_at ASC
  `, { user_id: userId });
}

async function markAlertsSent(userId, jobIds) {
  if (!jobIds?.length) return;
  await run(
    `UPDATE job_alerts SET sent_at = @now WHERE user_id = @user_id AND job_id = ANY(@job_ids)`,
    { user_id: userId, job_ids: jobIds, now: nowMs() },
  );
  await run(`UPDATE users SET last_alert_sent_at = @now WHERE id = @id`, { id: userId, now: nowMs() });
}

async function setAlertsEnabled(userId, enabled) {
  await run(`UPDATE users SET alerts_enabled = @enabled, updated_at = @now WHERE id = @id`,
    { id: userId, enabled: enabled ? 1 : 0, now: nowMs() });
}

async function setUnsubscribeToken(userId, token) {
  await run(`UPDATE users SET unsubscribe_token = @token WHERE id = @id`, { id: userId, token });
}

async function getUserByUnsubscribeToken(token) {
  return get(`SELECT * FROM users WHERE unsubscribe_token = @token`, { token });
}

async function setTrainingDataConsent(userId, enabled) {
  await run(`UPDATE users SET training_data_consent = @enabled, updated_at = @now WHERE id = @id`,
    { id: userId, enabled: enabled ? 1 : 0, now: nowMs() });
}

async function setThemePreference(userId, value) {
  await run(`UPDATE users SET theme_preference = @value, updated_at = @now WHERE id = @id`,
    { id: userId, value, now: nowMs() });
}

// Only consenting users' rows — the query itself is the enforcement point
// for the opt-in requirement, not just an application-layer check.
async function getConsentingLearnedWeights() {
  return all(`
    SELECT lw.user_id, lw.feature_key, lw.weight, lw.sample_count
    FROM learned_weights lw
    JOIN users u ON u.id = lw.user_id
    WHERE u.training_data_consent = 1
  `);
}

// Raw interaction events for consenting users only — exported pseudonymized
// and day-coarsened by trainingExportService, never with real ids/timestamps.
// Company is reduced to its category list + type: enough signal for preference
// training, not enough to re-identify a person from a trail of specific
// companies.
async function getConsentingInteractions() {
  return all(`
    SELECT i.user_id, i.action, i.created_at,
           c.cats AS company_cats, c.type AS company_type
    FROM interactions i
    JOIN users u ON u.id = i.user_id
    JOIN companies c ON c.id = i.company_id
    WHERE u.training_data_consent = 1
    ORDER BY i.created_at
  `);
}

// Job-posting corpus for training: public posting content only, joined to the
// company's industry — deliberately no company_id/name and no per-user columns.
async function getJobCorpus() {
  return all(`
    SELECT j.title, j.title_norm, COALESCE(j.description_full, j.description) AS description,
           j.salary, j.job_type, j.location, j.remote, j.posted_at, j.closes_at,
           j.source, j.repost_count, j.detail_status,
           c.cats AS company_cats, c.type AS company_type
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    WHERE COALESCE(j.description_full, j.description) IS NOT NULL
  `);
}

async function getAreaJobCorpus() {
  return all(`
    SELECT title, company_name, COALESCE(description_full, description) AS description,
           salary, job_type, location, suburb, state, remote, posted_at, closes_at,
           source, visa_flag, detail_status
    FROM area_jobs
    WHERE COALESCE(description_full, description) IS NOT NULL
  `);
}

// Upsert a batch of enriched area-board jobs, keyed by posting URL. Reposts
// of the same URL just refresh last_seen_at; content columns take the newest
// non-null value so a later successful detail fetch upgrades an old snippet
// row rather than being ignored.
async function saveAreaJobs(jobs, suburb, state) {
  const now = nowMs();
  for (const j of jobs || []) {
    if (!j?.url || !j?.title) continue;
    await run(`
      INSERT INTO area_jobs (
        url, title, company_name, location, suburb, state, description,
        description_full, salary, job_type, posted_at, closes_at, remote,
        source, visa_flag, detail_status, first_seen_at, last_seen_at
      ) VALUES (
        @url, @title, @company_name, @location, @suburb, @state, @description,
        @description_full, @salary, @job_type, @posted_at, @closes_at, @remote,
        @source, @visa_flag, @detail_status, @now, @now
      )
      ON CONFLICT(url) DO UPDATE SET
        title            = excluded.title,
        company_name     = COALESCE(excluded.company_name, area_jobs.company_name),
        location         = COALESCE(excluded.location, area_jobs.location),
        description      = COALESCE(excluded.description, area_jobs.description),
        description_full = COALESCE(excluded.description_full, area_jobs.description_full),
        salary           = COALESCE(excluded.salary, area_jobs.salary),
        job_type         = COALESCE(excluded.job_type, area_jobs.job_type),
        posted_at        = COALESCE(excluded.posted_at, area_jobs.posted_at),
        closes_at        = COALESCE(excluded.closes_at, area_jobs.closes_at),
        remote           = GREATEST(excluded.remote, area_jobs.remote),
        visa_flag        = COALESCE(excluded.visa_flag, area_jobs.visa_flag),
        detail_status    = CASE WHEN excluded.detail_status = 'full' THEN 'full'
                                ELSE COALESCE(area_jobs.detail_status, excluded.detail_status) END,
        last_seen_at     = excluded.last_seen_at
    `, {
      url: j.url,
      title: j.title,
      company_name: j.company_name || null,
      location: j.location || null,
      suburb: suburb || null,
      state: state || null,
      description: j.description || null,
      description_full: j.description_full || null,
      salary: j.salary || null,
      job_type: j.job_type || null,
      posted_at: j.posted_at || null,
      closes_at: j.closes_at || null,
      remote: j.remote ? 1 : 0,
      source: j.source || 'board',
      visa_flag: j.visa_flag || null,
      detail_status: j.detail_status || null,
      now,
    });
  }
}

// Jobs freshly synced within the lookback window, joined to their company —
// the candidate set the alert-check job matches against.
async function getRecentlyFetchedJobsWithCompany(sinceMs) {
  return all(`
    SELECT j.id AS job_id, j.title AS job_title, j.location AS job_location,
           c.id AS company_id, c.name AS company_name, c.lat, c.lng, c.opportunities
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    WHERE j.fetched_at > @since
  `, { since: sinceMs });
}

// Pipeline funnel across every user (admin overview).
async function getStatusCounts() {
  const rows = await all(`SELECT status, COUNT(*) AS n FROM user_company_status GROUP BY status`);
  const out = { none: 0, interested: 0, applied: 0, interviewing: 0, offer: 0, rejected: 0, skipped: 0 };
  let touched = 0;
  for (const row of rows) {
    if (row.status !== 'none') { out[row.status] = Number(row.n); touched += Number(row.n); }
  }
  const companyCount = await get(`SELECT COUNT(*) AS n FROM companies`);
  out.none = Math.max(0, (Number(companyCount.n) || 0) - touched);
  return out;
}

async function getJobQualityStats() {
  const row = await get(`
    SELECT COUNT(*) AS total, AVG(score) AS avg_score, SUM(CASE WHEN score < 0.4 THEN 1 ELSE 0 END) AS suspicious_count
    FROM job_quality
  `);
  return { total: Number(row.total) || 0, avg_score: row.avg_score || null, suspicious_count: Number(row.suspicious_count) || 0 };
}

async function getAiFitUsageStats() {
  const row = await get(`SELECT COUNT(*) AS total, AVG(score) AS avg_score FROM ai_fit_scores`);
  return { total: Number(row.total) || 0, avg_score: row.avg_score || null };
}

// --- admin analytics (time series + breakdowns for the dashboard) ---

// Builds one row per day for the trailing `days` days (UTC calendar days),
// filling in zero for days with no matching rows, so the chart never has to
// guess at gaps in the x-axis.
function fillDays(rows, days) {
  const byDay = new Map(rows.map(r => [r.day, Number(r.n)]));
  const out = [];
  const now = nowMs();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, n: byDay.get(day) || 0 });
  }
  return out;
}

async function getSignupsSeries(days) {
  const since = nowMs() - days * 86400000;
  const rows = await all(`
    SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM users WHERE created_at >= @since GROUP BY day
  `, { since });
  return fillDays(rows, days);
}

async function getScansSeries(days) {
  const since = nowMs() - days * 86400000;
  const rows = await all(`
    SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM scans WHERE created_at >= @since GROUP BY day
  `, { since });
  return fillDays(rows, days);
}

async function getInteractionsSeries(days, action) {
  const since = nowMs() - days * 86400000;
  const rows = await all(`
    SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day, COUNT(*) AS n
    FROM interactions WHERE created_at >= @since AND action = @action GROUP BY day
  `, { since, action });
  return fillDays(rows, days);
}

// Parses companies.cats (JSON array of category slugs) in JS since there's
// no native JSON array aggregation used elsewhere in this file; folds
// everything past `limit` into a single "other" bucket rather than a long
// tail of 1-count categories.
async function getIndustryBreakdown(limit = 8) {
  const rows = await all(`SELECT cats FROM companies`);
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

async function getProviderBreakdown() {
  const rows = await all(`SELECT provider, COUNT(*) AS n FROM scans GROUP BY provider ORDER BY n DESC`);
  return rows.map(r => ({ provider: r.provider, n: Number(r.n) }));
}

async function getJobSourceBreakdown() {
  const rows = await all(`
    SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS n
    FROM jobs GROUP BY source ORDER BY n DESC
  `);
  return rows.map(r => ({ source: r.source, n: Number(r.n) }));
}

async function getDataQualityStats() {
  const row = await get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) AS with_email,
      SUM(CASE WHEN email_verified = 1 THEN 1 ELSE 0 END) AS verified_email,
      SUM(CASE WHEN team IS NOT NULL AND team != '[]' THEN 1 ELSE 0 END) AS with_team,
      SUM(CASE WHEN website IS NOT NULL AND website != '' THEN 1 ELSE 0 END) AS with_website
    FROM companies
  `);
  const jobsRow = await get(`SELECT COUNT(DISTINCT company_id) AS n FROM jobs`);
  return {
    total: Number(row.total) || 0,
    with_email: Number(row.with_email) || 0,
    verified_email: Number(row.verified_email) || 0,
    with_team: Number(row.with_team) || 0,
    with_website: Number(row.with_website) || 0,
    with_jobs: Number(jobsRow.n) || 0,
  };
}

// Buckets job_quality.score (0..1) into the four fixed status tiers so the
// admin chart can reuse the same reserved status palette as the rest of the
// product instead of an arbitrary sequential ramp.
async function getQualityBuckets() {
  const rows = await all(`SELECT score FROM job_quality`);
  const b = { critical: 0, serious: 0, warning: 0, good: 0 };
  for (const { score } of rows) {
    if (score < 0.25) b.critical++;
    else if (score < 0.5) b.serious++;
    else if (score < 0.75) b.warning++;
    else b.good++;
  }
  return b;
}

async function getAiFitBuckets() {
  const rows = await all(`SELECT score FROM ai_fit_scores`);
  const b = { critical: 0, serious: 0, warning: 0, good: 0 };
  for (const { score } of rows) {
    if (score < 25) b.critical++;
    else if (score < 50) b.serious++;
    else if (score < 75) b.warning++;
    else b.good++;
  }
  return b;
}

async function getTopCompaniesByInterest(limit = 8) {
  const rows = await all(`
    SELECT c.name AS name, COUNT(*) AS n
    FROM user_company_status ucs JOIN companies c ON c.id = ucs.company_id
    WHERE ucs.status IN ('interested', 'applied')
    GROUP BY ucs.company_id, c.name ORDER BY n DESC LIMIT @limit
  `, { limit });
  return rows.map(r => ({ name: r.name, n: Number(r.n) }));
}

async function getAnalytics(days = 30) {
  days = Math.max(1, Math.min(90, Number(days) || 30));
  const [
    signups_series, scans_series, applied_series, industries, providers,
    job_sources, data_quality, quality_buckets, ai_fit_buckets, top_companies,
  ] = await Promise.all([
    getSignupsSeries(days),
    getScansSeries(days),
    getInteractionsSeries(days, 'applied'),
    getIndustryBreakdown(8),
    getProviderBreakdown(),
    getJobSourceBreakdown(),
    getDataQualityStats(),
    getQualityBuckets(),
    getAiFitBuckets(),
    getTopCompaniesByInterest(8),
  ]);
  return {
    days, signups_series, scans_series, applied_series, industries, providers,
    job_sources, data_quality, quality_buckets, ai_fit_buckets, top_companies,
  };
}

// One-time repair: local businesses (restaurants, shops) were sometimes tagged
// ai/marketing from Linktree promos in scraped page text. Re-derive sector tags
// from name + type only. Runs once at boot (see index.js) — a handful of
// sequential awaits over the full companies/jobs table is fine at that scale
// and only that cadence.
async function repairBogusScrapedJobs() {
  const { isFakeMarketingTitle, isSpecificJobUrl } = require('./services/jobsService');
  const rows = await all(`
    SELECT j.id, j.title, j.url, j.applied, c.website
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    WHERE j.source = 'careers-page' AND j.applied = 0
  `);
  let removed = 0;
  for (const r of rows) {
    const base = r.website || r.url || '';
    if (isFakeMarketingTitle(r.title) || !isSpecificJobUrl(r.url, base)) {
      await run(`DELETE FROM jobs WHERE id = @id`, { id: r.id });
      removed++;
    }
  }
  if (removed) console.log(`[repair] removed ${removed} bogus scraped job listing(s)`);
}

async function repairBogusTeamMembers() {
  const { isValidTeamMember } = require('./services/teamTrustService');
  const rows = await all(`SELECT id, team FROM companies WHERE team IS NOT NULL AND team != '[]'`);
  let fixed = 0;
  for (const row of rows) {
    const team = safeJSON(row.team, []);
    const cleaned = team.filter(isValidTeamMember);
    if (cleaned.length !== team.length) {
      await run(`UPDATE companies SET team = @team, updated_at = @now WHERE id = @id`, {
        team: JSON.stringify(cleaned), now: nowMs(), id: row.id,
      });
      fixed += team.length - cleaned.length;
    }
  }
  if (fixed) console.log(`[repair] removed ${fixed} bogus team/location entr${fixed === 1 ? 'y' : 'ies'}`);
}

async function repairOpportunityTargetClassification() {
  const { reclassifyStored, isOpportunityTarget, inferOpportunities } = require('./services/classifyService');
  const rows = await all(`SELECT id, name, type, cats, opportunities FROM companies`);
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
      await run(`
        UPDATE companies SET cats = @cats, skills = @skills, icon = @icon, color = @color, opportunities = @opportunities, updated_at = @now
        WHERE id = @id
      `, {
        cats: JSON.stringify(fresh.cats),
        skills: JSON.stringify(fresh.skills),
        icon: fresh.icon,
        color: fresh.color,
        opportunities: JSON.stringify(freshOpps),
        now: nowMs(),
        id: row.id,
      });
      fixed++;
    }
  }
  if (fixed) console.log(`[db] Reclassified ${fixed} local businesses`);
  return fixed;
}

// --- users (email/password auth + onboarding profiles) ---

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
    emailVerified: !!row.email_verified,
    alertsEnabled: row.alerts_enabled == null ? true : !!row.alerts_enabled,
    trainingDataConsent: !!row.training_data_consent,
    themePreference: row.theme_preference || 'dark',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function upsertUser({ id, email, profile = {}, onboardingComplete = false }) {
  const normalized = email.toLowerCase().trim();
  await run(`
    INSERT INTO users (id, email, profile_json, onboarding_complete, created_at, updated_at)
    VALUES (@id, @email, @profile_json, @onboarding_complete, @now, @now)
    ON CONFLICT(email) DO UPDATE SET
      profile_json        = excluded.profile_json,
      onboarding_complete  = excluded.onboarding_complete,
      updated_at           = excluded.updated_at
  `, {
    id, email: normalized, profile_json: JSON.stringify(profile),
    onboarding_complete: onboardingComplete ? 1 : 0, now: nowMs(),
  });
  return getUserByEmail(normalized);
}

async function getUserByEmail(email) {
  const row = await get(`SELECT * FROM users WHERE email = @email`, { email: String(email || '').toLowerCase().trim() });
  return hydrateUser(row);
}

async function getUserById(id) {
  const row = await get(`SELECT * FROM users WHERE id = @id`, { id });
  return hydrateUser(row);
}

async function setPasswordHash(userId, hash) {
  await run(`UPDATE users SET password_hash = @password_hash, updated_at = @now WHERE id = @id`, {
    password_hash: hash, now: nowMs(), id: userId,
  });
}

async function setEmailVerifyToken(userId, token, expiresAt) {
  await run(
    `UPDATE users SET email_verify_token = @token, email_verify_expires = @expires, updated_at = @now WHERE id = @id`,
    { token, expires: expiresAt, now: nowMs(), id: userId },
  );
}

// Verifies + consumes the token in one step (clears it either way so it
// can't be replayed) — returns the now-verified user, or null if the token
// doesn't match any account or has expired.
async function verifyEmailByToken(token) {
  const row = await get(
    `SELECT * FROM users WHERE email_verify_token = @token AND email_verify_expires > @now`,
    { token, now: nowMs() },
  );
  if (!row) return null;
  await run(
    `UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires = NULL, updated_at = @now WHERE id = @id`,
    { now: nowMs(), id: row.id },
  );
  return hydrateUser(row);
}

// --- admin: user management ---

async function getAllUsersWithStats() {
  const rows = await all(`
    SELECT u.id, u.email, u.profile_json, u.onboarding_complete, u.suspended, u.created_at, u.updated_at,
      (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'interested') AS saved_count,
      (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'applied') AS applied_count,
      (SELECT COUNT(*) FROM user_company_status ucs WHERE ucs.user_id = u.id AND ucs.status = 'skipped') AS skipped_count,
      (SELECT COUNT(*) FROM interactions i WHERE i.user_id = u.id) AS interaction_count
    FROM users u
    ORDER BY u.created_at DESC
  `);
  return rows.map(row => ({
    ...hydrateUser(row),
    savedCount: Number(row.saved_count),
    appliedCount: Number(row.applied_count),
    skippedCount: Number(row.skipped_count),
    interactionCount: Number(row.interaction_count),
  }));
}

async function setUserSuspended(id, suspended) {
  await run(`UPDATE users SET suspended = @suspended, updated_at = @now WHERE id = @id`, {
    suspended: suspended ? 1 : 0, now: nowMs(), id,
  });
}

async function recordAdminAction(action, target, detail, actorIp) {
  await run(
    `INSERT INTO admin_actions (action, target, detail, actor_ip, created_at) VALUES (@action, @target, @detail, @actor_ip, @now)`,
    { action, target: target || null, detail: detail || null, actor_ip: actorIp || null, now: nowMs() },
  );
}

async function getAdminActions(limit = 100) {
  return all(`SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT @limit`, { limit });
}

async function deleteUser(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_company_status WHERE user_id = $1', [id]);
    await client.query('DELETE FROM interactions WHERE user_id = $1', [id]);
    await client.query('DELETE FROM learned_weights WHERE user_id = $1', [id]);
    await client.query('DELETE FROM ai_fit_scores WHERE user_id = $1', [id]);
    await client.query('DELETE FROM user_job_applied WHERE user_id = $1', [id]);
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  ready,
  pool, // exposed for test cleanup only — app code should go through the named functions above
  upsertCompany,
  updateEnrichment,
  updateScrapeStatus,
  getCompaniesNeedingRescan,
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
  getRecentCoveringScan,
  getCandidateUsersForLocation,
  recordJobAlertMatch,
  getUsersWithUnsentAlerts,
  getUnsentAlertsForUser,
  markAlertsSent,
  setAlertsEnabled,
  setUnsubscribeToken,
  getUserByUnsubscribeToken,
  setTrainingDataConsent,
  setThemePreference,
  getConsentingLearnedWeights,
  getConsentingInteractions,
  getJobCorpus,
  getAreaJobCorpus,
  saveAreaJobs,
  getRecentlyFetchedJobsWithCompany,
  getTeam,
  updateTeam,
  repairBogusScrapedJobs,
  repairBogusTeamMembers,
  repairOpportunityTargetClassification,
  upsertUser,
  getUserByEmail,
  getUserById,
  setPasswordHash,
  setEmailVerifyToken,
  verifyEmailByToken,
  getAllUsersWithStats,
  setUserSuspended,
  deleteUser,
  recordAdminAction,
  getAdminActions,
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
