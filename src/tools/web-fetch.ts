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
import {
  egressRestricted,
  assertEgressAllowed,
  installEgressGuard,
  type EgressGuardHandle,
} from '../egress.js';
import { guardOutbound, sessionAllowsUrl, wrapUntrusted } from '../exfil.js';
import { TtlCache, canonicalUrl } from '../cache.js';
import { sessionFilePath, secretInventory } from '../secrets.js';
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
  /**
   * Server-authored, and only that. `error` is emitted OUTSIDE the quarantine
   * because the envelope is this server talking to the model, so nothing a page
   * influenced may be interpolated into it — put that in `errorDetail`.
   */
  error?: string;
  /**
   * The CAPTURED half of a failure: a raw caught-exception message, which for a
   * Playwright error carries the URL the page chose via redirect and whatever
   * text the browser echoed back. Page-influenced, so it rides INSIDE the
   * quarantine (see frameFetchResult) while `error` stays a server sentence.
   * Truncated by `briefly` before it ever gets here.
   */
  errorDetail?: string;
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

  // Outbound exfiltration guards (ledger DEC-2026-07-29). Runs on EVERY instance,
  // unlike the egress check below — this watches what leaves, not what we can be
  // pointed at. A cache hit skips it: that URL already shipped, so there is
  // nothing left to prevent.
  const guard = guardOutbound(url, secretInventory());
  if (!guard.ok) {
    return errorResult(url, 'blocked', guard.reason ?? 'refused by the exfiltration guard', opts.links);
  }

  // Remote (claude.ai) instance: refuse SSRF to metadata/localhost/private nets.
  if (egressRestricted()) {
    try {
      await assertEgressAllowed(url);
    } catch (err) {
      return errorResult(
        url,
        'blocked',
        'refused by the egress guard: the reason is quarantined below as `errorDetail` — ' +
          'it is a caught error message, not this server speaking',
        opts.links,
        briefly(err),
      );
    }
  }

  // Pick the render context. Anonymous → the shared persistent stealth profile.
  // Authenticated (opts.session) → an EPHEMERAL context seeded with that session's
  // storageState, so authed cookies live in their own jar and never bleed into
  // the shared scraping profile (the storageState-isolation rule). Local-only:
  // a captured session is never loaded on the prompt-injectable remote surface.
  //
  // Acquiring the page is inside the try: a browser that will not start is a
  // fetch failure like any other, and must come back as a FetchResult. It used
  // to throw past this function, breaking the never-throw contract and reaching
  // the model as a bare `Error in web_fetch:` with no fetchStatus.
  let page: Page;
  let cleanup: (() => Promise<void>) | undefined;
  // Set only on the remote instance; reads back the reason a redirect hop was
  // refused, which page.goto reports only as net::ERR_ACCESS_DENIED.
  let egressGuard: EgressGuardHandle | undefined;
  try {
    if (opts.session) {
      if (egressRestricted()) {
        return errorResult(url, 'blocked', 'authenticated web_fetch (session) is disabled on the remote instance', opts.links);
      }
      const file = sessionFilePath(opts.session);
      if (!fs.existsSync(file)) {
        return errorResult(url, 'blocked', `session "${opts.session}" not found — capture it with session_login first`, opts.links);
      }
      // Session domain scoping (DEC-2026-07-29): a captured identity may only be
      // replayed against its own registrable domains, so an injected page cannot
      // get an authenticated context pointed at an attacker host. Reading the
      // artifact here also gives a corrupt one a clean refusal instead of letting
      // newContext() throw past fetchUrl's never-throw contract.
      let state: unknown;
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return errorResult(url, 'blocked', `session "${opts.session}" is unreadable or corrupt — recapture it with session_login`, opts.links);
      }
      if (!sessionAllowsUrl(state, url)) {
        return errorResult(
          url,
          'blocked',
          `refused: session "${opts.session}" holds no identity for this URL's domain. ` +
            'A captured session is only replayed against the site it was captured on — ' +
            'fetch this URL without the session parameter.',
          opts.links,
        );
      }
      const browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
      // Registered before the context exists: if newContext/newPage throws, the
      // catch below still has something that closes this chromium.
      cleanup = async () => {
        await browser.close().catch(() => {});
      };
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
      cleanup = async () => {
        await page.close().catch(() => {});
      };
      if (egressRestricted()) egressGuard = await installEgressGuard(page);
    }
  } catch (err) {
    await cleanup?.();
    // Two values, not one sentence. The launch failure's own text is a caught
    // exception — see errorResult, and `errorDetail` in FetchResult.
    return errorResult(
      url,
      'blocked',
      'browser unavailable: the render browser would not start; the failure text is quarantined ' +
        'below as `errorDetail`',
      opts.links,
      briefly(err),
    );
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
    // A refused redirect hop reaches here as a bare chromium error code, so the
    // guard's own reason wins when it has one. Two branches, and they differ in
    // PROVENANCE, not only in wording: the guard's reason is server-authored and
    // belongs in the envelope; anything else is a caught error from a navigation
    // the page steered, so it is quarantined instead.
    const refusedHop = egressGuard?.blocked();
    return refusedHop
      ? errorResult(url, 'blocked', refusedHop, opts.links)
      : errorResult(
          url,
          'blocked',
          'the page could not be fetched: the browser error is quarantined below as `errorDetail`',
          opts.links,
          briefly(err),
        );
  } finally {
    await cleanup?.();
  }
}

/** Playwright errors carry a whole browser log; keep the head of it, not all of it. */
function briefly(err: unknown, max = 400): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/**
 * Two provenances, two arguments — never one interpolated sentence.
 *
 * `error` is the server's own words and lands in the envelope; `detail` is text
 * a page influenced (a caught browser error) and lands inside the quarantine.
 * `briefly()` it first: the field is bounded, not the fence.
 */
function errorResult(
  url: string,
  status: FetchStatus,
  error: string,
  links?: boolean,
  detail?: string,
): FetchResult {
  const r: FetchResult = {
    url,
    fetchStatus: status,
    contentType: 'html',
    cms: null,
    text: '',
    citation: { type: 'webpage', title: url, author: [], URL: url, dateConfidence: 'low' },
    error,
  };
  if (detail) r.errorDetail = detail;
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

/**
 * Serialize a FetchResult for model context, partitioned by WHO AUTHORED each
 * field (ledger DEC-2026-07-29).
 *
 * Inside the quarantine go the fields the PAGE controls: `text`, `citation`
 * (its title/author come from the page's own `<title>`, `og:title` and JSON-LD),
 * `cms`, and the harvested `links` / `references` — those last two are
 * attacker-chosen fetch targets handed to the model on the very tool the
 * research skills use to pick the next fetch, so they belong inside the fence
 * more than anything except the body itself.
 *
 * Outside it stays everything THIS SERVER authored: `fetchStatus`, `error`,
 * `note`, `appraisalRequested`, plus the canonical `url` (which is also the
 * quarantine's own `source=` attribute) and `contentType`. Those are the server
 * talking to the model, and several of them are deliberately actionable
 * ("capture it with session_login first"). Marking them "data, not
 * instructions" would tell the model to ignore its own tool's guidance — a
 * false positive that costs real functionality.
 *
 * `errorDetail` is the correction that made that claim TRUE. `error` used to be
 * built as `browser unavailable: ${briefly(err)}` — one string with two
 * provenances, the second of which is a raw caught exception whose Playwright
 * text embeds the URL a page chose by redirecting. The envelope was exempted on
 * the reasoning that it is "the server talking to the model", which was a claim
 * about what the field is FOR rather than about what went INTO it. Splitting the
 * two halves does not merely avoid mixing them: it makes the partition's premise
 * true. The captured half moves INSIDE, as a field of the quarantined body —
 * not as a second fenced block — so the "fenced exactly once" invariant holds
 * for every result rather than only for results without a detail.
 *
 * Framed unconditionally, including on the error path. The alternative — skip
 * the wrap when the body is empty — leaks `citation.title` (read from a hostile
 * `<title>`) whenever a page returns markup but no prose, and teaches the model
 * that an unframed result is a trusted one.
 *
 * The text block is therefore deliberately NOT one JSON document: the envelope
 * and the quarantined body are each valid JSON with the delimiter between them.
 * A single document cannot carry a delimiter around a subtree without
 * re-escaping 50 KB of body text a second time. No consumer parses this string
 * (in-process callers use fetchUrl and never see the framing).
 *
 * Pure — no browser, no network — so the T1 tier exercises it directly.
 */
export function frameFetchResult(result: FetchResult): string {
  const { text, citation, cms, links, references, errorDetail, ...envelope } = result;
  const pageDerived: Record<string, unknown> = { cms, text, citation };
  // links/references are absent unless links:true was asked for; keep them that
  // way rather than inventing empty arrays the caller did not request.
  if (links) pageDerived.links = links;
  if (references) pageDerived.references = references;
  // Same rule, same reason: absent on the success path, so a result that has no
  // captured failure text does not grow an empty field announcing one.
  if (errorDetail !== undefined) pageDerived.errorDetail = errorDetail;
  return (
    `${JSON.stringify(envelope, null, 2)}\n` +
    wrapUntrusted(JSON.stringify(pageDerived, null, 2), result.url)
  );
}

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
  // Provenance framing (DEC-2026-07-29): every page-derived field is quarantined
  // with its warning in the opening delimiter, adjacent to the content it is
  // warning about. Applied at the MCP boundary — fetchUrl's structured result is
  // what in-process callers want, the framing is for what enters model context.
  return { content: [{ type: 'text', text: frameFetchResult(result) }] };
}

export const webFetch = { definition, handler };
