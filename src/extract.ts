/**
 * extract.ts — content + citation extraction. OWNED by web_fetch; the single
 * source of truth for the whole stack (web_search confirm-fetch and
 * deep_research level-fetches call web_fetch and inherit all of this; nothing
 * above re-extracts).
 *
 * Everything here is PURE over an HTML string (or PDF bytes) + url, so it is
 * tested against recorded fixtures with no browser. The browser lives in
 * web_fetch (render) — extraction never touches the network.
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export type FetchStatus = 'ok' | 'paywall' | '404' | 'parked' | 'login-wall' | 'blocked';
export type ContentType = 'html' | 'pdf';

export interface CslAuthor {
  family: string;
  given?: string;
}

export interface Citation {
  type: string;
  title: string;
  author: CslAuthor[];
  'container-title'?: string;
  issued?: { 'date-parts': number[][] };
  URL: string;
  dateConfidence: 'high' | 'low';
}

// ── Page health ────────────────────────────────────────────────────────────

const BLOCK_TELL = /unusual traffic|are you a robot|captcha|verify you are human|access denied|cf-error-details/i;
const LOGIN_TELL = /sign in to continue|log ?in to continue|please sign in|you must be logged in/i;
const PAYWALL_TELL = /subscribe to (read|continue)|subscribers only|this article is for subscribers|create a free account to (read|continue)|metered/i;
const NOTFOUND_TELL = /\b(404|page not found|page can.?t be found|no longer exists|content (is )?unavailable)\b/i;
const PARKED_TELL = /domain (is )?for sale|buy this domain|parked (free|domain)|courtesy of (godaddy|sedo)/i;

/**
 * Classify page health from the rendered HTML + HTTP status. Callers branch on
 * status, not content-type. `bodyText` (readable text, if already extracted)
 * sharpens soft-404 / paywall / truncation calls.
 */
export function classifyHealth(html: string, httpStatus = 200, bodyText?: string): FetchStatus {
  if (httpStatus === 404) return '404';
  if (httpStatus === 403 || httpStatus === 429) return 'blocked';
  const head = html.slice(0, 60_000);
  if (BLOCK_TELL.test(head)) return 'blocked';
  if (PARKED_TELL.test(head)) return 'parked';

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '') ?? '';
  // Soft-404: 200 OK but the title/H1 announces not-found.
  if (NOTFOUND_TELL.test(title) || NOTFOUND_TELL.test(h1)) return '404';

  const body = bodyText ?? '';
  const short = body.length > 0 && body.length < 600;
  // Subscription sites (NYT, News Corp titles) embed regwall/paywall markup in
  // the DOM regardless of entitlement, so PAYWALL_TELL fires even on a full,
  // authenticated read. Only call it a wall when the content is actually gated —
  // missing or truncated body — not when a substantial article body came through.
  const substantial = body.length >= 1500;
  if (LOGIN_TELL.test(head) && short) return 'login-wall';
  if (PAYWALL_TELL.test(head) && !substantial) return 'paywall';
  return 'ok';
}

// ── Readable content ─────────────────────────────────────────────────────────

export interface Readable {
  title: string;
  text: string;
}

/** Run Mozilla Readability over the rendered DOM; fall back to body text. */
export function extractReadable(html: string, url: string): Readable {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const title = doc.title || '';
  try {
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (article && article.textContent && article.textContent.trim().length > 0) {
      return { title: article.title || title, text: article.textContent.trim() };
    }
  } catch {
    /* fall through to body text */
  }
  const text = (doc.body?.textContent ?? '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  return { title, text };
}

// ── Citation (CSL-JSON), priority chain ──────────────────────────────────────

function splitName(full: string): CslAuthor {
  const name = full.trim().replace(/\s+/g, ' ');
  const parts = name.split(' ');
  if (parts.length === 1) return { family: parts[0] };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

function parseDateParts(raw?: string | null): number[][] | undefined {
  if (!raw) return undefined;
  const m = /(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?/.exec(raw);
  if (!m) return undefined;
  const parts = [Number(m[1])];
  if (m[2]) parts.push(Number(m[2]));
  if (m[3]) parts.push(Number(m[3]));
  return [parts];
}

function meta(doc: Document, sel: string): string | undefined {
  const el = doc.querySelector(sel);
  const v = el?.getAttribute('content') ?? el?.getAttribute('href') ?? el?.textContent;
  return v?.trim() || undefined;
}

const ARTICLE_TYPES = /Article|NewsArticle|BlogPosting|ScholarlyArticle|Report|WebPage/;

function fromJsonLd(doc: Document): Partial<Citation> | undefined {
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  for (const s of scripts) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    const nodes: any[] = Array.isArray(data) ? data : (data as any)?.['@graph'] ?? [data];
    for (const node of nodes) {
      const type = Array.isArray(node?.['@type']) ? node['@type'].join(' ') : String(node?.['@type'] ?? '');
      if (!ARTICLE_TYPES.test(type)) continue;
      const authorRaw = node.author;
      const authors: CslAuthor[] = [];
      const pushAuthor = (a: any) => {
        const n = typeof a === 'string' ? a : a?.name;
        if (n) authors.push(splitName(n));
      };
      if (Array.isArray(authorRaw)) authorRaw.forEach(pushAuthor);
      else if (authorRaw) pushAuthor(authorRaw);
      return {
        type: /News/.test(type) ? 'article-newspaper' : /Scholarly/.test(type) ? 'article-journal' : 'webpage',
        title: node.headline || node.name,
        author: authors,
        'container-title': typeof node.publisher === 'object' ? node.publisher?.name : node.publisher,
        issued: parseDateParts(node.datePublished) ? { 'date-parts': parseDateParts(node.datePublished)! } : undefined,
      };
    }
  }
  return undefined;
}

/**
 * Build a CSL-JSON citation via the trust-ordered priority chain:
 * JSON-LD (high) → OG/article meta (high) → Dublin Core / highwire (high) →
 * visible byline (low). `dateConfidence` is `low` only when the date came from
 * a scraped byline, never from structured metadata.
 */
export function extractCitation(html: string, url: string): Citation {
  const doc = new JSDOM(html, { url }).window.document;
  const title = doc.title || meta(doc, 'meta[property="og:title"]') || '';
  const base: Citation = { type: 'webpage', title, author: [], URL: url, dateConfidence: 'low' };

  // 1. JSON-LD (highest trust)
  const ld = fromJsonLd(doc);
  if (ld) {
    return {
      ...base,
      type: ld.type ?? base.type,
      title: ld.title || base.title,
      author: ld.author?.length ? ld.author : base.author,
      'container-title': ld['container-title'],
      issued: ld.issued,
      dateConfidence: ld.issued ? 'high' : 'low',
    };
  }

  // 2. OpenGraph / article meta + 3. Dublin Core / highwire
  const ogAuthor =
    meta(doc, 'meta[property="article:author"]') ||
    meta(doc, 'meta[name="author"]') ||
    meta(doc, 'meta[name="DC.creator"]') ||
    meta(doc, 'meta[name="citation_author"]');
  const ogDate =
    meta(doc, 'meta[property="article:published_time"]') ||
    meta(doc, 'meta[name="DC.date"]') ||
    meta(doc, 'meta[name="citation_publication_date"]') ||
    meta(doc, 'meta[itemprop="datePublished"]');
  const site = meta(doc, 'meta[property="og:site_name"]') || meta(doc, 'meta[name="citation_journal_title"]');

  if (ogAuthor || ogDate || site) {
    return {
      ...base,
      title: meta(doc, 'meta[property="og:title"]') || base.title,
      author: ogAuthor ? ogAuthor.split(/,| and /).map((a) => splitName(a)).filter((a) => a.family) : [],
      'container-title': site,
      issued: parseDateParts(ogDate) ? { 'date-parts': parseDateParts(ogDate)! } : undefined,
      dateConfidence: ogDate ? 'high' : 'low',
    };
  }

  // 4. Visible byline (low confidence)
  const byline =
    meta(doc, '[rel="author"]') || meta(doc, '.byline') || meta(doc, '.author') || meta(doc, '[itemprop="author"]');
  const timeEl = doc.querySelector('time[datetime]')?.getAttribute('datetime') ?? undefined;
  return {
    ...base,
    author: byline ? [splitName(byline.replace(/^by\s+/i, ''))] : [],
    issued: parseDateParts(timeEl) ? { 'date-parts': parseDateParts(timeEl)! } : undefined,
    dateConfidence: 'low',
  };
}

// ── CMS detection ─────────────────────────────────────────────────────────────

/** Best-effort CMS/platform detection; null when unknown. */
export function detectCms(html: string, headers: Record<string, string> = {}): string | null {
  const generator = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  if (generator) {
    if (/wordpress/i.test(generator)) return 'WordPress';
    if (/drupal/i.test(generator)) return 'Drupal';
    if (/ghost/i.test(generator)) return 'Ghost';
    if (/hugo/i.test(generator)) return 'Hugo';
    return generator.split(' ')[0];
  }
  const powered = headers['x-powered-by'];
  if (powered && /wordpress|express|next/i.test(powered)) return powered;
  if (/cdn\.substack\.com|substackcdn/i.test(html)) return 'Substack';
  if (/wp-content\/|wp-includes\//i.test(html)) return 'WordPress';
  if (/\/_next\/static\//i.test(html)) return 'Next.js';
  if (/MediaWiki|mw-content-text/i.test(html)) return 'MediaWiki';
  if (/arxiv\.org/i.test(html) && /abs\//i.test(html)) return 'arXiv';
  return null;
}

// ── Lead harvesting (deep_research; only when links:true) ─────────────────────

const REF_SECTION = /(references|bibliography|works cited|citations|sources|further reading)/i;

export interface Leads {
  links: string[];
  references: string[];
}

/**
 * Harvest outbound links from the main content and, separately, the links in any
 * reference/bibliography section. Returned apart so the upstream harvester does
 * not re-parse. Only called when web_fetch is invoked with links:true.
 */
export function harvestLinks(html: string, url: string): Leads {
  const doc = new JSDOM(html, { url }).window.document;
  let origin = '';
  try {
    origin = new URL(url).hostname;
  } catch {
    /* keep origin empty → treat all as outbound */
  }

  const abs = (href: string): string | undefined => {
    try {
      return new URL(href, url).toString();
    } catch {
      return undefined;
    }
  };
  const isHttp = (u: string) => /^https?:\/\//i.test(u);
  const outbound = (u: string) => {
    try {
      return new URL(u).hostname !== origin;
    } catch {
      return false;
    }
  };

  // Reference section: find a heading matching REF_SECTION, take links after it.
  const references: string[] = [];
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,section,div')];
  for (const h of headings) {
    const label = (h.getAttribute('id') || h.textContent || '').slice(0, 40);
    if (REF_SECTION.test(label)) {
      for (const a of h.querySelectorAll('a[href]')) {
        const u = abs(a.getAttribute('href') ?? '');
        if (u && isHttp(u)) references.push(u);
      }
    }
  }

  const links: string[] = [];
  const main = doc.querySelector('main, article') ?? doc.body;
  for (const a of main?.querySelectorAll('a[href]') ?? []) {
    const u = abs(a.getAttribute('href') ?? '');
    if (u && isHttp(u) && outbound(u)) links.push(u);
  }

  return { links: dedup(links).slice(0, 100), references: dedup(references).slice(0, 100) };
}

function dedup(xs: string[]): string[] {
  return [...new Set(xs)];
}

// ── PDF text ──────────────────────────────────────────────────────────────────

/**
 * Extract text from PDF bytes (scholarly sources are mostly PDFs). Uses
 * pdfjs-dist; image-only PDFs return empty text (OCR is an escalation-only hook,
 * intentionally not wired here). Never throws into the caller.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<Readable> {
  try {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true }).promise;
    const out: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out.push(content.items.map((it: any) => ('str' in it ? it.str : '')).join(' '));
    }
    const meta = await doc.getMetadata().catch(() => undefined);
    const title = (meta?.info as any)?.Title?.trim() || '';
    return { title, text: out.join('\n').replace(/[ \t]{2,}/g, ' ').trim() };
  } catch (err) {
    return { title: '', text: '' };
  }
}
