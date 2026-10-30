#!/usr/bin/env node
// T1 acceptance — web_fetch on a bot wall: the saved clearance is reused, and the
// human window opens only where session_solve_challenge itself is allowed.
//
// The window itself is not driven here: it waits on a person. What is covered is
// every path around it — reuse, the cloud tier, no display — against a local
// server that walls any request without its clearance cookie.
//
// Browser-free by default, like the rest of the gate — the fetch tests need a real
// chrome and run only with PLAYWRIGHT_MCP_TEST_BROWSER=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
const sessions = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-wall-'));
process.env.PLAYWRIGHT_MCP_SESSIONS = sessions;

const { fetchUrl, wallSessionName } = await import('../dist/tools/web-fetch.js');
const { closeBrowser } = await import('../dist/browser.js');

const WALL = '<html><body>Please enable JavaScript to view the page content.Your support ID is: 1.</body></html>';
const PAGE =
  '<html><head><title>Results</title></head><body><table><tr><td>PICTURE THIS PRODUCTION SERVICES, INC.</td></tr></table>' +
  `<p>${'Registry row. '.repeat(20)}</p></body></html>`;

test('wallSessionName: one clearance per host', () => {
  assert.equal(wallSessionName('https://egov.sos.state.or.us/br/x?y=1'), 'wall-egov.sos.state.or.us');
  assert.equal(wallSessionName('not a url'), undefined);
});

test('web_fetch wall handling', { skip: !BROWSER_TESTS && 'set PLAYWRIGHT_MCP_TEST_BROWSER=1' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(/(^|;\s*)cleared=1/.test(req.headers.cookie ?? '') ? PAGE : WALL);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const display = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
  t.after(async () => {
    Object.assign(process.env, display);
    for (const k of Object.keys(display)) if (display[k] === undefined) delete process.env[k];
    server.close();
    await closeBrowser();
    fs.rmSync(sessions, { recursive: true, force: true });
  });

  await t.test('cloud tier: blocked, no window, no reuse', async () => {
    const r = await fetchUrl({ url: `${base}/a` }, { trust: 'cloud' });
    assert.equal(r.fetchStatus, 'blocked');
    assert.match(r.error, /F5 BIG-IP/);
  });

  await t.test('no display: blocked with a reason, no window', async () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const r = await fetchUrl({ url: `${base}/b` }, { trust: 'stdio' });
    assert.equal(r.fetchStatus, 'blocked');
    if (process.platform === 'linux') assert.match(r.error, /no display/);
  });

  await t.test('a saved clearance for the host is reused', async () => {
    const name = wallSessionName(base);
    const state = {
      cookies: [{ name: 'cleared', value: '1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    };
    fs.writeFileSync(path.join(sessions, `${name}.json`), JSON.stringify(state), { mode: 0o600 });
    const r = await fetchUrl({ url: `${base}/c` }, { trust: 'stdio' });
    assert.equal(r.fetchStatus, 'ok');
    assert.match(r.text, /PICTURE THIS PRODUCTION/);
    assert.match(r.note, /saved bot-wall clearance/);
  });

  await t.test('no ctx is an unknown surface: no reuse', async () => {
    const r = await fetchUrl({ url: `${base}/d` });
    assert.equal(r.fetchStatus, 'blocked');
  });
});
