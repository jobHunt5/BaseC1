// Shared Claude (Anthropic) client for every LLM feature — AI fit scoring,
// the admin analyst, cover letters, and outreach drafts. One ANTHROPIC_API_KEY
// switches all of them on together; without it, callers fall back to
// templates / {available:false} rather than erroring.
//
// Uses the official @anthropic-ai/sdk (not raw HTTP). Model defaults to
// claude-opus-4-8, overridable with ANTHROPIC_MODEL.

const Anthropic = require('@anthropic-ai/sdk');

let client;
function getClient() {
  // Lazy — the SDK constructor throws when no key is present, so only ever
  // called behind a hasKey() guard.
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

function hasKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function model() {
  return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
}

// Pull the first well-formed JSON object out of the model's reply, tolerating
// stray prose or ```json fences even though we explicitly ask for raw JSON.
function extractJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through to brace-slice */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

// One Claude call that returns parsed JSON (or null if the reply couldn't be
// parsed). Thinking is left off — these are bounded scoring/extraction tasks,
// and the explicit "raw JSON only" instruction keeps Opus 4.8 from leaking
// prose into the response.
async function completeJson({ system, user, maxTokens = 2000 }) {
  const resp = await getClient().messages.create({
    model: model(),
    max_tokens: maxTokens,
    system: `${system}\n\nOutput the raw JSON object only — no explanation, no markdown code fences.`,
    messages: [{ role: 'user', content: user }],
  });
  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
  return extractJson(text);
}

module.exports = { getClient, hasKey, model, completeJson, extractJson };
