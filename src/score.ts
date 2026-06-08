/**
 * score.ts — the SHARED scoring spine for web_search and deep_research.
 * Single source of truth: source-type classification, the one static
 * scholarly/primary boost list, query-intent inference, relevance scoring, and
 * independent-consensus weighting. Never copied into a second file.
 *
 * Design rules (from /web-search-method § Selection & ranking):
 *  - Relevance is the SPINE; everything else is a SMALL modifier.
 *  - No curated list of "blessed" brand domains — classify by what a source IS.
 *  - The ONE static list is the scholarly/primary boost (.edu/.gov/doi/arxiv/…).
 *  - Keep boosts small; never let "trusted-but-off-topic" beat
 *    "untrusted-but-bang-on". Surface every boost in `why`.
 */

export type SourceType =
  | 'primary'
  | 'academic'
  | 'reference'
  | 'journalism'
  | 'blog'
  | 'commercial'
  | 'content-farm'
  | 'unknown';

export type QueryIntent = 'docs' | 'current-events' | 'research' | 'general';

export interface Candidate {
  url: string;
  title: string;
  snippet?: string;
}

/** The one static list: scholarly / primary-source signals. */
const SCHOLARLY_HOST = /(^|\.)(edu|gov|mil)($|\.)|(\.|^)(doi\.org|arxiv\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|jstor\.org|ssrn\.com|nature\.com|sciencedirect\.com|springer\.com|wiley\.com|acm\.org|ieee\.org|plos\.org|biorxiv\.org|semanticscholar\.org)($|\/)/i;

const REFERENCE_HOST = /(\.|^)(wikipedia\.org|wiktionary\.org|britannica\.com|stanford\.edu\/entries|merriam-webster\.com|investopedia\.com)($|\/)/i;
const JOURNALISM_HOST = /(\.|^)(reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|nytimes\.com|wsj\.com|theguardian\.com|washingtonpost\.com|npr\.org|bloomberg\.com|ft\.com|economist\.com|aljazeera\.com)($|\/)/i;
const BLOG_HOST = /(\.|^)(medium\.com|substack\.com|wordpress\.com|blogspot\.com|dev\.to|hashnode\.|ghost\.io)($|\/)/i;

/** Content-farm / affiliate / parked tells (URL + title heuristics). */
const PARKED_TELL = /(^|\.)(godaddy|sedo|parkingcrew|bodis|afternic)\.|domain[- ]?for[- ]?sale|buy this domain/i;
const AFFILIATE_TITLE = /\b(\d+\s+best|top\s+\d+|best\s+\w+\s+of\s+20\d\d|honest review|vs\.?\s|deals?|coupon|discount code)\b/i;
const CONTENT_FARM_HOST = /(\.|^)(ehow|wikihow\.|answers\.com|quora\.com|coursehero|chegg)\.?/i;

const OFFICIAL_PATH = /(^|\.)docs?\.|\/docs?\/|developer\.|api\.|\.dev($|\/)|readthedocs\.io|github\.io/i;

function host(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Classify a source by WHAT IT IS (url + optional title). Heuristic and
 * deliberately coarse — the relevance spine dominates the final score.
 */
export function classifySourceType(c: Candidate): SourceType {
  const h = host(c.url);
  if (!h) return 'unknown';
  if (PARKED_TELL.test(c.url) || PARKED_TELL.test(c.title)) return 'content-farm';
  if (CONTENT_FARM_HOST.test(h)) return 'content-farm';
  if (SCHOLARLY_HOST.test(h) || SCHOLARLY_HOST.test(c.url)) {
    // .gov is primary/official; academic publishers + arxiv/doi are academic.
    if (/(^|\.)(gov|mil)($|\.)/i.test(h)) return 'primary';
    return 'academic';
  }
  if (REFERENCE_HOST.test(c.url)) return 'reference';
  if (JOURNALISM_HOST.test(c.url)) return 'journalism';
  if (OFFICIAL_PATH.test(c.url)) return 'primary';
  if (BLOG_HOST.test(c.url)) return 'blog';
  if (AFFILIATE_TITLE.test(c.title) && /\.(com|net|io|co)($|\/)/i.test(h)) return 'commercial';
  return 'unknown';
}

/** Static scholarly/primary boost (the one allowed static list). 0 when none. */
export function scholarlyBoost(url: string): number {
  return SCHOLARLY_HOST.test(url) || SCHOLARLY_HOST.test(host(url)) ? 0.04 : 0;
}

/** Infer which source type the query "wants" — modulates the type modifier. */
export function inferIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  if (/\b(api|sdk|docs?|documentation|install|config|tutorial|how to|reference|cli|function|method|error)\b/.test(q))
    return 'docs';
  if (/\b(news|today|breaking|latest|2026|2025|update|announce|election|stock|price)\b/.test(q))
    return 'current-events';
  if (/\b(study|research|evidence|paper|meta-analysis|trial|theory|effect of|impact of|peer-reviewed)\b/.test(q))
    return 'research';
  return 'general';
}

/** How well a source type fits the query intent → small additive modifier. */
function typeModifier(type: SourceType, intent: QueryIntent): number {
  const fit: Record<QueryIntent, Partial<Record<SourceType, number>>> = {
    docs: { primary: 0.05, reference: 0.03, academic: 0.01 },
    'current-events': { journalism: 0.05, primary: 0.03 },
    research: { academic: 0.05, primary: 0.03, reference: 0.02 },
    general: { reference: 0.03, journalism: 0.02, primary: 0.02, academic: 0.02 },
  };
  const penalty: Partial<Record<SourceType, number>> = {
    'content-farm': -0.12,
    commercial: -0.05,
  };
  return (fit[intent][type] ?? 0) + (penalty[type] ?? 0);
}

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}

/** Fraction of query terms present in `text`. */
function coverage(queryTerms: string[], text: string): number {
  if (queryTerms.length === 0) return 0;
  const set = new Set(tokens(text));
  const hits = queryTerms.filter((t) => set.has(t)).length;
  return hits / queryTerms.length;
}

export interface Relevance {
  score: number;
  why: string;
}

/**
 * Pre-fetch relevance score (title + snippet + url, no network). Relevance is
 * the spine (title coverage weighted highest); source-type fit, scholarly boost,
 * and affiliate/parked penalties are small modifiers, each surfaced in `why`.
 */
export function relevanceScore(c: Candidate, query: string, intent?: QueryIntent): Relevance {
  const qt = tokens(query);
  const titleCov = coverage(qt, c.title);
  const snipCov = c.snippet ? coverage(qt, c.snippet) : 0;
  const urlCov = coverage(qt, c.url);
  const base = titleCov * 0.6 + snipCov * 0.25 + urlCov * 0.05;

  const type = classifySourceType(c);
  const it = intent ?? inferIntent(query);
  const tMod = typeModifier(type, it);
  const sBoost = scholarlyBoost(c.url);
  const affiliatePenalty = AFFILIATE_TITLE.test(c.title) ? -0.06 : 0;

  const score = Math.max(0, Math.min(1, base + tMod + sBoost + affiliatePenalty));

  const reasons: string[] = [`title ${(titleCov * 100) | 0}%`];
  if (snipCov) reasons.push(`snippet ${(snipCov * 100) | 0}%`);
  reasons.push(`type=${type}`);
  if (tMod) reasons.push(`${tMod > 0 ? '+' : ''}${tMod.toFixed(2)} intent(${it})`);
  if (sBoost) reasons.push(`+${sBoost.toFixed(2)} scholarly`);
  if (affiliatePenalty) reasons.push(`${affiliatePenalty.toFixed(2)} affiliate`);

  return { score: Number(score.toFixed(3)), why: reasons.join(', ') };
}

/**
 * Small independent-consensus boost: more INDEPENDENT corroborating sources →
 * a little more confidence, capped so it can never override clear relevance.
 * `n` is the post-corroboration-guard independent count (syndicated reprints
 * already collapsed to 1 by the caller).
 */
export function consensusBoost(n: number): number {
  if (n <= 1) return 0;
  return Math.min(0.06, (n - 1) * 0.02);
}

/** Jaccard token similarity — used to collapse syndicated near-duplicates. */
export function similarity(a: string, b: string): number {
  const sa = new Set(tokens(a));
  const sb = new Set(tokens(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}
