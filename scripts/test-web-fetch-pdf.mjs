#!/usr/bin/env node
// T1 acceptance — web_fetch reads PDFs through real Chrome, says why a PDF failed,
// and keeps a page whose scripts never finish loading.
//
// ntrs.nasa.gov, 2026-11-14: every PDF came back "blocked" with empty text and no
// reason. Real Chrome opens a PDF navigation in its built-in viewer, and the
// navigation response's body is then the viewer's HTML stub, not the document.
// The same site's citation pages load a `type=module` bundle, which holds back
// DOMContentLoaded: one stalled script timed the whole fetch out and discarded a
// server-rendered page that had already arrived.
//
// Browser-free by default, like the rest of the gate — these need a real chrome
// and run only with PLAYWRIGHT_MCP_TEST_BROWSER=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
const PDF = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'web-fetch', 'sample.pdf'),
);
const BUSY =
  '<html><head><title>503 Service Temporarily Unavailable</title></head><body><center>' +
  '<h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>';
const SLOW =
  '<html><head><title>Morpheus</title><script type="module" src="/never.js"></script></head><body>' +
  `<article><h1>Morpheus free flight</h1><p>${'The vehicle lifted off from the pad. '.repeat(30)}</p></article></body></html>`;

test('web_fetch PDFs and slow pages', { skip: !BROWSER_TESTS && 'set PLAYWRIGHT_MCP_TEST_BROWSER=1' }, async (t) => {
  const { fetchUrl } = await import('../dist/tools/web-fetch.js');
  const { closeBrowser } = await import('../dist/browser.js');
  const stalled = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf' || req.url === '/api/downloads/doc') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(PDF);
    } else if (req.url === '/busy.pdf') {
      res.writeHead(503, { 'content-type': 'text/html' }).end(BUSY);
    } else if (req.url === '/fake.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end('<html><body>not a pdf</body></html>');
    } else if (req.url === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(SLOW);
    } else if (req.url === '/never.js') {
      stalled.push(res); // never answered: DOMContentLoaded cannot fire
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const res of stalled) res.destroy();
    server.close();
    await closeBrowser();
  });

  await t.test('a PDF is read from its own bytes, not the viewer page', async () => {
    const r = await fetchUrl({ url: `${base}/doc.pdf` });
    assert.equal(r.fetchStatus, 'ok');
    assert.equal(r.contentType, 'pdf');
    assert.match(r.text, /Cascadia tide gauge/);
  });

  await t.test('a PDF at a URL with no .pdf extension is still read', async () => {
    const r = await fetchUrl({ url: `${base}/api/downloads/doc` });
    assert.equal(r.fetchStatus, 'ok');
    assert.match(r.text, /Cascadia tide gauge/);
  });

  await t.test('a .pdf URL answering with a 503 page says so', async () => {
    const r = await fetchUrl({ url: `${base}/busy.pdf` });
    assert.equal(r.fetchStatus, 'blocked');
    assert.equal(r.contentType, 'html');
    assert.match(r.error, /HTTP 503/);
    assert.doesNotMatch(r.error, /CAPTCHA/);
  });

  await t.test('bytes labelled a PDF that are not one are never blocked without a reason', async () => {
    const r = await fetchUrl({ url: `${base}/fake.pdf` });
    assert.equal(r.fetchStatus, 'blocked');
    assert.match(r.error, /not one/);
  });

  await t.test('a page whose module script never loads keeps what rendered', async () => {
    const r = await fetchUrl({ url: `${base}/slow` });
    assert.equal(r.fetchStatus, 'ok');
    assert.match(r.text, /lifted off from the pad/);
    assert.match(r.note, /had not finished loading/);
    assert.equal(r.errorDetail, undefined);
  });
});
