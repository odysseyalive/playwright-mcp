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
  wallVendor,
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

test('fetchStatus: LiteSpeed "Bot Verification" hCaptcha interstitial is blocked', () => {
  // afcinema.com, 2026-10-18: served to every visitor without a clearance cookie.
  const h = html('bot-verification-lsrecap.html');
  const { text } = extractReadable(h, 'https://www.afcinema.com/a.html');
  assert.equal(classifyHealth(h, 200, text), 'blocked');
});

test('fetchStatus: F5 BIG-IP "Your support ID is" challenge is blocked and named', () => {
  // egov.sos.state.or.us, 2026-10-30: came back ok with only this sentence as the body.
  // The fixture is rebuilt from the extracted text; the raw challenge markup was not captured.
  const h = html('f5-bot-defense.html');
  const { text } = extractReadable(h, 'https://egov.sos.state.or.us/br/x');
  assert.equal(classifyHealth(h, 200, text), 'blocked');
  assert.equal(wallVendor(h), 'F5 BIG-IP bot defense');
});

test('wallVendor: names LiteSpeed, and stays quiet on an unknown wall', () => {
  assert.equal(wallVendor(html('bot-verification-lsrecap.html')), 'LiteSpeed reCAPTCHA');
  assert.equal(wallVendor(html('blocked.html')), undefined);
});

test('readable: a results table whose rows all link out is kept, one row per line', () => {
  // egov.sos.state.or.us search, 2026-10-30: Readability kept the header table and
  // dropped the results, so `text` was "Business Entity Names returned for: ..." only.
  const { text, tableRows } = extractReadable(html('registry-results-table.html'), 'https://egov.sos.state.or.us/br/x');
  assert.equal(tableRows, 3, 'header + two results; web_fetch skips the index rescue on this');
  assert.match(text, /Business Entity Names returned for/);
  assert.match(text, /Record No \| Entity Type \| Entity Status \| Registry Number \| Name Status \| Name \| Assoc Search/);
  assert.match(text, /1 \| DBC \| ACT \| 091944-81 \| CUR \| PICTURE THIS PRODUCTION SERVICES, INC\./);
  assert.match(text, /2 \| DBC \| ACT \| 091944-81 \| PRE \| PICTURE THIS PRODUCTIONS, INC\./);
  assert.doesNotMatch(text, /Help \| Contact/, 'a one-row layout table is not data');
});

test('readable: an article is left as Readability returned it', () => {
  const h = html('article-jsonld.html');
  const { text } = extractReadable(h, 'https://coastalreview.test/tides');
  assert.doesNotMatch(text, / \| /);
});

test('fetchStatus: a bot check is blocked even without the word captcha', () => {
  const wall = '<html><head><title>Bot Verification</title></head><body><h3>Verifying that you are not a robot...</h3></body></html>';
  assert.equal(classifyHealth(wall, 200, 'Verifying that you are not a robot...'), 'blocked');
});

test('fetchStatus: a short shop page with "captcha" only in scripts and JSON is not blocked', () => {
  // atergolupi.com, 2026-11-08: 577 visible characters, and "captcha" only in a consent
  // manager's config and WooCommerce's reCAPTCHA i18n. Marked walled, it opened a
  // window that sat unattended for 3.5 hours.
  const h =
    '<html><head><title>Ater Go Lupi — Shop</title>' +
    '<script>window.cmplz={"blocked":["_grecaptcha","recaptcha"]};</script>' +
    '<script type="application/json" id="wc-settings">{"recaptcha":{"i18n":{"error":"reCAPTCHA error"}}}</script>' +
    '<style>.g-recaptcha{display:none}</style></head><body>' +
    '<!-- captcha placeholder --><div class="grecaptcha-badge" data-captcha="1"></div>' +
    `<h1>Ater Go Lupi</h1><p>${'Handmade goods from a small workshop. '.repeat(12)}</p>` +
    '<a href="/cart">Cart</a></body></html>';
  const { text } = extractReadable(h, 'https://www.atergolupi.com/');
  assert.ok(text.length < 1500, 'short enough that the size guard does not save it');
  assert.equal(classifyHealth(h, 200, text), 'ok');
});

test('fetchStatus: unclosed tags cannot make the wall check quadratic', () => {
  // A lazy `<script[\s\S]*?</script>` rescanned to the end for every unclosed
  // opener; 2 MB of bare `<script` and `<` took minutes. A linear pass is instant.
  for (const unit of ['<script ', '<style>', '<!--x', '<a ']) {
    const h = `<title>t</title><p>short</p>${unit.repeat(2_000_000 / unit.length)}`;
    const t0 = Date.now();
    classifyHealth(h, 200, 'short');
    assert.ok(Date.now() - t0 < 2000, `${JSON.stringify(unit)} took ${Date.now() - t0} ms`);
  }
  // Text after a closed script still counts, and an unclosed script hides the rest.
  assert.equal(classifyHealth('<script>x</script><p>Are you a robot?</p>', 200, ''), 'blocked');
  assert.equal(classifyHealth('<p>hi</p><script>var s="are you a robot"', 200, ''), 'ok');
});

test('fetchStatus: Cloudflare "Just a moment" challenge is blocked and named', () => {
  const h =
    '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>' +
    '<div class="main-wrapper"><h1>www.example.test</h1><p>Verifying you are human. This may take a few seconds.</p></div>' +
    '<noscript>Enable JavaScript and cookies to continue</noscript>' +
    '<script>window._cf_chl_opt={cvId:"3",cType:"managed"};</script></body></html>';
  assert.equal(classifyHealth(h, 200, ''), 'blocked');
  assert.equal(wallVendor(h), 'Cloudflare');
});

test('fetchStatus: a challenge with no wall prose is still blocked on its vendor markup', () => {
  // DataDome's interstitial is an iframe and little else; the markup is the only tell.
  const h = '<html><head><title>example.test</title></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe></body></html>';
  assert.equal(classifyHealth(h, 200, ''), 'blocked');
  assert.equal(wallVendor(h), 'DataDome');
});

test('fetchStatus: a Turnstile box in an ordinary short form is not a wall', () => {
  const h = '<html><head><title>Contact</title></head><body><form><input name="email"><div id="cf-chl-widget-abc12" class="cf-turnstile"></div><button>Send</button></form></body></html>';
  assert.equal(classifyHealth(h, 200, 'Contact Send'), 'ok');
});

test('fetchStatus: 403 is a hard block whatever the page says', () => {
  assert.equal(classifyHealth('<html><head><title>News</title></head><body>An ordinary page.</body></html>', 403), 'blocked');
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
