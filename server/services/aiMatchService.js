// AI layer — semantic job matching for the admin console.
//
// This is the foundation brick of the matching stack: turn a candidate's
// skills/profile into a ranked list of jobs by MEANING overlap, not exact
// keyword equality. v1 uses a local TF-IDF + cosine index — zero external
// keys, zero per-call cost, memory-light, so it runs on the free tier and
// works today. `EMBEDDINGS_PROVIDER` is the seam: when a neural-embeddings
// key is wired in later (OpenAI / Voyage / a local model), only buildIndex/
// rank get a vector backend swapped underneath; the routes and UI don't
// change. Pure functions (buildIndex/rank) are separated from the DB fetch
// so they're unit-testable without a database.

const STOPWORDS = new Set(('a an the and or but of to in on for with at by from up about into over after '
  + 'is are was were be been being have has had do does did will would shall should can could may might must '
  + 'this that these those you your we our they their he she it its as if not no so than then also more most '
  + 'we are looking role job work team company please apply candidate you will who what when where how our your')
  .split(/\s+/));

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')      // keep c++, c#, node.js-ish tokens
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 30 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function l2normalize(vec) {
  let sum = 0;
  for (const w of vec.values()) sum += w * w;
  const norm = Math.sqrt(sum) || 1;
  for (const [k, w] of vec) vec.set(k, w / norm);
  return vec;
}

// Build a searchable index from docs: [{ ref, title, text, ...meta }].
// Title tokens are weighted (repeated) — a match on the role title is a
// stronger signal than one buried in the description body.
function buildIndex(docs, { titleBoost = 3 } = {}) {
  const N = docs.length || 1;
  const df = new Map();
  const docTokenCounts = [];

  for (const d of docs) {
    const tokens = [
      ...tokenize(d.title).flatMap(t => Array(titleBoost).fill(t)),
      ...tokenize(d.text),
    ];
    const counts = termCounts(tokens);
    docTokenCounts.push(counts);
    for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  }

  const idf = new Map();
  for (const [term, n] of df) idf.set(term, Math.log((N + 1) / (n + 1)) + 1);

  const vectors = docTokenCounts.map(counts => {
    const v = new Map();
    for (const [term, tf] of counts) v.set(term, (1 + Math.log(tf)) * (idf.get(term) || 0));
    return l2normalize(v);
  });

  return { docs, vectors, idf, builtAt: Date.now(), size: docs.length };
}

function queryVector(index, text) {
  const counts = termCounts(tokenize(text));
  const v = new Map();
  for (const [term, tf] of counts) {
    const w = index.idf.get(term);
    if (w) v.set(term, (1 + Math.log(tf)) * w); // ignore terms unseen in corpus
  }
  return l2normalize(v);
}

function cosine(a, b) {
  // Iterate the smaller vector for speed; both are L2-normalized so the dot
  // product IS the cosine similarity.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, w] of small) {
    const w2 = big.get(k);
    if (w2) dot += w * w2;
  }
  return dot;
}

// Rank the indexed docs against a free-text query (skills / a profile / a job
// description). Returns the top matches with a 0..1 score and light metadata.
function rank(index, queryText, { limit = 10 } = {}) {
  const qv = queryVector(index, queryText);
  if (qv.size === 0) return [];
  const scored = index.vectors.map((v, i) => ({ i, score: cosine(qv, v) }));
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter(s => s.score > 0)
    .slice(0, limit)
    .map(({ i, score }) => {
      const d = index.docs[i];
      return {
        ref: d.ref,
        title: d.title,
        company_name: d.company_name || null,
        location: d.location || null,
        url: d.url || null,
        source: d.source || null,
        score: Math.round(score * 1000) / 1000,
      };
    });
}

// ---- live, DB-backed matcher (cached index) -----------------------------

let cachedIndex = null;
let cachedAt = 0;
const INDEX_TTL_MS = parseInt(process.env.AI_MATCH_INDEX_TTL_MS || String(5 * 60 * 1000), 10);

async function getIndex({ force = false } = {}) {
  if (!force && cachedIndex && Date.now() - cachedAt < INDEX_TTL_MS) return cachedIndex;
  const db = require('../db');
  const docs = await db.getMatchableJobs();
  cachedIndex = buildIndex(docs);
  cachedAt = Date.now();
  return cachedIndex;
}

async function matchJobs(queryText, { limit = 10 } = {}) {
  const index = await getIndex();
  return { method: method(), corpus_size: index.size, results: rank(index, queryText, { limit }) };
}

// Which backend is active. Local today; the presence of a neural-embeddings
// key flips this label (and, once implemented, the index backend).
function method() {
  return process.env.EMBEDDINGS_PROVIDER
    ? `neural:${process.env.EMBEDDINGS_PROVIDER}`
    : 'tfidf-local';
}

async function status() {
  const index = await getIndex();
  return {
    method: method(),
    corpus_size: index.size,
    neural_available: !!process.env.EMBEDDINGS_PROVIDER,
    indexed_at: index.builtAt,
    index_ttl_ms: INDEX_TTL_MS,
  };
}

module.exports = {
  tokenize, buildIndex, rank, // pure, unit-testable
  matchJobs, status, method,
};
