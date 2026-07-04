#!/usr/bin/env node
// T1 acceptance — session_login / session_status round-trip vs a fake-login
// localhost app. Deterministic (localhost, headless, no external network).
// Asserts: storageState written at mode 600, tokens never echoed, fresh / stale
// / missing / unreachable, and project-.env credential precedence. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate config dirs BEFORE importing the module (it reads env at call time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-sess-'));
process.env.PLAYWRIGHT_MCP_SESSIONS = path.join(TMP, 'sessions');
process.env.PLAYWRIGHT_MCP_SECRETS = path.join(TMP, 'secrets.env');
fs.writeFileSync(process.env.PLAYWRIGHT_MCP_SECRETS, 'DEMO_USER=demo\nDEMO_PASS=secret\n');

const { sessionLogin, sessionStatus } = await import('../dist/tools/session.js');
const { getSecret } = await import('../dist/secrets.js');

async function withProjectDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-proj-'));
  try {
    for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── fake-login app ────────────────────────────────────────────────────────────
function startApp() {
  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    const authed = /(?:^|;\s*)sid=ok(?:;|$)/.test(cookie);
    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const p = new URLSearchParams(body);
        if (p.get('username') === 'demo' && p.get('password') === 'secret') {
          res.writeHead(302, { 'Set-Cookie': 'sid=ok; Path=/', Location: '/app' });
          res.end();
        } else {
          res.writeHead(302, { Location: '/login' });
          res.end();
        }
      });
      return;
    }
    if (req.url?.startsWith('/app')) {
      if (!authed) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body><h1>Welcome demo</h1></body></html>');
      return;
    }
    // /login (and default)
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!DOCTYPE html><html><body><form method="POST" action="/login">' +
        '<input name="username" type="text"><input name="password" type="password">' +
        '<button type="submit">Login</button></form></body></html>',
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let server;
let base;
test.before(async () => {
  server = await startApp();
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('session_login captures a session at mode 600 without echoing tokens', async () => {
  const r = await sessionLogin({
    name: 'demo',
    loginUrl: `${base}/login`,
    successSignal: 'h1',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
  });
  assert.equal(r.ok, true, r.error ?? 'login ok');
  assert.equal(r.mode, 'headless');
  assert.ok(fs.existsSync(r.path), 'storageState file written');
  const mode = fs.statSync(r.path).mode & 0o777;
  assert.equal(mode, 0o600, `mode ${mode.toString(8)} === 600`);
  // Tool result must never echo cookie/token values.
  assert.ok(!JSON.stringify(r).includes('sid'), 'no cookie token in tool result');
  // The captured artifact does contain the cookie (that is its job).
  assert.match(fs.readFileSync(r.path, 'utf8'), /sid/);
});

test('session_status: fresh for a valid saved session', async () => {
  const s = await sessionStatus({ name: 'demo', probeUrl: `${base}/app`, loginIndicator: '/login' });
  assert.equal(s.state, 'fresh');
});

test('session_status: missing when no file exists', async () => {
  const s = await sessionStatus({ name: 'nope', probeUrl: `${base}/app` });
  assert.equal(s.state, 'missing');
});

test('session_status: stale when the saved session has no valid cookie', async () => {
  const stalePath = path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, 'staley.json');
  fs.writeFileSync(stalePath, JSON.stringify({ cookies: [], origins: [] }));
  const s = await sessionStatus({ name: 'staley', probeUrl: `${base}/app`, loginIndicator: '/login' });
  assert.equal(s.state, 'stale');
});

test('session_status: unreachable when the probe cannot complete (not stale)', async () => {
  // .invalid is reserved (RFC 2606): resolution always fails, no external network.
  const s = await sessionStatus({ name: 'demo', probeUrl: 'http://nonexistent.invalid/' });
  assert.equal(s.state, 'unreachable');
});

test('session_status: stale (recapture) for a corrupt storageState file', async () => {
  const corruptPath = path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, 'corrupt.json');
  fs.writeFileSync(corruptPath, 'not json');
  const s = await sessionStatus({ name: 'corrupt', probeUrl: `${base}/app` });
  assert.equal(s.state, 'stale');
});

// ── credential precedence (project .env → secrets.env → process.env) ──────────

test('getSecret: project .env in cwd wins over user secrets.env', async () => {
  fs.appendFileSync(process.env.PLAYWRIGHT_MCP_SECRETS, 'OVERRIDE_KEY=from-secrets\n');
  await withProjectDir({ '.env': 'OVERRIDE_KEY=from-project\n' }, (dir) => {
    const prev = process.cwd();
    try {
      process.chdir(dir);
      assert.equal(getSecret('OVERRIDE_KEY'), 'from-project');
    } finally {
      process.chdir(prev);
    }
  });
  assert.equal(getSecret('OVERRIDE_KEY'), 'from-secrets');
});

test('getSecret: explicit envFile is honored; a missing envFile throws', async () => {
  await withProjectDir({ 'creds.env': 'PROJ_ONLY=yes\n' }, (dir) => {
    assert.equal(getSecret('PROJ_ONLY', { envFile: path.join(dir, 'creds.env') }), 'yes');
    assert.throws(
      () => getSecret('PROJ_ONLY', { envFile: path.join(dir, 'missing.env') }),
      /envFile not found/,
    );
  });
});

test('session_login: credentials from a project envFile, tokens still not echoed', async () => {
  await withProjectDir({ '.env': 'PROJ_USER=demo\nPROJ_PASS=secret\n' }, async (dir) => {
    const r = await sessionLogin({
      name: 'projenv',
      loginUrl: `${base}/login`,
      successSignal: 'h1',
      credKeys: { user: 'PROJ_USER', pass: 'PROJ_PASS' },
      envFile: path.join(dir, '.env'),
    });
    assert.equal(r.ok, true, r.error ?? 'login ok');
    assert.ok(!JSON.stringify(r).includes('sid'), 'no cookie token in tool result');
  });
});
