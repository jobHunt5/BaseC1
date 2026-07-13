// "Learn from your behavior over time" — a small, fully explainable
// preference model, not a black-box classifier. Every save/apply/skip is
// logged as an interaction (db.recordInteraction); this turns that history
// into per-feature weights (e.g. "industry:dev" tends to get saved, "industry:
// retail" tends to get skipped) and blends them into a per-company score
// the frontend can use to boost or de-prioritise future matches.
//
// Deliberately a simple weighted-average model, not real ML infrastructure:
// at the scale of one person's job hunt (hundreds, not millions, of
// interactions) a transparent "what did this number come from" model is
// more useful than a opaque one, and it's the same shape of answer either
// way — no need for a training pipeline.

const {
  getAllInteractionsWithCompany,
  getLearnedWeights,
  setLearnedWeight,
} = require('../db');

const POSITIVE_ACTIONS = new Set(['saved', 'applied']);
const NEGATIVE_ACTIONS = new Set(['unsaved', 'unapplied', 'skipped']);

// A feature only influences scoring once it has enough samples behind it —
// one skip on a "dev" company shouldn't tank every dev company's score.
const MIN_SAMPLES = 3;

function safeJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function extractFeatures({ cats, opportunities, type, has_email, email_verified, has_careers_url }) {
  const feats = [];
  for (const c of safeJSON(cats, [])) feats.push(`industry:${c}`);
  for (const o of safeJSON(opportunities, [])) feats.push(`opportunity:${o}`);
  if (type) feats.push(`type:${String(type).toLowerCase()}`);
  if (has_email) feats.push('has_email');
  if (email_verified) feats.push('email_verified');
  if (has_careers_url) feats.push('has_careers_url');
  return feats;
}

/**
 * Replays the full interaction history into per-feature weights. Cheap at
 * this scale (a full personal job hunt is hundreds, not millions, of rows)
 * so a full retrain after every interaction is simpler and safer than
 * trying to update weights incrementally and risking drift.
 */
function retrainWeights() {
  const rows = getAllInteractionsWithCompany();
  const agg = {}; // feature -> { sum, count }

  for (const row of rows) {
    const direction = POSITIVE_ACTIONS.has(row.action) ? 1 : NEGATIVE_ACTIONS.has(row.action) ? -1 : 0;
    if (!direction) continue;
    for (const f of extractFeatures(row)) {
      if (!agg[f]) agg[f] = { sum: 0, count: 0 };
      agg[f].sum += direction;
      agg[f].count += 1;
    }
  }

  for (const [key, { sum, count }] of Object.entries(agg)) {
    setLearnedWeight(key, sum / count, count);
  }
}

/**
 * Score a company from -1 (you tend to skip companies like this) to +1
 * (you tend to save/apply to companies like this), averaged only over
 * features that have crossed MIN_SAMPLES. Returns 0 (neutral) until
 * there's enough history to say anything.
 */
function scoreCompanyByLearning(company, weights) {
  const w = weights || getLearnedWeights();
  const feats = extractFeatures({
    cats: JSON.stringify(company.cats || []),
    opportunities: JSON.stringify(company.opportunities || []),
    type: company.type,
    has_email: !!company.email,
    email_verified: company.email_verified,
    has_careers_url: !!company.careers_url,
  });
  let total = 0, matched = 0;
  for (const f of feats) {
    const entry = w[f];
    if (entry && entry.sample_count >= MIN_SAMPLES) {
      total += entry.weight;
      matched++;
    }
  }
  return matched ? total / matched : 0;
}

/** For the admin view: which features the model has actually learned. */
function getLearningStats() {
  const weights = getLearnedWeights();
  const entries = Object.entries(weights)
    .filter(([, v]) => v.sample_count >= MIN_SAMPLES)
    .map(([feature, v]) => ({ feature, weight: v.weight, sample_count: v.sample_count }))
    .sort((a, b) => b.weight - a.weight);
  return {
    total_features_tracked: Object.keys(weights).length,
    confident_features: entries.length,
    top_liked: entries.filter(e => e.weight > 0).slice(0, 8),
    top_avoided: entries.filter(e => e.weight < 0).slice(-8).reverse(),
  };
}

module.exports = { retrainWeights, scoreCompanyByLearning, getLearningStats, MIN_SAMPLES };
