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

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getStealthContext, pace } from '../browser.js';
import { TtlCache, canonicalUrl } from '../cache.js';
import {
  classifyHealth,
  extractReadable,
  extractCitation,
  detectCms,
  harvestLinks,
  extractPdfText,
  type Citation,
  type FetchStatus,
  type ContentType,
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
  error?: string;
}

export interface FetchOptions {
  url: string;
  links?: boolean;
  quality?: 'fast' | 'research';
}

/**
 * Mechanical render + extract. Never throws into the caller — failures come back
 * as a FetchResult with an error and a best-effort fetchStatus.
 */
export async function fetchUrl(opts: FetchOptions): Promise<FetchResult> {
  const url = canonicalUrl(opts.url);
  const cacheKey = `${url}|links=${opts.links ? 1 : 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const context = await getStealthContext();
  const page = await context.newPage();
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
      const html = await page.content();
      const readable = extractReadable(html, finalUrl);
      const fetchStatus = classifyHealth(html, status, readable.text);
      const citation = extractCitation(html, finalUrl);
      if (!citation.title) citation.title = readable.title || finalUrl;
      result = {
        url: finalUrl,
        fetchStatus,
        contentType: 'html',
        cms: detectCms(html, headers),
        text: readable.text,
        citation,
      };
      if (opts.links) {
        const leads = harvestLinks(html, finalUrl);
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
    await page.close().catch(() => {});
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
    'links and the reference section. quality:"research" flags the result for source appraisal.',
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
    },
    required: ['url'],
  },
};

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = String(args.url ?? '');
  if (!url) {
    return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
  }
  const result = await fetchUrl({
    url,
    links: Boolean(args.links),
    quality: args.quality === 'research' ? 'research' : 'fast',
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export const webFetch = { definition, handler };
