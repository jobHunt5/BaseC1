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
        WHERE ucs.status = 'applied' OR uja.user_id IS NOT NULL
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
  await run(`
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
    posted_at: j.posted_at || null,
    closes_at: j.closes_at || null,
    remote: j.remote ? 1 : 0,
    now: nowMs(),
  });
}

const JOB_UJA_JOIN = `LEFT JOIN user_job_applied uja ON uja.job_id = j.id AND uja.user_id = @user_id`;
const JOB_UJA_COLS = `(uja.user_id IS NOT NULL) AS uja_applied, uja.applied_at AS uja_applied_at`;

function hydrateJob(row) {
  if (!row) return row;
  return { ...row, applied: row.uja_applied ? 1 : 0, applied_at: row.uja_applied_at ?? null };
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

async function syncJobsForCompany(companyId, jobs, { ok = true, replace = false } = {}) {
  if (!ok) return;
  if (replace) await run(`DELETE FROM jobs WHERE company_id = @company_id AND applied = 0`, { company_id: companyId });
  if (!jobs || jobs.length === 0) return;
  if (!replace) await run(`DELETE FROM jobs WHERE company_id = @company_id AND applied = 0`, { company_id: companyId });
  for (const j of jobs) {
    await upsertJob({ company_id: companyId, ...j });
  }
  await scoreJobsForCompany(companyId);
}

// Runs the (cheap, local, no network) fake/scam-signal scorer over every job
// currently stored for a company and persists the result. Called right
// after jobs are synced so a quality score/flags are ready by the time the
// frontend asks for them — never on the request path itself.
async function scoreJobsForCompany(companyId) {
  const { scoreJobQuality } = require('./services/jobQualityService');
  const { detectVisaFlagForJob } = require('./services/visaDetectionService');
  const company = await get(`SELECT * FROM companies WHERE id = @id`, { id: companyId });
  const freshJobs = await all(`SELECT * FROM jobs WHERE company_id = @company_id ORDER BY id ASC`, { company_id: companyId });
  for (const job of freshJobs) {
    const { score, flags } = scoreJobQuality(job, company);
    await setJobQuality(job.id, score, flags);
    await run(`UPDATE jobs SET visa_flag = @visa_flag WHERE id = @id`, { visa_flag: detectVisaFlagForJob(job), id: job.id });
  }
}

// --- scans ---

async function recordScan({ south, west, north, east, provider, resultCount }, userId) {
  await run(`
    INSERT INTO scans (south, west, north, east, provider, result_count, user_id, created_at)
    VALUES (@south, @west, @north, @east, @provider, @result_count, @user_id, @now)
  `, { south, west, north, east, provider, result_count: resultCount, user_id: userId || null, now: nowMs() });
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

// Pipeline funnel across every user (admin overview).
async function getStatusCounts() {
  const rows = await all(`SELECT status, COUNT(*) AS n FROM user_company_status GROUP BY status`);
  const out = { none: 0, interested: 0, applied: 0, skipped: 0 };
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
