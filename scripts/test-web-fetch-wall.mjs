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

const { fetchUrl, wallSessionName, awaitWallSolve, notifyWallWindow, WALL_WAIT_MS, WALL_WINDOW_MS } = await import(
  '../dist/tools/web-fetch.js'
);
const { closeBrowser } = await import('../dist/browser.js');

const WALL = '<html><body>Please enable JavaScript to view the page content.Your support ID is: 1.</body></html>';
const PAGE =
  '<html><head><title>Results</title></head><body><table><tr><td>PICTURE THIS PRODUCTION SERVICES, INC.</td></tr></table>' +
  `<p>${'Registry row. '.repeat(20)}</p></body></html>`;

test('wallSessionName: one clearance per host', () => {
  assert.equal(wallSessionName('https://egov.sos.state.or.us/br/x?y=1'), 'wall-egov.sos.state.or.us');
  assert.equal(wallSessionName('not a url'), undefined);
});

test('wall- names are reserved: a login saved as one would be replayed unasked', async () => {
  const { sessionLoginTool, sessionSolveChallengeTool } = await import('../dist/tools/session.js');
  // Any case: macOS and Windows filesystems fold it, so "WALL-x" is the same file.
  for (const tool of [sessionLoginTool, sessionSolveChallengeTool]) {
    for (const name of ['wall-example.test', 'WALL-example.test']) {
      const r = await tool.handler({ name, url: 'https://example.test', loginUrl: 'https://example.test' });
      assert.equal(r.isError, true, `${tool.definition.name} ${name}`);
      assert.match(r.content[0].text, /reserved/);
    }
  }
});

/** A solve the test finishes by hand. */
function deferredSolve() {
  let finish;
  const promise = new Promise((r) => (finish = r));
  return { promise, finish: (ok) => finish({ name: 'wall-x', path: '', capturedAt: '', mode: 'challenge', ok }) };
}

test('wall wait: bounded, the window outlives it, and a second fetch never joins it', async () => {
  // atergolupi.com, 2026-11-08: an unattended fetch waited 3.5 hours on its window.
  assert.equal(WALL_WAIT_MS, 90_000);
  assert.equal(WALL_WINDOW_MS, 30 * 60_000);
  const solve = deferredSolve();
  let opened = 0;
  const open = () => {
    opened += 1;
    return solve.promise;
  };
  const first = await awaitWallSolve('wall-bound.test', open, 20);
  assert.deepEqual(first, { state: 'waiting' }, 'returns after the bound, not when the human finishes');
  // Still open in the background: the next fetch is told so at once, and opens nothing.
  const t0 = Date.now();
  assert.deepEqual(await awaitWallSolve('wall-bound.test', open, 60_000), { state: 'busy' });
  assert.ok(Date.now() - t0 < 1000, 'busy answers immediately instead of blocking on the solve');
  assert.equal(opened, 1);
  // The human clears it later; the slot frees, and the next wall opens a fresh window.
  solve.finish(true);
  await solve.promise;
  await new Promise((r) => setImmediate(r));
  const again = deferredSolve();
  again.finish(true);
  const r = await awaitWallSolve('wall-bound.test', () => again.promise, 60_000);
  assert.equal(r.state, 'done');
  assert.equal(r.result.ok, true);
});

test('wall wait: a solve that throws comes back as a failed result, never a rejection', async () => {
  const r = await awaitWallSolve('wall-throws.test', () => Promise.reject(new Error('chrome not found')), 60_000);
  assert.equal(r.state, 'done');
  assert.equal(r.result.ok, false);
  assert.match(r.result.error, /chrome not found/);
  // ...and one that throws after the bound does not surface as an unhandledRejection.
  let fail;
  const late = await awaitWallSolve('wall-late.test', () => new Promise((_, rj) => (fail = rj)), 10);
  assert.deepEqual(late, { state: 'waiting' });
  fail(new Error('late'));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await awaitWallSolve('wall-late.test', () => Promise.resolve({ ok: true }), 60_000), {
    state: 'done',
    result: { ok: true },
  });
});

test('notify: argv only, host as its own argument, skipped without a display, never throws', () => {
  const calls = [];
  const fake = (file, args, opts, done) => {
    calls.push({ file, args, opts });
    done(new Error('spawn notify-send ENOENT')); // missing binary: swallowed
    return { on() {}, unref() {} };
  };
  notifyWallWindow('www.kvraudio.com', { execFile: fake, env: { WAYLAND_DISPLAY: 'wayland-1' }, platform: 'linux' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'notify-send');
  assert.ok(Array.isArray(calls[0].args));
  assert.ok(calls[0].args.some((a) => a.includes('www.kvraudio.com')));
  assert.ok(calls[0].opts.timeout > 0);
  // No display, or not Linux: nothing is spawned.
  notifyWallWindow('x.test', { execFile: fake, env: {}, platform: 'linux' });
  notifyWallWindow('x.test', { execFile: fake, env: { DISPLAY: ':0' }, platform: 'darwin' });
  assert.equal(calls.length, 1);
  // A spawn that throws synchronously is not the fetch's problem.
  assert.doesNotThrow(() =>
    notifyWallWindow('x.test', {
      execFile: () => {
        throw new Error('EAGAIN');
      },
      env: { DISPLAY: ':0' },
      platform: 'linux',
    }),
  );
});

test('web_fetch wall handling', { skip: !BROWSER_TESTS && 'set PLAYWRIGHT_MCP_TEST_BROWSER=1' }, async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/private') {
      res.writeHead(302, { location: '/uas/login?session_redirect=%2Fprivate' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/uas/login')) {
      res.end('<html><head><title>Sign in</title></head><body><form><input type="password"></form><div class="g-recaptcha"></div></body></html>');
      return;
    }
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

  await t.test('a redirect to a sign-in page is a login wall, never a bot wall', async () => {
    // LinkedIn, 2026-10-30: a lapsed session landed on /uas/login and was reported as
    // "a bot check or CAPTCHA". It is a login, and no wall window may open for it.
    const r = await fetchUrl({ url: `${base}/private` }, { trust: 'stdio' });
    assert.equal(r.fetchStatus, 'login-wall');
    assert.match(r.error, /sign-in page/);
    assert.doesNotMatch(r.error, /CAPTCHA/);
  });

  await t.test('no ctx is an unknown surface: no reuse', async () => {
    const r = await fetchUrl({ url: `${base}/d` });
    assert.equal(r.fetchStatus, 'blocked');
  });
});
