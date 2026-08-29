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
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { getStealthContext } from '../dist/browser.js';

/** Must match PROFILE_POOL_SIZE in src/browser.ts. */
const POOL_SIZE = 8;
/** Deliberately NOT `pwmcp-fetch-` — that prefix is the temp-profile reaper's. */
const FIXTURE_PREFIX = 'pwmcp-pool-';
const DEAD_PID = 2147483646;

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

after(() => {
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

test('a LIVE lock on the base profile is skipped — selection advances to the next slot', async () => {
  const cache = freshCache();
  const [base, second] = pool(cache);
  liveLock(base);

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [second], 'contention must route around the occupied dir, not hard-fail on it');
  assert.ok(!tried.includes(base), 'the live-locked dir must never be launched on');
  assert.ok(isLocked(base), "a live owner's lock must never be cleared");
});

test('successive LIVE locks walk down the pool, one slot at a time', async () => {
  const cache = freshCache();
  const dirs = pool(cache);
  for (let held = 1; held < 4; held++) {
    liveLock(dirs[held - 1]);
    assert.deepEqual(await attemptedDirs(), [dirs[held]], `slots 1..${held} held`);
  }
});

test('a STALE lock on the base profile is recovered, not skipped', async () => {
  const cache = freshCache();
  const [base, second] = pool(cache);
  staleLock(base);
  assert.ok(isLocked(base), 'fixture precondition: the corpse lock exists');

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [base], 'a recoverable slot stays preferred over a lower one');
  assert.ok(!tried.includes(second), 'a dead owner is not contention');
  assert.equal(isLocked(base), false, 'the corpse lock is cleared before launch');
});

test('a live slot is skipped even when an earlier-numbered slot is merely stale', async () => {
  const cache = freshCache();
  const [base, second, third] = pool(cache);
  liveLock(base);
  liveLock(second);
  staleLock(third);

  assert.deepEqual(await attemptedDirs(), [third]);
  assert.ok(isLocked(base) && isLocked(second), 'live locks left intact');
  assert.equal(isLocked(third), false, 'the stale slot we landed on was cleared');
});

test('a lock written on another host is stale here — the slot is still usable', async () => {
  const cache = freshCache();
  const [base] = pool(cache);
  writeLock(base, process.pid, 'someotherbox'); // live pid, foreign host

  assert.deepEqual(await attemptedDirs(), [base]);
});

// ── fallback ─────────────────────────────────────────────────────────────────

test('every pool slot live-locked falls back to the pid-keyed temp profile', async () => {
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

test('PLAYWRIGHT_MCP_PROFILE_DIR pins one dir — no pool walk, no temp fallback', async () => {
  const cache = freshCache(); // pool left entirely free, so a pool pick would show
  const override = path.join(fixtureRoot(), 'pinned');
  liveLock(override); // even occupied, an override is never routed around
  process.env.PLAYWRIGHT_MCP_PROFILE_DIR = override;

  const tried = await attemptedDirs();
  assert.deepEqual(tried, [override], 'an override is one explicit dir and still throws');
  assert.ok(!tried.some((d) => d.startsWith(cache)), 'the pool must not be consulted');
});
