#!/usr/bin/env node
// T1 acceptance — browser ownership, idle close, shutdown and the reaper
// (src/lifetime.ts).
//
// Regression cover for 2026-11-24 ~11:06: playwright-mcp servers left four
// headless Chromes running (45 processes, 4.4 GB RSS, the machine 11 GB into
// swap), three of them idle for 11+ hours. Nothing closed an idle browser, and a
// server outlived its client: stdin EOF was ignored and SIGHUP only closed
// Playwright's browsers. The user: "this should never happen again".
//
// Two tiers, like the rest of the gate:
//   - browser-free: the reaper's decision over fake process tables, the idle sweep
//     over a fake clock, the queue's busy rule, the cap, the registry file, and a
//     drift check that every launch site in src/ registers what it launches;
//   - PLAYWRIGHT_MCP_TEST_BROWSER=1: real servers (dist/index.js) with real Chrome,
//     one per path that must end a browser: idle timeout, stdin EOF, SIGTERM,
//     SIGHUP, the client dying, and the reaper on a dead owner's entry. Each one
//     asserts that NO process is left with that browser's --user-data-dir.
//
// SAFETY: every server here runs on a private XDG_CACHE_HOME and browser_* root,
// so its registry and profiles are its own. Its reaper still scans the machine,
// and by planReap's rule it only ever kills an orphan or a dead owner's browser.
// Nothing here kills a process it did not start.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
const LINUX = process.platform === 'linux';
const DEAD_PID = 2147483646;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-own-'));
process.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY = path.join(scratch, 'registry');
process.env.PLAYWRIGHT_MCP_BROWSER_IDLE_MS = '1000';
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const lifetime = await import('../dist/lifetime.js');
const { BrowserQueue } = await import('../dist/queue.js');
const {
  planReap,
  sweepIdle,
  trackBrowser,
  trackedBrowsers,
  chromeRootDir,
  startLifetime,
  readRegistries,
} = lifetime;

// ── the reaper's decision, on a fake machine ─────────────────────────────────

const UID = 1000;
const CACHE = '/home/u/.cache/playwright-mcp';
const PATTERNS = [
  new RegExp(`^${CACHE}/profile(-\\d+)?$`),
  new RegExp(`^${CACHE}/read-profiles/[^/]+$`),
  /^\/home\/u\/\.cache\/ms-playwright\/mcp-chrom(e|ium)-[0-9a-f]{7}(-\d+)?$/,
  /^\/tmp\/(playwright_chromiumdev_profile-[^/]+|pwmcp-(fetch|browser)-[^/]+)$/,
];
const proc = (pid, ppid, { start = 100, comm = 'chrome', dir, uid = UID, helper = false } = {}) => ({
  pid,
  ppid,
  pgid: pid,
  start,
  uid,
  comm,
  argv: dir === undefined ? [comm] : helper ? [`/opt/chrome --type=renderer --user-data-dir=${dir}`] : ['/opt/chrome', '--headless', `--user-data-dir=${dir}`],
});
const machine = (...procs) => new Map(procs.map((p) => [p.pid, p]));
const fileFor = (serverPid, start, browsers) => ({
  file: `/reg/${serverPid}.json`,
  data: { format: 1, server: { pid: serverPid, start, startedAt: '' }, client: { pid: 1 }, browsers },
});
const plan = (table, regs = []) => planReap(table, regs, { uid: UID, selfPid: 999_999, patterns: PATTERNS, platform: 'linux' });
const SYSTEMD = proc(1110, 1, { comm: 'systemd' });

test('reaper: a registered browser whose server is dead is killed, and the file goes', () => {
  const chrome = proc(500, 1110, { dir: `${CACHE}/profile` });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'web_fetch', pid: 500, start: 100, userDataDir: `${CACHE}/profile` }]);
  const p = plan(machine(SYSTEMD, chrome), [reg]);
  assert.deepEqual(p.kill.map((k) => k.pid), [500]);
  assert.deepEqual(p.staleFiles, ['/reg/400.json']);
});

test('reaper: a live server\'s browsers are never touched, orphaned-looking or not', () => {
  const server = proc(400, 1, { start: 7, comm: 'node' }); // reparented itself; still alive
  const chrome = proc(500, 1110, { dir: `${CACHE}/profile` });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'web_fetch', pid: 500, start: 100, userDataDir: `${CACHE}/profile` }]);
  const p = plan(machine(SYSTEMD, server, chrome), [reg]);
  assert.deepEqual(p.kill, []);
  assert.deepEqual(p.staleFiles, []);
});

test('reaper: a reused SERVER pid counts as dead; a reused CHROME pid is not the browser', () => {
  const impostor = proc(400, 1, { start: 99, comm: 'bash' }); // same pid, different start
  const chrome = proc(500, 1110, { dir: `${CACHE}/profile` });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'web_fetch', pid: 500, start: 100, userDataDir: `${CACHE}/profile` }]);
  assert.deepEqual(plan(machine(SYSTEMD, impostor, chrome), [reg]).kill.map((k) => k.pid), [500]);

  // Under a live launcher, so the unregistered-orphan rule stays out of it.
  const launcher = proc(300, 1110, { comm: 'node', dir: undefined });
  const reusedChrome = proc(500, 300, { start: 555, dir: `${CACHE}/profile` });
  assert.deepEqual(plan(machine(SYSTEMD, launcher, reusedChrome), [reg]).kill, [], 'pid 500 is now somebody else');
});

test('reaper: a dead owner\'s entry whose pid is now on another profile is left alone', () => {
  const chrome = proc(500, 1110, { dir: '/home/u/.config/google-chrome' });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'web_fetch', pid: 500, start: 100, userDataDir: `${CACHE}/profile` }]);
  assert.deepEqual(plan(machine(SYSTEMD, chrome), [reg]).kill, []);
});

test('reaper: an UNREGISTERED Chrome is killed only when orphaned AND on a playwright-mcp profile', () => {
  const node = proc(300, 1110, { comm: 'node', dir: undefined });
  const cases = [
    [proc(501, 1, { dir: `${CACHE}/profile-3` }), true, 'reparented to init'],
    [proc(502, 1110, { dir: '/tmp/playwright_chromiumdev_profile-AbC' }), true, 'reparented to systemd --user'],
    [proc(503, 1110, { dir: `${CACHE}/read-profiles/ebay` }), true, 'a read profile'],
    [proc(504, 1110, { dir: '/home/u/.cache/ms-playwright/mcp-chrome-9e38592' }), true, 'the browser_* slot 1'],
    [proc(505, 300, { dir: '/tmp/playwright_chromiumdev_profile-XyZ' }), false, 'its launcher is alive (could be the user\'s own test run)'],
    [proc(506, 300, { dir: `${CACHE}/profile` }), false, 'a live (older) server still owns it'],
    [proc(507, 1110, { dir: `${CACHE}/login-profiles/ebay` }), false, 'the human\'s login profile'],
    [proc(508, 1110, { dir: '/home/u/.config/google-chrome' }), false, 'the user\'s own Chrome'],
    [proc(509, 1110, { dir: `${CACHE}/profile`, uid: 1001 }), false, 'another user\'s process'],
    [proc(510, 1110, { dir: `${CACHE}/profile`, helper: true }), false, 'a helper, not a root: the group kill covers it'],
    [proc(511, 1110, { dir: `${CACHE}/profile-evil/x` }), false, 'pattern is anchored'],
  ];
  const p = plan(machine(SYSTEMD, node, ...cases.map(([c]) => c)));
  for (const [c, killed, why] of cases)
    assert.equal(p.kill.some((k) => k.pid === c.pid), killed, `${c.argv.join(' ')}: ${why}`);
});

test('reaper: an orphan a LIVE server lists is that server\'s, not the reaper\'s', () => {
  const server = proc(400, 1, { start: 7, comm: 'node' });
  const chrome = proc(500, 1, { dir: `${CACHE}/profile` });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'web_fetch', pid: 500, start: 100 }]);
  assert.deepEqual(plan(machine(server, chrome), [reg]).kill, []);
});

test('reaper: a capture on the user\'s REAL profile is never reaped, even when its server died', () => {
  const chrome = proc(500, 1110, { dir: '/home/u/.config/google-chrome' });
  const reg = fileFor(400, 7, [{ id: 'a', kind: 'capture', pid: 500, start: 100, userDataDir: '/home/u/.config/google-chrome', reapable: false }]);
  assert.deepEqual(plan(machine(SYSTEMD, chrome), [reg]).kill, []);
});

test('reaper: a Chrome this server launched is never planned, even orphan-shaped', () => {
  const chrome = proc(500, 999_999, { dir: `${CACHE}/profile` });
  assert.deepEqual(plan(machine(chrome)).kill, []);
});

// ── macOS and Windows, from documented-format fixtures ──────────────────────────
//
// Only Linux can run here, so the other two platforms are covered through the
// parser seam (src/proctable.ts) with output in the documented formats of
// `ps -A -o pid= -o ppid= … -o command=` and the CIM query, written by hand.
// They are NOT captures from a real Mac or Windows machine; the ps argv and parser
// are additionally run against this host's own ps below.

const proctable = await import('../dist/proctable.js');
const { parsePs, parseCim } = proctable;
const { buildPatterns, isOrphaned, normDir } = lifetime;
const FIX = path.join(ROOT, 'scripts/fixtures/proctable');

test('ps: the exact argv, run against this host\'s own ps, parses and finds this process', { skip: !['linux', 'darwin'].includes(process.platform) && 'no ps' }, () => {
  const { PS_ARGS } = proctable;
  const out = execFileSync('ps', PS_ARGS, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const me = parsePs(out).get(process.pid);
  assert.ok(me, 'this process is in the table');
  assert.equal(me.ppid, process.ppid);
  assert.ok(Math.abs(me.start - Date.now()) < 24 * 3600_000, 'lstart parsed to a plausible time');
  assert.match(me.command, /test-browser-ownership|--test/);
});

test('snapshot: a table that does not list this process is refused, so it cannot make every server look dead', async () => {
  const { snapshot } = proctable;
  const snap = await snapshot();
  if (process.platform === 'linux') assert.equal(snap.ok, true);
  assert.equal(parsePs('garbage\n').has(process.pid), false);
});

test('macOS: ps output parses into the table, rss in bytes, lstart as a time', () => {
  const t = parsePs(fs.readFileSync(path.join(FIX, 'ps-darwin.txt'), 'utf8'));
  assert.equal(t.size, 9);
  const root = t.get(701);
  assert.deepEqual([root.ppid, root.pgid, root.uid, root.rss], [700, 701, 501, 210004 * 1024]);
  assert.equal(new Date(root.start).getMinutes(), 16);
  assert.equal(chromeRootDir(root), '/Users/fm/.cache/playwright-mcp/profile');
  assert.equal(chromeRootDir(t.get(702)), undefined, 'a helper (--type) is not a root');
  assert.equal(chromeRootDir(t.get(900)), undefined, 'the user\'s own Chrome has no --user-data-dir');
});

test('macOS: the reaper takes only the launchd orphan on a playwright-mcp profile, of this user', () => {
  const t = parsePs(fs.readFileSync(path.join(FIX, 'ps-darwin.txt'), 'utf8'));
  const patterns = buildPatterns(
    { cache: '/Users/fm/.cache/playwright-mcp', readProfiles: '/Users/fm/.cache/playwright-mcp/read-profiles', msp: '/Users/fm/Library/Caches/ms-playwright', tmp: '/var/folders/x1/abc/T' },
    'darwin',
  );
  const p = planReap(t, [], { uid: 501, selfPid: 123, patterns, platform: 'darwin' });
  assert.deepEqual(p.kill.map((k) => k.pid), [801], 'reparented to launchd; 701 has a live server; 950 is another uid');
  assert.equal(isOrphaned(t.get(701), t, 'darwin'), false);
});

test('Windows: CIM JSON parses, quoted and unquoted --user-data-dir both read, one object or many', () => {
  const t = parseCim(fs.readFileSync(path.join(FIX, 'cim-win32.json'), 'utf8'));
  assert.equal(t.size, 10);
  assert.equal(chromeRootDir(t.get(5200)), 'C:\\Users\\Fm\\.cache\\playwright-mcp\\profile');
  assert.equal(chromeRootDir(t.get(6000)), 'C:\\Users\\Fm Meetze\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-AbCdEf', 'whole arg quoted');
  assert.equal(chromeRootDir(t.get(6100)), 'C:\\Users\\Fm\\AppData\\Local\\ms-playwright\\mcp-chrome-9e38592', 'value quoted');
  assert.equal(chromeRootDir(t.get(5210)), undefined, 'renderer');
  assert.equal(t.get(5200).pgid, 5200, 'no process groups on Windows');
  const one = parseCim('{"ProcessId":7,"ParentProcessId":1,"CommandLine":null,"WorkingSetSize":1,"CreationDate":"/Date(1763888400000)/"}');
  assert.equal(one.get(7).start, 1763888400000, 'a single object, and the /Date()/ shape');
});

test('Windows: no reparenting, so an orphan is a missing parent or a parent created later (pid reuse)', () => {
  const t = parseCim(fs.readFileSync(path.join(FIX, 'cim-win32.json'), 'utf8'));
  const patterns = buildPatterns(
    {
      cache: 'C:\\Users\\Fm\\.cache\\playwright-mcp',
      readProfiles: 'C:\\Users\\Fm\\.cache\\playwright-mcp\\read-profiles',
      msp: 'C:\\Users\\fm\\AppData\\Local\\ms-playwright', // a different case than Chrome got: NTFS does not care
      tmp: 'C:\\Users\\Fm Meetze\\AppData\\Local\\Temp',
    },
    'win32',
  );
  const p = planReap(t, [], { uid: undefined, selfPid: 1, patterns, platform: 'win32' });
  assert.deepEqual(
    p.kill.map((k) => k.pid).sort(),
    [6000, 6100],
    '6000: parent gone; 6100: its parent pid now belongs to a newer notepad. 5200/6200: live server. 6300: the user\'s own Chrome',
  );
  assert.equal(normDir('C:\\Users\\Fm\\X\\', 'win32'), 'c:/users/fm/x');
});

test('Windows: a dead owner\'s registered browser matches its dir regardless of slash and case', () => {
  const t = parseCim(fs.readFileSync(path.join(FIX, 'cim-win32.json'), 'utf8'));
  const reg = fileFor(5120, 1, [{ id: 'a', kind: 'web_fetch', pid: 5200, start: 1763975800000, userDataDir: 'c:/users/fm/.cache/playwright-mcp/PROFILE' }]);
  const p = planReap(t, [reg], { selfPid: 1, patterns: [], platform: 'win32' });
  assert.deepEqual(p.kill.map((k) => k.pid), [5200], 'server 5120 has a different start time: it is not the owner any more');
});

// ── idle close, holds, busy, the capture rule ────────────────────────────────

function fakeBrowser(opts) {
  const closes = [];
  let handle;
  handle = trackBrowser({
    kind: 'web_fetch',
    idleClose: true,
    ...opts,
    close: async () => {
      closes.push(Date.now());
      handle.done();
    },
  });
  return { handle, closes };
}
const later = (ms) => Date.now() + ms;

test('idle: closed once idle for PLAYWRIGHT_MCP_BROWSER_IDLE_MS, not before', async () => {
  const { handle, closes } = fakeBrowser();
  try {
    assert.equal(await sweepIdle(later(500)), 0);
    assert.equal(closes.length, 0);
    assert.equal(await sweepIdle(later(1_500)), 1);
    assert.equal(closes.length, 1);
    assert.ok(!trackedBrowsers().some((b) => b.id === handle.id), 'closed means untracked');
  } finally {
    handle.done();
  }
});

test('idle: a held browser is never closed; the clock starts again at release', async () => {
  const { handle, closes } = fakeBrowser();
  try {
    const release = handle.hold();
    assert.equal(await sweepIdle(later(60_000)), 0, 'held for a minute of fake time');
    release();
    assert.equal(await sweepIdle(later(500)), 0, 'released just now');
    assert.equal(await sweepIdle(later(1_500)), 1);
    assert.equal(closes.length, 1);
  } finally {
    handle.done();
  }
});

test('idle: a lease on the browser_* queue blocks the close; idle time runs from when it ends', async () => {
  const queue = new BrowserQueue({ idleMs: 90_000, maxLeaseMs: 600_000, maxWaitMs: 600_000 });
  const { handle, closes } = fakeBrowser({ kind: 'browser_*', busy: () => !queue.isIdle() });
  try {
    const { lease } = await queue.acquire({ holder: 'test' });
    assert.equal(queue.isIdle(), false);
    const t0 = Date.now();
    assert.equal(await sweepIdle(t0 + 30_000), 0, 'lease held');
    queue.release(lease);
    assert.equal(queue.isIdle(), true);
    assert.equal(await sweepIdle(t0 + 30_500), 0, 'lease ended half a second ago');
    assert.equal(await sweepIdle(t0 + 31_500), 1, 'a full idle period after the lease');
    assert.equal(closes.length, 1);
  } finally {
    handle.done();
  }
});

test('idle: a running queued call blocks the close too', async () => {
  const queue = new BrowserQueue({ idleMs: 90_000, maxLeaseMs: 600_000, maxWaitMs: 600_000 });
  const { handle } = fakeBrowser({ kind: 'browser_*', busy: () => !queue.isIdle() });
  try {
    let finish;
    const running = queue.run(() => new Promise((r) => (finish = r)), { label: 'browser_wait_for' });
    assert.equal(await sweepIdle(later(60_000)), 0);
    finish();
    await running;
  } finally {
    handle.done();
  }
});

test('idle: a capture or solve window is NEVER idle-closed: a human is in it, with no time limit', async () => {
  const captures = ['capture', 'solve'].map((kind) => fakeBrowser({ kind, idleClose: false }));
  try {
    assert.equal(await sweepIdle(later(24 * 3600_000)), 0, 'a day of fake time');
    for (const c of captures) assert.equal(c.closes.length, 0);
  } finally {
    for (const c of captures) c.handle.done();
  }
});

test('cap: past PLAYWRIGHT_MCP_MAX_BROWSERS a launch closes the least recently used idle browser', async () => {
  process.env.PLAYWRIGHT_MCP_MAX_BROWSERS = '2';
  const made = [];
  try {
    made.push(fakeBrowser({ kind: 'web_fetch' }));
    await new Promise((r) => setTimeout(r, 5));
    made.push(fakeBrowser({ kind: 'browser_*' }));
    made[1].handle.touch();
    const held = made[1].handle.hold();
    made.push(fakeBrowser({ kind: 'read-profile', idleClose: false }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(made[0].closes.length, 0, 'used moments ago: an unleased caller between two calls keeps its browser');
    await lifetime.makeRoom(made[2].handle.id, Date.now() + 120_000); // two minutes on
    assert.equal(made[0].closes.length, 1, 'the oldest idle one went');
    assert.equal(made[1].closes.length, 0, 'the one in use stayed');
    assert.equal(made[2].closes.length, 0, 'the new one stayed');
    held();
  } finally {
    delete process.env.PLAYWRIGHT_MCP_MAX_BROWSERS;
    for (const m of made) m.handle.done();
  }
});

// 2026-11-25: web_fetch's bot-wall window now waits up to 4 hours for a human who is
// away. Registered as session.ts registers it (no idleClose given), it must never be
// idle-closed or picked to make room, however long it sits.
test('a bot-wall solve window, registered with the defaults, is never idle-closed or made room for', async () => {
  process.env.PLAYWRIGHT_MCP_MAX_BROWSERS = '1';
  const solve = fakeBrowser({ kind: 'solve', idleClose: undefined, session: 'wall-gs1uk.test' });
  const other = fakeBrowser({ kind: 'read-profile', idleClose: false });
  try {
    assert.equal(trackedBrowsers().find((b) => b.id === solve.handle.id).idleClose, false);
    assert.equal(await sweepIdle(later(5 * 3600_000)), 0, 'five hours of fake time');
    await lifetime.makeRoom(other.handle.id, later(5 * 3600_000));
    assert.equal(solve.closes.length, 0);
  } finally {
    delete process.env.PLAYWRIGHT_MCP_MAX_BROWSERS;
    solve.handle.done();
    other.handle.done();
  }
});

test('--browsers lists a waiting bot-wall window by host', () => {
  const row = { serverPid: 10, serverAlive: true, kind: 'solve', pid: 11, alive: true, session: 'wall-gs1uk.test', ageSec: 600 };
  const out = lifetime.formatStatus([row, { ...row, kind: 'capture', session: 'ebay', pid: 12 }]);
  assert.match(out, /Bot walls waiting for you to solve:\n  gs1uk\.test  open 10m \(server 10\)/);
  assert.doesNotMatch(out, /^  ebay/m, 'a login capture is not a bot wall');
  assert.doesNotMatch(lifetime.formatStatus([{ ...row, alive: false }]), /Bot walls/, 'a window already gone');
});

// ── the registry file ────────────────────────────────────────────────────────

test('registry: one owner-only file per server, written atomically, listing its browsers and client', { skip: process.platform === 'win32' && 'POSIX modes' }, () => {
  startLifetime({ version: 'test', reap: false });
  const { handle } = fakeBrowser({ kind: 'movie', idleClose: false, userDataDir: '/nowhere/x' });
  try {
    const dir = process.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY;
    const file = path.join(dir, `${process.pid}.json`);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left behind');
    const mine = readRegistries().find((r) => r.data.server.pid === process.pid).data;
    assert.equal(mine.client.pid, process.ppid);
    assert.equal(mine.server.version, 'test');
    assert.deepEqual(mine.browsers.map((b) => [b.kind, b.userDataDir]), [['movie', '/nowhere/x']]);
    handle.done();
    assert.equal(readRegistries().find((r) => r.data.server.pid === process.pid).data.browsers.length, 0);
  } finally {
    handle.done();
  }
});

test('chromeRootDir: a root carries the dir; a helper (one rewritten cmdline with --type) does not', () => {
  assert.equal(chromeRootDir(proc(1, 0, { dir: '/x/y' })), '/x/y');
  assert.equal(chromeRootDir(proc(1, 0, { dir: '/x/y', helper: true })), undefined);
  assert.equal(chromeRootDir(proc(1, 0, { comm: 'node' })), undefined);
});

// Every browser launched in src/ must be registered, or it is invisible to idle
// close, shutdown, status and the reaper: the incident again. A new launch site
// changes these counts and fails here until it calls trackBrowser.
test('drift: every launch site in src/ registers what it launches', () => {
  const EXPECTED = {
    'src/browser.ts': 2, // launchStealthProfile (tracked by launch() and openSessionContext), the ephemeral read
    'src/upstream.ts': 2, // persistent + bound browser_*, tracked in browserOwner's getContext
    'src/movie.ts': 1,
    'src/tools/session.ts': 2, // the driven capture and the attach Chrome spawn
  };
  const found = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (rel.endsWith('.ts')) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n'); // not the prose
        const n = (code.match(/chromium\.launch(PersistentContext)?\(|spawn\(chromePath/g) ?? []).length;
        if (n) {
          found[rel] = n;
          assert.match(src, /trackBrowser\(/, `${rel} launches a browser but never calls trackBrowser`);
        }
      }
    }
  };
  walk('src');
  assert.deepEqual(found, EXPECTED);
});

// ── real servers, real Chrome (opt-in) ───────────────────────────────────────

const E2E_SKIP = !BROWSER_TESTS ? 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)' : !LINUX && 'reads /proc';

/** Every process on the machine whose command line carries this exact user-data-dir. */
function processesOn(dir) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      const flag = `--user-data-dir=${dir}`;
      const i = cmd.indexOf(flag);
      if (i >= 0 && /^($|[\0 ])/.test(cmd.slice(i + flag.length))) out.push(Number(name));
    } catch {
      /* gone */
    }
  }
  return out;
}

async function waitFor(pred, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out after ${ms}ms waiting for ${what}`);
}

/** A local fixture: an article, and a page that prints the cookies it was sent. */
let fixture;
after(() => fixture?.close());
async function fixtureUrl(p) {
  if (!fixture) {
    fixture = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      // In the title: browser_navigate reports it inline (the snapshot goes to a file).
      if (req.url.startsWith('/echo')) res.end(`<title>cookie=[${req.headers.cookie ?? ''}]</title><p>echo</p>`);
      else res.end(`<html><head><title>Owned</title></head><body><article><h1>Owned</h1>${'<p>Browser lifetime fixture text. '.repeat(40)}</p></article></body></html>`);
    });
    await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  }
  return `http://127.0.0.1:${fixture.address().port}${p}`;
}

let serverN = 0;
/** A private world for one server: its own cache (registry, web_fetch profile), browser_* root and sessions. */
function world() {
  const dir = path.join(scratch, `w${++serverN}`);
  for (const d of ['cache', 'msp', 'sessions']) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  return {
    dir,
    env: {
      XDG_CACHE_HOME: path.join(dir, 'cache'),
      PWMCP_PROFILES_DIR_FOR_TEST: path.join(dir, 'msp'),
      PLAYWRIGHT_MCP_SESSIONS: path.join(dir, 'sessions'),
      PLAYWRIGHT_MCP_BROWSER_REGISTRY: path.join(dir, 'cache', 'playwright-mcp', 'browsers'),
      PLAYWRIGHT_MCP_BROWSER_IDLE_MS: '600000',
      PLAYWRIGHT_MCP_PARENT_POLL_MS: '500',
    },
  };
}

/** A JSON-RPC driver over raw stdio, so the test controls stdin's end itself. */
function rpc(write, onLine) {
  let id = 0;
  const waiting = new Map();
  onLine((line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return {
    async init() {
      await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ownership-test', version: '0' } });
      write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async call(name, args = {}) {
      const r = await send('tools/call', { name, arguments: args });
      const text = (r.result?.content ?? []).map((c) => c.text ?? '').join('\n');
      return { text, isError: r.result?.isError === true || r.error !== undefined };
    },
  };
}

function startServer(w, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/index.js')], {
    cwd: w.dir, // upstream writes its snapshot files under the cwd
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...w.env, ...extraEnv },
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  let buf = '';
  const listeners = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const l of listeners) l(line);
    }
  });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return { child, exited, stderr: () => err, ...rpc((s) => child.stdin.write(s), (l) => listeners.push(l)) };
}

/** This server's registry entries, as it wrote them. */
function entriesOf(w, pid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(w.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY, `${pid}.json`), 'utf8')).browsers;
  } catch {
    return [];
  }
}

/** Launch web_fetch's shared profile and the browser_* browser; return their user-data-dirs. */
async function launchBoth(s, w) {
  const url = await fixtureUrl('/article');
  const fetched = await s.call('web_fetch', { url });
  assert.ok(!fetched.isError && /fixture text/.test(fetched.text), `web_fetch read the fixture: ${fetched.text.slice(0, 300)}`);
  const nav = await s.call('browser_navigate', { url });
  assert.ok(!nav.isError, `browser_navigate: ${nav.text.slice(0, 300)}`);
  let dirs = [];
  await waitFor(() => {
    dirs = entriesOf(w, s.child.pid).map((b) => b.userDataDir).filter(Boolean);
    return dirs.length >= 2;
  }, 5_000, 'both browsers in the registry');
  for (const d of dirs) assert.ok(processesOn(d).length > 0, `a Chrome is running on ${d}`);
  return dirs;
}

async function assertAllGone(dirs, ms = 10_000) {
  await waitFor(() => dirs.every((d) => processesOn(d).length === 0), ms, `no process left on ${dirs.join(', ')}`);
}

for (const [label, end] of [
  ['stdin EOF (the client closed the pipe)', (s) => s.child.stdin.end()],
  ['SIGTERM', (s) => s.child.kill('SIGTERM')],
  ['SIGHUP (Playwright\'s own handler used to swallow it)', (s) => s.child.kill('SIGHUP')],
]) {
  test(`shutdown on ${label}: the server exits and no Chrome is left on its profiles`, { skip: E2E_SKIP, timeout: 90_000 }, async () => {
    const w = world();
    const s = startServer(w);
    await s.init();
    const dirs = await launchBoth(s, w);
    end(s);
    const { code } = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r({ code: 'hung' }), 12_000))]);
    assert.equal(code, 0, `exited cleanly; stderr:\n${s.stderr().slice(-2000)}`);
    await assertAllGone(dirs);
    assert.ok(!fs.existsSync(path.join(w.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY, `${s.child.pid}.json`)), 'its registry file is gone');
  });
}

test('shutdown when the client process is SIGKILLed: the parent poll notices, stdin still open', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  // The client is a wrapper that starts the server on a FIFO it does not own the
  // only end of: the server holds it read-write, so stdin never reaches EOF and
  // only the parent poll can see the wrapper go.
  const fifo = path.join(w.dir, 'in.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const out = path.join(w.dir, 'out.log');
  fs.writeFileSync(out, '');
  const wrapper = path.join(w.dir, 'client.mjs');
  fs.writeFileSync(
    wrapper,
    `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const [fifo, out, entry] = process.argv.slice(2);
const c = spawn(process.execPath, [entry], { stdio: [fs.openSync(fifo, fs.constants.O_RDWR), fs.openSync(out, 'a'), 'ignore'], env: process.env });
process.stdout.write(String(c.pid) + '\\n');
setInterval(() => {}, 1 << 30);`,
  );
  const client = spawn(process.execPath, [wrapper, fifo, out, path.join(ROOT, 'dist/index.js')], {
    cwd: w.dir,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...w.env },
  });
  after(() => client.kill('SIGKILL'));
  const serverPid = Number(await new Promise((r) => client.stdout.once('data', (d) => r(String(d).trim()))));
  after(() => {
    try {
      process.kill(serverPid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  const fd = fs.openSync(fifo, fs.constants.O_RDWR);
  after(() => fs.closeSync(fd));
  let seen = 0;
  const lines = [];
  const poll = setInterval(() => {
    const text = fs.readFileSync(out, 'utf8');
    const fresh = text.slice(seen);
    const cut = fresh.lastIndexOf('\n');
    if (cut < 0) return;
    seen += cut + 1;
    for (const l of fresh.slice(0, cut).split('\n')) for (const fn of lines) fn(l);
  }, 50);
  after(() => clearInterval(poll));
  const s = { child: { pid: serverPid }, ...rpc((m) => fs.writeSync(fd, m), (fn) => lines.push(fn)) };
  await s.init();
  const dirs = await launchBoth(s, w);
  client.kill('SIGKILL');
  await waitFor(() => {
    try {
      process.kill(serverPid, 0);
      return false;
    } catch {
      return true;
    }
  }, 10_000, 'the orphaned server to exit');
  await assertAllGone(dirs);
});

test('idle: both browsers close after the idle time and relaunch on the next call', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  const s = startServer(w, { PLAYWRIGHT_MCP_BROWSER_IDLE_MS: '1500' });
  try {
    await s.init();
    const dirs = await launchBoth(s, w);
    await assertAllGone(dirs, 8_000);
    // Chrome is gone a few ms before the server knows it: context.close() resolves
    // after the process exits, and only then does done() drop the entry (src/upstream.ts).
    await waitFor(() => entriesOf(w, s.child.pid).length === 0, 2_000, 'the registry to list nothing once both are closed');
    // Transparent relaunch: the next call just works.
    const url = await fixtureUrl('/article');
    assert.ok(/fixture text/.test((await s.call('web_fetch', { url })).text), 'web_fetch relaunched');
    const nav = await s.call('browser_navigate', { url });
    assert.ok(!nav.isError && /Owned/.test(nav.text), `browser_* relaunched: ${nav.text.slice(0, 300)}`);
  } finally {
    s.child.kill('SIGTERM');
    await s.exited;
  }
});

test('idle: a held lease keeps the browser_* browser up; it closes once the lease is released', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  const s = startServer(w, { PLAYWRIGHT_MCP_BROWSER_IDLE_MS: '1500' });
  try {
    await s.init();
    const { lease } = JSON.parse((await s.call('browser_lease_acquire', { holder: 'idle-test' })).text);
    const nav = await s.call('browser_navigate', { url: await fixtureUrl('/article'), lease });
    assert.ok(!nav.isError, nav.text.slice(0, 300));
    let dir;
    await waitFor(() => (dir = entriesOf(w, s.child.pid).find((b) => b.kind === 'browser_*')?.userDataDir), 5_000, 'the browser_* entry');
    await new Promise((r) => setTimeout(r, 4_500)); // three idle periods with the lease held
    assert.ok(processesOn(dir).length > 0, 'still up under the lease');
    await s.call('browser_lease_release', { lease });
    await assertAllGone([dir], 8_000);
  } finally {
    s.child.kill('SIGTERM');
    await s.exited;
  }
});

test('idle: a session_attach binding survives an idle close; the relaunch carries the same session', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  fs.writeFileSync(
    path.join(w.env.PLAYWRIGHT_MCP_SESSIONS, 'own.json'),
    JSON.stringify({ cookies: [{ name: 'sid', value: 'kept-across-idle', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }),
    { mode: 0o600 },
  );
  const s = startServer(w, { PLAYWRIGHT_MCP_BROWSER_IDLE_MS: '1500' });
  try {
    await s.init();
    const bound = await s.call('session_attach', { name: 'own' });
    assert.ok(!bound.isError, bound.text);
    const url = await fixtureUrl('/echo');
    const first = await s.call('browser_navigate', { url });
    assert.match(first.text, /sid=kept-across-idle/, 'bound before the idle close');
    let dir;
    await waitFor(() => (dir = entriesOf(w, s.child.pid).find((b) => b.kind === 'browser_*')?.userDataDir), 5_000, 'the browser_* entry');
    assert.equal(entriesOf(w, s.child.pid).find((b) => b.kind === 'browser_*').session, 'own');
    await assertAllGone([dir], 8_000);
    const again = await s.call('browser_navigate', { url });
    assert.match(again.text, /sid=kept-across-idle/, 'the relaunched browser carries the attached session');
    assert.match(again.text, /authenticated as session "own"/, 'and the banner still says so');
  } finally {
    s.child.kill('SIGTERM');
    await s.exited;
  }
});

test('reaper: a server starting up kills the browser of a registry entry whose owner is dead', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  const { chromium } = await import('playwright');
  const { STEALTH_LAUNCH } = await import('../dist/stealth.js');
  // A Chrome this test owns, recorded as if a server that no longer exists had launched it.
  const browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
  try {
    const mine = [...lifetime.procTable().values()].filter((p) => p.ppid === process.pid && chromeRootDir(p));
    const root = mine.sort((a, b) => b.start - a.start)[0];
    assert.ok(root, 'found the test\'s own Chrome');
    const dir = chromeRootDir(root);
    const regDir = w.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY;
    fs.mkdirSync(regDir, { recursive: true, mode: 0o700 });
    const stale = path.join(regDir, `${DEAD_PID}.json`);
    fs.writeFileSync(
      stale,
      JSON.stringify({
        format: 1,
        server: { pid: DEAD_PID, start: 1, startedAt: new Date(0).toISOString() },
        client: { pid: DEAD_PID },
        browsers: [{ id: 'x', kind: 'web_fetch', pid: root.pid, start: root.start, userDataDir: dir, launchedAt: '', lastUsedAt: '', inUse: false, idleClose: true }],
      }),
    );
    const s = startServer(w);
    try {
      await s.init();
      await assertAllGone([dir], 10_000);
      await waitFor(() => !fs.existsSync(stale), 5_000, 'the dead server\'s file to be removed');
      assert.match(s.stderr(), new RegExp(`reaping Chrome pid ${root.pid}`), 'and the reap is logged');
    } finally {
      s.child.kill('SIGTERM');
      await s.exited;
    }
  } finally {
    await browser.close().catch(() => {});
  }
});

test('--browsers prints the machine\'s browsers without a client, and reaps nothing', { skip: E2E_SKIP, timeout: 90_000 }, async () => {
  const w = world();
  const s = startServer(w);
  try {
    await s.init();
    await s.call('web_fetch', { url: await fixtureUrl('/article') });
    let listing = '';
    await waitFor(() => {
      listing = execFileSync(process.execPath, [path.join(ROOT, 'dist/index.js'), '--browsers'], { env: { ...process.env, ...w.env }, encoding: 'utf8' });
      return listing.includes('web_fetch');
    }, 5_000, 'the listing to show web_fetch');
    assert.match(listing, new RegExp(`^${s.child.pid}\\s`, 'm'), 'owner server pid');
    assert.match(listing, /SERVER\s+CLIENT\s+KIND/);
    const status = JSON.parse((await s.call('browser_status')).text);
    const row = status.browsers.find((b) => b.kind === 'web_fetch' && b.serverPid === s.child.pid);
    assert.ok(row?.alive && row.serverAlive && row.rssBytes > 0, JSON.stringify(row));
    assert.equal(row.clientPid, process.pid, 'the client is this test process');
    assert.equal(row.clientName, 'ownership-test', 'named by initialize');
  } finally {
    s.child.kill('SIGTERM');
    await s.exited;
  }
});
