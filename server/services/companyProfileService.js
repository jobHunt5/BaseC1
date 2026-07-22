// Unified company profile — single source of truth for the UI.
// Merges jobs, LinkedIn verification, company links, and trust metadata.

const {
  jobConfidence,
  isHighConfidenceJob,
  linkedinMemberConfidence,
  buildCompanyLinkedIn,
  buildCompanyLinks,
  buildTrustSummary,
} = require('./trustService');
const { listJobsForCompany, getJobQualityForCompany, getLearnedWeights } = require('../db');
const { scoreCompanyByLearning } = require('./matchLearningService');
const { freshnessLabel, hiddenMarketLabel } = require('./jobQualityService');
const { seniorityRank } = require('./enrichService');

const BOARD_SOURCES = new Set(['seek', 'indeed', 'linkedin-jobs', 'jora']);

// This person's literal job is hiring — outranks any department match or
// general seniority.
const HIRING_TITLE_RE = /\b(hr|human resources|talent|recruit(ing|er|ment)?|people (ops|operations|partner)|hiring manager)\b/i;

// Most common significant word across the company's own open jobs'
// `department` field (populated per-ATS in jobsService.js, e.g.
// "Engineering", "Sales" — free text, no enum) — used to bias toward a team
// member whose title matches what the company is actually hiring for.
function departmentSignal(jobRows) {
  const counts = {};
  for (const j of jobRows || []) {
    const dept = String(j.department || '').toLowerCase();
    for (const w of dept.split(/[\s/&,]+/)) {
      if (w.length > 3) counts[w] = (counts[w] || 0) + 1;
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || null;
}

function scoreContact(member, deptWord) {
  const title = (member.title || '').toLowerCase();
  let score = 0;
  let reason = null;
  if (HIRING_TITLE_RE.test(title)) {
    score += 100;
    reason = 'Handles hiring for this company';
  } else if (deptWord && title.includes(deptWord)) {
    score += 50;
    reason = `Leads their ${capitalizeWord(deptWord)} team`;
  }
  // Fold in general seniority as a tiebreaker/fallback — lower rank number
  // is more senior, so invert it into a small positive contribution.
  score += Math.max(0, 20 - seniorityRank(member.title));
  return { score, reason };
}

function capitalizeWord(w) {
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

// Picks the best publicly-sourced hiring contact for this company: an
// HR/Talent-titled person first, then someone whose title matches what the
// company is actually hiring for, falling back to the most senior team
// member found. Returns null when there's no team at all — never invents a
// contact, and never reaches for LinkedIn scraping / third-party lookups
// (team data here is 100% sourced from the company's own website).
function pickHiringContact(team, jobRows) {
  if (!team?.length) return null;
  const deptWord = departmentSignal(jobRows);
  const scored = team.map(m => ({ member: m, ...scoreContact(m, deptWord) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  return {
    name: best.member.name,
    title: best.member.title || '',
    email: best.member.email || null,
    linkedin_url: best.member.linkedin_url || null,
    linkedin_verified: !!best.member.linkedin_verified,
    reason: best.reason || 'Most senior contact found',
  };
}

function enrichJobRow(job, qualityByJobId) {
  const confidence = job.confidence || jobConfidence(job.source);
  const quality = qualityByJobId?.get(job.id) || null;
  const hidden = hiddenMarketLabel(job);
  return {
    ...job,
    confidence,
    confidence_label: confidenceLabel(confidence),
    is_verified: confidence === 'verified',
    is_board_listing: BOARD_SOURCES.has(job.source),
    // "Genuine job" signal — separate from confidence (which is about the
    // *source*), this is about the posting's own text. Null until the
    // background scorer has run on it (right after jobs are synced).
    quality_score: quality?.score ?? null,
    quality_flags: quality?.flags ?? [],
    looks_suspicious: quality != null && quality.score < 0.4,
    freshness_label: freshnessLabel(job.posted_at),
    // "Hidden market" signal — is this genuinely still open (first time
    // seen, no repost history) or possibly already informally filled
    // (reposted repeatedly)? See jobQualityService.hiddenMarketLabel.
    hidden_market_label: hidden.label,
    repost_count: hidden.repostCount,
    hidden_market_reason: hidden.reason,
  };
}

function confidenceLabel(confidence) {
  if (confidence === 'verified') return 'Verified listing';
  if (confidence === 'found') return 'Found on careers page';
  if (confidence === 'board') return 'Job board listing';
  return 'Unverified';
}

function enrichTeamMember(member, company) {
  const confidence = linkedinMemberConfidence(member);
  const verified = confidence === 'verified';
  return {
    ...member,
    linkedin_confidence: confidence,
    linkedin_verified: verified,
    linkedin_search_url: verified ? null : buildMemberSearchUrl(member.name, company),
  };
}

function buildMemberSearchUrl(name, company) {
  const { searchUrl, formatAustralianLocation } = require('./linkedinService');
  return searchUrl(name, company?.name, company?.address);
}

/**
 * Build the full profile payload for one company. `learnedWeights`, if
 * provided, is a pre-fetched result of db.getLearnedWeights(userId) — the
 * same value for every company in a batch, so bulk callers (see
 * attachProfiles below) fetch it once instead of once per company.
 */
async function buildCompanyProfile(company, jobs = null, userId = null, learnedWeights = null) {
  const qualityByJobId = new Map((await getJobQualityForCompany(company.id)).map(q => [q.job_id, q]));
  const jobRows = (jobs || await listJobsForCompany(company.id, userId)).map(j => enrichJobRow(j, qualityByJobId));
  const websiteJobs = jobRows.filter(j => !j.is_board_listing);
  const boardJobs = jobRows.filter(j => j.is_board_listing);
  const verifiedJobs = jobRows.filter(j => j.is_verified);
  const suspiciousJobs = jobRows.filter(j => j.looks_suspicious);

  const team = (company.team || []).map(m => enrichTeamMember(m, company));
  const linkedin = buildCompanyLinkedIn(company);
  const links = buildCompanyLinks(company);
  const trust = buildTrustSummary(company, jobRows, team, linkedin);

  return {
    company_id: company.id,
    name: company.name,
    about: company.description || '',
    address: company.address || '',
    type: company.type || '',
    trust,
    // Behaviour-learning boost: -1 (you tend to skip companies like this)
    // to +1 (you tend to save/apply). 0 until there's enough history.
    learned_score: await scoreCompanyByLearning(company, learnedWeights, userId),
    suspicious_job_count: suspiciousJobs.length,
    contact: {
      email: company.email || null,
      email_verified: !!company.email_verified,
      email_source: company.email_source || null,
      phone: company.phone || null,
      all_emails: company.all_emails || [],
    },
    links,
    linkedin,
    team,
    hiring_contact: pickHiringContact(team, jobRows),
    team_stats: {
      total: team.length,
      verified_linkedin: team.filter(m => m.linkedin_verified).length,
    },
    jobs: jobRows,
    jobs_stats: {
      total: jobRows.length,
      verified: verifiedJobs.length,
      from_website: websiteJobs.length,
      from_boards: boardJobs.length,
      primary_source: websiteJobs.length
        ? websiteJobs[0]?.source
        : (boardJobs[0]?.source || null),
    },
    careers_url: company.careers_url || null,
    enriched_at: company.enriched_at || null,
    enrich_depth: company.enrich_depth || null,
  };
}

async function attachProfile(company, jobs = null, userId = null, learnedWeights = null) {
  const profile = await buildCompanyProfile(company, jobs, userId, learnedWeights);
  return {
    ...company,
    jobs: profile.jobs,
    profile,
  };
}

// Bulk version — fetches the user's learned weights once (same value for
// every company) instead of once per company, then builds profiles in
// parallel. `jobsMap` is a Map of company.id -> jobs[] (see db.jobsGroupedFor).
async function attachProfiles(companies, jobsMap, userId = null) {
  if (!companies.length) return [];
  const learnedWeights = await getLearnedWeights(userId);
  return Promise.all(companies.map(c => attachProfile(c, jobsMap.get(c.id) || [], userId, learnedWeights)));
}

module.exports = {
  buildCompanyProfile,
  attachProfile,
  attachProfiles,
  enrichJobRow,
  enrichTeamMember,
  pickHiringContact,
  departmentSignal,
};
