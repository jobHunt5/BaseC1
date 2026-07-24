// "Is this a genuine job posting?" — separate from trustService's source
// confidence (which asks "did this come from a real ATS/website"), this
// looks at the actual title/description text for the content patterns that
// show up in scam, MLM, and stale/evergreen listings regardless of where
// they were scraped from. A posting sourced from a real Greenhouse account
// is still worth flagging if its own text reads like a wire-transfer scam.

const { isHighConfidenceJob, BOARD_JOB_SOURCES } = require('./trustService');

// Each rule: a regex over "title + description", a penalty (0-1 taken off
// the score), and a short human-readable reason shown in the UI.
const RED_FLAG_RULES = [
  { re: /\b(processing|registration|training|starter kit|equipment|admin)\s+fee\b/i, penalty: 0.55, reason: 'Asks for an upfront fee' },
  { re: /\b(wire transfer|western union|money\s*gram|cash\s*app|venmo|bitcoin|crypto)\b.*\b(pay|send|deposit)\b|\b(pay|send|deposit)\b.*\b(wire transfer|western union|money\s*gram)\b/i, penalty: 0.6, reason: 'Asks for payment via wire transfer / crypto' },
  { re: /\bsend (us )?your (ssn|social security|bank (details|account)|credit card|passport)\b/i, penalty: 0.7, reason: 'Asks for sensitive personal/financial info upfront' },
  { re: /\bno experience (necessary|needed|required)\b.*\$\s?\d{2,}[,.]?\d{0,3}\s*(\/|per)\s*(day|hour|week)/i, penalty: 0.4, reason: 'No-experience-needed + suspiciously high pay' },
  { re: /\$\s?\d{3,}\s*(\/|per)\s*day\b|\$\s?\d{4,}\s*(\/|per)\s*week\b/i, penalty: 0.3, reason: 'Unusually high guaranteed daily/weekly pay' },
  { re: /\bbe your own boss\b|\bunlimited earning potential\b|\brecruit (others|your (friends|team))\b|\bnetwork marketing\b|\bpyramid\b/i, penalty: 0.5, reason: 'MLM / pyramid-scheme language' },
  { re: /\bwhatsapp only\b|\btext (only|us) at\b|\bcontact.{0,15}whatsapp\b/i, penalty: 0.35, reason: 'Directs to WhatsApp/text instead of a normal application process' },
  { re: /\bguaranteed income\b|\bguaranteed hire\b|\b100% guaranteed\b/i, penalty: 0.3, reason: 'Unrealistic "guaranteed" income/hire language' },
  { re: /\bapply (immediately|now)\b.{0,25}\blimited (spots|positions|slots)\b|\blimited (spots|positions|slots)\b.{0,25}\bapply (immediately|now)\b/i, penalty: 0.2, reason: 'Artificial urgency ("limited spots, apply now")' },
  { re: /\bwork from home\b.{0,30}\bno interview\b|\bno interview\b.{0,30}\bwork from home\b/i, penalty: 0.35, reason: 'Work-from-home with no interview process' },
];

// Positive signals — reduce risk, on top of the source-confidence baseline.
function positiveAdjustments(job, company) {
  let bonus = 0;
  bonus += freshnessBonus(job.posted_at);
  if (company?.email_verified) bonus += 0.05;
  if (company?.website && job.url && sameHost(job.url, company.website)) bonus += 0.05;
  return bonus;
}

// A recently-posted listing is the closest available signal that a role is
// genuinely still open rather than already informally filled — graduated
// instead of a flat bonus so a job posted yesterday outranks one from
// 6 months ago instead of scoring identically to it.
function freshnessBonus(postedAt) {
  if (!postedAt) return 0;
  const days = (Date.now() - postedAt) / (24 * 60 * 60 * 1000);
  if (days <= 7) return 0.12;
  if (days <= 30) return 0.07;
  if (days <= 90) return 0.02;
  return 0;
}

function freshnessLabel(postedAt) {
  if (!postedAt) return null;
  const days = (Date.now() - postedAt) / (24 * 60 * 60 * 1000);
  if (days <= 7) return 'new';
  if (days <= 30) return 'recent';
  return 'older';
}

// How many days a soft-removed job is still eligible to be matched as a
// "repost" of a new listing with a different URL — beyond this it's treated
// as an unrelated posting, and the stale row gets pruned.
const REPOST_RETENTION_DAYS = 150;
const REPOST_RETENTION_MS = REPOST_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const SENIORITY_WORDS = /\b(senior|sr|junior|jr|lead|principal|staff|entry.level|graduate|grad|i{1,3}|iv|v)\b/g;

// Collapses "Senior Nurse (Casual)" and "Nurse - Casual" toward the same
// key so a repost under a new listing URL/ID can still be recognized as
// the same underlying role, not scored as a brand-new posting.
function normalizeTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(SENIORITY_WORDS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// "Hidden market" signal — separate from quality/scam scoring, this asks
// whether a posting looks genuinely open (first time seen, no repost
// history) or likely already informally filled (reposted repeatedly).
// Computed live on read, same as freshnessLabel, not persisted.
function hiddenMarketLabel(job) {
  const repostCount = job.repost_count || 0;
  if (repostCount >= 3) {
    return { label: 'possibly-filled', repostCount, reason: `Reposted ${repostCount} times — may already be informally filled` };
  }
  if (repostCount === 0 && job.first_seen_at && !job.removed_at) {
    const days = (Date.now() - job.first_seen_at) / (24 * 60 * 60 * 1000);
    if (days <= 7) return { label: 'likely-open', repostCount, reason: 'First time seen, no repost history' };
  }
  return { label: null, repostCount, reason: null };
}

// "Evergreen" pipeline posts — talent-community / expression-of-interest
// listings that never close and aren't a real opening. LinkedIn shows them
// dated a year+ old (or undated) with "Responses managed off LinkedIn".
// They're noise for a job seeker and poison for a training corpus (a model
// learns "job" from something that was never a fillable role), so they're
// dropped outright rather than merely down-ranked.
// Only unambiguous pipeline phrasings — bare "join our team" is deliberately
// excluded (a real title like "Join our team as a Senior Nurse" must survive);
// the talent-community variants and "express interest" catch the actual
// evergreen posts without that false-positive risk.
const EVERGREEN_TITLE_RE = /\b(express(ion)?\s+(of\s+)?interest|register\s+your\s+interest|talent\s+(community|pool|network|pipeline)|join\s+our\s+(talent|community|network)|future\s+(opportunit\w*|roles?|vacanc\w*)|general\s+(application|expression)|speculative\s+application|keep\s+me\s+in\s+mind|we'?re\s+always\s+hiring)\b/i;

function isEvergreenPost(title) {
  return EVERGREEN_TITLE_RE.test(String(title || ''));
}

function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); }
  catch { return false; }
}

// Baseline confidence from the source alone, before reading any text.
function baselineForSource(source) {
  if (isHighConfidenceJob(source)) return 0.9;   // real ATS account — hard to fake
  if (source === 'careers-page') return 0.75;    // scraped from the company's own site
  if (BOARD_JOB_SOURCES.has(source)) return 0.6; // reputable aggregator, but anyone can post there
  return 0.55;
}

/**
 * Score a single job 0 (looks fake) .. 1 (looks genuine), with the specific
 * reasons that pulled the score down. Pure text/metadata rules — no network
 * calls, so this is cheap enough to run on every job as it's saved.
 */
function scoreJobQuality(job, company) {
  const haystack = `${job.title || ''} ${job.description || ''}`;
  let score = baselineForSource(job.source);
  const flags = [];

  for (const rule of RED_FLAG_RULES) {
    if (rule.re.test(haystack)) {
      score -= rule.penalty;
      flags.push(rule.reason);
    }
  }

  score += positiveAdjustments(job, company);
  score = Math.max(0, Math.min(1, score));

  return { score, flags };
}

module.exports = { scoreJobQuality, freshnessLabel, hiddenMarketLabel, normalizeTitle, isEvergreenPost, REPOST_RETENTION_MS };
