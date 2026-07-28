#!/usr/bin/env node
// T1 acceptance — remote (claude.ai) transport. Deterministic: no live browser,
// no live GitHub, no network. Covers the egress SSRF backstop, the REMOTE_MODE
// tool denylist (via createOutwardServer over an in-memory transport), and the
// GitHub proxy-OAuth layer (metadata discovery, DCR, /authorize redirect, bearer
// guard) by mounting the auth router on a throwaway express app. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';

import { isBlockedIp, isBlockedHostSync, assertEgressAllowed, EgressBlockedError } from '../dist/egress.js';
import { createOutwardServer } from '../dist/index.js';
import { buildGitHubAuth } from '../dist/auth.js';

const DENYLISTED = ['browser_run_code_unsafe', 'session_login', 'session_status', 'session_solve_challenge', 'session_scaffold_tests', 'browser_file_upload', 'suite_scaffold', 'suite_audit'];
const KEEPERS = ['web_fetch', 'browser_evaluate', 'browser_navigate', 'browser_snapshot', 'browser_click'];

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

function stubUpstream() {
  const tools = [...DENYLISTED, ...KEEPERS, 'browser_close']
    .filter((n) => !['web_fetch', 'session_login', 'session_status', 'session_solve_challenge', 'session_scaffold_tests'].includes(n)) // these are custom, not upstream
    .map((name) => ({ name, inputSchema: { type: 'object' } }));
  return {
    listTools: async () => ({ tools }),
    callTool: async ({ name }) => ({ content: [{ type: 'text', text: `upstream:${name}` }] }),
  };
}

async function connectOutward(remote) {
  const upstream = stubUpstream();
  const { tools: upstreamTools } = await upstream.listTools();
  // createOutwardServer resolves the upstream client PER CALL so a session bind
  // can swap the browser underneath live callers (src/upstream.ts) — hand it a
  // getter, not the client.
  const server = createOutwardServer(() => upstream, upstreamTools, { remote });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return client;
}

test('denylist: remote tools/list omits the dangerous tools, keeps the rest', async () => {
  const client = await connectOutward(true);
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const d of DENYLISTED) assert.equal(names.has(d), false, `${d} hidden on remote`);
  for (const k of KEEPERS) assert.equal(names.has(k), true, `${k} present on remote`);
  await client.close();
});

test('denylist: remote tools/call rejects a denylisted tool by name (not just hidden)', async () => {
  const client = await connectOutward(true);
  const res = await client.callTool({ name: 'session_login', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content.find((c) => c.type === 'text').text, /not available on the remote surface/);
  await client.close();
});

test('denylist: local (remote:false) surface keeps the full toolset', async () => {
  const client = await connectOutward(false);
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const d of DENYLISTED) assert.equal(names.has(d), true, `${d} present locally`);
  await client.close();
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
