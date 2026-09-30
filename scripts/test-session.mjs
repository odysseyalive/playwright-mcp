#!/usr/bin/env node
// T1 acceptance — session_login / session_status round-trip vs a fake-login
// localhost app. Deterministic (localhost, headless, no external network).
// Asserts: storageState written at mode 600, tokens never echoed, fresh / stale
// / missing / unreachable, and project-.env credential precedence. Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withPlatformSync } from './fixtures/platform.mjs';

// Isolate config dirs BEFORE importing the module (it reads env at call time).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-sess-'));
process.env.PLAYWRIGHT_MCP_SESSIONS = path.join(TMP, 'sessions');
process.env.PLAYWRIGHT_MCP_SECRETS = path.join(TMP, 'secrets.env');
fs.writeFileSync(
  process.env.PLAYWRIGHT_MCP_SECRETS,
  'DEMO_USER=demo\nDEMO_PASS=secret\nDEMO_BADPASS=wrong\n',
);

const { sessionLogin, sessionStatus, leftLoginPage, scopeStorageState, challengeCleared, clearanceSummary, wallUp, newCookies, siteCookies, urlMarkerHit, makeAttachLoginCheck, isInfraCookieName, isAuthCookieName, gainedAuthCookie, makeAuthCookieProbe, resolveHumanWait, CAPPED_HUMAN_WAIT_MS, makeWindowClosedWatch, makeEndpointWatch, devtoolsUnreachable, LoginCancelledError, captureProgress, sessionLoginTool, sessionSolveChallengeTool } =
  await import('../dist/tools/session.js');
const { getSecret, ownerOnlyAclArgs, parseWhoamiSid, ownerOnlyFile, ownerOnlyDir, reassertOwnerOnly, OwnerOnlyError, sessionFilePath } =
  await import('../dist/secrets.js');

/** Read once, before any test fakes it, so a leaked fake is detectable. */
const REAL_PLATFORM = process.platform;
const IS_WIN32 = REAL_PLATFORM === 'win32';

// ── owner-only verification on win32 (the REAL ACL, not .mode) ─────────────────
// On Windows fs.statSync().mode derives only from the read-only attribute, so a
// `.mode & 0o777` check cannot see an ACL at all. What the capture promises there
// is: the DACL is PROTECTED (no inherited ACEs can apply), it holds exactly ONE
// ACE, and that ACE allows the current account's SID. Read with Get-Acl asking
// for SIDs rather than names (icacls prints resolved, localized account names and
// has no protected flag to show). Tools run by absolute System32 path, argument
// array, no shell; the target path travels in an environment variable, never in
// the command text. NOT VERIFIED ON WINDOWS — this repo has no Windows host; the
// judge (daclProblems) is exercised on every OS against canned dumps below.

const system32 = (...rel) =>
  path.win32.join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', ...rel);

const DACL_DUMP_SCRIPT = [
  '$acl = Get-Acl -LiteralPath $env:PWMCP_ACL_TARGET',
  '"protected=$($acl.AreAccessRulesProtected)"',
  '$acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {',
  '  "ace=$($_.IdentityReference.Value)|$($_.AccessControlType)|$($_.IsInherited)|$($_.FileSystemRights)" }',
].join('\n');

/** The current account's SID from `whoami /user /fo csv /nh`, parsed here, independently of src/secrets.ts. */
function whoamiSid() {
  const r = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(r.status, 0, `whoami failed: ${r.error?.message ?? r.stderr}`);
  const sid = r.stdout.trim().match(/,"(S-1-\d+(?:-\d+)+)"$/)?.[1];
  assert.ok(sid, 'whoami printed no SID');
  return sid;
}

/** `protected=<bool>` then one `ace=<SID>|<type>|<inherited>|<rights>` line per ACE. */
function daclDump(target) {
  const r = spawnSync(
    system32('WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', DACL_DUMP_SCRIPT],
    { encoding: 'utf8', shell: false, windowsHide: true, env: { ...process.env, PWMCP_ACL_TARGET: target } },
  );
  assert.equal(r.status, 0, `Get-Acl failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}

/**
 * Everything wrong with a DACL dump for an owner-only artifact; [] when it is
 * right. Pure, so it is tested on every OS — including that it CAN fail.
 */
function daclProblems(dump, sid) {
  const lines = dump.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const problems = [];
  const prot = lines.find((l) => l.startsWith('protected='));
  if (prot !== 'protected=True') problems.push(`DACL not protected (${prot ?? 'no protected= line'}), so inherited ACEs apply`);
  const aces = lines.filter((l) => l.startsWith('ace=')).map((l) => l.slice(4).split('|'));
  if (aces.length !== 1) problems.push(`expected exactly one ACE, found ${aces.length}`);
  for (const [grantee, type, inherited, rights] of aces) {
    if (grantee !== sid) problems.push(`an ACE grants ${grantee}, not the current account ${sid}`);
    if (type !== 'Allow') problems.push(`the ACE for ${grantee} is ${type}, not Allow`);
    if (inherited !== 'False') problems.push(`the ACE for ${grantee} is inherited`);
    if (rights !== 'FullControl') problems.push(`the ACE for ${grantee} grants ${rights}, not FullControl`);
  }
  return problems;
}

/** Assert the artifact is readable by its owner alone, by whatever this OS enforces. */
function assertOwnerOnly(file) {
  if (IS_WIN32) {
    const problems = daclProblems(daclDump(file), whoamiSid()); // NOT VERIFIED ON WINDOWS
    assert.deepEqual(problems, [], `artifact is not owner-only:\n${problems.join('\n')}`);
  } else {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `mode ${mode.toString(8)} === 600`);
  }
}

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
    // Same-origin SPA login (the iCloud class): submitting does NOT navigate — the
    // pathname stays /spa throughout — so the URL-change heuristic can never fire.
    // On success the password form is removed and an auth-NAMED cookie is set.
    if (req.url?.startsWith('/spa')) {
      if (req.method === 'POST' && req.url === '/spa-login') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const p = new URLSearchParams(body);
          if (p.get('username') === 'demo' && p.get('password') === 'secret') {
            // Mimic iCloud's first-party auth cookie name (contains "token").
            res.writeHead(200, {
              'Set-Cookie': 'X-APPLE-WEBAUTH-TOKEN=ok; Path=/',
              'Content-Type': 'text/plain',
            });
            res.end('ok');
          } else {
            res.writeHead(401);
            res.end('no');
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html><body>' +
          '<form id="f"><input name="username" type="text"><input name="password" type="password">' +
          '<button type="submit">Login</button></form><div id="app"></div>' +
          '<script>document.getElementById("f").addEventListener("submit",async function(e){' +
          'e.preventDefault();var f=e.target;' +
          'var b=new URLSearchParams(new FormData(f)).toString();' +
          'var r=await fetch("/spa-login",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:b});' +
          'if(r.ok){f.remove();document.getElementById("app").textContent="Signed in";}' +
          '});</script></body></html>',
      );
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

test('session_login captures an owner-only session (mode 600; win32: one-ACE protected owner DACL) without echoing tokens', async () => {
  const r = await sessionLogin({
    name: 'demo',
    loginUrl: `${base}/login`,
    successSignal: 'h1',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
  });
  assert.equal(r.ok, true, r.error ?? 'login ok');
  assert.equal(r.mode, 'headless');
  assert.ok(fs.existsSync(r.path), 'storageState file written');
  assertOwnerOnly(r.path);
  // Tool result must never echo cookie/token values.
  assert.ok(!JSON.stringify(r).includes('sid'), 'no cookie token in tool result');
  // The captured artifact does contain the cookie (that is its job).
  assert.match(fs.readFileSync(r.path, 'utf8'), /sid/);
});

// ── the win32 owner-only contract, exercised on every OS ────────────────────────
// src/secrets.ts's win32 branch never runs on the Linux gate. These pin its
// deterministic seams: the exact icacls argv, the whoami SID parse, and the
// failure path. NOT VERIFIED ON WINDOWS: icacls/whoami themselves never ran here.

test('win32 contract: the DACL judge accepts only a protected, single, owner-SID, non-inherited ACE', () => {
  const sid = 'S-1-5-21-111-222-333-1001';
  const good = `protected=True\r\nace=${sid}|Allow|False|FullControl\r\n`;
  assert.deepEqual(daclProblems(good, sid), []);
  // Every way it can be wrong is caught (the judge is not vacuous).
  assert.match(daclProblems(good.replace('True', 'False'), sid).join(), /not protected/);
  assert.match(daclProblems(`${good}ace=S-1-5-18|Allow|False|FullControl\n`, sid).join(), /exactly one ACE, found 2/);
  assert.match(daclProblems(good.replace('|False|', '|True|'), sid).join(), /inherited/);
  assert.match(daclProblems(good, 'S-1-5-21-111-222-333-1002').join(), /not the current account/);
  assert.match(daclProblems(good.replace('Allow', 'Deny'), sid).join(), /not Allow/);
  assert.match(daclProblems(good.replace('FullControl', 'ReadAndExecute, Synchronize'), sid).join(), /not FullControl/);
  assert.equal(daclProblems('', sid).length, 2, 'an empty dump fails twice: no protected line, zero ACEs');
});

test('win32 contract: ownerOnlyAclArgs is the exact icacls argv for a file and for the dir', () => {
  const sid = 'S-1-5-21-1-2-3-1001';
  assert.deepEqual(ownerOnlyAclArgs('C:\\s\\demo.json', sid, 'file'), [
    'C:\\s\\demo.json',
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(F)`,
  ]);
  assert.deepEqual(ownerOnlyAclArgs('C:\\s', sid, 'dir'), ['C:\\s', '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(F)`]);
  // A malformed SID never reaches an argument.
  for (const bad of ['', 'Everyone', 'S-1-5-21-1 /grant Everyone:F', 'S-1-5-21-1:(F) *S-1-1-0']) {
    assert.throws(() => ownerOnlyAclArgs('C:\\s', bad, 'file'), OwnerOnlyError, JSON.stringify(bad));
  }
});

test('win32 contract: parseWhoamiSid takes the SID field and rejects anything that is not one', () => {
  assert.equal(parseWhoamiSid('"desktop-x\\francis","S-1-5-21-111-222-333-1001"\r\n'), 'S-1-5-21-111-222-333-1001');
  assert.equal(parseWhoamiSid('"CORP\\a,b","S-1-5-21-9-9-9-500"'), 'S-1-5-21-9-9-9-500', 'a comma in the name');
  for (const bad of [
    '',
    '"desktop-x\\francis"',
    '"x","not-a-sid"',
    '"x","S-1-5-21-1 /grant Everyone:F"', // injection-shaped last field
    '"x","S-1-5-21-1-1001:(F)"',
    '"x","S-1-5-21-1-1001" & calc',
  ]) {
    assert.throws(() => parseWhoamiSid(bad), OwnerOnlyError, JSON.stringify(bad));
  }
});

const WIN32_FAILURE_PATH_SKIP = IS_WIN32
  ? 'real win32: the path guard passes and icacls runs for real, so this failure is only reachable by ' +
    'faking the platform on POSIX; the success path is asserted by the capture test above'
  : false;

test('win32 contract (faked platform): ownerOnlyFile/ownerOnlyDir refuse, with OwnerOnlyError, before any tool runs', { skip: WIN32_FAILURE_PATH_SKIP }, () => {
  const file = path.join(TMP, 'acl-refuse.json');
  fs.writeFileSync(file, '{}');
  const caught = (fn) => {
    try {
      fn();
    } catch (err) {
      return err;
    }
    return undefined;
  };
  // Synchronous calls: the fake cannot outlive them, and no other code runs under it.
  const fileErr = withPlatformSync('win32', () => caught(() => ownerOnlyFile(file)));
  const dirErr = withPlatformSync('win32', () => caught(() => ownerOnlyDir(path.join(TMP, 'acl-refuse-dir'))));
  for (const err of [fileErr, dirErr]) {
    assert.ok(err instanceof OwnerOnlyError, `expected OwnerOnlyError, got ${err}`);
    // The path guard, not a failed spawn: no whoami or icacls was attempted.
    assert.match(err.message, /refusing to run icacls on an unexpected path/);
  }
  assert.equal(process.platform, REAL_PLATFORM, 'the platform was restored');
});

test('win32 contract (faked platform): reassertOwnerOnly warns on stderr and never throws', { skip: WIN32_FAILURE_PATH_SKIP }, () => {
  const file = path.join(TMP, 'acl-reassert.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  const lines = [];
  const realError = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    assert.doesNotThrow(() => withPlatformSync('win32', () => reassertOwnerOnly(file)));
  } finally {
    console.error = realError;
  }
  const warning = lines.join('\n');
  assert.match(warning, /warning: rewrote .*acl-reassert\.json but could NOT restrict it/);
  assert.match(warning, /not confirmed owner-only/);
  // The chmod half ran before the ACL half refused.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

// The capture policy (src/tools/session.ts restrictCapturedArtifact): when the
// owner-only step fails, the artifact is DELETED and the capture reports ok:false
// with "session not saved". Driven through a real sessionLogin, with the
// win32 branch forced for one synchronous stretch only:
//   fs.chmodSync(<artifact>)  — patched: does the real chmod, THEN fakes win32
//   ownerOnlyFile → restrictAclToOwner → path guard throws OwnerOnlyError
//   fs.rmSync(<artifact>)     — patched: restores the platform, THEN deletes
// Nothing between those two calls awaits, so no Playwright code (which reads
// process.platform at call time for its own launch and close paths) ever runs
// under the fake. Faking the platform around the whole sessionLogin would be
// unsound for exactly that reason. The counters prove the window opened and
// closed once, where claimed.
test('capture fails LOUD when the owner-only step fails: artifact deleted, ok:false, "session not saved"', { skip: WIN32_FAILURE_PATH_SKIP }, async () => {
  const name = 'aclfail';
  const artifact = path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, `${name}.json`);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { chmodSync, rmSync } = fs;
  let opened = 0;
  let closed = 0;
  fs.chmodSync = function (p, ...rest) {
    const out = chmodSync.call(this, p, ...rest);
    if (path.resolve(String(p)) === artifact) {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      opened++;
    }
    return out;
  };
  fs.rmSync = function (p, ...rest) {
    if (opened > closed && path.resolve(String(p)) === artifact) {
      Object.defineProperty(process, 'platform', platform);
      closed++;
    }
    return rmSync.call(this, p, ...rest);
  };
  let r;
  try {
    r = await sessionLogin({
      name,
      loginUrl: `${base}/login`,
      successSignal: 'h1',
      credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
    });
  } finally {
    fs.chmodSync = chmodSync;
    fs.rmSync = rmSync;
    Object.defineProperty(process, 'platform', platform);
  }

  assert.equal(opened, 1, 'the win32 branch was forced exactly once, on the artifact');
  assert.equal(closed, 1, 'the fake closed at the artifact delete, before any await');
  assert.equal(r.ok, false, 'a capture that could not be restricted is not a success');
  assert.match(r.error ?? '', /^session not saved — the captured file could not be restricted to your account/);
  assert.match(r.error ?? '', /refusing to run icacls/, 'the reason is the win32 owner-only step');
  assert.match(r.error ?? '', /so it was deleted rather than left readable by others/);
  assert.equal(fs.existsSync(artifact), false, 'the unrestricted artifact is gone');
  assert.ok(!JSON.stringify(r).includes('sid=ok'), 'no cookie token in the failure either');
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

test('session_login: auto-detects a SAME-ORIGIN SPA login whose URL never changes', async () => {
  // Regression for the iCloud class of app: the pathname stays /spa through sign-in,
  // so the URL-change heuristic (waitPastLogin's movedOff) can NEVER fire. Before the
  // fix this timed out even though login plainly succeeded. Completion must instead
  // come from the newly issued auth-named cookie, with NO successSignal supplied.
  const r = await sessionLogin({
    name: 'spa',
    loginUrl: `${base}/spa`,
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
    timeoutMs: 15_000,
  });
  assert.equal(r.ok, true, r.error ?? 'SPA login auto-detected via the auth-cookie signal');
  assert.ok(fs.existsSync(r.path), 'storageState written');
  assert.match(fs.readFileSync(r.path, 'utf8'), /X-APPLE-WEBAUTH-TOKEN/, 'the auth cookie was captured');
});

// Regression for the iCloud premature-capture failure: the sign-in handshake set an
// auth-named cookie that tripped completion and was then cleared before the save, so an
// unauthenticated session was written and reported ok:true. The durability probe must
// require the auth cookie to persist CONTINUOUSLY past the settle window, and a cookie
// that flaps (disappears and returns, as a cleared handshake cookie does) restarts the
// clock. Driven with an injected time source so it is fully deterministic (no browser).
test('makeAuthCookieProbe: an auth cookie completes only after CONTINUOUS presence past the settle window', async () => {
  const SETTLE = 4000; // AUTH_COOKIE_SETTLE_MS
  let t = 0;
  let jar = [];
  const probe = makeAuthCookieProbe(
    async () => jar,
    { cookies: [] },
    'https://app.example.com/login',
    () => t,
  );
  const auth = [{ domain: 'app.example.com', name: 'X-APPLE-WEBAUTH-TOKEN' }];

  assert.equal(await probe(), false, 'no cookie yet');

  jar = auth; // appears at t=0
  assert.equal(await probe(), false, 'just appeared — not yet durable');
  t = SETTLE - 1;
  assert.equal(await probe(), false, 'still inside the settle window');
  t = SETTLE;
  assert.equal(await probe(), true, 'continuous presence past the window completes');

  jar = []; // the handshake clears it
  assert.equal(await probe(), false, 'gone → not complete, clock reset');
  jar = auth;
  t = SETTLE + 1; // reappears — the clock must restart, not resume
  assert.equal(await probe(), false, 'reappeared — a fresh window has not yet elapsed');
  t = 2 * SETTLE + 1;
  assert.equal(await probe(), true, 'durable again after a full fresh window');

  jar = [{ domain: 'app.example.com', name: '_ga' }]; // an infra cookie never qualifies
  t = 10 * SETTLE;
  assert.equal(await probe(), false, 'a non-auth cookie never completes');
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

// Regression: attach-mode LOGIN carried the same defect the headed path had.
// challengeCleared() already refuses a blank title and pins to the target host;
// the login predicate did neither, so an app URL redirecting to an IdP looked
// like a completed login on the very first poll.
test('makeAttachLoginCheck: an SSO redirect is the START of a login, not the end', () => {
  const done = makeAttachLoginCheck();

  // Chrome opened; the document has not rendered — never judge a blank title.
  assert.equal(done({ url: 'https://apps.docusign.com/send', title: '' }), false);

  // First real page latches as the baseline (this IS the login page).
  assert.equal(
    done({ url: 'https://account.docusign.com/oauth/auth?x=1', title: 'Docusign Login' }),
    false,
    'the login page itself is never "done"',
  );

  // Walking to the email step on the same host: new path, but still logging in.
  // (leftLoginPage treats a path change as done, so this documents the residual
  // limit — the cookie gate in the export path is what backstops it.)
  const emailStep = done({ url: 'https://account.docusign.com/username', title: 'Docusign Login' });
  assert.equal(typeof emailStep, 'boolean');

  // A fresh capture must not inherit the previous one's baseline.
  const done2 = makeAttachLoginCheck();
  assert.equal(done2({ url: 'https://account.docusign.com/oauth/auth', title: 'Login' }), false);
  assert.equal(done2({ url: 'https://apps.docusign.com/send', title: 'Docusign' }), true, 'landed on the app');

  // A wall still up is never done, even off the login page.
  const done3 = makeAttachLoginCheck();
  done3({ url: 'https://signin.example.com/', title: 'Login' });
  assert.equal(done3({ url: 'https://app.example.com/home', title: 'Just a moment...' }), false);
});

// The cookie gate the makeAttachLoginCheck test above refers to as its backstop.
// A same-origin SPA / multi-step / SSO login can finish without the URL ever
// leaving the login page; a new AUTH cookie is what proves it happened.
test('gainedAuthCookie: auth-named completes at once, plain new cookie only after settle, infra never', () => {
  const set = (a) => new Set(a);
  const base = set(['x.test|ASP.NET_SessionId', 'x.test|srv_id', 'x.test|_mkto_trk']);

  // A strong auth-named cookie counts the instant it appears (settled irrelevant).
  assert.equal(gainedAuthCookie(base, set([...base, 'x.test|AuthToken']), false), 'AuthToken');
  assert.equal(gainedAuthCookie(base, set([...base, 'x.test|.AspNet.Cookies']), false), '.AspNet.Cookies');

  // Pure infra/marketing new cookies never count, even settled.
  assert.equal(gainedAuthCookie(base, set([...base, 'x.test|_mkto_trk2', 'x.test|__cfruid']), true), null);

  // A non-infra, non-auth-named opaque cookie counts ONLY once past the settle window.
  assert.equal(gainedAuthCookie(base, set([...base, 'x.test|opaque42']), false), null, 'pre-settle: wait');
  assert.equal(gainedAuthCookie(base, set([...base, 'x.test|opaque42']), true), 'opaque42', 'post-settle: accept');

  // Nothing gained → null.
  assert.equal(gainedAuthCookie(base, base, true), null);

  // Name classifiers: ASP.NET_SessionId is pre-login, never the auth ticket.
  assert.equal(isAuthCookieName('ASP.NET_SessionId'), false);
  assert.equal(isAuthCookieName('AuthToken'), true);
  assert.equal(isAuthCookieName('.AspNet.Cookies'), true);
  assert.equal(isAuthCookieName('.ASPXAUTH'), true);
  assert.equal(isInfraCookieName('_mkto_trk'), true);
  assert.equal(isInfraCookieName('__cfruid'), true);
  assert.equal(isInfraCookieName('AuthToken'), false);

  // Sign-in FLOW cookies the login page sets before anyone types (measured on
  // chatgpt.com 2026-09-14): the attach capture completed on page load because
  // `__Host-next-auth.csrf-token` matched both the `auth` and `token` arms. They are
  // never login proof — not at once, and not as the post-settle fallback either.
  const cg = set(['chatgpt.com|oai-did']);
  for (const flow of ['__Host-next-auth.csrf-token', '__Secure-next-auth.callback-url', 'XSRF-TOKEN', 'g_state', 'oauth_nonce']) {
    assert.equal(isAuthCookieName(flow), false, `${flow} is not an auth cookie`);
    assert.equal(gainedAuthCookie(cg, set([...cg, `chatgpt.com|${flow}`]), true), null, `${flow} never completes a login`);
  }
  // The real next-auth session ticket still completes at once.
  assert.equal(isAuthCookieName('__Secure-next-auth.session-token'), true);
  assert.equal(
    gainedAuthCookie(cg, set([...cg, 'chatgpt.com|__Host-next-auth.csrf-token', 'chatgpt.com|__Secure-next-auth.session-token']), false),
    '__Secure-next-auth.session-token',
  );
});

// attach must never hold a CDP connection while the human signs in (measured on
// chatgpt.com 2026-09-14: a held connection broke auth.openai.com's password step).
// The gate that decides when a brief read is allowed.
test('attachCookieReadDecision: no CDP read on a wall, off-site, or with no site page', async () => {
  const { attachCookieReadDecision } = await import('../dist/tools/session.js');
  const onSite = (h) => h === 'chatgpt.com' || h.endsWith('.chatgpt.com');
  const login = { type: 'page', url: 'https://chatgpt.com/auth/login', title: 'Get started | ChatGPT' };
  const key = `${login.url}|${login.title}`;

  // No rendered login-site page (the tab navigated to the identity provider) → blocked.
  assert.equal(attachCookieReadDecision([{ type: 'page', url: 'https://auth.openai.com/log-in', title: 'Log in' }], onSite, '', key, 99_999), 'blocked');
  // A site page exists but another tab is on the identity provider → blocked.
  assert.equal(attachCookieReadDecision([login, { type: 'page', url: 'https://auth.openai.com/log-in/password', title: 'Enter your password - OpenAI' }], onSite, key, '', 99_999), 'blocked');
  // Any tab on a bot wall → blocked.
  assert.equal(attachCookieReadDecision([{ ...login, title: 'Just a moment...' }], onSite, key, '', 99_999), 'blocked');
  // Non-http targets (new tab page, devtools) do not count as off-site.
  assert.equal(attachCookieReadDecision([login, { type: 'page', url: 'chrome://newtab/', title: 'New Tab' }], onSite, key, '', 0), 'read');
  // Safe: read on change, reuse while unchanged, re-read once stale.
  assert.equal(attachCookieReadDecision([login], onSite, key, '', 0), 'read');
  assert.equal(attachCookieReadDecision([login], onSite, key, key, 1000), 'reuse');
  assert.equal(attachCookieReadDecision([login], onSite, key, key, 5000), 'read');
});

// Measured on chatgpt.com 2026-09-14: past the 15s settle window, pre-login cookies
// (`oai-asli`, `precise_location_permission`) appeared on the still-logged-out login
// page and the un-gated fallback saved a logged-out session. A weak signal now needs
// the URL to have left the login page; only a strong auth cookie completes alone.
test('attachLoginDone: weak cookie signals need the URL to leave the login page', async () => {
  const { attachLoginDone } = await import('../dist/tools/session.js');
  const s = (a) => new Set(a);
  const base = s(['chatgpt.com|oai-did', 'chatgpt.com|__Host-next-auth.csrf-token']);
  const baseV = s(['chatgpt.com|oai-did|1']);
  const preLogin = s([...base, 'chatgpt.com|oai-asli', 'chatgpt.com|precise_location_permission']);
  const preLoginV = s([...baseV, 'chatgpt.com|oai-asli|x', 'chatgpt.com|precise_location_permission|denied']);

  // The chatgpt.com failure: settled, new opaque cookies, still ON the login page → not done.
  assert.equal(attachLoginDone(base, preLogin, baseV, preLoginV, false, true), false);
  // Same cookies once the human is back on chatgpt.com past the login page → done.
  assert.equal(attachLoginDone(base, preLogin, baseV, preLoginV, true, true), true);
  // The real session ticket completes at once, URL unmoved (same-origin SPA case).
  const authed = s([...base, 'chatgpt.com|__Secure-next-auth.session-token']);
  assert.equal(attachLoginDone(base, authed, baseV, baseV, false, false), true);
  // URL left but nothing changed (an email step before any cookie) → not done.
  assert.equal(attachLoginDone(base, base, baseV, baseV, true, true), false);
});

// Measured on Chrome 153, 2026-09-14: `--remote-debugging-port=0` makes every page
// report navigator.webdriver=true (a fixed port reports false), and chatgpt.com's
// sign-in failed with "Route Error (400 Invalid content type: text/html)" in the
// supposedly plain attach window. The launch must never use port 0.
test('attachChromeArgs: attach never launches Chrome with debugging port 0', async () => {
  const { attachChromeArgs } = await import('../dist/tools/session.js');
  const args = attachChromeArgs('/tmp/pwmcp-attach-x', 40123, 'https://chatgpt.com/auth/login');
  assert.ok(args.includes('--remote-debugging-port=40123'));
  assert.ok(!args.includes('--remote-debugging-port=0'));
  assert.equal(args.at(-1), 'https://chatgpt.com/auth/login');
  assert.throws(() => attachChromeArgs('/tmp/pwmcp-attach-x', 0, 'https://x.test/'), /port 0/);
});

// Both capture modes write the same kind of artifact to the same store, so both
// must leave browser_* able to use it. A cleared wall the interactive tools
// cannot see is as useless as a login they cannot see. Assert the two handlers
// share ONE bind path rather than each carrying their own copy to drift.
test('session_login and session_solve_challenge share one bind path', async () => {
  const src = fs.readFileSync(new URL('../src/tools/session.ts', import.meta.url), 'utf8');

  const loginTail = src.slice(src.indexOf('async function loginHandler'));
  const challengeTail = src.slice(src.indexOf('async function solveChallengeHandler'));
  assert.match(loginTail.slice(0, 1200), /return bindAndReport\(/, 'login binds via the shared helper');
  assert.match(challengeTail.slice(0, 1200), /return bindAndReport\(/, 'challenge binds via the shared helper');

  // Exactly one implementation of the bind, so the modes cannot diverge.
  const impls = src.match(/async function bindAndReport\(/g) ?? [];
  assert.equal(impls.length, 1, 'exactly one bindAndReport implementation');

  // ...and it is the ONLY place bindSession is called from the tool handlers,
  // aside from session_attach's own explicit re-bind.
  const callers = src.match(/await bindSession\(/g) ?? [];
  assert.ok(callers.length <= 2, `bindSession called from ${callers.length} sites; expected <= 2`);
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
  // Live-path guard: a real probeUrl must NOT take the offline branch.
  assert.equal(s.check, undefined);
  assert.equal(s.artifact, undefined);
});

test('session_status: missing when no file exists', async () => {
  const s = await sessionStatus({ name: 'nope', probeUrl: `${base}/app` });
  assert.equal(s.state, 'missing');
  assert.equal(s.check, undefined);
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

// ── session_status OFFLINE artifact verdict (no browser, no network) ──────────
// The name-only call answers "do I already have access?" from the stored file
// alone, so a headless agent stops proposing a headed login for access it has.

const HOUR = 3600;
const SOON = Math.floor(Date.now() / 1000) + HOUR; // Unix SECONDS, as storageState records it

function writeArtifact(name, state) {
  const file = path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}

writeArtifact('offline-ok', {
  cookies: [
    { name: 'sid', value: 'TOP-SECRET-COOKIE-VALUE', domain: '.app.example.com', path: '/', expires: SOON + HOUR },
    { name: 'csrf', value: 'ANOTHER-SECRET', domain: 'example.com', path: '/', expires: SOON },
  ],
  origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'tok', value: 'SECRET-LOCALSTORAGE' }] }],
});

test('session_status offline: reports present, covered domains, earliest expiry', async () => {
  const s = await sessionStatus({ name: 'offline-ok' });
  assert.equal(s.state, 'present'); // never 'fresh' — only a live probe can know that
  assert.equal(s.check, 'artifact');
  assert.deepEqual(s.artifact.domains, ['example.com']);
  assert.deepEqual(s.artifact.origins, ['https://app.example.com']);
  assert.equal(s.artifact.cookieCount, 2);
  assert.equal(s.artifact.sessionCookies, 0);
  assert.equal(s.artifact.expiresAt, new Date(SOON * 1000).toISOString()); // earliest, not latest
  assert.equal(s.artifact.expired, false);
});

test('session_status offline: missing artifact is a clean verdict, not a throw', async () => {
  const s = await sessionStatus({ name: 'no-such-session-anywhere' });
  assert.equal(s.state, 'missing');
  assert.equal(s.check, 'artifact');
  assert.equal(s.artifact, undefined);
});

test('session_status offline: corrupt artifact reads stale (recapture), echoes nothing', async () => {
  fs.writeFileSync(path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, 'offline-corrupt.json'), '{ not json');
  const s = await sessionStatus({ name: 'offline-corrupt' });
  assert.equal(s.state, 'stale');
  assert.equal(s.check, 'artifact');
  assert.ok(!JSON.stringify(s).includes('not json'));
});

test('session_status offline: coverage matches the artifact domains (sessionAllowsUrl semantics)', async () => {
  const { sessionAllowsUrl } = await import('../dist/exfil.js');
  const state = JSON.parse(
    fs.readFileSync(path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, 'offline-ok.json'), 'utf8'),
  );
  const s = await sessionStatus({ name: 'offline-ok' });
  // Covered: the artifact's own registrable domain, including a subdomain of it.
  assert.ok(s.artifact.domains.includes('example.com'));
  assert.equal(sessionAllowsUrl(state, 'https://app.example.com/x'), true);
  // NOT covered: an unrelated host must be absent from the listing and refused.
  assert.ok(!s.artifact.domains.includes('evil.test'));
  assert.equal(sessionAllowsUrl(state, 'https://evil.test/x'), false);
});

test('session_status offline: a session cookie reports "no fixed expiry", never -1', async () => {
  writeArtifact('offline-sessioncookie', {
    cookies: [{ name: 'sid', value: 'V', domain: 'sessiononly.test', path: '/', expires: -1 }],
    origins: [],
  });
  const s = await sessionStatus({ name: 'offline-sessioncookie' });
  assert.equal(s.state, 'present');
  assert.equal(s.artifact.expiresAt, null); // NOT 1969 — -1 is "dies with the browser"
  assert.equal(s.artifact.sessionCookies, 1);
  assert.equal(s.artifact.expired, false);
  assert.match(s.artifact.expiryNote, /no fixed expiry/);
  assert.ok(!JSON.stringify(s.artifact).includes('-1')); // the raw sentinel never surfaces
});

test('session_status offline: an already-past expiry is flagged advisory, not "stale"', async () => {
  writeArtifact('offline-expired', {
    cookies: [{ name: 'sid', value: 'V', domain: 'old.test', path: '/', expires: 1_000_000 }],
    origins: [],
  });
  const s = await sessionStatus({ name: 'offline-expired' });
  // 'stale' is the live vocabulary for "the server rejected it"; offline we only
  // have capture-time metadata, and the keepalive rolls expiry forward server-side.
  assert.equal(s.state, 'present');
  assert.equal(s.artifact.expired, true);
});

test('session_status offline: no cookie or localStorage VALUE appears in the verdict', async () => {
  const s = await sessionStatus({ name: 'offline-ok' });
  const dumped = JSON.stringify(s);
  assert.ok(!dumped.includes('TOP-SECRET-COOKIE-VALUE'));
  assert.ok(!dumped.includes('ANOTHER-SECRET'));
  assert.ok(!dumped.includes('SECRET-LOCALSTORAGE'));
  assert.ok(!dumped.includes('"value"'));
});

test('session_status offline: does NOT write the artifact back (no keepalive path)', async () => {
  const file = path.join(process.env.PLAYWRIGHT_MCP_SESSIONS, 'offline-ok.json');
  const before = fs.readFileSync(file);
  await sessionStatus({ name: 'offline-ok' });
  assert.deepEqual(fs.readFileSync(file), before); // byte-identical: the live keepalive never ran
});

test('session_status handler: name-only, blank and whitespace probeUrl all go offline', async () => {
  const { callCustomTool } = await import('../dist/tools.js');
  for (const args of [
    { name: 'offline-ok' },
    { name: 'offline-ok', probeUrl: '' },
    { name: 'offline-ok', probeUrl: '   ' },
  ]) {
    const res = await callCustomTool('session_status', args);
    const verdict = JSON.parse(res.content[0].text);
    assert.equal(verdict.check, 'artifact', `expected offline branch for ${JSON.stringify(args)}`);
    assert.equal(verdict.state, 'present');
  }
});

test('session_status handler: a real probeUrl still takes the live branch', async () => {
  const { callCustomTool } = await import('../dist/tools.js');
  const res = await callCustomTool('session_status', { name: 'demo', probeUrl: `${base}/app`, loginIndicator: '/login' });
  const verdict = JSON.parse(res.content[0].text);
  assert.equal(verdict.check, undefined); // no offline marker ⇒ the probe ran
  assert.equal(verdict.state, 'fresh');
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

// ── the human wait: no deadline, and what ends it instead ─────────────────────
// A human login has no honest duration (password only, password + TOTP, two SSO
// hops, a CAPTCHA mid-flow), so the 300s default was replaced rather than raised.
// Replaced, not merely lengthened, is what makes the END SIGNALS load-bearing:
// with no clock, a window that is gone and nothing noticing is a forever-hang.
// Everything below drives the injected seams — never a real timer.

test('resolveHumanWait: only the stdio surface gets an unbounded wait; an explicit timeoutMs still arms one', () => {
  // The tier rule. stdio is the LOCAL Claude Code process — a person is at this
  // display, so the window they opened is theirs to take as long as they need.
  assert.deepEqual(resolveHumanWait(undefined, 'stdio'), { deadline: 'none' });

  // The HTTP surfaces keep the cap: the headed window opens on the SERVER host, so
  // nobody is at that display and an unbounded wait is an unreclaimable browser.
  assert.equal(CAPPED_HUMAN_WAIT_MS, 300_000, 'the bounded default is unchanged where it still applies');
  for (const trust of ['local', 'cloud']) {
    assert.deepEqual(
      resolveHumanWait(undefined, trust),
      { deadline: 'capped', ms: 300_000 },
      `${trust} must keep the 300s cap`,
    );
  }

  // THE OPT-IN CAP. Without this half a build that ignored timeoutMs entirely would
  // pass the row above: the caller who asks for a deadline must still get a real one,
  // on stdio as much as anywhere.
  assert.deepEqual(resolveHumanWait(2500, 'stdio'), { deadline: 'capped', ms: 2500 });
  assert.deepEqual(resolveHumanWait(2500, 'local'), { deadline: 'capped', ms: 2500 });
  assert.deepEqual(resolveHumanWait(1, 'stdio'), { deadline: 'capped', ms: 1 });

  // Garbage asked for nothing, so the SURFACE decides — never Playwright's
  // "0 means forever", which would hand an unbounded wait to a capped surface.
  for (const junk of [0, -1, Number.NaN, Infinity, -Infinity]) {
    assert.deepEqual(resolveHumanWait(junk, 'local'), { deadline: 'capped', ms: 300_000 }, `local, timeoutMs=${junk}`);
    assert.deepEqual(resolveHumanWait(junk, 'stdio'), { deadline: 'none' }, `stdio, timeoutMs=${junk}`);
  }
});

test('makeWindowClosedWatch: a closed window cancels, but an SSO popup must NOT', async () => {
  // Injected schedule: the grace is asserted as a NUMBER handed to the scheduler,
  // never waited out. graceMs stays the shipped default so a change to it is visible.
  const pending = [];
  const schedule = (fn, ms) => pending.push({ fn, ms });
  const run = () => {
    const due = pending.splice(0, pending.length);
    for (const p of due) p.fn();
  };

  // 1. The human closed the last window. Nothing is left to log in with → cancel.
  let pages = 1;
  const gone = makeWindowClosedWatch({ pagesOpen: () => pages, connected: () => true }, { schedule, message: 'closed-x' });
  pages = 0;
  gone.pageClosed();
  assert.equal(pending.length, 1, 'the decision is deferred by the grace, not taken inline');
  assert.equal(pending[0].ms, 3000, 'WINDOW_CLOSE_GRACE_MS');
  assert.equal(gone.cancelled(), false, 'not cancelled until the grace elapses');
  run();
  assert.equal(gone.cancelled(), true);
  await assert.rejects(gone.promise, (err) => {
    assert.ok(err instanceof LoginCancelledError, `named error, got ${err?.name}`);
    assert.equal(err.name, 'LoginCancelledError');
    assert.equal(err.message, 'closed-x');
    return true;
  });

  // 2. THE CASE THIS FEATURE EXISTS FOR. An identity provider opens a popup and
  // closes the original tab: a page closed, but a page is still OPEN. Cancelling
  // here would break the very SSO logins the unbounded wait was added to rescue.
  const sso = makeWindowClosedWatch({ pagesOpen: () => 1, connected: () => true }, { schedule, message: 'closed-sso' });
  sso.pageClosed();
  run();
  assert.equal(sso.cancelled(), false, 'an SSO popup must survive the original tab closing');
  // ...and it keeps surviving: a second hop closes another tab, one still open.
  sso.pageClosed();
  run();
  assert.equal(sso.cancelled(), false, 'still logging in after a second hop');
  // Only when the last one goes does it end.
  let ssoPages = 0;
  const ssoEnd = makeWindowClosedWatch({ pagesOpen: () => ssoPages, connected: () => true }, { schedule, message: 'closed-sso' });
  ssoEnd.pageClosed();
  run();
  assert.equal(ssoEnd.cancelled(), true, 'the last page closing does cancel');

  // 3. A disconnected browser cancels even while it still reports pages: nothing
  //    can complete after that, so waiting on it is the forever-hang.
  const dead = makeWindowClosedWatch({ pagesOpen: () => 2, connected: () => false }, { schedule });
  dead.pageClosed();
  run();
  assert.equal(dead.cancelled(), true, 'a disconnected browser is gone whatever it reports');
  await assert.rejects(dead.promise, /login cancelled: the window was closed/);

  // 4. The browser itself went away — no re-ask, it cannot come back.
  const bye = makeWindowClosedWatch({ pagesOpen: () => 5, connected: () => true }, { schedule });
  bye.browserGone();
  run();
  assert.equal(bye.cancelled(), true);

  // 5. Fires once. Two closes must not produce a second rejection to go unhandled.
  const once = makeWindowClosedWatch({ pagesOpen: () => 0, connected: () => true }, { schedule });
  once.pageClosed();
  once.browserGone();
  run();
  assert.equal(once.cancelled(), true);
  await assert.rejects(once.promise, /login cancelled/);
});

test('makeEndpointWatch: Chrome having EXITED cancels; a transient devtools miss never does', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:40123'), { code: 'ECONNREFUSED' });
  const hangup = new Error('socket hang up');
  // What devtoolsJson actually throws on its own 4000ms read timeout, and what a
  // half-written /json/list body throws. Neither says the browser is gone: a busy
  // Chrome mid-navigation produces both, and treating them as gone would cancel a
  // LIVE login — with no deadline left, the wrong half of this split is fatal.
  const slow = new Error('devtools endpoint timeout');
  const garbage = new SyntaxError('Unexpected end of JSON input');
  assert.equal(devtoolsUnreachable(slow), false, 'a read timeout is a busy browser, not a dead one');
  assert.equal(devtoolsUnreachable(garbage), false, 'an unparseable body is not a dead browser');
  assert.equal(devtoolsUnreachable(refused), true);
  assert.equal(devtoolsUnreachable(hangup), true);

  // A transient miss, however often it repeats, never cancels — and it RESETS the
  // unreachable run, so alternating slow reads cannot accumulate into a cancel.
  const transient = makeEndpointWatch();
  for (let i = 0; i < 50; i += 1) {
    assert.equal(transient.failed(slow, false), false, `slow read #${i + 1} must not cancel`);
    assert.equal(transient.failed(garbage, false), false, `garbage read #${i + 1} must not cancel`);
  }
  assert.equal(transient.failed(refused, false), false, 'one refusal after a reset is still strike 1');

  // Unreachable reads need a RUN of DEVTOOLS_GONE_STRIKES: one refusal during
  // Chrome's own teardown of a tab is not proof.
  const flaky = makeEndpointWatch();
  assert.equal(flaky.failed(refused, false), false, 'strike 1');
  assert.equal(flaky.failed(refused, false), false, 'strike 2');
  assert.equal(flaky.failed(refused, false), true, 'strike 3 — gone on the endpoint\'s own evidence');

  // A success anywhere in the run clears it.
  const recovered = makeEndpointWatch();
  recovered.failed(refused, false);
  recovered.failed(refused, false);
  recovered.alive();
  assert.equal(recovered.failed(refused, false), false, 'the run restarted after a good read');
  assert.equal(recovered.failed(refused, false), false);
  assert.equal(recovered.failed(refused, false), true);

  // CHROME HAS EXITED: the child we spawned is gone AND the port refuses. One
  // strike is conclusive — this is what stops a closed window hanging forever.
  const exited = makeEndpointWatch();
  assert.equal(exited.failed(refused, true), true, 'exited child + refused port cancels at once');
  // But the ENDPOINT stays the authority: a launcher that execs and exits while the
  // browser lives on answers its reads, so a dead child alone is never a cancel.
  const wrapper = makeEndpointWatch();
  assert.equal(wrapper.failed(slow, true), false, 'a dead wrapper script with a live endpoint is not a cancel');
  assert.equal(wrapper.failed(garbage, true), false);

  // The other shape of gone: the endpoint answers while every window is closed.
  // A popup keeps the count >= 1, so it can never trip this.
  const windows = makeEndpointWatch();
  for (let i = 0; i < 40; i += 1) assert.equal(windows.targets(1), false, `one page open, poll ${i + 1}`);
  for (let i = 1; i <= 9; i += 1) assert.equal(windows.targets(0), false, `NO_TARGET_STRIKES not reached (${i})`);
  assert.equal(windows.targets(0), true, 'ten windowless polls — nothing left to log in with');
  // A single page reappearing resets it (an SSO popup arriving late).
  const late = makeEndpointWatch();
  for (let i = 0; i < 9; i += 1) late.targets(0);
  assert.equal(late.targets(1), false, 'a page came back');
  for (let i = 0; i < 9; i += 1) assert.equal(late.targets(0), false, `count restarted (${i + 1})`);
});

// ── attach mode end to end, against a fake DevTools endpoint ──────────────────
// attach mode's human wait speaks to the browser through /json/version and
// /json/list ONLY (passively — attaching mid-solve is what makes a managed
// challenge loop), so scripts/fixtures/fake-chrome.mjs is a faithful stand-in
// for the whole wait. It exercises the real handler, the real cancel/timeout
// decisions, the real capture registry and the real artifact path — with no
// browser, no display and no wall-clock guess. POSIX only: the spawn goes
// through the fixture's shebang.
const FAKE_CHROME = fileURLToPath(new URL('./fixtures/fake-chrome.mjs', import.meta.url));
const FAKE_LOGIN_URL = 'https://app.fake.test/login';

async function withFakeChrome(mode, fn) {
  const prevPath = process.env.PLAYWRIGHT_MCP_CHROME_PATH;
  const prevMode = process.env.PWMCP_FAKE_CHROME_MODE;
  process.env.PLAYWRIGHT_MCP_CHROME_PATH = FAKE_CHROME;
  process.env.PWMCP_FAKE_CHROME_MODE = mode;
  try {
    return await fn();
  } finally {
    if (prevPath === undefined) delete process.env.PLAYWRIGHT_MCP_CHROME_PATH;
    else process.env.PLAYWRIGHT_MCP_CHROME_PATH = prevPath;
    if (prevMode === undefined) delete process.env.PWMCP_FAKE_CHROME_MODE;
    else process.env.PWMCP_FAKE_CHROME_MODE = prevMode;
  }
}

/** The tool result's JSON envelope (bindAndReport writes exactly one text block). */
const envelopeOf = (res) => JSON.parse(res.content[0].text.split('\n<untrusted')[0]);

const skipOnWin32 = IS_WIN32 ? 'POSIX only: win32 cannot exec the fixture\'s shebang' : false;

test(
  'attach + stdio: an UNBOUNDED wait still ends when the window is gone — cancelled, nothing saved, recoverable via session_status',
  { skip: skipOnWin32 },
  async () => {
    // trust:'stdio' with no timeoutMs is the unbounded wait. If the end signals did
    // not work this call could never return, so the test finishing at all is half the
    // assertion; the other half is that it ends as a CANCEL and leaves no artifact.
    const name = 'attach-cancelled';
    const file = sessionFilePath(name);
    await withFakeChrome('die', async () => {
      const pending = sessionLoginTool.handler(
        { name, loginUrl: FAKE_LOGIN_URL, attach: true },
        { trust: 'stdio' },
      );

      // The recovery path, observed IN FLIGHT: beginCapture runs before the first
      // await, so an agent whose call was cut short can poll session_status right
      // now and be told a login is still under way rather than that it failed.
      const inFlight = await sessionStatus({ name });
      assert.equal(inFlight.state, 'missing', 'nothing on disk yet — that is what an in-flight capture looks like');
      assert.equal(inFlight.capture?.state, 'waiting');
      assert.equal(inFlight.capture?.mode, 'attach');
      assert.equal(inFlight.capture?.endedAt, undefined, 'a waiting record has no end time');
      assert.match(inFlight.capture?.note ?? '', /IN PROGRESS/, 'and it says so in the server\'s own words');
      assert.match(inFlight.capture?.note ?? '', /never tell the user it failed/);

      const env = envelopeOf(await pending);
      assert.equal(env.ok, false);
      assert.equal(env.cancelled, true, 'a closed window is a CANCEL, not a timeout');
      assert.equal(env.mode, 'attach');
      assert.match(env.error, /^login cancelled: the Chrome window was closed/);
      assert.match(env.error, /waits as long as you need/, 'the remedy, not a shorter clock');
    });

    assert.equal(fs.existsSync(file), false, 'a cancelled capture must leave NO artifact behind');

    // ...and the record now says so, for the agent that comes back to poll.
    const after = await sessionStatus({ name });
    assert.equal(after.state, 'missing');
    assert.equal(after.capture?.state, 'cancelled');
    assert.ok(after.capture?.endedAt, 'a closed record carries an end time');
    assert.match(after.capture?.note ?? '', /closed the window before the login finished/);
    assert.equal(after.capture?.savedTo, undefined, 'nothing was saved, so nothing is claimed');
  },
);

test(
  'attach + stdio: an EXPLICIT timeoutMs still arms a real deadline, and ends as a timeout — not a cancel',
  { skip: skipOnWin32 },
  async () => {
    // The discriminating half of the tier rule at the handler boundary: a build that
    // dropped timeoutMs and always waited unbounded would hang here forever, and a
    // build that mistook a live-but-unfinished login for a closed window would report
    // `cancelled`. Neither is what the caller asked for.
    const name = 'attach-opt-in-cap';
    const started = Date.now();
    await withFakeChrome('alive', async () => {
      const env = envelopeOf(
        await sessionLoginTool.handler(
          { name, loginUrl: FAKE_LOGIN_URL, attach: true, timeoutMs: 3000 },
          { trust: 'stdio' },
        ),
      );
      assert.equal(env.ok, false);
      assert.notEqual(env.cancelled, true, 'a live endpoint with a page open was never cancelled');
      assert.match(env.error, /was not completed before the timeout/);
    });
    assert.ok(Date.now() - started < 120_000, 'the opt-in cap bounded the wait');
    assert.equal(fs.existsSync(sessionFilePath(name)), false, 'a timed-out capture saves nothing either');
    assert.equal(captureProgress(name)?.state, 'failed', 'a timeout is a failure, not a cancel');
  },
);

test(
  'attach: an SSO popup that closes the original tab must NOT cancel the login',
  { skip: skipOnWin32 },
  async () => {
    // THE CASE THIS WHOLE ORDER EXISTS FOR, on the attach path. The identity provider
    // pops a consent window and closes the tab Chrome was launched with. A page is
    // still open, so the human is still logging in — a cancel here would break exactly
    // the long SSO logins the unbounded wait was added to rescue. It must run to the
    // caller's own deadline instead, and say so.
    const name = 'attach-sso-popup';
    await withFakeChrome('popup', async () => {
      const env = envelopeOf(
        await sessionLoginTool.handler(
          { name, loginUrl: FAKE_LOGIN_URL, attach: true, timeoutMs: 4000 },
          { trust: 'stdio' },
        ),
      );
      assert.notEqual(env.cancelled, true, 'the original tab closing is not an abandoned login');
      assert.doesNotMatch(env.error ?? '', /cancelled/, 'never a cancel while a page is open');
      assert.match(env.error ?? '', /was not completed before the timeout/);
    });
  },
);

test(
  'runCapture: a throw BEFORE the engine\'s own try never strands the record at "waiting"',
  { skip: skipOnWin32 },
  async () => {
    // The few lines that run before sessionAttach's try (resolveAttachProfile ->
    // mkdtempSync) can throw, and a stranded 'waiting' record would tell every later
    // session_status "a capture is IN PROGRESS, never tell the user it failed" for the
    // life of the process. An unwritable temp dir is the cheapest way to make that
    // throw happen for real. os.tmpdir() reads these at call time.
    const name = 'attach-early-throw';
    const bogus = path.join(TMP, 'no-such-tmpdir', 'deeper');
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    await withFakeChrome('die', async () => {
      process.env.TMPDIR = bogus;
      process.env.TEMP = bogus;
      process.env.TMP = bogus;
      try {
        await assert.rejects(
          sessionLoginTool.handler({ name, loginUrl: FAKE_LOGIN_URL, attach: true }, { trust: 'stdio' }),
          /ENOENT|no such file/i,
          'the throw propagates untouched',
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
    const rec = captureProgress(name);
    assert.equal(rec?.state, 'failed', 'the record must never be left claiming a login is under way');
    assert.ok(rec?.endedAt, 'and it is closed, with an end time');
    assert.match(rec?.note ?? '', /the capture failed/);
    assert.doesNotMatch(rec?.note ?? '', /IN PROGRESS/);
  },
);

/** Everything the module logged while `fn` ran. `log` is console.error (session.ts:54). */
async function captureLog(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.error = real;
  }
  return lines.join('\n');
}

test(
  'the tier rule reaches the HANDLER: the same call is unbounded on stdio and capped on an HTTP surface',
  { skip: skipOnWin32 },
  async () => {
    // resolveHumanWait being right is worth nothing if the handler does not hand it
    // the surface. Only the tool handler knows the surface, so this is where the
    // feature is either live or dead — and `ctx.trust` is the server's own value,
    // never a tool argument, so a caller cannot ask for the unbounded wait.
    //
    // The budget itself has no exported getter; sessionAttach announces it
    // (session.ts:1451, `if (w.wait.deadline === 'none')`), so the log line is the
    // observable. 'die' mode makes BOTH surfaces finish in about a second — the
    // capped one never reaches its 300s deadline, it is cancelled long before.
    await withFakeChrome('die', async () => {
      const onStdio = await captureLog(() =>
        sessionLoginTool.handler(
          { name: 'tier-stdio', loginUrl: FAKE_LOGIN_URL, attach: true },
          { trust: 'stdio' },
        ),
      );
      assert.match(onStdio, /no time limit/, 'stdio: a person is at this display — no deadline');

      for (const trust of ['local', 'cloud']) {
        const onHttp = await captureLog(() =>
          sessionLoginTool.handler(
            { name: `tier-${trust}`, loginUrl: FAKE_LOGIN_URL, attach: true },
            { trust },
          ),
        );
        assert.doesNotMatch(onHttp, /no time limit/, `${trust}: the window opens on the SERVER host — still capped`);
      }

      // An unknown surface is an HTTP surface as far as this is concerned: the
      // fail-closed `?? 'local'` must never resolve to the permissive tier.
      const noCtx = await captureLog(() =>
        sessionLoginTool.handler({ name: 'tier-noctx', loginUrl: FAKE_LOGIN_URL, attach: true }),
      );
      assert.doesNotMatch(noCtx, /no time limit/, 'no surface at all must not grant an unbounded wait');
    });
  },
);

test('headless credKeys: the 30s default is unchanged and cannot be reached by an unbounded budget', async () => {
  // There is no human on the credential path, so a clock is the right instrument
  // there and 30s is still the default. The load-bearing half is that the headed
  // rule cannot LEAK onto it: the headless arm builds its own capped budget and
  // ignores `wait` entirely, so even an explicitly unbounded budget stays bounded.
  const started = Date.now();
  const r = await sessionLogin({
    name: 'headless-stays-capped',
    loginUrl: `${base}/login`,
    successSignal: 'nonexistent-marker',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_BADPASS' },
    wait: { deadline: 'none' }, // what a stdio human capture would have been handed
    timeoutMs: 2500,
  });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 25_000, 'the headless arm ignored the unbounded budget');
  assert.notEqual(r.cancelled, true, 'no window-close machinery is wired on the credential path');
  assert.match(r.error ?? '', /timed out|login form/, 'still the bounded diagnostic');

  // The default itself, and the wiring, read from the source: the headless arm has
  // no exported seam, and a structural read is how this file already guards drift.
  const src = fs.readFileSync(new URL('../src/tools/session.ts', import.meta.url), 'utf8');
  const headlessDefaults = src.match(/opts\.timeoutMs \?\? 30_000/g) ?? [];
  assert.equal(headlessDefaults.length, 1, 'exactly one 30s credential default, still 30_000');
  // ...and it is NOT resolveHumanWait: the surface rule must stay unreachable from here.
  const headlessArm = src.slice(src.indexOf('const sel = { ...DEFAULT_SELECTORS'), src.indexOf('// The wait heuristics can resolve'));
  assert.doesNotMatch(headlessArm, /resolveHumanWait/, 'the credential path never consults the surface');
  assert.match(headlessArm, /deadline: 'capped'/, 'and it builds a capped budget of its own');
});

test('DRIFT GUARD: the unbounded wait is granted by the SURFACE only, and fails closed', () => {
  // Two ways this feature turns into a vulnerability by accident: a handler that
  // defaults an unknown surface to 'stdio' (permissive), or a second hard-coded
  // 300_000 that quietly re-imposes the deadline the tier rule removed.
  const src = fs.readFileSync(new URL('../src/tools/session.ts', import.meta.url), 'utf8');

  const humanHandlers = ['async function loginHandler', 'async function solveChallengeHandler'];
  for (const marker of humanHandlers) {
    const body = src.slice(src.indexOf(marker), src.indexOf(marker) + 1500);
    assert.match(body, /resolveHumanWait\([^)]*ctx\?\.trust \?\? 'local'\)/, `${marker} must fail closed to 'local'`);
    assert.doesNotMatch(body, /\?\? 'stdio'/, `${marker} must never default to the permissive tier`);
  }

  // The tier rule is the ONLY place the human budget is decided.
  assert.equal((src.match(/\?\? 300_000|\?\? 300000/g) ?? []).length, 0, 'no hard-coded human deadline survives');
  assert.equal(
    (src.match(/CAPPED_HUMAN_WAIT_MS = 300_000/g) ?? []).length,
    1,
    'one named constant, read only by resolveHumanWait',
  );

  // The HEADED engine consuming that budget. Unreachable behaviourally (a headed
  // window needs a display the gate has not got), so the wiring is pinned here:
  // the branch must take the resolved budget AND arm the end signal, because with
  // no deadline the watch is the only thing that can end the wait.
  const headedArm = src.slice(src.indexOf('if (opts.headed) {'), src.indexOf('const sel = { ...DEFAULT_SELECTORS'));
  assert.match(headedArm, /opts\.wait \?\? resolveHumanWait\(opts\.timeoutMs, 'local'\)/, 'headed takes the resolved budget, capped for a direct caller');
  assert.match(headedArm, /watchDrivenWindow\(/, 'and arms the window-close end signal');
  assert.match(headedArm, /waitForLogin\(page, loginUrl, opts\.successSignal, wait, authGained, cancel\)/, 'the wait is raced against the cancel');

  // Every attach poll loop counts PAGE targets only. Counting devtools/webview/
  // service-worker targets as pages would make a windowless Chrome look alive;
  // counting a popup as not-a-page would cancel an SSO login mid-flow.
  for (const marker of ['async function pollAttached(', 'async function pollAttachedLogin(']) {
    const body = src.slice(src.indexOf(marker), src.indexOf(marker) + 2600);
    assert.match(body, /p\.type === 'page'/, `${marker} must filter page targets`);
    assert.match(body, /endpoint\.targets\(/, `${marker} must consult the shared endpoint watch`);
  }
});

test(
  'session_solve_challenge: a closed window cancels the SOLVE too, with its own wording and no artifact',
  { skip: skipOnWin32 },
  async () => {
    // The third human path. It is a thin front door over the SAME attach engine, so
    // the end signals are shared by construction — but the tool the user actually
    // calls has to say the right thing, and it must not leave a half-cleared
    // artifact behind any more than a login does.
    const name = 'challenge-cancelled';
    await withFakeChrome('die', async () => {
      const env = envelopeOf(
        await sessionSolveChallengeTool.handler({ name, url: FAKE_LOGIN_URL }, { trust: 'stdio' }),
      );
      assert.equal(env.ok, false);
      assert.equal(env.cancelled, true);
      assert.equal(env.mode, 'challenge', 'reported as a challenge, not a login');
      assert.match(env.error, /^challenge cancelled: the Chrome window was closed/);
      assert.match(env.error, /stay on the page until the tool reports the session saved/);
    });
    assert.equal(fs.existsSync(sessionFilePath(name)), false, 'nothing saved');
    const rec = captureProgress(name);
    assert.equal(rec?.state, 'cancelled');
    assert.equal(rec?.mode, 'challenge');
    assert.match(rec?.note ?? '', /Nothing was saved; start a new capture/);
  },
);

test('session_status reports a COMPLETED capture, so an abandoned call is still recoverable', async () => {
  // The other half of the recovery path: the capture outlives the call that started
  // it, so an agent whose call was cut short must be able to learn it SUCCEEDED —
  // "poll session_status" is worthless if a finished capture leaves no record.
  const name = 'capture-saved';
  const res = await sessionLoginTool.handler({
    name,
    loginUrl: `${base}/login`,
    successSignal: 'h1',
    credKeys: { user: 'DEMO_USER', pass: 'DEMO_PASS' },
  });
  const env = envelopeOf(res);
  assert.equal(env.ok, true, env.error ?? 'login ok');

  const status = await sessionStatus({ name });
  assert.equal(status.capture?.state, 'saved');
  assert.equal(status.capture?.savedTo, sessionFilePath(name), 'the record names the artifact on disk');
  assert.ok(status.capture?.cookiesGained > 0, 'and how much it got');
  assert.ok(status.capture?.endedAt, 'closed, with an end time');
  assert.match(status.capture?.note ?? '', /COMPLETED and the session was saved, even if the tool call/);
  assert.doesNotMatch(status.capture?.note ?? '', /IN PROGRESS/);
  assert.ok(fs.existsSync(status.capture.savedTo), 'the claim is true');

  // Server-authored values only — session_status is exempt from the untrusted-content
  // marking, so a capture record must never carry page text or the caller's own URL.
  const blob = JSON.stringify(status.capture);
  assert.ok(!blob.includes(base), 'no caller URL in the record');
  assert.ok(!blob.includes('secret'), 'no credential value in the record');
});
