#!/usr/bin/env node
// T1 acceptance — web_fetch extraction contract (deterministic, no browser).
// Exercises src/extract.ts (dist/) against recorded fixtures. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  classifyHealth,
  extractReadable,
  extractCitation,
  detectCms,
  harvestLinks,
  extractPdfText,
} from '../dist/extract.js';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'web-fetch');
const html = (name) => readFileSync(join(FX, name), 'utf8');

test('fetchStatus: ok for a healthy article', () => {
  const h = html('article-jsonld.html');
  const { text } = extractReadable(h, 'https://coastalreview.test/tides');
  assert.equal(classifyHealth(h, 200, text), 'ok');
});

test('fetchStatus: 404 from HTTP status', () => {
  assert.equal(classifyHealth('<html></html>', 404), '404');
});

test('fetchStatus: soft-404 (200 + not-found title)', () => {
  assert.equal(classifyHealth(html('soft-404.html'), 200), '404');
});

test('fetchStatus: paywall', () => {
  const h = html('paywall.html');
  const { text } = extractReadable(h, 'https://ledger.test/kelp');
  assert.equal(classifyHealth(h, 200, text), 'paywall');
});

test('fetchStatus: blocked (captcha / unusual traffic)', () => {
  assert.equal(classifyHealth(html('blocked.html'), 200), 'blocked');
});

test('fetchStatus: blocked from 429', () => {
  assert.equal(classifyHealth('<html>ok</html>', 429), 'blocked');
});

test('fetchStatus: a substantial article that merely references "captcha" stays ok', () => {
  // Every Wikipedia page references a captcha in its edit UI markup, tripping
  // BLOCK_TELL. A full article body means the fetch succeeded — not a bot wall.
  const head = '<html><head><title>Hawaii</title><script>mw.loader.load("ext.confirmEdit.CaptchaWidget")</script></head><body>';
  const article = 'Hawaii is a U.S. state in the Pacific. '.repeat(60); // > 1500 chars
  assert.equal(classifyHealth(head + article + '</body></html>', 200, article), 'ok');
});

test('fetchStatus: a captcha interstitial with a tiny body is still blocked', () => {
  // The guard is body-size, not keyword removal: a real challenge page has ~no prose.
  const wall = '<html><body>Please verify you are human by solving the captcha.</body></html>';
  assert.equal(classifyHealth(wall, 200, 'verify you are human'), 'blocked');
});

test('citation: JSON-LD yields author + dateConfidence high', () => {
  const c = extractCitation(html('article-jsonld.html'), 'https://coastalreview.test/tides');
  assert.ok(c.author.length >= 1, 'has an author');
  assert.equal(c.author[0].family, 'Halloran');
  assert.equal(c.dateConfidence, 'high');
  assert.equal(c.issued?.['date-parts'][0][0], 2026);
  assert.equal(c['container-title'], 'Coastal Review');
});

test('citation: visible byline yields dateConfidence low', () => {
  const c = extractCitation(html('article-byline.html'), 'https://marsh.test/notes');
  assert.equal(c.dateConfidence, 'low');
  assert.equal(c.author[0]?.family, 'Asher');
});

test('cms: WordPress detected from generator meta', () => {
  assert.equal(detectCms(html('article-jsonld.html')), 'WordPress');
});

test('readable: strips boilerplate, keeps body text', () => {
  const { text } = extractReadable(html('article-jsonld.html'), 'https://coastalreview.test/tides');
  assert.ok(text.includes('Cascadia margin'), 'keeps article prose');
});

test('links: harvest is empty without outbound links, never throws', () => {
  const leads = harvestLinks(html('article-jsonld.html'), 'https://coastalreview.test/tides');
  assert.deepEqual(leads.links, []);
  assert.deepEqual(leads.references, []);
});

test('pdf: text extracted from a PDF fixture', async () => {
  const bytes = new Uint8Array(readFileSync(join(FX, 'sample.pdf')));
  const { text } = await extractPdfText(bytes);
  assert.ok(text.includes('Cascadia tide gauge'), 'PDF text recovered');
});

test('robustness: extractors never throw on garbage input', () => {
  assert.doesNotThrow(() => extractReadable('<not really html', 'https://x.test'));
  assert.doesNotThrow(() => extractCitation('', 'https://x.test'));
  assert.doesNotThrow(() => classifyHealth('', 200));
  assert.doesNotThrow(() => detectCms(''));
});
