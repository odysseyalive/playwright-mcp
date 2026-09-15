#!/usr/bin/env node
// T1 acceptance — profile-POOL contention selection (src/browser.ts).
//
// Regression cover for the concurrency incident: two user-scoped instances
// sharing one persistent profile meant the second's launch was refused by
// chrome's LIVE SingletonLock, and every web_fetch on it read back `blocked`.
// launch() now walks a numbered pool (profile, profile-2 … profile-8), skipping
// slots a live chrome holds, clearing corpse locks, and falling back to a
// pid-keyed temp dir rather than ever hard-failing a fetch.
//
// DETERMINISM (principle 9): no real chromium, no network, no clock, no
// ordering dependence. `chromium.launchPersistentContext` is stubbed on the
// shared playwright object with an always-throwing recorder, so the dir the
// module SELECTED is observable directly and every launch fails identically.
// Liveness is proved with this test process's own pid — provably alive without
// spawning anything; deadness with 0x7ffffffe, above any real pid_max.
//
// The stub lives in its own file on purpose: test-browser-lifecycle.mjs's
// PLAYWRIGHT_MCP_TEST_BROWSER=1 tests need the REAL launcher, and node --test
// gives each file its own process.
//
// FIXTURE SAFETY: launch() reaps orphaned `pwmcp-fetch-<pid>` dirs out of
// os.tmpdir(). Fixtures here therefore use a DISTINCT prefix the reaper cannot
// match, and are removed in the after() hook.
//
// TWO LOCK DIALECTS. On POSIX chrome marks a profile with a SingletonLock
// symlink; on Windows it never creates one and instead holds `<profile>/lockfile`
// open with no write sharing (src/browser.ts lockfileState). isOccupied reads
// process.platform at CALL time and picks the dialect, so:
//   - the SingletonLock tests pin POSIX semantics. They skip, with the reason, on
//     win32 (where production no longer reads SingletonLock at all) and wherever
//     a symlink cannot be created;
//   - the `win32 branch` section below drives the SAME pool walk through the
//     lockfile dialect. On Linux it fakes process.platform around each call; on
//     Windows the fake is a no-op and it runs for real.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { getStealthContext, lockfileState } from '../dist/browser.js';
import { symlinkSkipReason, withPlatform } from './fixtures/platform.mjs';

/** Must match PROFILE_POOL_SIZE in src/browser.ts. */
const POOL_SIZE = 8;
/** Deliberately NOT `pwmcp-fetch-` — that prefix is the temp-profile reaper's. */
const FIXTURE_PREFIX = 'pwmcp-pool-';
const DEAD_PID = 2147483646;

/** Why a symlink fixture cannot be created in this process, or false. */
const NO_SYMLINKS = symlinkSkipReason();
/** Why a SingletonLock (POSIX-dialect) test cannot run here, or false. */
const POSIX_LOCK_SKIP =
  process.platform === 'win32'
    ? 'win32: isOccupied keys on chrome\'s exclusively held `lockfile` there, not on SingletonLock ' +
      '(Bug A, run org-20260915T190026Z). This test pins POSIX SingletonLock semantics; the win32 ' +
      'pool walk is covered by the "win32 branch" tests in this file.'
    : NO_SYMLINKS;

// ── the seam: an always-throwing launcher that records the dir it was given ──

const realLaunch = chromium.launchPersistentContext;
let attempts = [];
chromium.launchPersistentContext = async (dir) => {
  attempts.push(dir);
  // Never resolve. A success would memoize ctxPromise and silence later tests.
  throw new Error(`stubbed launch refused ${dir}`);
};

const savedCache = process.env.XDG_CACHE_HOME;
const savedOverride = process.env.PLAYWRIGHT_MCP_PROFILE_DIR;
const fixtures = [];
/** File descriptors held open to fake a live win32 lockfile; closed before cleanup. */
const heldFds = [];

after(() => {
  for (const fd of heldFds) fs.closeSync(fd);
  chromium.launchPersistentContext = realLaunch;
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCache;
  if (savedOverride === undefined) delete process.env.PLAYWRIGHT_MCP_PROFILE_DIR;
  else process.env.PLAYWRIGHT_MCP_PROFILE_DIR = savedOverride;
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function fixtureRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  fixtures.push(dir);
  return dir;
}

/** A cache root with no pool dirs yet, wired in as XDG_CACHE_HOME. No override. */
function freshCache() {
  const cache = fixtureRoot();
  process.env.XDG_CACHE_HOME = cache;
  delete process.env.PLAYWRIGHT_MCP_PROFILE_DIR; // ambient value would short-circuit selection
  return cache;
}

/** The pool candidates the module will derive from `cache`, best slot first. */
function pool(cache) {
  const first = path.join(cache, 'playwright-mcp', 'profile');
  const dirs = [first, ...Array.from({ length: POOL_SIZE - 1 }, (_, i) => `${first}-${i + 2}`)];
  assert.equal(dirs.length, POOL_SIZE, 'fixture pool must be the same size as the real one');
  return dirs;
}

const lockPath = (dir) => path.join(dir, 'SingletonLock');

/** SingletonLock is a symlink to `host-pid` — dangling by design, so lstat/readlink, never exists(). */
function writeLock(dir, pid, host = os.hostname()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(`${host}-${pid}`, lockPath(dir));
}

const liveLock = (dir) => writeLock(dir, process.pid); // our own pid: provably alive
const staleLock = (dir) => writeLock(dir, DEAD_PID);

function isLocked(dir) {
  try {
    fs.readlinkSync(lockPath(dir));
    return true;
  } catch {
    return false;
  }
}

/** Drive one launch to its (guaranteed) failure and return the dirs it tried. */
async function attemptedDirs() {
  attempts = [];
  await assert.rejects(getStealthContext(), /stubbed launch refused/);
  return attempts;
}

// ── selection ────────────────────────────────────────────────────────────────

test('control: an unlocked pool takes slot 1, the historical profile dir', async () => {
  const cache = freshCache();
  const [base] = pool(cache);

  assert.deepEqual(await attemptedDirs(), [base]);
});

test('a LIVE lock on the base profile is skipped — selection advances to the next slot', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base, second] = pool(cache);
  liveLock(base);

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [second], 'contention must route around the occupied dir, not hard-fail on it');
  assert.ok(!tried.includes(base), 'the live-locked dir must never be launched on');
  assert.ok(isLocked(base), "a live owner's lock must never be cleared");
});

test('successive LIVE locks walk down the pool, one slot at a time', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const dirs = pool(cache);
  for (let held = 1; held < 4; held++) {
    liveLock(dirs[held - 1]);
    assert.deepEqual(await attemptedDirs(), [dirs[held]], `slots 1..${held} held`);
  }
});

test('a STALE lock on the base profile is recovered, not skipped', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base, second] = pool(cache);
  staleLock(base);
  assert.ok(isLocked(base), 'fixture precondition: the corpse lock exists');

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [base], 'a recoverable slot stays preferred over a lower one');
  assert.ok(!tried.includes(second), 'a dead owner is not contention');
  assert.equal(isLocked(base), false, 'the corpse lock is cleared before launch');
});

test('a live slot is skipped even when an earlier-numbered slot is merely stale', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base, second, third] = pool(cache);
  liveLock(base);
  liveLock(second);
  staleLock(third);

  assert.deepEqual(await attemptedDirs(), [third]);
  assert.ok(isLocked(base) && isLocked(second), 'live locks left intact');
  assert.equal(isLocked(third), false, 'the stale slot we landed on was cleared');
});

test('a lock written on another host is stale here — the slot is still usable', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base] = pool(cache);
  writeLock(base, process.pid, 'someotherbox'); // live pid, foreign host

  assert.deepEqual(await attemptedDirs(), [base]);
});

// ── fallback ─────────────────────────────────────────────────────────────────

test('every pool slot live-locked falls back to the pid-keyed temp profile', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const dirs = pool(cache);
  for (const dir of dirs) liveLock(dir);

  const tried = await attemptedDirs();
  assert.deepEqual(
    tried,
    [path.join(os.tmpdir(), `pwmcp-fetch-${process.pid}`)],
    'a full pool must fall back, never hard-fail the fetch',
  );
  for (const dir of dirs) assert.ok(isLocked(dir), 'no pooled lock was disturbed');
});

// ── explicit override ────────────────────────────────────────────────────────

test('PLAYWRIGHT_MCP_PROFILE_DIR pins one dir — no pool walk, no temp fallback', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache(); // pool left entirely free, so a pool pick would show
  const override = path.join(fixtureRoot(), 'pinned');
  liveLock(override); // even occupied, an override is never routed around
  process.env.PLAYWRIGHT_MCP_PROFILE_DIR = override;

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [override], 'an override is one explicit dir and still throws');
  assert.ok(!tried.some((d) => d.startsWith(cache)), 'the pool must not be consulted');
});

// ── win32 lock dialect: lockfileState (the seam src/browser.ts exports) ─────────
// Pure apart from its probe, so it runs on any OS. A real "live" needs a file
// the default probe cannot open for write:
//   - on Windows: an exclusive open (libuv UV_FS_O_EXLOCK, 0x10000000 → share
//     mode 0), the same sharing violation a running chrome's handle causes.
//     NOT VERIFIED ON WINDOWS;
//   - elsewhere: a DIRECTORY named `lockfile`. open(dir, 'r+') is EISDIR for
//     every uid. (chmod 0o000 was rejected: TE-1 runs the suite under
//     `unshare -rn`, where the user maps to uid 0 and CAP_DAC_OVERRIDE opens it
//     anyway, so the fixture would silently turn 'stale'.)
// Either way it is a real syscall failing with a non-ENOENT errno, and every
// holdLockfile() call asserts the production probe really reads it as 'live' —
// a fixture that is not what it claims fails loudly instead of passing blind.

const UV_FS_O_EXLOCK = 0x10000000;
const lockfilePath = (dir) => path.join(dir, 'lockfile');

/** Make `<dir>/lockfile` read as held by a live chrome, then prove the probe agrees. */
function holdLockfile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const { O_RDWR, O_CREAT } = fs.constants;
    heldFds.push(fs.openSync(lockfilePath(dir), O_RDWR | O_CREAT | UV_FS_O_EXLOCK));
  } else {
    fs.mkdirSync(lockfilePath(dir));
  }
  assert.equal(lockfileState(dir), 'live', `fixture precondition: ${lockfilePath(dir)} must probe as live`);
}

/** A lockfile nobody holds: what a chrome that lost power leaves behind. */
function staleLockfile(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockfilePath(dir), 'corpse');
  assert.equal(lockfileState(dir), 'stale', 'fixture precondition: an unheld lockfile probes as stale');
}

/** One launch through the pool walk with the win32 dialect in force. */
const attemptedDirsWin32 = () => withPlatform('win32', attemptedDirs);

const errno = (code) => Object.assign(new Error(`fake ${code}`), { code });

test('lockfileState: no lockfile, or no profile dir at all, is free — and the probe creates nothing', () => {
  const root = fixtureRoot();
  assert.equal(lockfileState(root), 'free', 'a dir with no lockfile');
  const missing = path.join(root, 'never-created');
  assert.equal(lockfileState(missing), 'free', 'a profile dir that does not exist');
  assert.equal(fs.existsSync(missing), false, 'probing a free slot must not create it');
  assert.equal(fs.existsSync(lockfilePath(root)), false, "probing must never leave a lockfile of ours");
});

test('lockfileState: an unheld lockfile is stale, and survives the probe untouched', () => {
  const root = fixtureRoot();
  staleLockfile(root);
  assert.equal(fs.readFileSync(lockfilePath(root), 'utf8'), 'corpse', "opened 'r+': neither truncated nor removed");
});

test('lockfileState: any errno but ENOENT is live (injected probe), and the probe is given <dir>/lockfile', () => {
  const root = fixtureRoot();
  const seen = [];
  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EISDIR']) {
    const state = lockfileState(root, (file) => {
      seen.push(file);
      throw errno(code);
    });
    assert.equal(state, 'live', `${code} → live (a slot we cannot probe is a slot we do not take)`);
  }
  assert.equal(lockfileState(root, () => { throw errno('ENOENT'); }), 'free');
  assert.equal(lockfileState(root, () => {}), 'stale', 'a probe that opens is stale');
  assert.deepEqual([...new Set(seen)], [lockfilePath(root)]);
});

test('lockfileState: a lockfile the default probe cannot open for write is live (real syscall)', () => {
  holdLockfile(fixtureRoot()); // the assertion is inside: the default probe must say 'live'
});

// ── win32 branch: the pool walk keyed on `lockfile` ──────────────────────────
// Same contract as the SingletonLock tests above, through the other dialect.

test('win32 branch: an unlocked pool takes slot 1', async () => {
  const [base] = pool(freshCache());
  assert.deepEqual(await attemptedDirsWin32(), [base]);
});

test('win32 branch: a LIVE lockfile on the base profile is skipped — selection advances', async () => {
  const [base, second] = pool(freshCache());
  holdLockfile(base);

  assert.deepEqual(await attemptedDirsWin32(), [second], 'contention must route around the held dir');
  assert.equal(lockfileState(base), 'live', "a live owner's lockfile is never disturbed");
});

test('win32 branch: successive LIVE lockfiles walk down the pool, one slot at a time', async () => {
  const dirs = pool(freshCache());
  for (let held = 1; held < 4; held++) {
    holdLockfile(dirs[held - 1]);
    assert.deepEqual(await attemptedDirsWin32(), [dirs[held]], `slots 1..${held} held`);
  }
});

test('win32 branch: a STALE lockfile keeps the slot preferred, and nothing is cleared', async () => {
  const [base] = pool(freshCache());
  staleLockfile(base);

  assert.deepEqual(await attemptedDirsWin32(), [base], 'an unheld lockfile is not contention');
  // No win32 clear step exists or is needed: chrome reclaims its own lockfile.
  assert.equal(fs.readFileSync(lockfilePath(base), 'utf8'), 'corpse', 'the stale lockfile is left for chrome');
});

test('win32 branch: a live slot is skipped even when an earlier slot is merely stale', async () => {
  const [base, second, third] = pool(freshCache());
  holdLockfile(base);
  holdLockfile(second);
  staleLockfile(third);

  assert.deepEqual(await attemptedDirsWin32(), [third]);
});

test('win32 branch: every pool slot held falls back to the pid-keyed temp profile', async () => {
  const dirs = pool(freshCache());
  for (const dir of dirs) holdLockfile(dir);

  assert.deepEqual(
    await attemptedDirsWin32(),
    [path.join(os.tmpdir(), `pwmcp-fetch-${process.pid}`)],
    'a full pool must fall back, never hard-fail the fetch',
  );
});

test('win32 branch: PLAYWRIGHT_MCP_PROFILE_DIR pins one dir even when its lockfile is held', async () => {
  const cache = freshCache();
  const override = path.join(fixtureRoot(), 'pinned');
  holdLockfile(override);
  process.env.PLAYWRIGHT_MCP_PROFILE_DIR = override;

  const tried = await attemptedDirsWin32();
  assert.deepEqual(tried, [override], 'an override is one explicit dir and still throws');
  assert.ok(!tried.some((d) => d.startsWith(cache)), 'the pool must not be consulted');
});

// The Bug-A discriminator: before the win32 branch existed, isOccupied read
// SingletonLock on every OS, so on Windows (where chrome never writes one) the
// pool walk was dead and every instance piled onto slot 1. Under win32 a planted
// LIVE SingletonLock must therefore NOT move selection — only `lockfile` may.
test('win32 branch: a live POSIX SingletonLock does not count — only lockfile does', { skip: NO_SYMLINKS }, async () => {
  const [base] = pool(freshCache());
  liveLock(base); // the POSIX dialect: live on Linux, and ignored under win32

  assert.deepEqual(await attemptedDirsWin32(), [base], 'the win32 walk keys on lockfile alone');
});
