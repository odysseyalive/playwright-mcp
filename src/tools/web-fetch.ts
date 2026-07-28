/**
 * web-fetch.ts — stealth-renders a URL (HTML or PDF) and returns readable text +
 * CSL-JSON citation + page-health + CMS, and (on request) outbound links + the
 * reference section. Replaces native WebFetch.
 *
 * Owns all rendering and extraction. The session-side web-search skill drives it
 * over MCP to verify/cite the top native-WebSearch results (links mode harvests
 * leads for research). The MCP tool (webFetch) is a thin wrapper over fetchUrl().
 *
 * Spec: /web-fetch-method. Extraction internals live in src/extract.ts.
 */

import fs from 'node:fs';

import { chromium, type Page } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getStealthContext, pace } from '../browser.js';
import { dismissConsent } from '../consent.js';
import { egressRestricted, assertEgressAllowed, installEgressGuard } from '../egress.js';
import { TtlCache, canonicalUrl } from '../cache.js';
import { sessionFilePath } from '../secrets.js';
import { STEALTH_LAUNCH, STEALTH_INIT, stealthContextOptions } from '../stealth.js';
import {
  classifyHealth,
  extractReadable,
  extractCitation,
  detectCms,
  harvestLinks,
  extractLinkIndex,
  extractPdfText,
  type Citation,
  type FetchStatus,
  type ContentType,
  type LinkScope,
} from '../extract.js';

const FETCH_TIMEOUT_MS = 20_000;
const cache = new TtlCache<FetchResult>(5 * 60_000); // 5-min page cache

export interface FetchResult {
  url: string;
  fetchStatus: FetchStatus;
  contentType: ContentType;
  cms: string | null;
  text: string;
  citation: Citation;
  links?: string[];
  references?: string[];
  /** Present only when quality:"research" — a marker for the session to run the
   *  source-appraiser agent (the server has no LLM; it never fills this). */
  appraisalRequested?: boolean;
  /** Set when the body is not article prose (e.g. a rescued link index). */
  note?: string;
  error?: string;
}

export interface FetchOptions {
  url: string;
  links?: boolean;
  quality?: 'fast' | 'research';
  /**
   * Named session_login artifact to read authenticated (paywalled) content with,
   * e.g. "ft" or "nyt". Loaded into an EPHEMERAL stealth context with its own
   * cookie jar — the authed identity never touches the shared scraping profile
   * (the storageState-isolation rule). Local instance only (refused on remote).
   */
  session?: string;
  /**
   * Which links `links:true` returns. Defaults to `outbound` (research leads),
   * which is what every pre-existing caller expects. Use `same-origin` to
   * enumerate a site's own pages (archives, indexes, tables of contents).
   */
  linkScope?: LinkScope;
}

/**
 * Mechanical render + extract. Never throws into the caller — failures come back
 * as a FetchResult with an error and a best-effort fetchStatus.
 */
export async function fetchUrl(opts: FetchOptions): Promise<FetchResult> {
  const url = canonicalUrl(opts.url);
  const linkScope: LinkScope = opts.linkScope ?? 'outbound';
  const cacheKey = `${url}|links=${opts.links ? 1 : 0}|scope=${linkScope}|session=${opts.session ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Remote (claude.ai) instance: refuse SSRF to metadata/localhost/private nets.
  if (egressRestricted()) {
    try {
      await assertEgressAllowed(url);
    } catch (err) {
      return errorResult(url, 'blocked', err instanceof Error ? err.message : String(err), opts.links);
    }
  }

  // Pick the render context. Anonymous → the shared persistent stealth profile.
  // Authenticated (opts.session) → an EPHEMERAL context seeded with that session's
  // storageState, so authed cookies live in their own jar and never bleed into
  // the shared scraping profile (the storageState-isolation rule). Local-only:
  // a captured session is never loaded on the prompt-injectable remote surface.
  let page: Page;
  let cleanup: () => Promise<void>;
  if (opts.session) {
    if (egressRestricted()) {
      return errorResult(url, 'blocked', 'authenticated web_fetch (session) is disabled on the remote instance', opts.links);
    }
    const file = sessionFilePath(opts.session);
    if (!fs.existsSync(file)) {
      return errorResult(url, 'blocked', `session "${opts.session}" not found — capture it with session_login first`, opts.links);
    }
    const browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
    const context = await browser.newContext({ ...stealthContextOptions, storageState: file, ignoreHTTPSErrors: true });
    await context.addInitScript(STEALTH_INIT);
    page = await context.newPage();
    cleanup = async () => {
      // Rolling session write-back: sites extend cookie expiry on every authed
      // request; persisting the refreshed jar means each read PROLONGS the
      // session instead of letting the artifact age toward its original expiry.
      // Skipped when the page landed on a login wall — a logged-out jar must
      // never overwrite the (possibly recoverable) captured one.
      try {
        const landed = page.url();
        if (!/\/(login|signin|sign-in|auth)(\b|\/|\?)/i.test(landed)) {
          await context.storageState({ path: file });
          fs.chmodSync(file, 0o600);
        }
      } catch {
        /* write-back is best-effort; the read result is unaffected */
      }
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    };
  } else {
    const context = await getStealthContext();
    page = await context.newPage();
    if (egressRestricted()) await installEgressGuard(page);
    cleanup = async () => {
      await page.close().catch(() => {});
    };
  }
  try {
    await pace();
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FETCH_TIMEOUT_MS });
    const status = resp?.status() ?? 0;
    const headers = resp?.headers() ?? {};
    const ctHeader = (headers['content-type'] ?? '').toLowerCase();
    const finalUrl = canonicalUrl(page.url());

    let result: FetchResult;
    if (ctHeader.includes('application/pdf') || /\.pdf($|\?)/i.test(url)) {
      const body = resp ? await resp.body().catch(() => undefined) : undefined;
      const pdf = body ? await extractPdfText(new Uint8Array(body)) : { title: '', text: '' };
      result = {
        url: finalUrl,
        fetchStatus: status === 404 ? '404' : pdf.text ? 'ok' : 'blocked',
        contentType: 'pdf',
        cms: 'PDF',
        text: pdf.text,
        citation: {
          type: 'article-journal',
          title: pdf.title || finalUrl,
          author: [],
          URL: finalUrl,
          dateConfidence: 'low',
        },
      };
    } else {
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      // Dismiss any cookie-consent banner BEFORE extracting. On a link-dense
      // index page the notice is the only substantial prose block, so
      // Readability would otherwise select the privacy text AS the article and
      // discard the real content silently. The shared profile is persistent, so
      // this costs one click per domain, ever.
      await dismissConsent(page);
      const html = await page.content();
      let readable = extractReadable(html, finalUrl);
      let fetchStatus = classifyHealth(html, status, readable.text);
      const citation = extractCitation(html, finalUrl);
      if (!citation.title) citation.title = readable.title || finalUrl;

      // Index rescue: the page carries no usable prose (a surviving banner, or
      // simply a listing) but is dense with on-site links. Return that index as
      // the body rather than a privacy notice or an empty string.
      let note: string | undefined;
      if (fetchStatus === 'consent-wall' || readable.text.length < 600) {
        const index = extractLinkIndex(html, finalUrl);
        if (index.split('\n').length >= 10) {
          readable = { title: readable.title, text: index };
          fetchStatus = 'ok';
          note = 'index page: body is a "label | url" list of on-site links, not prose';
        }
      }

      result = {
        url: finalUrl,
        fetchStatus,
        contentType: 'html',
        cms: detectCms(html, headers),
        text: readable.text,
        citation,
      };
      if (note) result.note = note;
      if (fetchStatus === 'consent-wall') {
        result.error =
          'a cookie-consent notice was returned instead of page content and could not be dismissed; ' +
          'the real content may still be in the DOM. Retry, or add an accept selector to ACCEPT_SELECTORS in src/consent.ts';
      }
      if (opts.links) {
        const leads = harvestLinks(html, finalUrl, linkScope);
        result.links = leads.links;
        result.references = leads.references;
      }
    }

    if (opts.quality === 'research') result.appraisalRequested = true;
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    return errorResult(url, 'blocked', err instanceof Error ? err.message : String(err), opts.links);
  } finally {
    await cleanup();
  }
}

function errorResult(url: string, status: FetchStatus, error: string, links?: boolean): FetchResult {
  const r: FetchResult = {
    url,
    fetchStatus: status,
    contentType: 'html',
    cms: null,
    text: '',
    citation: { type: 'webpage', title: url, author: [], URL: url, dateConfidence: 'low' },
    error,
  };
  if (links) {
    r.links = [];
    r.references = [];
  }
  return r;
}

// ── MCP tool wrapper ──────────────────────────────────────────────────────────

const definition: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a URL via headless Playwright with full JS rendering (handles SPAs and PDFs). ' +
    'Replaces the built-in WebFetch tool. Returns readable main text plus author/date/publisher ' +
    'citation data (CSL-JSON) and page-health status. Set links:true to also harvest outbound ' +
    'links and the reference section, and linkScope:"same-origin" to enumerate a site\'s own pages ' +
    '(archives, indexes, tables of contents). quality:"research" flags the result for source appraisal. ' +
    'Pass session:"name" to read paywalled content behind a session_login capture (local only). ' +
    'Cookie-consent banners are dismissed automatically; a notice that survives returns ' +
    'fetchStatus:"consent-wall" rather than being handed back as page content.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http/https; HTML or PDF).' },
      links: {
        type: 'boolean',
        description: 'Also return outbound links + reference section (for research). Default false.',
      },
      quality: {
        type: 'string',
        enum: ['fast', 'research'],
        description: 'fast = mechanical (default); research = flag for in-session source-appraiser agent.',
      },
      session: {
        type: 'string',
        description:
          'Named session_login artifact (e.g. "ft", "nyt") to read authenticated/paywalled content. ' +
          'Loaded into an isolated ephemeral context; local instance only.',
      },
      linkScope: {
        type: 'string',
        enum: ['outbound', 'same-origin', 'all'],
        description:
          'Which links to return when links:true. "outbound" (default) = research leads leaving the host. ' +
          '"same-origin" = the site\'s own pages, for enumerating an archive, index or table of contents. "all" = both.',
      },
    },
    required: ['url'],
  },
};

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = String(args.url ?? '');
  if (!url) {
    return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
  }
  const scope = String(args.linkScope ?? 'outbound');
  const result = await fetchUrl({
    url,
    links: Boolean(args.links),
    quality: args.quality === 'research' ? 'research' : 'fast',
    session: args.session ? String(args.session) : undefined,
    linkScope: scope === 'same-origin' || scope === 'all' ? scope : 'outbound',
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export const webFetch = { definition, handler };
