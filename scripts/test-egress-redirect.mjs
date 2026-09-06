#!/usr/bin/env node
// T1 acceptance — per-hop redirect re-validation (catalog SEC-8), plus the
// false-positive regression that keeps localhost debugging working.
//
// TIER NOTE, stated because it is a deliberate choice and not an oversight:
// the default gate here is browser-free. `installEgressGuard` is driven through
// a fake Page + fake CDP session, so the REAL guard code decides, the REAL
// blocklist runs, and nothing launches or resolves anything. The end-to-end
// claim that chromium honours `Fetch.failRequest` — two servers, a genuine
// cross-origin 302 chain, hop 2's server receiving NOTHING — needs a real
// browser, so it lives at the bottom of this file behind
// PLAYWRIGHT_MCP_TEST_BROWSER=1, the same opt-in gate test-browser-lifecycle.mjs
// uses. Run them with:
//   PLAYWRIGHT_MCP_TEST_BROWSER=1 node --test scripts/test-egress-redirect.mjs
//
// Run: node --test   (browser tests: PLAYWRIGHT_MCP_TEST_BROWSER=1 node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  installEgressGuard,
  egressRestricted,
  isBlockedHostSync,
  EgressBlockedError,
} from '../dist/egress.js';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';

// The guard is remote-only. Nothing in this file may leave the flag set for the
// next test file, so it is saved once and restored explicitly wherever it moves.
const PUBLIC_URL_AT_START = process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;

// ── doubles ──────────────────────────────────────────────────────────────────
//
// What is doubled: the Playwright Page and the CDP session — i.e. chromium.
// What is NOT doubled: installEgressGuard, its paused-request handler, and (in
// the default-validator tests) assertEgressAllowed. The decision under test is
// the guard's, not chromium's.

function fakeCdp() {
  const sent = [];
  const handlers = new Map();
  const waiters = new Map();
  let n = 0;

  const cdp = {
    on: (event, fn) => handlers.set(event, fn),
    send: async (method, params) => {
      sent.push({ method, params });
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
        const settle = waiters.get(params?.requestId);
        waiters.delete(params?.requestId);
        settle?.({ method, params });
      }
      return {};
    },
  };

  return {
    cdp,
    sent,
    /**
     * Pause one request the way chromium does and resolve when the guard has
     * DECIDED on it. Resolution is the guard's own continue/fail call — no
     * timers, so the test cannot pass by waiting long enough.
     */
    hop(url, { resourceType = 'Document' } = {}) {
      const requestId = `req-${++n}`;
      const settled = new Promise((resolve) => waiters.set(requestId, resolve));
      handlers.get('Fetch.requestPaused')({ requestId, request: { url }, resourceType });
      return settled;
    },
    decisions: () => sent.filter((s) => s.method !== 'Fetch.enable'),
  };
}

function fakePage({ cdpFails = false } = {}) {
  const cdp = fakeCdp();
  const routeHandlers = [];
  const page = {
    route: async (_pattern, fn) => void routeHandlers.push(fn),
    context: () => ({
      newCDPSession: async () => {
        if (cdpFails) throw new Error('Target does not support CDP');
        return cdp.cdp;
      },
    }),
  };
  return {
    page,
    cdp,
    /** Drive the SUB-RESOURCE route layer the way playwright would. */
    subResource(url) {
      const actions = [];
      routeHandlers[0]({
        request: () => ({ url: () => url }),
        abort: async (reason) => void actions.push(['abort', reason]),
        continue: async () => void actions.push(['continue']),
      });
      return actions;
    },
  };
}

// ── every hop is observed, not just the first ────────────────────────────────

test('per-hop: EVERY hop of a redirect chain is re-validated, cross-origin included', async () => {
  // The gap this closes, measured in src/egress.ts: page.route fires ONCE for a
  // 302 chain — for hop 1 — because playwright follows 30x internally. Two
  // distinct origins here, since the catalog records the cross-origin case as
  // never having been separately executed.
  const seen = [];
  const h = fakePage();
  const guard = await installEgressGuard(h.page, { validate: async (u) => void seen.push(u) });

  await h.cdp.hop('http://a.test:1111/a');
  await h.cdp.hop('http://b.test:2222/b');
  await h.cdp.hop('http://b.test:2222/c');

  assert.deepEqual(seen, ['http://a.test:1111/a', 'http://b.test:2222/b', 'http://b.test:2222/c']);
  assert.equal(guard.blocked(), null, 'nothing was refused');
  assert.deepEqual(
    h.cdp.decisions().map((d) => d.method),
    ['Fetch.continueRequest', 'Fetch.continueRequest', 'Fetch.continueRequest'],
    'each allowed hop is let through exactly once',
  );
});

test('per-hop: a refused hop is FAILED before its packet leaves, not reported after', async () => {
  const h = fakePage();
  const guard = await installEgressGuard(h.page, {
    validate: async (u) => {
      if (u.includes('/b')) throw new EgressBlockedError('blocked: b.test resolves to a private address');
    },
  });

  assert.equal(guard.blocked(), null, 'clean before any refusal');
  const first = await h.cdp.hop('http://a.test:1111/a');
  assert.equal(first.method, 'Fetch.continueRequest');

  const second = await h.cdp.hop('http://b.test:2222/b');
  assert.equal(second.method, 'Fetch.failRequest', 'hop 2 is failed at the REQUEST stage');
  assert.equal(second.params.errorReason, 'AccessDenied');
  assert.ok(
    !h.cdp.decisions().some(
      (d) => d.method === 'Fetch.continueRequest' && d.params.requestId === second.params.requestId,
    ),
    'the refused hop is never also continued',
  );

  // The reason is readable, because page.goto reports only net::ERR_ACCESS_DENIED
  // — which says neither which hop nor why.
  assert.equal(guard.blocked(), 'blocked: b.test resolves to a private address');
});

test('per-hop: interception is enabled for DOCUMENTS only, at the REQUEST stage', async () => {
  // Both halves are design, not incident: request-stage is what makes a refusal
  // prevention rather than a report, and documents-only is what keeps every
  // image on the page off the CDP path.
  const h = fakePage();
  await installEgressGuard(h.page, { validate: async () => {} });
  const enable = h.cdp.sent.find((s) => s.method === 'Fetch.enable');
  assert.ok(enable, 'Fetch.enable was sent');
  assert.deepEqual(enable.params.patterns, [
    { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
  ]);

  // A paused non-document is continued without being validated.
  const seen = [];
  const h2 = fakePage();
  await installEgressGuard(h2.page, { validate: async (u) => void seen.push(u) });
  const out = await h2.cdp.hop('http://a.test:1111/logo.png', { resourceType: 'Image' });
  assert.equal(out.method, 'Fetch.continueRequest');
  assert.deepEqual(seen, [], 'the document validator did not run on a sub-resource');
});

test('per-hop: sub-resources keep the sync route guard, unchanged', async () => {
  const h = fakePage();
  await installEgressGuard(h.page, { validate: async () => {} });
  assert.deepEqual(h.subResource('http://127.0.0.1:8080/img.png'), [['abort', 'blockedbyclient']]);
  assert.deepEqual(h.subResource('https://example.com/img.png'), [['continue']]);
});

test('per-hop: an unusable CDP session degrades LOUDLY, keeping the route layer', async () => {
  // Fail-open is deliberate (the OS-level nftables block is the primary
  // control), but a layer that degrades SILENTLY is indistinguishable from one
  // that was never wired — so the warning must appear, and on stderr, never on
  // stdout, which carries the MCP stdio stream.
  const h = fakePage({ cdpFails: true });
  const captured = [];
  const realErr = process.stderr.write.bind(process.stderr);
  const realOut = process.stdout.write.bind(process.stdout);
  const stdoutBytes = [];
  process.stderr.write = (chunk, ...rest) => (captured.push(String(chunk)), realErr(chunk, ...rest));
  process.stdout.write = (chunk, ...rest) => (stdoutBytes.push(String(chunk)), realOut(chunk, ...rest));
  let guard;
  try {
    guard = await installEgressGuard(h.page, { validate: async () => {} });
  } finally {
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }

  assert.ok(guard, 'the fetch is not failed just because CDP is unavailable');
  assert.equal(guard.blocked(), null);
  assert.match(captured.join(''), /per-hop redirect guard unavailable/);
  assert.ok(
    !stdoutBytes.join('').includes('per-hop redirect guard'),
    'the degradation notice never touches stdout',
  );
  // The sub-resource layer is still doing its job.
  assert.deepEqual(h.subResource('http://169.254.169.254/latest/meta-data/'), [['abort', 'blockedbyclient']]);
});

// ── the real blocklist decision, per hop ─────────────────────────────────────

test('per-hop default validator: private, loopback, link-local and .local hops are refused', async () => {
  // No `validate` injected: this drives the SHIPPING default, assertEgressAllowed.
  const h = fakePage();
  const guard = await installEgressGuard(h.page);
  const refused = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/x',
    'http://10.1.2.3/x',
    'http://192.168.1.1/x',
    'http://172.16.4.4/x',
    'http://[::1]:9/x',
    'http://localhost:3000/x',
    'http://printer.local/x',
    'http://vault.internal/x',
  ];
  for (const url of refused) {
    const out = await h.cdp.hop(url);
    assert.equal(out.method, 'Fetch.failRequest', `${url} must be refused`);
    assert.equal(out.params.errorReason, 'AccessDenied');
  }
  // The FIRST refusal is what surfaces, and it names the host — page.goto would
  // otherwise report only net::ERR_ACCESS_DENIED.
  assert.equal(guard.blocked(), 'blocked IP: 169.254.169.254');
});

test('per-hop default validator: ordinary public redirect shapes still complete', async () => {
  // The false-positive side of the same function. http→https and bare→www are
  // the two commonest legitimate hops on the web; a guard that refuses them
  // would be switched off within a day.
  //
  // Deterministic without a network: a public hostname is allowed whether DNS
  // resolves it (public address) or cannot (unresolvable → let the fetch fail
  // naturally, nothing to leak). Both branches allow, so this passes identically
  // inside `unshare -rn`. KNOWN EXPOSURE, same as test-remote.mjs's
  // assertEgressAllowed('https://example.com/') case: a sinkhole resolver
  // answering 0.0.0.0 or 127.0.0.1 for example.com would flip the verdict.
  const h = fakePage();
  const guard = await installEgressGuard(h.page);
  for (const url of [
    'http://example.com/article',
    'https://example.com/article',
    'https://www.example.com/article',
    'https://cdn.example.com/article?utm=1',
  ]) {
    const out = await h.cdp.hop(url);
    assert.equal(out.method, 'Fetch.continueRequest', `${url} must be allowed`);
  }
  assert.equal(guard.blocked(), null);
});

test('per-hop default validator is the DNS-aware one, not the sync host check', async () => {
  // The two checks disagree, and the document path must be on the strict side.
  // A malformed URL is the deterministic discriminator: assertEgressAllowed
  // fails closed on it ("invalid URL"), while the sync route layer swallows the
  // parse error and continues. Same input, opposite verdicts — so the document
  // hop demonstrably is NOT running isBlockedHostSync.
  //
  // The other asymmetry the catalog names (SEC-2: a hostname whose A record is
  // private passes the sync check and fails the DNS-aware one) cannot be
  // mechanized here without a live-DNS dependency; assertEgressAllowed's own
  // dns.lookup path is covered in scripts/test-remote.mjs.
  const h = fakePage();
  await installEgressGuard(h.page);
  const out = await h.cdp.hop('http:// not a url /x');
  assert.equal(out.method, 'Fetch.failRequest', 'the document path fails closed');

  assert.equal(isBlockedHostSync(''), false, 'the sync check has no opinion on an unparseable host');
  assert.deepEqual(h.subResource('http:// not a url /x'), [['continue']], 'the route layer continues it');
});

// ── the false-positive regression: the LOCAL surface installs nothing ────────

test('local surface: with PLAYWRIGHT_MCP_PUBLIC_URL unset, egress is not restricted', () => {
  // This gate is the whole reason localhost dev-server debugging is unaffected:
  // installEgressGuard has exactly one call site, `if (egressRestricted())` in
  // fetchUrl, so a local stdio instance installs neither layer.
  assert.equal(process.env.PLAYWRIGHT_MCP_PUBLIC_URL, undefined);
  assert.equal(egressRestricted(), false);
  process.env.PLAYWRIGHT_MCP_PUBLIC_URL = 'https://mcp.example.com';
  try {
    assert.equal(egressRestricted(), true, 'and it IS restricted on the public instance');
  } finally {
    delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  }
});

// ── real chromium: the end-to-end claim (opt-in) ─────────────────────────────
//
// Everything above proves the guard DECIDES correctly. Only a real browser can
// prove chromium ACTS on the decision — that a failed hop never reaches the
// wire. Opt-in because the default gate is browser-free by project convention.

/**
 * A server that 302s `from` → `to`, and serves a marker page at `/c`.
 *
 * `/favicon.ico` is excluded from the log on purpose: chromium requests it
 * after the document loads, so asserting on a list that may or may not contain
 * it yet is a race, not a check.
 */
function redirectServer(routes) {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/favicon.ico') received.push(req.url);
    const to = routes[req.url];
    if (typeof to === 'function') return void to(res);
    if (to) {
      res.writeHead(302, { location: to });
      return void res.end();
    }
    res.writeHead(404).end();
  });
  return { server, received, listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)) };
}

const finalPage = (res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><head><title>Final</title></head><body><h1>REDIRECT-CHAIN-END</h1>${'<p>tide gauge prose. </p>'.repeat(60)}</body></html>`);
};

test('real chromium: a legitimate cross-origin 302 chain completes, every hop seen', { skip: !BROWSER_TESTS }, async () => {
  const { chromium } = await import('playwright');
  const A = redirectServer({});
  const B = redirectServer({});
  await A.listen();
  await B.listen();
  const pa = A.server.address().port;
  const pb = B.server.address().port;
  // Chromium's own resolver maps these — no DNS, hermetic, and genuinely
  // cross-origin. A literal 127.0.0.1 URL would be aborted by the sub-resource
  // route layer at hop 1 and never reach the CDP path at all: the trap.
  A.server.removeAllListeners('request');
  A.server.on('request', (req, res) => {
    if (req.url !== '/favicon.ico') A.received.push(req.url);
    res.writeHead(302, { location: `http://b.test:${pb}/b` }).end();
  });
  B.server.removeAllListeners('request');
  B.server.on('request', (req, res) => {
    if (req.url !== '/favicon.ico') B.received.push(req.url);
    if (req.url === '/b') return void res.writeHead(302, { location: `http://b.test:${pb}/c` }).end();
    finalPage(res);
  });

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1`],
  });
  try {
    const page = await browser.newPage();
    const seen = [];
    const guard = await installEgressGuard(page, { validate: async (u) => void seen.push(u) });
    await page.goto(`http://a.test:${pa}/a`, { waitUntil: 'domcontentloaded' });

    assert.deepEqual(seen, [
      `http://a.test:${pa}/a`,
      `http://b.test:${pb}/b`,
      `http://b.test:${pb}/c`,
    ], 'all three hops re-validated');
    assert.deepEqual(A.received, ['/a']);
    assert.deepEqual(B.received, ['/b', '/c']);
    assert.equal(page.url(), `http://b.test:${pb}/c`);
    assert.match(await page.content(), /REDIRECT-CHAIN-END/, 'the legitimate chain is NOT broken');
    assert.equal(guard.blocked(), null);
  } finally {
    await browser.close();
    A.server.close();
    B.server.close();
  }
});

test('real chromium: refusing hop 2 PREVENTS it — server B receives nothing', { skip: !BROWSER_TESTS }, async () => {
  const { chromium } = await import('playwright');
  const A = redirectServer({});
  const B = redirectServer({});
  await A.listen();
  await B.listen();
  const pa = A.server.address().port;
  const pb = B.server.address().port;
  A.server.removeAllListeners('request');
  A.server.on('request', (req, res) => {
    if (req.url !== '/favicon.ico') A.received.push(req.url);
    res.writeHead(302, { location: `http://b.test:${pb}/b` }).end();
  });
  B.server.removeAllListeners('request');
  B.server.on('request', (req, res) => {
    if (req.url !== '/favicon.ico') B.received.push(req.url);
    finalPage(res);
  });

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1`],
  });
  try {
    const page = await browser.newPage();
    const guard = await installEgressGuard(page, {
      validate: async (u) => {
        if (u.includes('b.test')) throw new EgressBlockedError('blocked: b.test resolves to a private address');
      },
    });
    const err = await page
      .goto(`http://a.test:${pa}/a`, { waitUntil: 'domcontentloaded' })
      .then(() => null, (e) => e);

    // Proven at the SERVER, not at the client: a guard that reports after the
    // request has left has already leaked the navigation.
    assert.deepEqual(B.received, [], 'hop 2 never reached its target');
    assert.deepEqual(A.received, ['/a']);
    assert.ok(err, 'the navigation failed rather than silently continuing');
    assert.match(guard.blocked() ?? '', /b\.test resolves to a private address/);
  } finally {
    await browser.close();
    A.server.close();
    B.server.close();
  }
});

test('real chromium: on the LOCAL surface a localhost 302 chain still reaches /c', { skip: !BROWSER_TESTS }, async () => {
  // The false-positive test, end to end through the shipping entry point.
  // PLAYWRIGHT_MCP_PUBLIC_URL is unset, so fetchUrl installs no guard at all and
  // debugging a local dev server is byte-for-byte what it was.
  assert.equal(process.env.PLAYWRIGHT_MCP_PUBLIC_URL, undefined);
  // Isolate the stealth profile the way test-browser-lifecycle.mjs does, so this
  // never contends for the developer's real ~/.cache/playwright-mcp SingletonLock.
  const cacheAtStart = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-redirect-'));
  const { fetchUrl } = await import('../dist/tools/web-fetch.js');
  const S = redirectServer({
    '/a': '/b',
    '/b': '/c',
    '/c': finalPage,
  });
  await S.listen();
  const port = S.server.address().port;
  try {
    const result = await fetchUrl({ url: `http://127.0.0.1:${port}/a` });
    assert.deepEqual(S.received, ['/a', '/b', '/c'], 'every hop was served');
    assert.match(result.url, new RegExp(`:${port}/c$`), 'the chain resolved to /c');
    assert.match(result.text, /tide gauge prose/, 'and the page body came back');
    assert.equal(result.error, undefined);
  } finally {
    S.server.close();
    const { closeBrowser } = await import('../dist/browser.js');
    await closeBrowser().catch(() => {});
    if (cacheAtStart === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = cacheAtStart;
  }
});

test.after(() => {
  if (PUBLIC_URL_AT_START === undefined) delete process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  else process.env.PLAYWRIGHT_MCP_PUBLIC_URL = PUBLIC_URL_AT_START;
});
