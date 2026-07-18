// Lightweight in-process rate limiting for expensive/abusable endpoints
// (PDF generation via headless Chrome, real email sends, paid AI calls).
// Not a substitute for a real distributed limiter if this ever runs
// multi-instance — state doesn't share across processes — but stops the
// single-instance case (a script hammering an endpoint, or one buggy
// client retry-looping) at negligible cost, which is what actually matters
// pre-launch.

const buckets = new Map();

function rateLimit({ max, windowMs, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry || now - entry.windowStart > windowMs) {
      buckets.set(key, { windowStart: now, count: 1 });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}

// Sweeps stale windows across every bucket periodically instead of on
// every request, so this never grows unbounded over a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.windowStart > 60 * 60 * 1000) buckets.delete(key);
  }
}, 30 * 60 * 1000).unref();

function byUser(req) {
  return req.user?.id || req.ip;
}

module.exports = { rateLimit, byUser };
