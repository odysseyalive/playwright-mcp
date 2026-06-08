/**
 * deep-research.ts — the TOP layer, the MECHANICAL recursive gather engine.
 * No reasoning, no LLM: it drives web_search (links mode) + web_fetch, harvests
 * leads, dedups across levels, clusters evidence, enforces the global budget,
 * and returns organized RAW MATERIAL. The thesis/paper reasoning is the
 * session-side `research-paper` skill + agent team — never here.
 *
 * Spec: /deep-research-method (Part 1). Owns: recursion, lead harvest, cross-
 * level dedup, evidence clustering, the global Budget, the research trace.
 * Inherits (never reimplements): engine scraping (web_search), fetch+citations
 * +PDF (web_fetch), scoring + scholarly list (src/score.ts).
 *
 * The lower layers are injected (DeepDeps) so the engine is tested deterministic-
 * ally with stubs — no browser, no network.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { Budget } from '../budget.js';
import { canonicalUrl } from '../cache.js';
import { relevanceScore, similarity, classifySourceType, type SourceType } from '../score.js';
import type { Citation } from '../extract.js';
import { runSearch, type SearchResult } from './web-search.js';
import { fetchUrl, type FetchResult } from './web-fetch.js';

const DRY_LIMIT = 1; // consecutive levels yielding nothing new → stop (until-dry)
const MAX_QUERIES_PER_LEVEL = 2;

export interface DeepOptions {
  query: string;
  depth?: number;
  breadth?: number;
  scholarly?: boolean;
  quality?: 'fast' | 'research';
}

export interface DeepDeps {
  search: (opts: Parameters<typeof runSearch>[0]) => Promise<SearchResult>;
  fetch: (opts: Parameters<typeof fetchUrl>[0]) => Promise<FetchResult>;
}

export interface Source {
  id: string;
  url: string;
  title: string;
  level: number;
  via: 'search' | 'scholar' | 'link' | 'citation';
  sourceType: SourceType;
  independentConsensus: number;
  citation: Citation;
  extract: string;
}

export interface Cluster {
  subtopic: string;
  claims: { claim: string; support: string[] }[];
  sources: string[];
}

export interface DeepResult {
  query: string;
  clusters: Cluster[];
  sources: Source[];
  trace: { action: string; detail: string }[];
  coverage: string;
}

const DEFAULT_DEPS: DeepDeps = { search: runSearch, fetch: fetchUrl };

export async function runDeepResearch(
  opts: DeepOptions,
  deps: DeepDeps = DEFAULT_DEPS,
  budget: Budget = new Budget(),
): Promise<DeepResult> {
  const depth = Math.max(1, Math.min(3, opts.depth ?? 3));
  const breadth = Math.max(1, Math.min(8, opts.breadth ?? 5));
  const scholarly = opts.scholarly ?? true;
  const quality = opts.quality;

  const seenUrls = new Set<string>();
  const seenQueries = new Set<string>();
  const sources: Source[] = [];
  const internalLeads = new Map<string, { links: string[]; references: string[] }>();
  const trace: DeepResult['trace'] = [];
  let sid = 0;

  /** Fetch a URL into the evidence set if new and within budget. */
  const fetchInto = async (
    url: string,
    level: number,
    via: Source['via'],
    consensus = 1,
  ): Promise<Source | null> => {
    const curl = canonicalUrl(url);
    if (seenUrls.has(curl)) return null; // cross-level dedup
    if (!budget.canFetch()) return null;
    seenUrls.add(curl);
    const f = await deps.fetch({ url: curl, links: true, quality, budget });
    trace.push({ action: 'fetched', detail: `${curl} → ${f.fetchStatus}` });
    if (!f.text && f.fetchStatus !== 'paywall') {
      trace.push({ action: 'dropped', detail: `${curl} (no content, ${f.fetchStatus})` });
      return null; // no citation without a usable fetched source
    }
    const src: Source = {
      id: `s${++sid}`,
      url: curl,
      title: f.citation.title || curl,
      level,
      via,
      sourceType: classify(f),
      independentConsensus: consensus,
      citation: f.citation,
      extract: f.text.slice(0, 500),
    };
    sources.push(src);
    internalLeads.set(src.id, { links: f.links ?? [], references: f.references ?? [] });
    return src;
  };

  // ── L1 — survey ──────────────────────────────────────────────────────────
  if (budget.canSearch()) {
    const s1 = await deps.search({ query: opts.query, mode: 'links', scholarly, quality, budget });
    seenQueries.add(opts.query.toLowerCase());
    trace.push({ action: 'searched', detail: `L1 "${opts.query}" → ${s1.results.length} candidates` });
    for (const c of s1.results.slice(0, breadth)) {
      await fetchInto(c.url, 1, c.engines.includes('scholar') ? 'scholar' : 'search', c.consensus);
    }
  }

  // ── L2..Ldepth — follow leads, until-dry ───────────────────────────────────
  let dryRounds = 0;
  for (let level = 2; level <= depth && dryRounds < DRY_LIMIT; level++) {
    if (!budget.canFetch() && !budget.canSearch()) break;
    const prev = sources.filter((s) => s.level === level - 1);
    const { urls, references, queries } = harvestLeads(prev, internalLeads, opts.query);
    let added = 0;

    // Refined sub-queries (web_search links mode).
    for (const q of queries.slice(0, MAX_QUERIES_PER_LEVEL)) {
      if (!budget.canSearch()) break;
      if (seenQueries.has(q.toLowerCase())) continue;
      seenQueries.add(q.toLowerCase());
      const sr = await deps.search({ query: q, mode: 'links', scholarly, quality, budget });
      trace.push({ action: 'searched', detail: `L${level} "${q}" → ${sr.results.length}` });
      for (const c of sr.results.slice(0, breadth)) {
        if (await fetchInto(c.url, level, 'search', c.consensus)) added++;
      }
    }

    // Outbound links + reference-section URLs (scored, deduped, best `breadth`).
    const refSet = new Set(references);
    const leadUrls = rankLeads([...urls, ...references], opts.query, seenUrls).slice(0, breadth);
    for (const u of leadUrls) {
      if (await fetchInto(u, level, refSet.has(u) ? 'citation' : 'link')) added++;
    }

    if (added === 0) dryRounds++;
    else dryRounds = 0;
    trace.push({ action: 'level-done', detail: `L${level} added ${added} (dry=${dryRounds})` });
  }

  const clusters = clusterSources(sources);
  const report = budget.report();
  const coverage =
    `fetches ${report.fetches}/${budget.limits.fetches}, searches ${report.searches}/${budget.limits.searches}` +
    (report.exhausted ? ' (budget exhausted — partial)' : '');

  return { query: opts.query, clusters, sources, trace, coverage };
}

function classify(f: FetchResult): SourceType {
  // web_fetch doesn't classify type; reuse the shared classifier on url+title.
  return classifySourceType({ url: f.url, title: f.citation.title });
}

/** Pool leads from the previous level's sources + derive refined sub-queries. */
function harvestLeads(
  prev: Source[],
  leadMap: Map<string, { links: string[]; references: string[] }>,
  rootQuery: string,
): { urls: string[]; references: string[]; queries: string[] } {
  const urls: string[] = [];
  const references: string[] = [];
  for (const s of prev) {
    const leads = leadMap.get(s.id);
    if (leads) {
      urls.push(...leads.links);
      references.push(...leads.references);
    }
  }
  // Sub-queries: root query + the most salient term from each prev title.
  const queries: string[] = [];
  for (const s of prev) {
    const term = salientTerm(s.title, rootQuery);
    if (term) queries.push(`${rootQuery} ${term}`);
  }
  return { urls: dedup(urls), references: dedup(references), queries: dedup(queries) };
}

function salientTerm(title: string, rootQuery: string): string | undefined {
  const qTerms = rootQuery.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stop = new Set<string>([...qTerms, 'the', 'and', 'for', 'with', 'a']);
  const terms = (title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((t) => !stop.has(t));
  return terms[0];
}

/** Score + dedup candidate lead URLs against everything already seen. */
function rankLeads(urls: string[], query: string, seen: Set<string>): string[] {
  const scored = dedup(urls)
    .map((u) => canonicalUrl(u))
    .filter((u) => !seen.has(u))
    .map((u) => ({ u, score: relevanceScore({ url: u, title: u }, query).score }))
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.u);
}

/**
 * Mechanical evidence clustering: greedily group sources by token similarity of
 * title+extract, label each cluster by its top shared terms, and attach claims
 * (representative sentences from the sources) with their supporting source ids.
 * No reasoning — just grouping so the paper layer gets pre-organized evidence.
 */
function clusterSources(sources: Source[]): Cluster[] {
  const clusters: { members: Source[] }[] = [];
  for (const s of sources) {
    const text = `${s.title} ${s.extract}`;
    let best: { members: Source[] } | undefined;
    let bestSim = 0;
    for (const c of clusters) {
      const rep = `${c.members[0].title} ${c.members[0].extract}`;
      const sim = similarity(text, rep);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best && bestSim >= 0.18) best.members.push(s);
    else clusters.push({ members: [s] });
  }

  return clusters.map((c) => ({
    subtopic: topTerms(c.members),
    sources: c.members.map((m) => m.id),
    claims: c.members
      .map((m) => ({ claim: firstSentence(m.extract), support: [m.id] }))
      .filter((cl) => cl.claim.length > 0),
  }));
}

function topTerms(members: Source[]): string {
  const counts = new Map<string, number>();
  const stop = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'from', 'have', 'they', 'were', 'which']);
  for (const m of members) {
    for (const t of (m.title.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
      if (!stop.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
  return top.join(', ') || members[0]?.title.slice(0, 40) || 'misc';
}

function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text.trim());
  return (m ? m[0] : text).trim().slice(0, 200);
}

function dedup(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

// ── MCP tool wrapper ──────────────────────────────────────────────────────────

const definition: Tool = {
  name: 'deep_research',
  description:
    'Recursively gather research material on a topic: drives web_search (links mode) + web_fetch ' +
    'across up to three levels, harvests leads from references and outbound links, dedups, clusters ' +
    'evidence by subtopic, and returns organized raw material (sources with citations, clusters, ' +
    'and a research trace). Mechanical gather only — turn it into a cited paper with the ' +
    'research-paper skill in session.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question.' },
      depth: { type: 'number', description: 'Recursion levels 1–3 (default 3).' },
      breadth: { type: 'number', description: 'Sources per level 1–8 (default 5).' },
      scholarly: { type: 'boolean', description: 'Include Google Scholar (default true).' },
      quality: { type: 'string', enum: ['fast', 'research'], description: 'research flags agent escalation in session.' },
    },
    required: ['query'],
  },
};

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = String(args.query ?? '');
  if (!query) return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true };
  const result = await runDeepResearch({
    query,
    depth: typeof args.depth === 'number' ? args.depth : undefined,
    breadth: typeof args.breadth === 'number' ? args.breadth : undefined,
    scholarly: args.scholarly === undefined ? undefined : Boolean(args.scholarly),
    quality: args.quality === 'research' ? 'research' : 'fast',
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export const deepResearch = { definition, handler };
