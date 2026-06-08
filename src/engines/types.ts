/**
 * engines/types.ts — the per-engine SERP scraper contract.
 *
 * Engines are PURE: they build a query URL and parse a SERP HTML string. They
 * never touch the browser — web-search.ts owns navigation/pacing and feeds each
 * engine the rendered HTML. This keeps every selector testable against recorded
 * fixtures (the parity harness is the regression check; drift order
 * Google > Scholar > Bing > DuckDuckGo).
 */

export interface RawResult {
  title: string;
  url: string;
  snippet: string;
}

export interface Engine {
  readonly name: string;
  /** Build the first-page search URL for a query. */
  buildUrl(query: string): string;
  /** CSS selector for the results container — web-search waits on it post-nav. */
  readonly resultSelector: string;
  /** True when the SERP is a consent/CAPTCHA/empty wall (engine drops out). */
  detectBlock(html: string): boolean;
  /** Parse organic results from the SERP HTML (pure). */
  parse(html: string): RawResult[];
}

/** Resolve a possibly-relative or redirect-wrapped href to a clean http(s) URL. */
export function cleanHref(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  let h = href.trim();
  if (h.startsWith('//')) h = 'https:' + h;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return undefined;
  }
  // DuckDuckGo redirect: /l/?uddg=<encoded target>
  if (/duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith('/l/')) {
    const target = u.searchParams.get('uddg');
    if (target) {
      try {
        return new URL(decodeURIComponent(target)).toString();
      } catch {
        return undefined;
      }
    }
  }
  // Google redirect: /url?q=<target>
  if (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname === '/url') {
    const target = u.searchParams.get('q') || u.searchParams.get('url');
    if (target) {
      try {
        return new URL(target).toString();
      } catch {
        return undefined;
      }
    }
  }
  if (!/^https?:$/i.test(u.protocol)) return undefined;
  return u.toString();
}
