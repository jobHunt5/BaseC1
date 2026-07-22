// Anonymized, opt-in-only export of the app's already-abstracted per-user
// preference signal (learned_weights: feature_key -> weight/sample_count)
// for training/improving the matching model. Deliberately does NOT touch
// users.profile_json (name, city, phone, and a live encrypted outreach
// email app-password) or raw `interactions` rows (timestamped per-company
// behavior) — those are re-identifiable personal data, not safe to export.
//
// Computed live from current DB state on every call, nothing persisted —
// this is what makes "opt out" and "delete your account" both remove a
// person from every FUTURE export immediately, not just from here on
// under some retention policy.

const crypto = require('crypto');
const { getAllSettings, setSetting, getConsentingLearnedWeights } = require('../db');

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

async function buildTrainingExport() {
  const rows = await getConsentingLearnedWeights();

  const bySubject = new Map();
  for (const row of rows) {
    const subjectId = pseudonymFor(row.user_id);
    if (!bySubject.has(subjectId)) bySubject.set(subjectId, []);
    bySubject.get(subjectId).push({
      feature_key: row.feature_key,
      weight: row.weight,
      sample_count: row.sample_count,
    });
  }

  const subjects = [...bySubject.entries()].map(([subject_id, features]) => ({ subject_id, features }));
  return {
    generated_at: Date.now(),
    consenting_user_count: subjects.length,
    subjects,
  };
}

module.exports = { pseudonymFor, buildTrainingExport };
