// Zero-dependency sliding-window rate limiter. In-memory by design: limits
// are a per-process abuse brake, not a distributed quota system; a restart
// resetting them is acceptable and keeps the store on disk unpolluted.
//
// Two hard rules (P0: the limiter must never be the memory-exhaustion vector):
//   1. Keys must be server-resolved identities (IP, order id, email from a
//      validated body) — NEVER raw client-chosen header values. Keying on the
//      unverified Authorization header let anyone mint a fresh limiter
//      identity per request, bypassing the limit AND growing the map forever.
//   2. The map is bounded: at most `maxKeys` tracked identities, evicted
//      least-recently-seen first. Eviction can only ever FORGET abuse history
//      (letting an evicted key start a fresh window) — it never blocks a
//      legitimate caller — so a full map degrades toward permissiveness for
//      the flooded keyspace while staying O(maxKeys) in memory.
export function makeLimiter({ windowMs, max, key, name, maxKeys = 10_000 }) {
  const hits = new Map(); // insertion order === recency order (entries are re-inserted on touch)
  let lastSweep = Date.now();
  const mw = (req, res, next) => {
    if (process.env.ALLODIC_RATE_LIMITS === 'off') return next();
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, arr] of hits) {
        const keep = arr.filter((t) => now - t < windowMs);
        keep.length ? hits.set(k, keep) : hits.delete(k);
      }
      lastSweep = now;
    }
    const k = key(req);
    if (k === null) return next(); // keyer opted out (e.g. auth middleware already rejected)
    const arr = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: `rate limit exceeded (${name}) — retry later` });
    }
    arr.push(now);
    hits.delete(k); // re-insert so Map iteration order tracks recency (LRU)
    hits.set(k, arr);
    while (hits.size > maxKeys) hits.delete(hits.keys().next().value); // evict least-recently-seen
    next();
  };
  mw.hits = hits; // exposed for tests
  return mw;
}

export const byIp = (req) => req.ip ?? 'unknown';
