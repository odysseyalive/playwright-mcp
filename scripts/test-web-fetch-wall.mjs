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
// Removed on every exit, not only in the browser test's t.after: a browser-free run
// (the gate's default) skipped that test and left one of these behind per run.
process.on('exit', () => fs.rmSync(sessions, { recursive: true, force: true }));
process.env.PLAYWRIGHT_MCP_SESSIONS = sessions;
process.env.PLAYWRIGHT_MCP_READ_PROFILES = path.join(sessions, 'read-profiles');

const { fetchUrl, isUnreachable, wallSessionName, awaitWallSolve, notifyWallWindow, sessionWallAdvice, solvedStillWalledAdvice, WALL_WAIT_MS, WALL_WINDOW_MS } = await import(
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

// eBay, 2026-11-23: a named session walled by eBay's "SORRY" page was told its
// "clearance may have lapsed". It had no clearance; its bot cookies were flagged.
test('a wall in front of a named session says what happened and both ways back in', () => {
  const a = sessionWallAdvice('ebay', 'wall-www.ebay.com', true);
  assert.doesNotMatch(a, /lapsed/);
  assert.match(a, /session_login\(\{name: "ebay", loginUrl: [^)]*attach: true\}\)/);
  assert.match(a, /without `session`/);
  assert.match(a, /opens a window/);
  assert.match(a, /"wall-www\.ebay\.com"/, 'the clearance name the fetch will actually save');
  // Where no window can open, it does not promise one.
  const b = sessionWallAdvice('ebay', 'wall-www.ebay.com', false);
  assert.doesNotMatch(b, /opens a window/);
  assert.match(b, /cannot open from here/);
  assert.match(b, /session_solve_challenge/);
});

// eBay /itm/, 2026-11-24: the human's Chrome loaded the page, the window saved, the
// headless retry was walled again, and the caller was told the clearance "may have lapsed".
test('a wall that survives a fresh solve says the headless browser is refused, not that a clearance lapsed', () => {
  const a = solvedStillWalledAdvice();
  assert.doesNotMatch(a, /lapsed/);
  assert.match(a, /real browser/);
  assert.match(a, /no clearance will fix/);
  assert.match(a, /session_login/);
  assert.match(a, /web_fetch\(\{url, session: name\}\)/);
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

// eBay, 2026-11-24: the machine lost its network mid-scan, the fetch threw
// net::ERR_INTERNET_DISCONNECTED, web_fetch called that 'blocked', and the scan
// backed off for hours from a bot wall that was never there.
test('isUnreachable: a network, DNS or connection failure is not a refusal', () => {
  for (const code of [
    'ERR_INTERNET_DISCONNECTED', 'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_ADDRESS_UNREACHABLE',
    'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_FAILED', 'ERR_TIMED_OUT', 'ERR_NETWORK_CHANGED', 'ERR_NETWORK_IO_SUSPENDED', 'ERR_PROXY_CONNECTION_FAILED',
  ]) {
    const msg = `page.goto: net::${code} at https://www.ebay.com/itm/327465486746\nCall log:\n  - navigating to "https://www.ebay.com/itm/327465486746"`;
    assert.equal(isUnreachable(new Error(msg)), true, code);
  }
  const timeout = new Error('page.goto: Timeout 20000ms exceeded.\nCall log:\n  - navigating to "https://x.test/"');
  timeout.name = 'TimeoutError';
  assert.equal(isUnreachable(timeout), true, 'TimeoutError');
  assert.equal(isUnreachable('page.goto: Timeout 20000ms exceeded.'), true, 'timeout text');
  // A refusal, a host that answered, or something that is not a net error at all.
  for (const msg of [
    'page.goto: net::ERR_ACCESS_DENIED at http://169.254.169.254/',
    'page.goto: net::ERR_BLOCKED_BY_CLIENT at https://x.test/',
    'page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.ebay.com/itm/1',
    'page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://x.test/',
    'page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://x.test/',
    'page.goto: net::ERR_ABORTED at https://x.test/net::ERR_INTERNET_DISCONNECTED',
    'Target page, context or browser has been closed',
    '',
  ]) {
    assert.equal(isUnreachable(new Error(msg)), false, msg);
  }
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
    // A page that refuses the headless browser whatever clearance it carries.
    if (req.url?.startsWith('/refused')) {
      res.end(WALL);
      return;
    }
    const cleared = /(^|;\s*)cleared=1/.test(req.headers.cookie ?? '');
    // Content re-mints the bot manager's cookie and rolls an auth one, as eBay's did.
    if (cleared) res.setHeader('set-cookie', ['bm_s=headless; Path=/', 'roll=2; Path=/']);
    res.end(cleared ? PAGE : WALL);
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

  await t.test('a session read that hits a wall leaves the session jar as it was', async () => {
    // eBay, 2026-11-23: the write-back saved the walled read's cookies over the capture.
    const file = path.join(sessions, 'walljar.json');
    const jar = JSON.stringify({
      cookies: [{ name: 'sid', value: 'human', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    });
    fs.writeFileSync(file, jar, { mode: 0o600 });
    const r = await fetchUrl({ url: `${base}/e`, session: 'walljar' }, { trust: 'stdio' });
    assert.equal(r.fetchStatus, 'blocked');
    assert.equal(fs.readFileSync(file, 'utf8'), jar);
    // A named session's wall says how to get back in, and names this host's clearance.
    assert.doesNotMatch(r.error, /lapsed/);
    assert.match(r.error, /session_login/);
    assert.ok(r.error.includes(`"${wallSessionName(base)}"`) || /cannot open from here/.test(r.error));
    // ...while a read that comes back as content still rolls the jar forward, except
    // for the bot manager's cookie, which stays the saved one.
    const ok = JSON.parse(jar);
    ok.cookies.push({ ...ok.cookies[0], name: 'cleared', value: '1' }, { ...ok.cookies[0], name: 'bm_s', value: 'human' });
    fs.writeFileSync(file, JSON.stringify(ok), { mode: 0o600 });
    const r2 = await fetchUrl({ url: `${base}/f`, session: 'walljar' }, { trust: 'stdio' });
    assert.equal(r2.fetchStatus, 'ok');
    const back = JSON.parse(fs.readFileSync(file, 'utf8')).cookies;
    assert.equal(back.find((c) => c.name === 'roll')?.value, '2', 'written back after a good read');
    assert.equal(back.find((c) => c.name === 'bm_s')?.value, 'human');
  });

  await t.test('walled again right after the window saved: says the headless browser is refused', async () => {
    process.env.DISPLAY = process.env.DISPLAY || ':0';
    const name = wallSessionName(base);
    let solves = 0;
    // Stands in for the window: a real browser got the page and saved a clearance.
    const solve = async () => {
      solves++;
      const wall = name;
      const state = {
        cookies: [{ name: 'cleared', value: '1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins: [],
      };
      fs.writeFileSync(path.join(sessions, `${wall}.json`), JSON.stringify(state), { mode: 0o600 });
      return { name: wall, path: '', capturedAt: '', mode: 'challenge', ok: true };
    };
    const r = await fetchUrl({ url: `${base}/refused` }, { trust: 'stdio' }, solve);
    assert.equal(solves, 1);
    assert.equal(r.fetchStatus, 'blocked');
    assert.doesNotMatch(r.error, /lapsed/);
    assert.match(r.error, /no clearance will fix/);
    assert.match(r.error, /session_login/);
    assert.ok(fs.existsSync(path.join(sessions, `${name}.json`)), 'the clearance is kept');
  });

  await t.test('a host that refuses the connection is unreachable: no wall, no window, no write-back, no cache', async () => {
    // A port nothing listens on: the connection is refused before any site answers.
    const closed = http.createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise((r) => closed.close(r));
    const gone = `http://127.0.0.1:${port}`;
    // The clearance an earlier subtest saved for this host (one per host, not per port).
    const clearance = path.join(sessions, `${wallSessionName(gone)}.json`);
    const before = fs.existsSync(clearance) ? fs.readFileSync(clearance, 'utf8') : undefined;
    // A display and a solver that would open the window, so a wall would show here.
    process.env.DISPLAY = process.env.DISPLAY || ':0';
    let solves = 0;
    const solve = async () => {
      solves++;
      return { name: wallSessionName(gone), path: '', capturedAt: '', mode: 'challenge', ok: false };
    };
    const r = await fetchUrl({ url: `${gone}/itm/1` }, { trust: 'stdio' }, solve);
    assert.equal(r.fetchStatus, 'unreachable');
    assert.equal(solves, 0, 'no window opens');
    assert.match(r.error, /not a bot wall/);
    assert.doesNotMatch(r.error, /CAPTCHA|session_solve_challenge/);
    assert.match(r.errorDetail, /ERR_CONNECTION_REFUSED/);
    assert.equal(fs.existsSync(clearance) ? fs.readFileSync(clearance, 'utf8') : undefined, before, 'clearance untouched');
    assert.equal(r.note, undefined, 'no "read with the saved clearance" note on a read that reached nothing');
    // A session read of a host that is down leaves its jar as it was.
    const file = path.join(sessions, 'downjar.json');
    const jar = JSON.stringify({
      cookies: [{ name: 'sid', value: 'human', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
      origins: [],
    });
    fs.writeFileSync(file, jar, { mode: 0o600 });
    const s = await fetchUrl({ url: `${gone}/itm/1`, session: 'downjar' }, { trust: 'stdio' });
    assert.equal(s.fetchStatus, 'unreachable');
    assert.equal(fs.readFileSync(file, 'utf8'), jar);
    // Not cached: once the host is back, the next read sees it.
    const back = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise((r) => back.listen(port, '127.0.0.1', r));
    try {
      const again = await fetchUrl({ url: `${gone}/itm/1` }, { trust: 'stdio' }, solve);
      assert.equal(again.fetchStatus, 'ok');
    } finally {
      await new Promise((r) => back.close(r));
    }
  });

  await t.test('no ctx is an unknown surface: no reuse', async () => {
    const r = await fetchUrl({ url: `${base}/d` });
    assert.equal(r.fetchStatus, 'blocked');
  });
});
