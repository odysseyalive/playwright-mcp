/**
 * cache.ts — short-TTL in-memory cache for SERP pages and fetched documents.
 *
 * Politeness + speed: a deep_research run re-fetches the same URL or re-issues
 * the same query across levels; this collapses those to one hit. Process-local,
 * not persisted — a fresh server starts cold. Keyed by canonical URL (fetches)
 * or normalized query+engine (SERPs).
 *
 * `now` is injected on every read/write so tests are deterministic without
 * touching the real clock.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();
  constructor(private readonly ttlMs: number) {}

  get(key: string, now: number = Date.now()): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (now >= hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  has(key: string, now: number = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }
}

/** Tracking params stripped during canonicalization (cache-key stability). */
const TRACKING_PARAMS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^mc_/,
  /^ref$/,
  /^ref_src$/,
  /^igshid$/,
  /^spm$/,
  /^_hsenc$/,
  /^_hsmi$/,
];

/**
 * Canonicalize a URL for cache keying and dedup: lowercase host, drop the
 * fragment, strip tracking params, sort the remaining query, drop a trailing
 * slash on non-root paths. Redirect resolution happens at fetch time (it needs
 * the network); this is the pure, structural half. Returns the input unchanged
 * if it is not a parseable absolute URL.
 */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.trim();
  }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS.some((re) => re.test(k))) continue;
    kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

/** Normalize a query string for SERP cache keys (engine-scoped). */
export function queryKey(engine: string, query: string): string {
  return `${engine}:${query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}
