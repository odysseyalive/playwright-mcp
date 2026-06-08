/**
 * web-search.ts — the MIDDLE layer. Scrapes three engines (Google + Bing +
 * DuckDuckGo, optional Scholar) through the shared stealth browser, re-ranks by
 * OUR relevance signals (not engine order), collapses syndicated reprints, and
 * (confirm mode) confirm-fetches the best 6 via web_fetch — citations inherited
 * from web_fetch, never re-extracted here. Replaces native WebSearch.
 *
 * Spec: /web-search-method. Ranking lives in rankCandidates() (pure, testable);
 * runSearch() drives the browser around it. deep_research calls runSearch() in
 * links mode in-process so it owns the global fetch budget.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getStealthContext, pace } from '../browser.js';
import { TtlCache, canonicalUrl, queryKey } from '../cache.js';
import { Budget } from '../budget.js';
import {
  classifySourceType,
  relevanceScore,
  consensusBoost,
  inferIntent,
  similarity,
  type SourceType,
  type Relevance,
} from '../score.js';
import { fetchUrl } from './web-fetch.js';
import type { Citation, FetchStatus } from '../extract.js';
import { type Engine, type RawResult } from '../engines/types.js';
import { duckduckgo } from '../engines/duckduckgo.js';
import { bing } from '../engines/bing.js';
import { google } from '../engines/google.js';
import { scholar } from '../engines/scholar.js';

const NAV_TIMEOUT_MS = 15_000;
const SYNDICATION_SIM = 0.85;
const serpCache = new TtlCache<RawResult[]>(5 * 60_000);

export interface RankedResult {
  rank: number;
  url: string;
  title: string;
  engines: string[];
  consensus: number;
  sourceType: SourceType;
  relevance: Relevance;
  fetchStatus?: FetchStatus;
  citation?: Citation;
  extract?: string;
}

export interface SearchResult {
  query: string;
  engines: {
    attempted: string[];
    succeeded: string[];
    failed: { engine: string; reason: string }[];
  };
  results: RankedResult[];
  coverage: string;
}

export interface SearchOptions {
  query: string;
  mode?: 'links' | 'confirm';
  quality?: 'fast' | 'research';
  scholarly?: boolean;
  budget?: Budget;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * PURE ranking pipeline over per-engine results (no browser, no network):
 * Stage A (best 2/engine) → A.5 (dedup canonical URL, collapse syndicated
 * near-dups across domains — the corroboration guard, so a reprint farm can't
 * manufacture authority) → Stage B (relevance + small independent-consensus
 * boost). consensus = distinct engines that surfaced the canonical URL.
 */
export function rankCandidates(
  byEngine: Map<string, RawResult[]>,
  query: string,
  limit = 12,
): RankedResult[] {
  const intent = inferIntent(query);

  // Stage A — best 2 per engine.
  const pool: { engine: string; raw: RawResult; rel: Relevance }[] = [];
  for (const [engine, results] of byEngine) {
    const scored = results
      .map((raw) => ({ engine, raw, rel: relevanceScore(raw, query, intent) }))
      .sort((a, b) => b.rel.score - a.rel.score);
    pool.push(...scored.slice(0, 2));
  }

  // Stage A.5a — dedup exact canonical URL; union engines (cross-engine consensus).
  const byUrl = new Map<string, { url: string; title: string; engines: Set<string>; rel: Relevance }>();
  for (const p of pool) {
    const key = canonicalUrl(p.raw.url);
    const existing = byUrl.get(key);
    if (existing) {
      existing.engines.add(p.engine);
      if (p.rel.score > existing.rel.score) {
        existing.rel = p.rel;
        existing.title = p.raw.title;
      }
    } else {
      byUrl.set(key, { url: key, title: p.raw.title, engines: new Set([p.engine]), rel: p.rel });
    }
  }

  // Stage A.5b — collapse syndicated near-duplicates across different domains.
  // Independent-corroboration guard: a reprint at another domain is dropped and
  // does NOT bump consensus, so a wire-story reprint farm can't fake authority.
  const sorted = [...byUrl.values()].sort((a, b) => b.rel.score - a.rel.score);
  const kept: typeof sorted = [];
  for (const e of sorted) {
    const dup = kept.find((k) => host(k.url) !== host(e.url) && similarity(k.title, e.title) >= SYNDICATION_SIM);
    if (!dup) kept.push(e);
  }

  // Stage B — final pre-fetch score.
  return kept
    .map((e) => {
      const consensus = e.engines.size;
      const boost = consensusBoost(consensus);
      const score = Number(Math.max(0, Math.min(1, e.rel.score + boost)).toFixed(3));
      const why = boost ? `${e.rel.why}, +${boost.toFixed(2)} consensus(${consensus})` : e.rel.why;
      return {
        url: e.url,
        title: e.title,
        engines: [...e.engines].sort(),
        consensus,
        sourceType: classifySourceType({ url: e.url, title: e.title }),
        relevance: { score, why },
      };
    })
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, limit)
    .map((r, i): RankedResult => ({ rank: i + 1, ...r }));
}

const ALL_ENGINES = (scholarly: boolean): Engine[] => [
  duckduckgo,
  bing,
  google,
  ...(scholarly ? [scholar] : []),
];

/** Drive one engine through the stealth browser and parse its SERP. */
async function scrapeEngine(
  engine: Engine,
  query: string,
  jitterSeed: number,
): Promise<{ ok: true; results: RawResult[] } | { ok: false; reason: string }> {
  const cached = serpCache.get(queryKey(engine.name, query));
  if (cached) return { ok: true, results: cached };

  const context = await getStealthContext();
  const page = await context.newPage();
  try {
    await pace(350, jitterSeed);
    await page.goto(engine.buildUrl(query), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector(engine.resultSelector, { timeout: 8_000 }).catch(() => {});
    const html = await page.content();
    if (engine.detectBlock(html)) return { ok: false, reason: 'blocked' };
    const results = engine.parse(html);
    if (results.length === 0) return { ok: false, reason: 'empty' };
    serpCache.set(queryKey(engine.name, query), results);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 80) : 'error' };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Full search. In `links` mode returns merged, pre-fetch-ranked candidates (no
 * fetch — what deep_research drives). In `confirm` mode confirm-fetches the best
 * 6 via web_fetch, attaching citation + page-health and demoting dead winners.
 */
export async function runSearch(opts: SearchOptions): Promise<SearchResult> {
  const { query } = opts;
  const mode = opts.mode ?? 'confirm';
  const scholarly = opts.scholarly ?? false;
  const engines = ALL_ENGINES(scholarly);
  const attempted = engines.map((e) => e.name);

  if (opts.budget && !opts.budget.canSearch()) {
    return {
      query,
      engines: { attempted, succeeded: [], failed: attempted.map((e) => ({ engine: e, reason: 'budget' })) },
      results: [],
      coverage: 'search budget exhausted',
    };
  }
  opts.budget?.spendSearch();

  const byEngine = new Map<string, RawResult[]>();
  const failed: { engine: string; reason: string }[] = [];
  const outcomes = await Promise.all(
    engines.map((e, i) => scrapeEngine(e, query, (i + 1) / (engines.length + 1))),
  );
  engines.forEach((e, i) => {
    const o = outcomes[i];
    if (o.ok) byEngine.set(e.name, o.results);
    else failed.push({ engine: e.name, reason: o.reason });
  });
  const succeeded = [...byEngine.keys()];

  let results = rankCandidates(byEngine, query, mode === 'links' ? 12 : 8);

  if (mode === 'confirm' && results.length > 0) {
    results = await confirmFetch(results, opts.budget);
  }

  return {
    query,
    engines: { attempted, succeeded, failed },
    results,
    coverage:
      failed.length > 0 ? `engines dropped: ${failed.map((f) => `${f.engine}(${f.reason})`).join(', ')}` : 'full',
  };
}

/** Confirm-fetch the best 6 via web_fetch; demote dead winners, keep paywalls. */
async function confirmFetch(candidates: RankedResult[], budget?: Budget): Promise<RankedResult[]> {
  const best = candidates.slice(0, 6);
  const reserve = candidates.slice(6);
  const confirmed: RankedResult[] = [];

  for (const c of best) {
    const f = await fetchUrl({ url: c.url, budget });
    const enriched: RankedResult = {
      ...c,
      fetchStatus: f.fetchStatus,
      citation: f.citation,
      extract: f.text ? f.text.slice(0, 400) : undefined,
    };
    // Hard-dead winners get replaced from reserve; paywalls are kept.
    if ((f.fetchStatus === '404' || f.fetchStatus === 'blocked') && reserve.length > 0) {
      const backfill = reserve.shift()!;
      const bf = await fetchUrl({ url: backfill.url, budget });
      confirmed.push({
        ...backfill,
        fetchStatus: bf.fetchStatus,
        citation: bf.citation,
        extract: bf.text ? bf.text.slice(0, 400) : undefined,
      });
    } else {
      confirmed.push(enriched);
    }
  }

  return confirmed
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ── MCP tool wrapper ──────────────────────────────────────────────────────────

const definition: Tool = {
  name: 'web_search',
  description:
    'Search the web across Google, Bing, and DuckDuckGo (optionally Google Scholar) via headless ' +
    'Playwright — no engine APIs. Replaces the built-in WebSearch tool. Reads each engine\'s full ' +
    'first page, confirms the best results by fetching them, and returns up to 6 sources ranked ' +
    'best→worst with author/date/CMS citations.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      mode: {
        type: 'string',
        enum: ['links', 'confirm'],
        description: 'confirm (default) fetches the best results for citations; links returns ranked candidates only.',
      },
      scholarly: { type: 'boolean', description: 'Also query Google Scholar. Default false.' },
      quality: {
        type: 'string',
        enum: ['fast', 'research'],
        description: 'fast = mechanical ranking (default); research = flag for in-session relevance-adjudicator agent.',
      },
    },
    required: ['query'],
  },
};

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = String(args.query ?? '');
  if (!query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
  const result = await runSearch({
    query,
    mode: args.mode === 'links' ? 'links' : 'confirm',
    scholarly: Boolean(args.scholarly),
    quality: args.quality === 'research' ? 'research' : 'fast',
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export const webSearch = { definition, handler };
