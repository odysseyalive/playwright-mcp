#!/usr/bin/env node
// T1 acceptance — deep_research mechanical engine with STUBBED lower layers.
// No browser, no network. Asserts: global caps hold, until-dry termination,
// cross-level dedup, and the credibility invariant (no citation without a
// fetched source). Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { runDeepResearch } from '../dist/tools/deep-research.js';
import { Budget } from '../dist/budget.js';

const citation = (url) => ({ type: 'webpage', title: `Title of ${url}`, author: [], URL: url, dateConfidence: 'low' });

// A stub search result candidate.
const cand = (url) => ({
  rank: 1,
  url,
  title: `Title of ${url}`,
  engines: ['bing'],
  consensus: 1,
  sourceType: 'unknown',
  relevance: { score: 0.5, why: 'stub' },
});

// Build stub deps. `spend:true` makes the stubs honor the shared budget exactly
// as the real fetchUrl/runSearch do (spend on every call), so caps are testable.
function makeDeps({ leadsFor, searchResultsFor, fetchText = (u) => `Body text for ${u}.`, spend = true }) {
  const calls = { search: 0, fetch: 0 };
  return {
    calls,
    deps: {
      async search(opts) {
        calls.search++;
        opts.budget && spend && opts.budget.spendSearch();
        return {
          query: opts.query,
          engines: { attempted: ['bing'], succeeded: ['bing'], failed: [] },
          results: searchResultsFor(opts.query, calls.search),
          coverage: 'full',
        };
      },
      async fetch(opts) {
        calls.fetch++;
        opts.budget && spend && opts.budget.spendFetch();
        const leads = leadsFor(opts.url, calls.fetch);
        return {
          url: opts.url,
          fetchStatus: 'ok',
          contentType: 'html',
          cms: null,
          text: fetchText(opts.url),
          citation: citation(opts.url),
          links: leads.links ?? [],
          references: leads.references ?? [],
        };
      },
    },
  };
}

test('global caps hold: ≤15 fetches and ≤8 searches even with infinite leads', async () => {
  const { calls, deps } = makeDeps({
    searchResultsFor: (q, n) => Array.from({ length: 5 }, (_, i) => cand(`https://s.example/${n}-${i}`)),
    leadsFor: (url, n) => ({ links: Array.from({ length: 5 }, (_, i) => `https://lead.example/${n}-${i}`) }),
  });
  const r = await runDeepResearch({ query: 'unbounded topic', depth: 3, breadth: 5 }, deps);
  assert.ok(calls.fetch <= 15, `fetches ${calls.fetch} <= 15`);
  assert.ok(calls.search <= 8, `searches ${calls.search} <= 8`);
  assert.ok(r.sources.length <= 15);
});

test('until-dry termination: stops when a level yields nothing new', async () => {
  // Same three URLs forever → after L1 fetches them, later levels add nothing.
  const fixed = ['https://a.example/x', 'https://b.example/y', 'https://c.example/z'];
  const { calls, deps } = makeDeps({
    searchResultsFor: () => fixed.map(cand),
    leadsFor: () => ({ links: fixed }),
  });
  const r = await runDeepResearch({ query: 'repeating topic', depth: 3, breadth: 5 }, deps);
  assert.equal(r.sources.length, 3, 'only the three unique URLs');
  assert.ok(!r.sources.some((s) => s.level >= 3), 'stopped before level 3 (dry)');
});

test('cross-level dedup: each canonical URL appears once', async () => {
  const { deps } = makeDeps({
    searchResultsFor: (q, n) => [cand(`https://x.example/p?utm_source=ad&id=${n}`), cand('https://shared.example/same')],
    leadsFor: () => ({ links: ['https://shared.example/same', 'https://shared.example/same/'] }),
  });
  const r = await runDeepResearch({ query: 'dedup topic', depth: 3, breadth: 5 }, deps);
  const urls = r.sources.map((s) => s.url);
  assert.equal(new Set(urls).size, urls.length, 'no duplicate canonical URLs');
});

test('credibility invariant: no source/claim without a fetched source; dead fetch is not cited', async () => {
  const { deps } = makeDeps({
    searchResultsFor: () => [cand('https://good.example/a'), cand('https://dead.example/b')],
    leadsFor: () => ({ links: [] }),
    fetchText: (u) => (u.includes('dead') ? '' : `Real content for ${u}.`),
  });
  const r = await runDeepResearch({ query: 'invariant topic', depth: 1, breadth: 5 }, deps);
  // dead.example returned empty text → must not become a cited source.
  assert.ok(!r.sources.some((s) => s.url.includes('dead')), 'empty fetch is not a source');
  assert.ok(r.sources.every((s) => s.citation && s.citation.URL), 'every source carries a citation');
  const ids = new Set(r.sources.map((s) => s.id));
  for (const cl of r.clusters) {
    for (const c of cl.claims) for (const sid of c.support) assert.ok(ids.has(sid), 'claim support → real source');
    for (const sid of cl.sources) assert.ok(ids.has(sid), 'cluster source → real source');
  }
});

test('budget injection: an exhausted budget yields an empty, non-throwing run', async () => {
  const { deps } = makeDeps({ searchResultsFor: () => [cand('https://x.example/a')], leadsFor: () => ({ links: [] }) });
  const spent = new Budget({ fetches: 0, searches: 0 });
  const r = await runDeepResearch({ query: 'no budget' }, deps, spent);
  assert.equal(r.sources.length, 0);
  assert.match(r.coverage, /0\/0/);
});
