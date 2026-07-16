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
fs.writeFileSync(
  process.env.PLAYWRIGHT_MCP_SECRETS,
  'DEMO_USER=demo\nDEMO_PASS=secret\nDEMO_BADPASS=wrong\n',
);

const { sessionLogin, sessionStatus, leftLoginPage, scopeStorageState } = await import(
  '../dist/tools/session.js'
);
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

test('session_login: auto-detects login with NO successSignal (moved past login page)', async () => {
  // A: omit successSignal entirely — success is detected because after POST the
  // app lands on /app (different path, no password field).
  const r = await sessionLogin({
    name: 'nosignal',
    loginUrl: `${base}/login`,
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
  });
  assert.equal(r.ok, true, r.error ?? 'login ok without a marker');
  assert.ok(fs.existsSync(r.path), 'storageState written');
});

test('session_login: a VISIBLE-TEXT successSignal matches (not just a CSS selector)', async () => {
  // B: "Welcome demo" is the h1 text, not a CSS selector — must still resolve.
  const r = await sessionLogin({
    name: 'texttext',
    loginUrl: `${base}/login`,
    successSignal: 'Welcome demo',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
  });
  assert.equal(r.ok, true, r.error ?? 'text-marker login ok');
});

test('session_login: timeout yields a DIAGNOSTIC error, not "All promises were rejected"', async () => {
  // C+D: correct key names but a WRONG password value → the form fills and
  // submits, the app bounces back to /login (password field still present), so
  // the marker never matches. A bounded timeout must surface an ACTIONABLE
  // message, never the opaque AggregateError "All promises were rejected".
  const r = await sessionLogin({
    name: 'badcreds',
    loginUrl: `${base}/login`,
    successSignal: 'nonexistent-marker',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_BADPASS' },
    timeoutMs: 2500,
  });
  assert.equal(r.ok, false, 'login should fail on a wrong password');
  assert.doesNotMatch(r.error ?? '', /All promises were rejected/, 'no opaque AggregateError');
  assert.match(r.error ?? '', /timed out|login form/, 'actionable diagnostic message');
});

test('attach: leftLoginPage detects login-complete (host change or path off the login page)', () => {
  const login = 'https://signin.carsforsale.com/';
  // Still on the Cloudflare challenge / login page → not done.
  assert.equal(leftLoginPage('https://signin.carsforsale.com/', login), false);
  assert.equal(leftLoginPage('https://signin.carsforsale.com/?ReturnUrl=x', login), false);
  // Redirected to the app on a different host → done.
  assert.equal(leftLoginPage('https://dealer.carsforsale.com/dashboard', login), true);
  assert.equal(leftLoginPage('https://www.carsforsale.com/account/', login), true);
  // Same host but path left the login page → done.
  const login2 = 'https://app.example.com/login';
  assert.equal(leftLoginPage('https://app.example.com/login', login2), false);
  assert.equal(leftLoginPage('https://app.example.com/home', login2), true);
});

test('attach (profile:system): scopeStorageState keeps ONLY the login domain — never the whole cookie jar', () => {
  const state = {
    cookies: [
      { name: 'cf_clearance', domain: '.carsforsale.com' },
      { name: 'sess', domain: 'dealer.carsforsale.com' },
      { name: 'ga', domain: '.google.com' }, // unrelated site — must be dropped
      { name: 'ftsession', domain: '.ft.com' }, // unrelated site — must be dropped
    ],
    origins: [
      { origin: 'https://signin.carsforsale.com' },
      { origin: 'https://mail.google.com' }, // dropped
    ],
  };
  const scoped = scopeStorageState(state, 'carsforsale.com');
  const domains = scoped.cookies.map((c) => c.domain).sort();
  assert.deepEqual(domains, ['.carsforsale.com', 'dealer.carsforsale.com']);
  assert.equal(scoped.origins.length, 1);
  assert.equal(scoped.origins[0].origin, 'https://signin.carsforsale.com');
  // The privacy invariant: nothing from an unrelated site survives.
  assert.ok(!JSON.stringify(scoped).includes('google.com'));
  assert.ok(!JSON.stringify(scoped).includes('ft.com'));
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
