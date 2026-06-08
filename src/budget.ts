/**
 * budget.ts — global fetch/search budget accounting.
 *
 * Owned conceptually by deep_research (a single deep_research run shares ONE
 * budget across every web_search and web_fetch it drives), but the type lives
 * here so web_fetch and web_search can accept an optional shared budget without
 * importing the top layer. A null/absent budget means "uncapped" (the drop-in
 * single-call path for web_fetch/web_search used on their own).
 *
 * Caps come from /deep-research-method: ≤15 web_fetch, ≤8 web_search, ~90s wall.
 */

export interface BudgetLimits {
  fetches: number;
  searches: number;
  /** Wall-clock milliseconds for the whole run. */
  wallMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  fetches: 15,
  searches: 8,
  wallMs: 90_000,
};

/**
 * A monotonic counter shared across the layers of one deep_research run.
 * Pure bookkeeping — it never performs work, it only authorizes it. Callers
 * ask `canFetch()/canSearch()` before acting and call `spendFetch()/spendSearch()`
 * after. `startedAt` is injected (the server cannot call Date.now() in tests
 * deterministically), defaulting to the real clock at construction.
 */
export class Budget {
  readonly limits: BudgetLimits;
  private fetches = 0;
  private searches = 0;
  private readonly startedAt: number;

  constructor(limits: Partial<BudgetLimits> = {}, startedAt: number = Date.now()) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.startedAt = startedAt;
  }

  elapsedMs(now: number = Date.now()): number {
    return now - this.startedAt;
  }

  timedOut(now: number = Date.now()): boolean {
    return this.elapsedMs(now) >= this.limits.wallMs;
  }

  canFetch(now: number = Date.now()): boolean {
    return this.fetches < this.limits.fetches && !this.timedOut(now);
  }

  canSearch(now: number = Date.now()): boolean {
    return this.searches < this.limits.searches && !this.timedOut(now);
  }

  spendFetch(): void {
    this.fetches += 1;
  }

  spendSearch(): void {
    this.searches += 1;
  }

  /** Snapshot for the `coverage` note in a partial result. */
  report(now: number = Date.now()): {
    fetches: number;
    searches: number;
    elapsedMs: number;
    exhausted: boolean;
  } {
    return {
      fetches: this.fetches,
      searches: this.searches,
      elapsedMs: this.elapsedMs(now),
      exhausted: !this.canFetch(now) && !this.canSearch(now),
    };
  }
}
