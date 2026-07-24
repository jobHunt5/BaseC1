// AI reasoning layer for the admin console — the "reason" half of retrieve →
// reason (RAG). aiMatchService retrieves the jobs most relevant to a
// candidate description (cheap, local, no key); this service then hands those
// jobs to a real LLM, which reads the candidate and each job and returns
// genuine reasoning: which roles actually fit, why, and what's blocking the
// candidate (the classic barrier for skilled/international job seekers).
//
// Same OpenAI call shape, key, and model config as aiFitService.js /
// outreachAiService.js — one OPENAI_API_KEY activates all of them together.
// Returns { available: false } (not an error) when no key is set, so the
// admin UI can show "add a key to switch this on" instead of breaking. This
// is the difference between the keyword matcher and real AI: with a key, an
// actual model reasons over the retrieved jobs.

const axios = require('axios');
const aiMatch = require('./aiMatchService');

function hasKey() {
  return !!process.env.OPENAI_API_KEY;
}

function buildPrompt(query, jobs) {
  const system = `You are a blunt, expert Australian career advisor helping a job seeker (local or
international/skilled-migrant) understand where they realistically fit. You are given a candidate
description and a shortlist of REAL current job postings already pre-filtered for relevance.

For each job decide genuine fit — not encouragement. Call out the specific barriers that keep skilled
people (especially migrants) out: missing local experience, unrecognised overseas qualifications, visa/
work-rights gaps, licensing/registration requirements, seniority mismatch. Low fit is fine and expected.

Return ONLY valid JSON of this exact shape:
{
  "summary": "2-3 sentence honest read on this candidate's position in this set of jobs",
  "matches": [
    { "ref": "<the job ref>", "title": "<job title>", "fit": 0-100,
      "why": "one plain sentence", "barrier": "the main thing blocking them, or 'none obvious'" }
  ],
  "advice": "one concrete next step this candidate should take"
}`;

  const jobLines = jobs.map((j, i) => `#${i + 1} ref=${j.ref} | ${j.title}`
    + `${j.company_name ? ' @ ' + j.company_name : ''}${j.location ? ' · ' + j.location : ''}`).join('\n');

  const user = `Candidate description:\n${query}\n\nShortlisted jobs (already relevance-ranked):\n${jobLines}\n\n`
    + `Judge fit for each job above and return the JSON.`;

  return { system, user };
}

/**
 * Retrieve the most relevant jobs for `query`, then have a real LLM reason
 * over them. Returns:
 *   { available: false }                        — no API key; feature dormant
 *   { available: true, model, retrieved, analysis } — real LLM reasoning
 *   { available: true, error }                  — key set but the call failed
 */
async function analyze(query, { limit = 8 } = {}) {
  if (!hasKey()) return { available: false };

  // Retrieval stage (local, free): narrow the whole corpus to a shortlist so
  // the LLM only reasons over a handful of jobs, not hundreds.
  const { results, corpus_size } = await aiMatch.matchJobs(query, { limit });
  if (!results.length) {
    return { available: true, model: model(), retrieved: 0, corpus_size, analysis: null };
  }

  const { system, user } = buildPrompt(query, results);
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: model(),
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      },
      {
        timeout: 45000,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      },
    );
    const content = resp.data?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content || '{}');
    // Re-attach the retrieval score + url to each match the model returned, by
    // ref, so the UI can link out and show both signals.
    const byRef = new Map(results.map(r => [r.ref, r]));
    const matches = (parsed.matches || []).map(m => {
      const r = byRef.get(m.ref) || {};
      return {
        title: m.title || r.title || '',
        company_name: r.company_name || null,
        url: r.url || null,
        fit: Math.max(0, Math.min(100, Math.round(Number(m.fit)) || 0)),
        why: String(m.why || '').slice(0, 300),
        barrier: String(m.barrier || '').slice(0, 200),
        retrieval_score: r.score ?? null,
      };
    });
    return {
      available: true,
      model: model(),
      retrieved: results.length,
      corpus_size,
      analysis: {
        summary: String(parsed.summary || '').slice(0, 600),
        advice: String(parsed.advice || '').slice(0, 400),
        matches,
      },
    };
  } catch (err) {
    console.warn('[ai-analyst]', err.message);
    return { available: true, model: model(), error: err.message };
  }
}

function model() {
  return process.env.OPENAI_MODEL || 'gpt-4o-mini';
}

module.exports = { analyze, hasKey, model };
