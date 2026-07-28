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

const { sessionLogin, sessionStatus, leftLoginPage, scopeStorageState, challengeCleared, clearanceSummary, wallUp, newCookies, siteCookies, urlMarkerHit } =
  await import('../dist/tools/session.js');
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

test('session_login: an explicit successSignal is NOT preempted by the generic heuristic', async () => {
  // Multi-step logins walk through pages that satisfy waitPastLogin() (new path,
  // no password field) while the human is still mid-login. Racing the heuristic
  // against the caller's marker means the loosest signal wins and the marker is
  // pointless. Here /app IS reachable and DOES move off /login, so the heuristic
  // would resolve — but the marker names something that never appears, so the
  // call must TIME OUT rather than report a success the caller did not ask for.
  const r = await sessionLogin({
    name: 'signal-wins',
    loginUrl: `${base}/login`,
    successSignal: 'this-marker-never-appears-anywhere',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
    timeoutMs: 2500,
  });
  assert.equal(r.ok, false, 'an unmatched marker must not be rescued by the heuristic');
  assert.doesNotMatch(r.error ?? '', /All promises were rejected/, 'still a readable diagnostic');
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

// Regression: the capture used to report ok:true after an anonymous visit.
// An app URL redirects to the IdP (apps.docusign.com/send → account.docusign.com),
// and the IdP's first screen asks only for an email — so the URL moved AND no
// password field is present, satisfying both wait heuristics before the human has
// typed anything. Cookies are the backstop: no new cookie ⇒ no login.
test('newCookies: only genuinely new (domain,name) pairs count as auth evidence', () => {
  const before = {
    cookies: [
      { domain: 'apps.docusign.com', name: '_ga' },
      { domain: '.apps.docusign.com', name: 'consent' },
    ],
  };

  // Anonymous visit: same cookies re-observed (one with a leading-dot domain
  // variant, which must NOT read as new) ⇒ nothing gained.
  assert.deepEqual(
    newCookies(before, {
      cookies: [
        { domain: '.apps.docusign.com', name: '_ga' },
        { domain: 'apps.docusign.com', name: 'consent' },
      ],
    }),
    [],
    'unchanged jar must yield no auth evidence',
  );

  // Real login: a session cookie appears on the IdP host.
  const gained = newCookies(before, {
    cookies: [
      { domain: 'apps.docusign.com', name: '_ga' },
      { domain: '.apps.docusign.com', name: 'consent' },
      { domain: 'account.docusign.com', name: 'AUTH_SESSION' },
    ],
  });
  assert.equal(gained.length, 1, 'exactly the new cookie is reported');
  assert.equal(gained[0].name, 'AUTH_SESSION');

  // Empty/missing jars must not throw.
  assert.deepEqual(newCookies({}, {}), []);
  assert.equal(newCookies({}, { cookies: [{ domain: 'x.test', name: 's' }] }).length, 1);
});

// Regression (attach/challenge): the export path wrote the artifact and returned
// ok:true with no evidence check at all for attach LOGIN — clearanceSummary only
// ran for challenge captures. attach has no before/after delta (it connects after
// the human finishes), so the invariant both profile modes share is "the target
// site issued something".
test('siteCookies: target-site evidence, matching scopeStorageState host rules', () => {
  const state = {
    cookies: [
      { domain: 'account.docusign.com', name: 'AUTH' },   // subdomain of target
      { domain: '.docusign.com', name: 'shared' },        // leading dot, apex
      { domain: 'evil.example', name: 'x' },              // unrelated site
    ],
  };
  assert.equal(siteCookies(state, 'docusign.com').length, 2, 'subdomain + apex count');
  assert.equal(siteCookies(state, 'example.com').length, 0, 'no partial-suffix match');
  assert.equal(siteCookies({ cookies: [] }, 'docusign.com').length, 0, 'empty jar = no evidence');
  assert.equal(siteCookies({}, 'docusign.com').length, 0, 'missing jar = no evidence');
  // A capture scoped to the site must never pass the check while being empty:
  // the two helpers share one host rule so they cannot disagree.
  const scoped = scopeStorageState(state, 'docusign.com');
  assert.equal(siteCookies(scoped, 'docusign.com').length, scoped.cookies.length);
});

// Regression: an OAuth login page embeds its own callback in the query string,
// so a post-login marker naming the app host was already present ON the login
// page and matched instantly. Markers describe where you LAND, not what is
// embedded in the URL of where you are.
test('urlMarkerHit: a marker in the OAuth query string is not a landing', () => {
  const login =
    'https://account.docusign.com/oauth/auth?redirect_uri=https%3A%2F%2Fapps.docusign.com%2Fauthenticate&state=x';
  const step2 =
    'https://account.docusign.com/username?redirect_uri=https%3A%2F%2Fapps.docusign.com%2Fauthenticate&state=x';

  // Still mid-login: the marker appears ONLY inside the query string.
  assert.equal(urlMarkerHit(login, 'apps.docusign.com', login), false, 'login page must not self-match');
  assert.equal(urlMarkerHit(step2, 'apps.docusign.com', login), false, 'email step must not match either');

  // Actually landed on the app.
  assert.equal(urlMarkerHit('https://apps.docusign.com/send', 'apps.docusign.com', login), true);

  // A marker naming the login HOST still needs the path to have moved on.
  assert.equal(urlMarkerHit(login, 'account.docusign.com', login), false, 'same path = not done');
  assert.equal(urlMarkerHit(step2, 'account.docusign.com', login), true, 'moved to a new path = done');

  // Case-insensitive, and an unparseable URL must not throw.
  assert.equal(urlMarkerHit('https://APPS.docusign.com/send', 'apps.docusign.com', login), true);
  assert.doesNotThrow(() => urlMarkerHit('not a url', 'x', login));
});

// The wall states every capture mode must agree on. Both modes compose wallUp(),
// so this corpus is the shared contract between them — extend it, never fork it.
const WALLED = [
  ['https://docs.example.com/guide', 'Just a moment...'],
  ['https://docs.example.com/guide', 'Attention Required! | Cloudflare'],
  ['https://docs.example.com/guide', 'Checking your browser before accessing'],
  ['https://docs.example.com/guide', 'Verifying you are human'],
  ['https://docs.example.com/guide', 'Access denied'],
  ['https://docs.example.com/cdn-cgi/challenge-platform/h/b', 'Guide'],
  ['https://www.google.com/sorry/index', 'Google'],
];

test('DRIFT GUARD: wallUp() is the ONLY definition of a wall — no second inline check exists', () => {
  // Two notions of "is the wall still up" is the failure mode this feature is most
  // prone to: login mode had its own inline /just a moment/i before wallUp() existed.
  // Catch a reintroduced literal at build time rather than by field bug report.
  const src = fs.readFileSync(new URL('../src/tools/session.ts', import.meta.url), 'utf8');
  const wallRegexLiterals = src.match(/\/[^/\n]*(just a moment|challenge-platform|verifying you are human)[^/\n]*\/i/gi) ?? [];
  assert.equal(
    wallRegexLiterals.length,
    2, // WALL_TITLE and WALL_PATH — nothing else may pattern-match a wall
    `expected exactly the WALL_TITLE + WALL_PATH constants, found ${wallRegexLiterals.length}:\n${wallRegexLiterals.join('\n')}`,
  );
});

test('DRIFT GUARD: both capture modes agree on every walled state (shared wallUp corpus)', () => {
  const loginUrl = 'https://docs.example.com/guide';
  for (const [url, title] of WALLED) {
    assert.equal(wallUp(url, title), true, `wallUp missed a wall: ${title} @ ${url}`);
    // Challenge mode must not complete...
    assert.equal(challengeCleared(url, loginUrl, title), false, `challenge mode completed on a wall: ${title}`);
    // ...and neither may login mode, which composes the same predicate. A page that
    // navigated away but still shows a wall is NOT a finished login.
    assert.equal(
      leftLoginPage(url, 'https://docs.example.com/login') && !wallUp(url, title),
      false,
      `login mode completed on a wall: ${title}`,
    );
  }
  // A cleared page is cleared for both modes.
  assert.equal(wallUp('https://docs.example.com/guide', 'Getting Started'), false);
});

test('challenge: cleared only when the markers vanish on the SAME url (a solve never navigates away)', () => {
  const walled = 'https://docs.example.com/guide';
  // The wall is still up — every one of these must keep waiting.
  assert.equal(challengeCleared(walled, walled, 'Just a moment...'), false);
  assert.equal(challengeCleared(walled, walled, 'Attention Required! | Cloudflare'), false);
  assert.equal(challengeCleared(walled, walled, 'Verifying you are human'), false);
  // A blank title is the challenge shell mid-load, not a cleared page.
  assert.equal(challengeCleared(walled, walled, ''), false);
  assert.equal(challengeCleared(walled, walled, '   '), false);
  // Parked on a dedicated challenge path → still walled, whatever the title says.
  assert.equal(challengeCleared('https://docs.example.com/cdn-cgi/challenge-platform/x', walled, 'Guide'), false);
  assert.equal(challengeCleared('https://www.google.com/sorry/index', 'https://www.google.com/search?q=x', 'Google'), false);
  // Another tab the human opened proves nothing about our wall.
  assert.equal(challengeCleared('https://mail.example.com/inbox', walled, 'Inbox'), false);
  // Cleared: same host, real title, no challenge path — the whole point of the mode.
  assert.equal(challengeCleared(walled, walled, 'Getting Started — Example Docs'), true);
  // Query/fragment churn on the same page still counts as cleared.
  assert.equal(challengeCleared(walled + '?ref=1', walled, 'Getting Started'), true);
  // Garbage in never reads as success.
  assert.equal(challengeCleared('not a url', walled, 'Guide'), false);
});

test('challenge: clearanceSummary reports expiry, and WARNS when nothing was actually cleared', () => {
  const soon = Math.floor(Date.now() / 1000) + 1800; // a cf_clearance is minutes, not days
  const later = soon + 86_400;
  // Earliest clearance expiry wins — that is when the artifact really dies.
  const ok = clearanceSummary({
    cookies: [
      { name: 'cf_clearance', expires: later },
      { name: '__cf_bm', expires: soon },
      { name: 'unrelated', expires: 1 },
    ],
  });
  assert.equal(ok.expiresAt, new Date(soon * 1000).toISOString());
  assert.equal(ok.warning, undefined);
  // A capture with no clearance cookie "succeeded" but is empty — must not pass silently.
  const none = clearanceSummary({ cookies: [{ name: 'lang', expires: later }] });
  assert.equal(none.expiresAt, undefined);
  assert.match(none.warning, /no clearance cookie/i);
  assert.match(clearanceSummary({}).warning, /no clearance cookie/i);
  // Playwright encodes a session cookie as expires:-1 — it dies with the browser we kill.
  const sess = clearanceSummary({ cookies: [{ name: 'cf_clearance', expires: -1 }] });
  assert.equal(sess.expiresAt, undefined);
  assert.match(sess.warning, /SESSION cookie/);
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
