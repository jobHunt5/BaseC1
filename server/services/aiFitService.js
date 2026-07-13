// LLM-based fit scoring — "would this specific candidate actually be a good
// fit for this specific job/company", with a plain-English reason. Follows
// the same OpenAI-call shape as outreachAiService.js (same key, same model
// config, same "just don't show this feature" fallback when no key is set).
//
// Results are cached in ai_fit_scores keyed by (company, job, profile
// snapshot) — an LLM call is slow (~1-3s) and costs real money per call, so
// this must never run on a hot path like rendering a list. It only runs
// when explicitly requested for one company/job at a time (see the
// /api/ai/fit-score route), and reuses the cached result until the
// candidate's own profile changes.

const axios = require('axios');
const crypto = require('crypto');
const { getAiFitScore, setAiFitScore } = require('../db');

function hasOpenAiKey() {
  return !!process.env.OPENAI_API_KEY;
}

// Only the fields that could actually change what "fit" means — not name/
// email/phone, so cosmetic profile edits don't invalidate the whole cache.
function profileHash(profile = {}) {
  const relevant = {
    skills: (profile.skills || []).slice().sort(),
    jobSectors: (profile.jobSectors || []).slice().sort(),
    employmentTypes: (profile.employmentTypes || []).slice().sort(),
    workModes: (profile.workModes || []).slice().sort(),
    experienceYears: profile.experienceYears || '',
    currentRole: profile.currentRole || '',
    experienceSummary: profile.experienceSummary || '',
    education: (profile.education || []).map(e => e.degree || '').sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

/**
 * Score how well `profile` fits `company` (optionally a specific `job`).
 * Returns { score, reason, cached } or null if no OPENAI_API_KEY is set —
 * callers should treat null as "feature not available", not an error.
 */
async function scoreFit(company, job, profile, userId) {
  if (!hasOpenAiKey()) return null;

  const hash = profileHash(profile);
  const jobId = job?.id ?? null;
  const cached = getAiFitScore(userId, company.id, jobId, hash);
  if (cached) return { score: cached.score, reason: cached.reason, cached: true };

  const system = `You are a blunt, honest career advisor. Given a candidate's profile and a job/company, judge
real fit — not encouragement. Return ONLY valid JSON: { "score": 0-100, "reason": "one or two plain-English
sentences" }. Low scores are fine and expected when the fit is genuinely weak; don't inflate.`;

  const user = `Candidate:
- Skills: ${(profile.skills || []).join(', ') || 'none listed'}
- Current/recent role: ${profile.currentRole || 'none listed'}
- Experience: ${profile.experienceYears || 'unknown'} years
- Summary: ${profile.experienceSummary || 'none'}
- Looking for: ${(profile.jobSectors || []).join(', ') || 'any'} · ${(profile.employmentTypes || []).join(', ') || 'any'} · ${(profile.workModes || []).join(', ') || 'any'}

${job ? `Job: "${job.title}" at ${company.name}\nJob description: ${(job.description || 'not available').slice(0, 500)}`
      : `Company: ${company.name} (${company.type || 'business'})\nAbout: ${(company.description || 'not available').slice(0, 500)}\nNo specific job posting yet — score general fit for this company/industry.`}`;

  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      {
        timeout: 30000,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      },
    );

    const content = resp.data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content || '{}');
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
    const reason = String(parsed.reason || '').slice(0, 400);
    if (Number.isNaN(score) || !reason) return null;

    setAiFitScore(userId, company.id, jobId, hash, score, reason);
    return { score, reason, cached: false };
  } catch (err) {
    console.warn('[ai-fit]', err.message);
    return null;
  }
}

module.exports = { scoreFit, hasOpenAiKey, profileHash };
