#!/usr/bin/env node
// T1 acceptance — the remote instance's egress block for the browser_* browser
// (src/egress.ts BLOCKED_ORIGIN_PATTERNS + installContextEgressGuard, wired in
// src/upstream.ts launchBrowser).
//
// Regression cover for DEC-2026-09-16-remote-egress-block-matched-nothing: with
// PLAYWRIGHT_MCP_PUBLIC_URL set, browser_navigate reached a server on 127.0.0.1.
// Every BLOCKED_ORIGIN_PATTERNS entry was written `*://host`, which upstream's
// originOrHostGlob turns into `*://*://host/**`, a glob no URL matches. And the
// server had no handle on the browser_* pages to guard them itself.
//
// TIER NOTE: the default gate is browser-free, as in test-egress-redirect.mjs.
//   - The pattern list is checked through UPSTREAM'S OWN code: a real
//     @playwright/mcp connection is handed a recording context, so the route
//     globs are the ones upstream builds, and they are matched with
//     playwright-core's own urlMatches. Nothing here re-implements either.
//   - The context guard is driven through a fake context, page and CDP session;
//     the guard code and the shipping blocklist decide.
// The end-to-end claims (chromium really refuses; a 302 into loopback never
// reaches the loopback server) need a real browser and sit at the bottom behind
// PLAYWRIGHT_MCP_TEST_BROWSER=1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { chromium } from 'playwright';

import { BLOCKED_ORIGIN_PATTERNS, EgressBlockedError, installContextEgressGuard } from '../dist/egress.js';
import { launchBrowser } from '../dist/upstream.js';
import { BROWSER_CHANNEL } from '../dist/stealth.js';

const { iso } = createRequire(import.meta.url)('playwright-core/lib/coreBundle');
const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';

// The guard is remote-only; nothing here may leak the flag or the profile root.
const saved = {
  PLAYWRIGHT_MCP_PUBLIC_URL: process.env.PLAYWRIGHT_MCP_PUBLIC_URL,
  PWMCP_PROFILES_DIR_FOR_TEST: process.env.PWMCP_PROFILES_DIR_FOR_TEST,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
const fixtures = [];
const realPersistent = chromium.launchPersistentContext;
after(() => {
  chromium.launchPersistentContext = realPersistent;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-egr-'));
  fixtures.push(dir);
  return dir;
}

/** The six the incident names, with and without ports where a port changes the glob. */
const MUST_BLOCK = [
  'http://127.0.0.1/',
  'http://127.0.0.1:8080/admin',
  'http://localhost/',
  'http://localhost:3000/x',
  'http://[::1]/',
  'http://[::1]:9/x',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.1.2.3/',
  'https://10.0.0.1:8443/x',
  // the rest of the ranges the list claims
  'http://0.0.0.0:80/',
  'http://172.16.4.4/',
  'http://172.31.0.1:81/',
  'http://192.168.1.1/',
  'http://100.64.0.1/',
  'http://[fd00:ec2::254]/latest/meta-data/',
  'http://[fe80::1]/',
  'http://[::ffff:7f00:1]:8080/',
  'http://metadata.google.internal/computeMetadata/v1/',
  'http://printer.local/',
  'http://app.localhost:5173/',
];

const MUST_ALLOW = [
  'https://example.com/',
  'http://8.8.8.8/',
  'http://11.0.0.1/',
  'http://172.15.0.1/',
  'http://172.32.0.1/',
  'http://172.160.0.1/',
  'http://100.63.0.1/',
  'http://100.6.0.1/',
  'http://192.169.0.1/',
  'https://[2001:db8::1]/',
];

// ── layer 2: upstream's own blockedOrigins, through upstream's own code ──────

/** A context that records the route globs upstream installs, and refuses to open a page. */
function recordingContext() {
  const globs = [];
  const ctx = {
    globs,
    route: async (glob) => {
      globs.push(glob);
      return { dispose: async () => {} };
    },
    pages: () => [],
    on: () => ctx,
    once: () => ctx,
    addListener: () => ctx,
    removeListener: () => ctx,
    off: () => ctx,
    browser: () => null,
    newPage: async () => {
      throw new Error('recording context: no pages');
    },
  };
  return ctx;
}

/** The route globs @playwright/mcp builds from `blockedOrigins`. */
async function upstreamGlobs(blockedOrigins) {
  const ctx = recordingContext();
  const server = await createConnection(
    { browser: { browserName: 'chromium', launchOptions: { headless: true } }, network: { blockedOrigins } },
    async () => ctx,
  );
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'egress-globs', version: '0.0.0' });
  await client.connect(clientT);
  try {
    // Any page tool makes upstream set up the context, routes first.
    await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } });
  } finally {
    await client.close();
  }
  return ctx.globs;
}

const matchedBy = (globs, url) => globs.filter((g) => iso.urlMatches(undefined, url, g));

test('BLOCKED_ORIGIN_PATTERNS: every private, loopback and metadata URL matches a route glob upstream installs', async () => {
  const globs = await upstreamGlobs(BLOCKED_ORIGIN_PATTERNS);
  assert.equal(globs.length, BLOCKED_ORIGIN_PATTERNS.length, 'upstream installed one route per entry');
  const missed = MUST_BLOCK.filter((u) => matchedBy(globs, u).length === 0);
  assert.deepEqual(missed, [], 'these URLs matched no blockedOrigins glob');
});

test('BLOCKED_ORIGIN_PATTERNS: public addresses and look-alike ranges match nothing', async () => {
  const globs = await upstreamGlobs(BLOCKED_ORIGIN_PATTERNS);
  const hit = MUST_ALLOW.filter((u) => matchedBy(globs, u).length > 0);
  assert.deepEqual(hit, [], 'these URLs would be wrongly blocked');
});

test('the incident shape: a `*://host` entry becomes a glob that matches nothing', async () => {
  // Pins upstream's parsing, so a future "fix" back to URL-shaped entries fails here.
  const [glob] = await upstreamGlobs(['*://127.0.0.1']);
  assert.equal(glob, '*://*://127.0.0.1/**');
  assert.equal(iso.urlMatches(undefined, 'http://127.0.0.1/', glob), false);
});

// ── layer 1: the in-process context guard ────────────────────────────────────

function fakeCdp() {
  const sent = [];
  const handlers = new Map();
  const waiters = new Map();
  let n = 0;
  const cdp = {
    on: (event, fn) => handlers.set(event, fn),
    send: async (method, params) => {
      sent.push({ method, params });
      const settle = waiters.get(params?.requestId);
      waiters.delete(params?.requestId);
      settle?.({ method, params });
      return {};
    },
  };
  return {
    cdp,
    sent,
    /** Pause one request the way chromium does; resolves with the guard's decision. */
    hop(url, resourceType = 'Document') {
      const requestId = `req-${++n}`;
      const settled = new Promise((resolve) => waiters.set(requestId, resolve));
      handlers.get('Fetch.requestPaused')({ requestId, request: { url }, resourceType });
      return settled;
    },
  };
}

function fakeGuardedContext({ browserHandle = true } = {}) {
  const browserCdp = fakeCdp();
  const calls = [];
  const browser = {
    newBrowserCDPSession: async () => (calls.push('newBrowserCDPSession'), browserCdp.cdp),
  };
  const routes = [];
  const wsHandlers = [];
  const ctx = {
    route: async (_glob, handler) => void (calls.push('route'), routes.push(handler)),
    routeWebSocket: async (_match, handler) => void (calls.push('routeWebSocket'), wsHandlers.push(handler)),
    browser: () => (browserHandle ? browser : null),
  };
  return {
    ctx,
    calls,
    browserCdp,
    /** Drive the context route (sync host layer) the way playwright would. */
    route(url) {
      const actions = [];
      routes[0]({
        request: () => ({ url: () => url }),
        abort: async (reason) => void actions.push(['abort', reason]),
        continue: async () => void actions.push(['continue']),
      });
      return actions;
    },
    /** Open a WebSocket through the route; resolves with what the guard did. */
    async websocket(url) {
      const actions = [];
      await wsHandlers[0]({
        url: () => url,
        close: async (o) => void actions.push(['close', o.code]),
        connectToServer: () => void actions.push(['connect']),
      });
      return actions;
    },
  };
}

const INCIDENT_FIVE_HOSTS = [
  'http://127.0.0.1:8080/',
  'http://localhost:3000/',
  'http://[::1]:9/',
  'http://169.254.169.254/latest/meta-data/',
  'http://10.1.2.3/',
];

test('context guard: a request to loopback, localhost, [::1], metadata or 10.x is failed before it leaves', async () => {
  const f = fakeGuardedContext();
  const guard = await installContextEgressGuard(f.ctx); // shipping DNS-aware validator
  for (const url of INCIDENT_FIVE_HOSTS) {
    const out = await f.browserCdp.hop(url);
    assert.equal(out.method, 'Fetch.failRequest', url);
    assert.equal(out.params.errorReason, 'AccessDenied');
  }
  assert.equal((await f.browserCdp.hop('https://example.com/')).method, 'Fetch.continueRequest');
  assert.equal(guard.blocked(), 'blocked IP: 127.0.0.1', 'the first refusal is readable');
});

test('context guard: EVERY request type is validated, not only documents (fetch/XHR/img)', async () => {
  // Measured on real chrome: with documents-only, a page's own fetch('/redir')
  // followed a 302 into 127.0.0.1 and read the body.
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  assert.deepEqual(f.browserCdp.sent.find((x) => x.method === 'Fetch.enable')?.params.patterns, [
    { urlPattern: '*', requestStage: 'Request' },
  ]);
  for (const type of ['Fetch', 'XHR', 'Image', 'Script', 'Other'])
    assert.equal((await f.browserCdp.hop('http://127.0.0.1:8080/sub', type)).method, 'Fetch.failRequest', type);
});

test('context guard: a REDIRECT hop into loopback is failed at the request stage', async () => {
  // Playwright's route layer does not re-enter on a 302; the CDP Fetch session does.
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  assert.equal((await f.browserCdp.hop('http://example.com/start')).method, 'Fetch.continueRequest');
  const hop2 = await f.browserCdp.hop('http://127.0.0.1:8080/admin');
  assert.equal(hop2.method, 'Fetch.failRequest');
});

test('context guard: installed on the BROWSER session before any page, and awaited', async () => {
  // A per-page session, attached from the 'page' event, lost the race against
  // newPage() + goto on real chrome and a 302 into loopback was served.
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  assert.equal(f.calls[0], 'newBrowserCDPSession', 'the CDP guard is the first thing set up');
  assert.ok(f.browserCdp.sent.some((x) => x.method === 'Fetch.enable'), 'enabled before install returns');
});

test('context guard: with no browser handle it FAILS CLOSED rather than run unguarded', async () => {
  const f = fakeGuardedContext({ browserHandle: false });
  await assert.rejects(installContextEgressGuard(f.ctx), /refusing to run unguarded/);
});

test('context guard: a hostname that RESOLVES to a private address is refused', async () => {
  // Injected so the test needs no resolver; the default, assertEgressAllowed, and
  // its dns.lookup path are covered in test-remote.mjs.
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx, {
    validate: async (u) => {
      if (new URL(u).hostname === 'intranet.example.com')
        throw new EgressBlockedError('blocked: intranet.example.com resolves to private address 10.0.0.5');
    },
  });
  assert.equal((await f.browserCdp.hop('http://intranet.example.com/', 'Fetch')).method, 'Fetch.failRequest');
  assert.equal((await f.browserCdp.hop('http://www.example.com/')).method, 'Fetch.continueRequest');
  assert.deepEqual(await f.websocket('wss://intranet.example.com/socket'), [['close', 1008]]);
});

test('context guard: verdicts are reused per host, not per URL', async () => {
  let lookups = 0;
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx, { validate: async () => void lookups++ });
  for (let i = 0; i < 20; i++) await f.browserCdp.hop(`https://cdn.example.com/img${i}.png`, 'Image');
  assert.equal(lookups, 1);
});

test('context guard: the sync route layer refuses literal private hosts too', async () => {
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  for (const url of INCIDENT_FIVE_HOSTS) assert.deepEqual(f.route(url), [['abort', 'blockedbyclient']], url);
  assert.deepEqual(f.route('https://cdn.example.com/a.js'), [['continue']]);
});

test('context guard: the forms a URL parser produces are still refused', async () => {
  // Chrome rewrites `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]` and keeps a trailing
  // dot on `localhost.`; the host check used to know neither form.
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  for (const url of ['http://[::ffff:7f00:1]:8080/', 'http://[::ffff:a9fe:a9fe]/latest/meta-data/', 'http://localhost.:3000/']) {
    assert.deepEqual(f.route(url), [['abort', 'blockedbyclient']], url);
    assert.equal((await f.browserCdp.hop(url)).method, 'Fetch.failRequest', url);
  }
  assert.deepEqual(f.route('http://[::ffff:808:808]/'), [['continue']], 'a mapped PUBLIC address is not blocked');
});

test('context guard: WebSockets to a blocked host are closed, others are connected', async () => {
  const f = fakeGuardedContext();
  await installContextEgressGuard(f.ctx);
  assert.deepEqual(await f.websocket('ws://127.0.0.1:9222/devtools/browser'), [['close', 1008]]);
  assert.deepEqual(await f.websocket('ws://[::1]:9/'), [['close', 1008]]);
  assert.deepEqual(await f.websocket('wss://10.1.2.3/socket'), [['close', 1008]]);
  assert.deepEqual(await f.websocket('wss://example.com/socket'), [['connect']]);
});

// ── wiring: only on the remote instance, and never unguarded ──────────────────

function stubLaunch(ctxFactory) {
  const cache = fixtureDir();
  process.env.PWMCP_PROFILES_DIR_FOR_TEST = cache;
  process.env.XDG_CACHE_HOME = cache;
  chromium.launchPersistentContext = async () => ctxFactory();
}

function launchRecorder({ cdpFails = false } = {}) {
  const calls = [];
  const cdp = { on: () => {}, send: async (method) => void calls.push(method) };
  const browser = {
    closed: 0,
    close: async () => void browser.closed++,
    newBrowserCDPSession: async () => {
      if (cdpFails) throw new Error('CDP refused');
      calls.push('newBrowserCDPSession');
      return cdp;
    },
  };
  const ctx = {
    calls,
    closed: 0,
    route: async () => void calls.push('route'),
    routeWebSocket: async () => void calls.push('routeWebSocket'),
    browser: () => browser,
    close: async () => void ctx.closed++,
  };
  return ctx;
}

test('launchBrowser: the local instance installs no guard (localhost debugging stays open)', async () => {
  const ctx = launchRecorder();
  stubLaunch(() => ctx);
  delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  await launchBrowser();
  assert.deepEqual(ctx.calls, []);
});

test('launchBrowser: the remote instance guards the context before upstream gets it', async () => {
  const ctx = launchRecorder();
  stubLaunch(() => ctx);
  process.env.PLAYWRIGHT_MCP_PUBLIC_URL = 'https://mcp.example.com';
  try {
    assert.equal(await launchBrowser(), ctx);
  } finally {
    delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  }
  assert.deepEqual(ctx.calls, ['newBrowserCDPSession', 'Fetch.enable', 'route', 'routeWebSocket']);
});

test('launchBrowser: if the guard cannot be installed, the browser is closed and the launch fails', async () => {
  const ctx = launchRecorder({ cdpFails: true });
  stubLaunch(() => ctx);
  process.env.PLAYWRIGHT_MCP_PUBLIC_URL = 'https://mcp.example.com';
  try {
    await assert.rejects(launchBrowser(), /CDP refused/);
  } finally {
    delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  }
  assert.equal(ctx.closed, 1, 'never handed to upstream unguarded');
  assert.equal(ctx.browser().closed, 1, 'its browser too');
});

// ── real chromium (opt-in) ───────────────────────────────────────────────────

function countingServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/favicon.ico') received.push(req.url);
    handler(req, res);
  });
  return {
    received,
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
  };
}

const REAL_SKIP = !BROWSER_TESTS && 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)';

test('real: on the remote instance, browser_navigate to 127.0.0.1 is refused and the server receives nothing', { skip: REAL_SKIP }, async () => {
  chromium.launchPersistentContext = realPersistent;
  const cache = fixtureDir();
  process.env.PWMCP_PROFILES_DIR_FOR_TEST = cache;
  process.env.XDG_CACHE_HOME = cache;
  process.env.PLAYWRIGHT_MCP_PUBLIC_URL = 'https://mcp.example.com';
  const target = countingServer((_q, res) => res.end('<title>internal</title>'));
  const port = await target.listen();
  const cwd = process.cwd();
  process.chdir(cache); // upstream writes snapshot files under the cwd
  const { initUpstream, getUpstream, closeUpstream } = await import('../dist/upstream.js');
  try {
    await initUpstream();
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
      const r = await getUpstream().callTool({ name: 'browser_navigate', arguments: { url } });
      assert.ok(r.isError, `${url} must fail`);
    }
    assert.deepEqual(target.received, [], 'no request reached the loopback server');
  } finally {
    await closeUpstream();
    process.chdir(cwd);
    delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
    target.server.close();
  }
});

test('real: a 302 from a public-looking host into loopback never reaches the loopback server', { skip: REAL_SKIP }, async () => {
  // `public.test` is mapped to 127.0.0.1 inside chrome only, so the guard sees an
  // ordinary unresolvable public name for hop 1 and a literal loopback URL for hop 2.
  const inner = countingServer((_q, res) => res.end('<title>internal</title>'));
  const innerPort = await inner.listen();
  const outer = countingServer((req, res) => {
    if (req.url === '/ok') return void res.end('<title>public</title>');
    res.writeHead(302, { location: `http://127.0.0.1:${innerPort}/secret` });
    res.end();
  });
  const outerPort = await outer.listen();
  const browser = await chromium.launch({
    channel: BROWSER_CHANNEL,
    headless: true,
    args: ['--host-resolver-rules=MAP public.test 127.0.0.1'],
  });
  try {
    const context = await browser.newContext();
    await installContextEgressGuard(context);
    const page = await context.newPage(); // navigate at once: no time for a late guard to attach
    await assert.rejects(page.goto(`http://public.test:${outerPort}/start`));
    assert.deepEqual(outer.received, ['/start'], 'hop 1 was allowed');
    const fresh = await context.newPage();
    await fresh.goto(`http://public.test:${outerPort}/ok`);
    assert.equal(await fresh.title(), 'public', 'an ordinary page still loads under the guard');
    assert.deepEqual(inner.received, [], 'hop 2 into loopback never left the browser');
  } finally {
    await browser.close();
    inner.server.close();
    outer.server.close();
  }
});

test('real: a page\'s own fetch() that 302s into loopback never reaches the loopback server', { skip: REAL_SKIP }, async () => {
  // Measured before the guard paused every request type: with documents-only,
  // this fetch followed the redirect and the page read the loopback response.
  const inner = countingServer((_q, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.end('secret');
  });
  const innerPort = await inner.listen();
  const outer = countingServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://127.0.0.1:${innerPort}/sub-secret` });
      return void res.end();
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      "<title>pub</title><script>fetch('/redir').then((r) => r.text())" +
        ".then((t) => (document.title = 'got:' + t), () => (document.title = 'fetch-failed'))</script>",
    );
  });
  const outerPort = await outer.listen();
  const browser = await chromium.launch({
    channel: BROWSER_CHANNEL,
    headless: true,
    args: ['--host-resolver-rules=MAP public.test 127.0.0.1'],
  });
  try {
    const context = await browser.newContext();
    await installContextEgressGuard(context);
    const page = await context.newPage();
    await page.goto(`http://public.test:${outerPort}/`);
    await page.waitForFunction(() => document.title !== 'pub');
    assert.equal(await page.title(), 'fetch-failed');
    assert.deepEqual(inner.received, [], 'the loopback server received nothing');
  } finally {
    await browser.close();
    inner.server.close();
    outer.server.close();
  }
});
