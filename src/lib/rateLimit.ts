/** Tiny in-memory sliding-window limiter to protect the paid AI endpoint on a public URL. Per server instance. */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit = Number(process.env.ASK_RATE_LIMIT ?? 20), windowMs = 60_000): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return true;
}
