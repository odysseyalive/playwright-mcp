#!/usr/bin/env node
// T1 acceptance — remote (claude.ai) transport. Deterministic: no live browser,
// no live GitHub, no network. Covers the egress SSRF backstop, the trust-tier
// tool denylist (via createOutwardServer over an in-memory transport, with each
// tier's denied set DERIVED from the running server rather than re-listed here),
// and the GitHub proxy-OAuth layer (metadata discovery, DCR, /authorize redirect,
// bearer guard) by mounting the auth router on a throwaway express app.
//
// Scope note: src/remote.ts is never constructed here. The transport wiring, the
// stateful session map and the express mount order are NOT covered by this file;
// what is covered is the filter (dist/index.js) and the auth router (dist/auth.js).
// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';

import { isBlockedIp, isBlockedHostSync, assertEgressAllowed, EgressBlockedError } from '../dist/egress.js';
import { createOutwardServer, withSessionBanner } from '../dist/index.js';
import { buildGitHubAuth } from '../dist/auth.js';

// ── egress backstop ───────────────────────────────────────────────────────────

test('egress: private/loopback/link-local/metadata IPs are blocked, public allowed', () => {
  for (const ip of ['169.254.169.254', '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fe80::1', 'fd00::1'])
    assert.equal(isBlockedIp(ip), true, `${ip} blocked`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'])
    assert.equal(isBlockedIp(ip), false, `${ip} allowed`);
});

test('egress: localhost + internal suffixes blocked by host', () => {
  for (const h of ['localhost', 'foo.internal', 'svc.local', 'metadata.google.internal'])
    assert.equal(isBlockedHostSync(h), true, `${h} blocked`);
  assert.equal(isBlockedHostSync('example.com'), false);
});

test('egress: assertEgressAllowed throws for blocked, resolves for public', async () => {
  await assert.rejects(() => assertEgressAllowed('http://169.254.169.254/latest/meta-data/'), EgressBlockedError);
  await assert.rejects(() => assertEgressAllowed('http://localhost:3000/'), EgressBlockedError);
  await assert.doesNotReject(() => assertEgressAllowed('https://example.com/'));
});

// ── REMOTE_MODE tool denylist ─────────────────────────────────────────────────
//
// The denied sets (ALWAYS_DENIED / CLOUD_DENIED / REMOTE_DENYLIST) live in
// src/index.ts and are NOT exported, so this file used to keep a hand-copy of
// them. A hand-copy is a claim about src/index.ts maintained where src/index.ts
// cannot see it — the drift class this suite exists to catch. The tests below
// DERIVE each tier's denied set from the running server instead:
//
//     denied(tier) === names(stdio) \ names(tier)
//
// so membership is read out of the live filter, never re-listed. The only names
// spelled out below are (a) the universe of upstream tools handed to the filter,
// which is not a claim about what is denied, and (b) three class representatives
// anchoring the decisions, each carrying its reason.
//
// Residual, stated rather than hidden: a name silently REMOVED from the source
// sets is caught only for the anchored representatives. Asserting full set
// equality would need ALWAYS_DENIED / CLOUD_DENIED (or a `deniedFor(trust)`
// helper) exported from src/index.ts, which this file does not own.

/**
 * The tool universe offered to the filter: real @playwright/mcp names only.
 * NOT a claim about which are denied — every denial below is derived. The custom
 * tools (web_fetch, session_*, suite_*) are injected by createOutwardServer
 * itself, so the universe stays complete without naming them here.
 */
const UPSTREAM_TOOLS = [
  'browser_run_code_unsafe',
  'browser_evaluate',
  'browser_file_upload',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_close',
];

function stubUpstream() {
  const tools = UPSTREAM_TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } }));
  return {
    listTools: async () => ({ tools }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: `upstream:${name}` }] }),
  };
}

async function connectOutward(options) {
  // Back-compat: a bare boolean maps to the legacy { remote } switch; an object
  // is passed through so tests can select a trust tier directly.
  const opts = typeof options === 'object' && options !== null ? options : { remote: options };
  const upstream = stubUpstream();
  const { tools: upstreamTools } = await upstream.listTools();
  // createOutwardServer resolves the upstream client PER CALL so a session bind
  // can swap the browser underneath live callers (src/upstream.ts) — hand it a
  // getter, not the client.
  const server = createOutwardServer(() => upstream, upstreamTools, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

/** Tool names a surface exposes on tools/list. */
async function namesOn(options) {
  const client = await connectOutward(options);
  try {
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } finally {
    await client.close();
  }
}

/**
 * A tier's denied set, as the SERVER computes it: everything the stdio surface
 * exposes that this tier does not. Derived on every call, so it cannot drift
 * from src/index.ts the way a copied list can.
 */
async function deniedOn(options) {
  const stdio = await namesOn(false);
  // Guard the diff: an empty or broken stdio listing would make every "denied"
  // assertion below pass by producing an empty universe.
  assert.ok(stdio.size > UPSTREAM_TOOLS.length, 'stdio baseline lists the full toolset');
  const tier = await namesOn(options);
  return new Set([...stdio].filter((n) => !tier.has(n)));
}

/** Call one tool on a surface. */
async function callOn(options, name) {
  const client = await connectOutward(options);
  try {
    return await client.callTool({ name, arguments: {} });
  } finally {
    await client.close();
  }
}

const textOf = (res) => res.content.find((c) => c.type === 'text')?.text ?? '';

test('tiers: stdio is the full toolset — the baseline every denial is derived against', async () => {
  const stdio = await namesOn(false);
  for (const n of UPSTREAM_TOOLS) assert.equal(stdio.has(n), true, `${n} present on stdio`);
  assert.ok(stdio.size > UPSTREAM_TOOLS.length, 'the custom tools reach the surface too');
});

for (const [tier, options, surface] of [
  ['local', { trust: 'local' }, /not available on the local surface/],
  ['cloud', { trust: 'cloud' }, /not available on the cloud surface/],
]) {
  test(`tiers: every tool the ${tier} surface hides is ALSO rejected by tools/call`, async () => {
    // Hiding alone is insufficient — a client can name a hidden tool
    // (DEC-2026-06-26). Derived, so this covers whatever the source denies today,
    // not whatever a copied list last remembered.
    const denied = await deniedOn(options);
    assert.ok(denied.size > 0, `the ${tier} tier denies something at all (guards a vacuous loop)`);
    let checked = 0;
    for (const name of denied) {
      const res = await callOn(options, name);
      assert.equal(res.isError, true, `${name} rejected on ${tier} tools/call`);
      assert.match(textOf(res), surface, `${name} rejected naming the ${tier} surface`);
      checked += 1;
    }
    assert.equal(checked, denied.size, 'every derived denial was actually exercised');
  });
}

test('tiers: the local denied set is a strict subset of the cloud one, differing only by session_*', async () => {
  const local = await deniedOn({ trust: 'local' });
  const cloud = await deniedOn({ trust: 'cloud' });
  for (const n of local) assert.equal(cloud.has(n), true, `${n} denied on local is denied on cloud too`);
  const cloudOnly = [...cloud].filter((n) => !local.has(n));
  assert.ok(cloudOnly.length > 0, 'the two tiers actually differ (guards both sets collapsing into one)');
  for (const n of cloudOnly) assert.match(n, /^session_/, `${n} is cloud-only because it is a human-gated handoff`);
});

test('tiers: the legacy remote:true alias resolves to exactly the cloud tier', async () => {
  // OutwardServerOptions still accepts the boolean and existing call sites use it.
  const legacy = await deniedOn(true);
  const cloud = await deniedOn({ trust: 'cloud' });
  assert.ok(cloud.size > 0, 'the cloud tier denies something at all');
  assert.deepEqual([...legacy].sort(), [...cloud].sort());
});

// ── anchors: the decisions, one class representative each ─────────────────────

test('anchor: browser_evaluate is denied on local AND cloud, on tools/list and tools/call', async () => {
  // It injects arbitrary JS into page context with no human gate, so it sits in
  // ALWAYS_DENIED, not CLOUD_DENIED (src/index.ts:120-127). This REVERSES
  // DEC-2026-06-26 §4, whose "expose" clause named it; the tier split is the
  // decision, so asserting cloud alone would also pass under CLOUD_DENIED —
  // the option that was rejected.
  for (const [tier, options, surface] of [
    ['local', { trust: 'local' }, /not available on the local surface/],
    ['cloud', { trust: 'cloud' }, /not available on the cloud surface/],
  ]) {
    assert.equal((await deniedOn(options)).has('browser_evaluate'), true, `browser_evaluate denied on ${tier}`);
    const res = await callOn(options, 'browser_evaluate');
    assert.equal(res.isError, true, `browser_evaluate rejected on ${tier} tools/call`);
    assert.match(textOf(res), surface);
  }
});

test('anchor: browser_evaluate is UNTOUCHED on stdio — visible and reaching upstream', async () => {
  // The false-positive assertion: the operator's own Claude Code surface must
  // keep the tool. Proven by a call that reaches the upstream stub, not by
  // presence in a listing.
  assert.equal((await namesOn(false)).has('browser_evaluate'), true, 'visible on stdio');
  const res = await callOn(false, 'browser_evaluate');
  assert.notEqual(res.isError, true, 'not rejected on stdio');
  assert.equal(res.content[0].text, 'upstream:browser_evaluate', 'the call reached upstream');
});

test('anchor: browser_run_code_unsafe stays denied on local and cloud', async () => {
  // browser_evaluate's pair: DEC-2026-07-29 treats the two as one class of
  // arbitrary-code bypass, so a change that split them would show up here.
  assert.equal((await deniedOn({ trust: 'local' })).has('browser_run_code_unsafe'), true, 'denied on local');
  assert.equal((await deniedOn({ trust: 'cloud' })).has('browser_run_code_unsafe'), true, 'denied on cloud');
});

test('anchor: session_login is the tier split — exposed on local, denied on cloud', async () => {
  // Human-gated (it opens a headed window), which is what makes it safe on the
  // opted-in loopback surface and unsafe behind a prompt-injectable cloud client.
  // Listing only: calling it for real would open a browser and break hermeticity.
  assert.equal((await namesOn({ trust: 'local' })).has('session_login'), true, 'exposed on local');
  assert.equal((await deniedOn({ trust: 'cloud' })).has('session_login'), true, 'denied on cloud');
  const res = await callOn({ trust: 'cloud' }, 'session_login');
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not available on the cloud surface/);
});

// ── GitHub proxy-OAuth layer ──────────────────────────────────────────────────

const PUBLIC = 'https://mcp.example.test';

async function startAuthApp() {
  const auth = buildGitHubAuth({
    publicUrl: PUBLIC,
    clientId: 'dummy-id',
    clientSecret: 'dummy-secret',
    allowedLogin: 'someone',
  });
  const app = express();
  app.use(express.json());
  app.use(auth.router);
  app.post('/mcp', auth.requireAuth, (_req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

let authApp;
test.before(async () => { authApp = await startAuthApp(); });
test.after(() => authApp?.server.close());

test('oauth: serves RFC 8414 authorization-server metadata', async () => {
  const m = await fetch(`${authApp.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  assert.ok(m.issuer.startsWith(PUBLIC));
  assert.ok(m.authorization_endpoint && m.token_endpoint && m.registration_endpoint);
});

test('oauth: serves RFC 9728 protected-resource metadata for /mcp', async () => {
  const m = await fetch(`${authApp.base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  assert.match(m.resource, /\/mcp$/);
  assert.ok(Array.isArray(m.authorization_servers) && m.authorization_servers.length >= 1);
});

test('oauth: DCR issues a client_id', async () => {
  const r = await fetch(`${authApp.base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 't', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  assert.equal(r.status, 201);
  assert.ok((await r.json()).client_id);
});

test('oauth: /authorize redirects to GitHub carrying our client_id + callback', async () => {
  const reg = await fetch(`${authApp.base}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  }).then((r) => r.json());
  const u = new URL(`${authApp.base}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'xyz', scope: 'mcp',
  }).toString();
  const res = await fetch(u, { redirect: 'manual' });
  const loc = res.headers.get('location') ?? '';
  assert.ok([302, 303].includes(res.status));
  assert.ok(loc.startsWith('https://github.com/login/oauth/authorize'));
  assert.ok(loc.includes('client_id=dummy-id'));
  assert.ok(loc.includes(encodeURIComponent(`${PUBLIC}/oauth/github/callback`)));
});

test('oauth: /mcp without a bearer token → 401 + WWW-Authenticate', async () => {
  const res = await fetch(`${authApp.base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
});

// ── RFC 9207 issuer identification (MCP 2026-07-28 / SEP-2468) ────────────────
// We are our own authorization server, so clients validate `iss` against us. The
// SDK emits none; ledger DEC-2026-07-28 adds it. GitHub is stubbed at the global
// fetch so the callback's redirect contract is exercised with zero network.

/** Register a client and start /authorize, returning the txn id GitHub would echo. */
async function beginAuthorization() {
  const reg = await fetch(`${authApp.base}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }),
  }).then((r) => r.json());
  const u = new URL(`${authApp.base}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', state: 'xyz', scope: 'mcp',
  }).toString();
  const res = await fetch(u, { redirect: 'manual' });
  return new URL(res.headers.get('location')).searchParams.get('state');
}

/** Drive the GitHub callback with `login` as the identity GitHub reports back. */
async function callbackAs(login) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return new Response(JSON.stringify({ access_token: 'gh-token' }), { headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://api.github.com/user'))
      return new Response(JSON.stringify({ login }), { headers: { 'Content-Type': 'application/json' } });
    return real(input, init);
  };
  try {
    const txn = await beginAuthorization();
    const res = await real(`${authApp.base}/oauth/github/callback?code=gh-code&state=${txn}`, { redirect: 'manual' });
    return new URL(res.headers.get('location'));
  } finally {
    globalThis.fetch = real;
  }
}

test('rfc9207: metadata advertises iss support and keeps the RFC 9728 route working', async () => {
  const m = await fetch(`${authApp.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  assert.equal(m.authorization_response_iss_parameter_supported, true);
  // Our metadata router mounts AHEAD of mcpAuthRouter to inject that flag; prove
  // the shadowed sibling route still resolves rather than being swallowed.
  const prm = await fetch(`${authApp.base}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
  assert.match(prm.resource, /\/mcp$/);
});

test('rfc9207: successful authorization response carries iss matching the metadata issuer', async () => {
  const { issuer } = await fetch(`${authApp.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const loc = await callbackAs('someone');
  assert.ok(loc.searchParams.get('code'), 'issues an authorization code');
  assert.equal(loc.searchParams.get('iss'), issuer, 'iss is byte-identical to the published issuer');
  assert.equal(loc.searchParams.get('state'), 'xyz');
});

test('rfc9207: denied authorization response ALSO carries iss (error responses are not exempt)', async () => {
  const { issuer } = await fetch(`${authApp.base}/.well-known/oauth-authorization-server`).then((r) => r.json());
  const loc = await callbackAs('somebody-else');
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('code'), null, 'no code is handed out on denial');
  assert.equal(loc.searchParams.get('iss'), issuer);
});

// ── ambient session-binding disclosure (ledger DEC-2026-07-28) ────────────────

// Deliberately unlike any English word: the remote test asserts this name is
// ABSENT from the banner, and a short name like "ft" is a substring of ordinary
// prose ("after"), which would make that assertion pass or fail by accident.
const SESSION = 'acme-portal';

test('binding banner: anonymous browser leaves the result untouched', () => {
  const result = { content: [{ type: 'text', text: 'snapshot' }] };
  assert.deepEqual(withSessionBanner(result, null, false), result);
});

test('binding banner: local surface names the session and says how to unbind', () => {
  const out = withSessionBanner({ content: [{ type: 'text', text: 'snapshot' }] }, SESSION, false);
  assert.equal(out.content.length, 2, 'appends rather than replaces');
  assert.equal(out.content[0].text, 'snapshot', 'original content is first and unmodified');
  assert.match(out.content[1].text, new RegExp(`session "${SESSION}"`));
  assert.match(out.content[1].text, /session_attach\(\{name:null\}\)/);
});

test('binding banner: remote surface discloses the binding WITHOUT leaking the name', () => {
  const out = withSessionBanner({ content: [{ type: 'text', text: 'snapshot' }] }, SESSION, true);
  assert.match(out.content[1].text, /authenticated session/);
  assert.equal(out.content[1].text.includes(SESSION), false, 'session name never reaches the remote client');
});

test('binding banner: a result with no content array still gets the notice', () => {
  const out = withSessionBanner({ isError: true }, SESSION, false);
  assert.equal(out.isError, true, 'other fields survive');
  assert.equal(out.content.length, 1);
});
