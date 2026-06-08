#!/usr/bin/env node
// T1 acceptance — web_search engine parsers + ranking pipeline (deterministic).
// Engine parsers run against recorded SERP fixtures; rankCandidates() runs on a
// synthetic candidate set. No browser, no network. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { duckduckgo } from '../dist/engines/duckduckgo.js';
import { bing } from '../dist/engines/bing.js';
import { google } from '../dist/engines/google.js';
import { scholar } from '../dist/engines/scholar.js';
import { rankCandidates } from '../dist/tools/web-search.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'serp');
const serp = (name) => readFileSync(join(FX, name), 'utf8');

// ── Engine parsers vs recorded SERPs ─────────────────────────────────────────

test('duckduckgo: parses results and resolves /l/?uddg= redirects', () => {
  const r = duckduckgo.parse(serp('duckduckgo.html'));
  assert.equal(r.length, 3);
  assert.equal(r[0].url, 'https://www.noaa.gov/tides/cascadia');
  assert.ok(r[0].snippet.includes('Official tide tables'));
});

test('bing: parses .b_algo with caption and algoSlug snippets', () => {
  const r = bing.parse(serp('bing.html'));
  assert.equal(r.length, 3);
  assert.equal(r[0].url, 'https://tidesandcurrents.noaa.gov/cascadia');
  assert.ok(r[2].snippet.includes('educational tutorial'));
});

test('google: skips ads + PAA, resolves /url?q= redirects', () => {
  const r = google.parse(serp('google.html'));
  assert.equal(r.length, 3, 'three organic results, ad + PAA excluded');
  assert.equal(r[0].url, 'https://www.noaa.gov/tides');
  assert.ok(!r.some((x) => /Sponsored|People also ask/.test(x.title)));
});

test('scholar: parses .gs_ri with doi/arxiv links', () => {
  const r = scholar.parse(serp('scholar.html'));
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://doi.org/10.1000/tides2026');
});

// ── Block detection ───────────────────────────────────────────────────────────

test('google: detectBlock true on captcha SERP', () => {
  assert.equal(google.detectBlock(serp('google-captcha.html')), true);
});

test('bing: detectBlock true on empty #b_results', () => {
  assert.equal(bing.detectBlock(serp('bing-empty.html')), true);
});

test('duckduckgo: detectBlock false on a real SERP', () => {
  assert.equal(duckduckgo.detectBlock(serp('duckduckgo.html')), false);
});

// ── Ranking pipeline (pure, synthetic candidates) ────────────────────────────

test('syndicated near-dupes across domains collapse to consensus 1', () => {
  const byEngine = new Map([
    ['duckduckgo', [{ title: 'Coastal storm floods Cascadia harbor towns', url: 'https://siteA.example/storm', snippet: 'flooding' }]],
    ['bing', [{ title: 'Coastal storm floods Cascadia harbor towns', url: 'https://siteB.example/reprint', snippet: 'flooding' }]],
  ]);
  const ranked = rankCandidates(byEngine, 'cascadia coastal storm flooding');
  assert.equal(ranked.length, 1, 'reprint collapsed');
  assert.equal(ranked[0].consensus, 1, 'reprint does not manufacture consensus');
});

test('same canonical URL from two engines yields consensus 2 + surfaced boost', () => {
  const byEngine = new Map([
    ['duckduckgo', [{ title: 'NOAA tide predictions', url: 'https://noaa.gov/tides', snippet: 'official tides' }]],
    ['bing', [{ title: 'NOAA tide predictions', url: 'https://noaa.gov/tides', snippet: 'official tides' }]],
  ]);
  const ranked = rankCandidates(byEngine, 'noaa tide predictions');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].consensus, 2);
  assert.deepEqual(ranked[0].engines, ['bing', 'duckduckgo']);
  assert.match(ranked[0].relevance.why, /consensus\(2\)/);
});

test('boosts stay small: relevant-but-untrusted beats trusted-but-off-topic', () => {
  const byEngine = new Map([
    ['bing', [
      { title: 'Cascadia tide gauge datum analysis', url: 'https://randomblog.example/tides', snippet: 'tide gauge datum cascadia analysis' },
      { title: 'Unrelated quantum chromodynamics lecture', url: 'https://mit.edu/qcd', snippet: 'quarks gluons' },
    ]],
  ]);
  const ranked = rankCandidates(byEngine, 'cascadia tide gauge datum analysis');
  assert.equal(ranked[0].url, 'https://randomblog.example/tides', 'relevance is the spine, scholarly boost cannot override it');
});

test('relevance.why surfaces the source type and scholarly boost', () => {
  const byEngine = new Map([
    ['scholar', [{ title: 'Secular trends in Cascadia tidal datums', url: 'https://doi.org/10.1000/tides2026', snippet: 'tide gauge records cascadia secular trend' }]],
  ]);
  const ranked = rankCandidates(byEngine, 'cascadia tidal datums secular trend');
  assert.match(ranked[0].relevance.why, /scholarly/);
  assert.equal(ranked[0].sourceType, 'academic');
});

test('rankCandidates never throws on empty input', () => {
  assert.doesNotThrow(() => rankCandidates(new Map(), 'anything'));
  assert.deepEqual(rankCandidates(new Map(), 'anything'), []);
});
