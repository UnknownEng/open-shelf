'use strict';
const { HttpError } = require('./http');

/** Fixed-window in-memory rate limiter. Swap for Redis when running multiple instances. */
const buckets = new Map();

const SCALE = Number(process.env.RATE_LIMIT_SCALE || 1); // e.g. raise for load tests

function limit(key, max, windowMs) {
  max *= SCALE;
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) {
    const err = new HttpError(429, 'Too many requests. Please slow down and try again shortly.');
    err.retryAfter = Math.ceil((b.reset - t) / 1000);
    throw err;
  }
}

setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
}, 60_000).unref();

module.exports = { limit, _buckets: buckets };
