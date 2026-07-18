// Personal job-hunt insights — built entirely from a user's own real data
// (their saved/applied companies' actual job postings, their own profile
// text, and their own save/apply/skip history), never generic advice
// templates. Two things:
//   1. Which of your saved companies you're actually likely to succeed
//      with — reuses matchLearningService's per-user learned weights
//      (already computed from real behavior, previously only shown to
//      admins in the user drawer).
//   2. What keeps coming up in the jobs you've saved/applied to that
//      isn't reflected anywhere in your own profile — computed by cross-
//      referencing real job description text against real profile text,
//      not a fixed "everyone needs a portfolio" checklist.

const { listCompaniesByPipeline, listJobsForCompany } = require('../db');
const { scoreCompanyByLearning, getLearningStats, MIN_SAMPLES } = require('./matchLearningService');

// Each category is checked two ways: how often it's mentioned across the
// user's own saved+applied job postings (signal strength), and whether
// their own profile text addresses it at all (gap or not). Kept to a small,
// well-defined set rather than open-ended keyword mining, which gets noisy
// fast without real NLP.
const GAP_CATEGORIES = [
  {
    id: 'public-speaking',
    label: 'Public speaking / presentations',
    jobRe: /\b(public speaking|presenting|presentations?|present to (?:clients|stakeholders)|speak(?:ing)? at (?:conferences|events))\b/i,
    profileRe: /\b(public speaking|presenting|presentations?|conference|meetup|talk|keynote|webinar)\b/i,
    suggestion: 'Consider adding a talk, presentation, or public-speaking experience to your profile — or plan to build one (a meetup talk, a recorded walkthrough of a project) before applying.',
  },
  {
    id: 'portfolio-projects',
    label: 'Portfolio / project work',
    jobRe: /\b(portfolio|case stud(?:y|ies)|sample(?:s)? of your work|previous projects?)\b/i,
    profileRe: /\b(portfolio|project)\b/i,
    suggestion: 'Add at least one project to your profile with a real outcome/link — roles like these usually ask for one during screening even if not listed as a hard requirement.',
  },
  {
    id: 'leadership',
    label: 'Leadership / people management',
    jobRe: /\b(lead(?:ing|ership)?\s+(?:a\s+)?team|manage\s+(?:a\s+)?team|people\s+management|direct\s+reports|mentor(?:ing|ed)?\s+(?:junior|other)\b)/i,
    profileRe: /\b(led|leadership|managed|mentor|direct reports|team lead)\b/i,
    suggestion: 'If you\'ve led a team, project, or mentored anyone (even informally), add it explicitly — "led" and "managed" are what get matched, not implied seniority.',
  },
  {
    id: 'stakeholder-comms',
    label: 'Client-facing / stakeholder communication',
    jobRe: /\b(stakeholder\s+management|client[- ]facing|liaise\s+with|communicate\s+with\s+(?:clients|stakeholders))\b/i,
    profileRe: /\b(stakeholder|client[- ]facing|liais(?:e|on))\b/i,
    suggestion: 'Roles that mention this usually screen for it directly — add a line about who you\'ve worked with directly (clients, execs, cross-functional teams).',
  },
  {
    id: 'certifications',
    label: 'Industry certifications',
    jobRe: /\b(certified|certification|accreditation)\b/i,
    profileRe: null, // checked structurally below, not by regex
    suggestion: 'Several of your saved roles mention certifications — even one relevant one can matter for initial screening. Add any you have (even in-progress) to your profile.',
  },
];

function textOf(...vals) {
  return vals.filter(Boolean).join(' ').toLowerCase();
}

function profileText(profile) {
  return textOf(
    (profile.skills || []).join(' '),
    profile.experienceSummary,
    profile.summary,
    profile.pitch,
    profile.currentRole,
    ...(profile.workHistory || []).map(w => w.description),
    ...(profile.projects || []).map(p => `${p.name} ${p.description} ${p.tech}`),
  );
}

// Only the jobs a user has actually shown real interest in (saved or
// applied) — job postings they haven't touched yet aren't a signal about
// what THEY need, just noise from the wider discovery pool.
function collectInterestedJobText(userId) {
  const companies = [
    ...listCompaniesByPipeline('interested', userId),
    ...listCompaniesByPipeline('applied', userId),
  ];
  const seen = new Set();
  const jobs = [];
  for (const c of companies) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    for (const j of listJobsForCompany(c.id, userId)) {
      jobs.push(`${j.title || ''} ${j.description || ''}`);
    }
  }
  return { jobTexts: jobs, companyCount: companies.length };
}

function getGapAnalysis(userId, profile) {
  const { jobTexts, companyCount } = collectInterestedJobText(userId);
  const pText = profileText(profile || {});
  const hasCerts = !!(profile?.certifications || []).length;

  if (!jobTexts.length) {
    return { ready: false, reason: companyCount ? 'none of your saved companies have job postings scraped yet' : 'save or apply to a few companies first', gaps: [] };
  }

  const gaps = [];
  for (const cat of GAP_CATEGORIES) {
    const mentions = jobTexts.filter(t => cat.jobRe.test(t)).length;
    if (mentions < 2) continue; // not a strong enough real signal yet
    const addressed = cat.id === 'certifications' ? hasCerts : cat.profileRe.test(pText);
    if (addressed) continue;
    gaps.push({
      id: cat.id,
      label: cat.label,
      mentionedIn: mentions,
      outOf: jobTexts.length,
      suggestion: cat.suggestion,
    });
  }
  gaps.sort((a, b) => b.mentionedIn - a.mentionedIn);
  return { ready: true, gaps, jobsAnalyzed: jobTexts.length, companiesAnalyzed: companyCount };
}

function getRankedSavedCompanies(userId, kind = 'interested') {
  const companies = listCompaniesByPipeline(kind, userId);
  const stats = getLearningStats(userId);
  const ranked = companies.map(c => ({
    id: c.id,
    name: c.name,
    learned_score: scoreCompanyByLearning(c, null, userId),
  }));
  ranked.sort((a, b) => b.learned_score - a.learned_score);
  return {
    ready: stats.confident_features > 0,
    minSamples: MIN_SAMPLES,
    companies: ranked,
  };
}

module.exports = { getGapAnalysis, getRankedSavedCompanies };
