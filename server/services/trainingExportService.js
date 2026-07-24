// Anonymized, opt-in-only training export. Three sections:
//
//  - subjects: the abstracted per-user preference signal (learned_weights)
//    plus interaction events for CONSENTING users only — pseudonymized
//    (HMAC subject id), timestamps coarsened to the day, and companies
//    reduced to category/type so a trail of specific companies can't
//    re-identify anyone.
//  - job_corpus / area_job_corpus: public job-posting content (title, full
//    description, salary, dates) — not personal data, no consent gate, but
//    deliberately carries no company ids/names from the companies table and
//    no per-user columns.
//
// Still deliberately never touches users.profile_json (name, city, phone,
// and a live encrypted outreach email app-password) or raw ids/timestamps.
//
// Computed live from current DB state on every call, nothing persisted —
// this is what makes "opt out" and "delete your account" both remove a
// person from every FUTURE export immediately, not just from here on
// under some retention policy.

const crypto = require('crypto');
const {
  getAllSettings, setSetting, getConsentingLearnedWeights,
  getConsentingInteractions, getJobCorpus, getAreaJobCorpus,
} = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;

// Deliberately a separate secret from auth.js's session-token secret
// (getAuthSecret) — an anonymization guarantee and a session-token
// guarantee are different security properties; reusing one secret for both
// means a leak of either compromises both. Same self-generating pattern.
function getExportSecret() {
  if (process.env.TRAINING_EXPORT_SECRET) return process.env.TRAINING_EXPORT_SECRET;
  const stored = getAllSettings();
  if (stored.TRAINING_EXPORT_SECRET) return stored.TRAINING_EXPORT_SECRET;
  const generated = crypto.randomBytes(32).toString('hex');
  setSetting('TRAINING_EXPORT_SECRET', generated);
  return generated;
}

// Stable across repeated exports (a real training pipeline can track "the
// same anonymous subject" over time) but never reversible back to the real
// user id without the secret.
function pseudonymFor(userId) {
  return crypto.createHmac('sha256', getExportSecret()).update(String(userId)).digest('hex').slice(0, 16);
}

function parseCats(catsJson) {
  try {
    const cats = JSON.parse(catsJson || '[]');
    return Array.isArray(cats) ? cats : [];
  } catch { return []; }
}

async function buildTrainingExport() {
  const [weights, interactions, jobCorpus, areaJobCorpus] = await Promise.all([
    getConsentingLearnedWeights(),
    getConsentingInteractions(),
    getJobCorpus(),
    getAreaJobCorpus(),
  ]);

  const bySubject = new Map();
  const subjectFor = (userId) => {
    const id = pseudonymFor(userId);
    if (!bySubject.has(id)) bySubject.set(id, { subject_id: id, features: [], events: [] });
    return bySubject.get(id);
  };

  for (const row of weights) {
    subjectFor(row.user_id).features.push({
      feature_key: row.feature_key,
      weight: row.weight,
      sample_count: row.sample_count,
    });
  }

  for (const row of interactions) {
    subjectFor(row.user_id).events.push({
      action: row.action,
      company_cats: parseCats(row.company_cats),
      company_type: row.company_type || null,
      // Day-granularity only: ordering/habit signal without a joinable
      // precise timestamp.
      day: Math.floor(row.created_at / DAY_MS) * DAY_MS,
    });
  }

  return {
    generated_at: Date.now(),
    consenting_user_count: bySubject.size,
    subjects: [...bySubject.values()],
    job_corpus: jobCorpus.map(j => ({ ...j, company_cats: parseCats(j.company_cats) })),
    area_job_corpus: areaJobCorpus,
  };
}

module.exports = { pseudonymFor, buildTrainingExport };
