// Flags a job posting's visa/citizenship requirement from its own text —
// core to matching in the Australian market, where a large share of
// postings explicitly restrict to citizens/PR (or require a security
// clearance, which amounts to the same restriction) and a large share of
// candidates are on a visa. Pure text heuristics, no network call, same
// shape as jobQualityService.js's scam-signal scoring.
//
// Returns one of:
//   'citizens-only'        — explicitly requires citizenship/PR
//   'clearance-required'   — security clearance mentioned (same practical
//                            effect — clearances are citizen/PR-only)
//   'sponsorship-available' — explicitly offers/considers sponsorship
//   null                   — nothing said either way (the common case —
//                            silence isn't a signal, so this must never be
//                            presented as "this one's fine for you")

const CITIZENS_ONLY_RULES = [
  /\bmust\s+be\s+(?:an?\s+)?australian\s+citizen/i,
  /\baustralian\s+citizens?\s+(?:and|or)\s+permanent\s+residents?\s+only\b/i,
  /\bcitizens?\s*\/\s*permanent\s+residents?\s+only\b/i,
  /\bonly\s+(?:australian\s+)?citizens?\s+(?:and|or)\s+permanent\s+residents?\b/i,
  /\bno\s+visa\s+sponsorship\b/i,
  /\bunable\s+to\s+(?:offer|provide)\s+(?:visa\s+)?sponsorship\b/i,
  /\bwe\s+(?:are\s+)?(?:not\s+able\s+to|cannot|can'?t)\s+(?:offer|provide)\s+(?:visa\s+)?sponsorship\b/i,
  /\bfull\s+working\s+rights?\s+(?:in\s+australia\s+)?(?:with\s+no\s+restrictions?|required|only)\b/i,
  /\bmust\s+have\s+(?:permanent\s+)?(?:unrestricted\s+)?work(?:ing)?\s+rights?\s+in\s+australia\b/i,
];

const CLEARANCE_RULES = [
  /\b(?:baseline|nv1|nv2|negative\s+vetting|positive\s+vetting)\s+(?:security\s+)?clearance\b/i,
  /\bcurrent\s+security\s+clearance\s+(?:is\s+)?(?:required|essential|mandatory)\b/i,
  /\bable\s+to\s+obtain\s+(?:and\s+maintain\s+)?(?:an?\s+)?(?:australian\s+government\s+)?security\s+clearance\b/i,
];

const SPONSORSHIP_AVAILABLE_RULES = [
  /\bvisa\s+sponsorship\s+(?:is\s+)?available\b/i,
  /\bwill\s+sponsor\b/i,
  /\bsponsorship\s+(?:is\s+)?(?:on\s+)?offer(?:ed)?\b/i,
  /\bsponsorship\s+for\s+the\s+right\s+candidate\b/i,
  /\b(?:482|186|187|494)\s+visa\s+sponsorship\b/i,
  /\bopen\s+to\s+(?:sponsoring|sponsorship)\b/i,
];

function detectVisaFlag(text) {
  const hay = String(text || '');
  if (!hay.trim()) return null;
  if (CITIZENS_ONLY_RULES.some(re => re.test(hay))) return 'citizens-only';
  if (CLEARANCE_RULES.some(re => re.test(hay))) return 'clearance-required';
  if (SPONSORSHIP_AVAILABLE_RULES.some(re => re.test(hay))) return 'sponsorship-available';
  return null;
}

function detectVisaFlagForJob(job) {
  return detectVisaFlag(`${job?.title || ''} ${job?.description || ''}`);
}

module.exports = { detectVisaFlag, detectVisaFlagForJob };
