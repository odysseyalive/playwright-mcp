#!/usr/bin/env node
// T1 acceptance — the browser_* browser's profile and lifecycle (src/upstream.ts,
// BROWSER_POOL in src/browser.ts).
//
// Regression cover for DEF-Q-17 (measured 2026-09-11): @playwright/mcp launched
// every browser_* chrome on ONE default profile (ms-playwright/mcp-chrome-<hash>)
// and never closed it. browser_close only dropped its tool state, so the chrome
// kept the profile locked and the next browser_* call, even a second
// browser_close, failed with "Browser is already in use". The launch is now ours:
// a pooled profile, the previous browser closed before the next launch, and the
// connection's browser closed when it is torn down.
//
// The pool must not cost what the single profile gave (DEC-2026-08-28 Path B):
// slot 1 is the exact dir upstream used for this workspace, so a browser_* login
// carries over, and every slot and the temp fallback are keyed to the workspace,
// so projects stay separate. Slot 1 is pinned against upstream's OWN launch, not
// against a copy of its formula.
//
// DETERMINISM (principle 9): no real chromium by default. chromium's launchers
// are stubbed on the shared playwright object with recorders that hand back fake
// contexts, so the dir chosen and the close order are observable directly.
// Liveness is this test process's own pid; deadness is 0x7ffffffe. The one
// end-to-end test that drives real chrome through @playwright/mcp runs only with
// PLAYWRIGHT_MCP_TEST_BROWSER=1.
//
// FIXTURE SAFETY: launchOnPool reaps orphaned `pwmcp-browser-<hash>-<pid>` dirs
// out of os.tmpdir(). Fixtures use a DISTINCT prefix, except the reaper test's
// own dir, whose pid is provably dead. Upstream's profile root is redirected with
// its own test seam, PWMCP_PROFILES_DIR_FOR_TEST, so no real
// ms-playwright/mcp-chrome-* profile is ever touched.
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { BROWSER_POOL, browserOwner, launchBrowser, upstreamConfig, upstreamProfileDir } from '../dist/upstream.js';
import { symlinkSkipReason } from './fixtures/platform.mjs';

const BROWSER_TESTS = process.env.PLAYWRIGHT_MCP_TEST_BROWSER === '1';
/** Must match PROFILE_POOL_SIZE in src/browser.ts. */
const POOL_SIZE = 8;
const FIXTURE_PREFIX = 'pwmcp-upb-';
const DEAD_PID = 2147483646;

/** These fixtures fake chrome's POSIX SingletonLock; the win32 dialect is covered in test-browser-profile-pool.mjs. */
const POSIX_LOCK_SKIP =
  process.platform === 'win32'
    ? 'win32: occupancy keys on `lockfile` there; the pool walk itself is shared and covered by test-browser-profile-pool.mjs'
    : symlinkSkipReason();

// ── the seam: launchers that record and hand back fake contexts ──────────────

const realPersistent = chromium.launchPersistentContext;
const realLaunch = chromium.launch;
/** Every launch, in order: { kind, dir?, options }. */
let launches = [];
/** Replaceable per test: what launchPersistentContext does with a dir. */
let onPersistent = async (dir) => fakeContext(dir);

chromium.launchPersistentContext = async (dir, options) => {
  launches.push({ kind: 'persistent', dir, options });
  return onPersistent(dir, options);
};
chromium.launch = async (options) => {
  launches.push({ kind: 'launch', options });
  return fakeBrowser();
};

/** A context that records closes. `browser()` is null, as for a persistent context. */
function fakeContext(dir, browser = null) {
  const listeners = [];
  const ctx = {
    dir,
    closed: 0,
    options: undefined,
    browser: () => browser,
    once: (event, fn) => event === 'close' && listeners.push(fn),
    close: async () => {
      ctx.closed++;
      for (const fn of listeners.splice(0)) fn();
    },
  };
  return ctx;
}

function fakeBrowser() {
  const b = {
    closed: 0,
    contexts: [],
    newContext: async (options) => {
      const ctx = fakeContext(undefined, b);
      ctx.options = options;
      b.contexts.push(ctx);
      return ctx;
    },
    close: async () => {
      b.closed++;
    },
  };
  return b;
}

const savedEnv = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME, PWMCP_PROFILES_DIR_FOR_TEST: process.env.PWMCP_PROFILES_DIR_FOR_TEST };
const savedCwd = process.cwd();
const fixtures = [];

after(() => {
  chromium.launchPersistentContext = realPersistent;
  chromium.launch = realLaunch;
  process.chdir(savedCwd);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of fixtures) fs.rmSync(dir, { recursive: true, force: true });
  // Temp fallbacks this process claimed (pid-keyed, so provably ours).
  for (const name of fs.readdirSync(os.tmpdir()))
    if (name.startsWith('pwmcp-browser-') && name.endsWith(`-${process.pid}`))
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
});

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), FIXTURE_PREFIX));
  fixtures.push(dir);
  return dir;
}

/** A cache root that both web_fetch (XDG_CACHE_HOME) and upstream's profile root read. */
function freshCache() {
  const cache = fixtureDir();
  process.env.XDG_CACHE_HOME = cache;
  process.env.PWMCP_PROFILES_DIR_FOR_TEST = cache;
  launches = [];
  onPersistent = async (dir) => fakeContext(dir);
  return cache;
}

/** Upstream's workspace hash, recomputed independently: sha256 of the cwd, 7 hex. */
const hashOf = (dir) => createHash('sha256').update(dir).digest('hex').slice(0, 7);

/** The browser_* pool candidates under `cache` for the current workspace, best slot first. */
function browserPool(cache) {
  const first = path.join(cache, `mcp-chrome-${hashOf(process.cwd())}`);
  return [first, ...Array.from({ length: POOL_SIZE - 1 }, (_, i) => `${first}-${i + 2}`)];
}

/** Run `fn` with the process in a fresh workspace dir, restoring the cwd after. */
async function inWorkspace(fn) {
  const ws = fixtureDir();
  const cwd = process.cwd();
  process.chdir(ws);
  try {
    return await fn(process.cwd()); // realpath, as upstream would see it
  } finally {
    process.chdir(cwd);
  }
}

function liveLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'));
}

// ── config: the launch is ours ───────────────────────────────────────────────

test('upstreamConfig asks upstream for neither its default profile nor its own isolated launch', () => {
  freshCache();
  const b = upstreamConfig().browser;
  assert.equal(b.userDataDir, undefined, 'no fixed profile dir for upstream to launch on');
  assert.equal(b.isolated, undefined, 'upstream rejects isolated alongside a context getter');
  assert.equal(b.launchOptions, undefined, 'launch options live in upstreamLaunch, which our launcher reads');
});

// ── profile selection: BROWSER_POOL ──────────────────────────────────────────

test('slot 1 is the exact dir @playwright/mcp itself launches browser_* on for this workspace', async () => {
  freshCache();
  // Upstream's OWN launch path: no context getter, so it picks the profile. The
  // stubbed launcher records the dir and refuses, so no chrome starts.
  onPersistent = async (dir) => {
    throw new Error(`stubbed launch refused ${dir}`);
  };
  const server = await createConnection({ browser: { browserName: 'chromium', launchOptions: { channel: 'chrome', headless: true } } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'pin-upstream-profile', version: '0.0.0' });
  await client.connect(clientT);
  try {
    const r = await client.callTool({ name: 'browser_navigate', arguments: { url: 'about:blank' } });
    assert.ok(r.isError, 'the stub refuses the launch');
  } finally {
    await client.close();
  }

  const upstreamChose = launches.filter((l) => l.kind === 'persistent').map((l) => l.dir);
  assert.deepEqual(upstreamChose, [upstreamProfileDir()], 'our slot 1 must be the dir upstream picks, so its login carries over');
  assert.equal(BROWSER_POOL.slot1(), upstreamProfileDir());
});

test('workspaces never share a browser_* profile: every slot and the temp fallback carry the workspace hash', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const seen = [];
  for (let i = 0; i < 2; i++) {
    await inWorkspace(async (ws) => {
      const slots = browserPool(cache);
      assert.equal(upstreamProfileDir(), slots[0]);
      for (const dir of slots) {
        assert.ok(path.basename(dir).includes(hashOf(ws)), `${dir} is keyed to ${ws}`);
        liveLock(dir);
      }
      launches = [];
      await launchBrowser();
      const temp = path.join(os.tmpdir(), `pwmcp-browser-${hashOf(ws)}-${process.pid}`);
      assert.deepEqual(launches.map((l) => l.dir), [temp], 'a full pool falls back to a temp dir of this workspace');
      seen.push(...slots, temp);
    });
  }
  assert.equal(new Set(seen).size, seen.length, 'no dir is shared between the two workspaces');
});

test('a full pool in ANOTHER workspace does not push this one off its slot 1', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  await inWorkspace(async () => {
    for (const dir of browserPool(cache)) liveLock(dir);
  });
  await inWorkspace(async () => {
    launches = [];
    await launchBrowser();
    assert.deepEqual(launches.map((l) => l.dir), [browserPool(cache)[0]]);
  });
});

test('an unbound browser_* launch takes slot 1 of its own pool, not web_fetch\'s', async () => {
  const cache = freshCache();
  const [base] = browserPool(cache);

  const ctx = await launchBrowser();
  assert.deepEqual(launches.map((l) => l.dir), [base]);
  assert.equal(ctx.dir, base);
  assert.equal(launches[0].options.headless, true);
});

test('a LIVE lock on slot 1 routes the launch to slot 2 instead of failing', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base, second] = browserPool(cache);
  liveLock(base);

  await launchBrowser();
  assert.deepEqual(launches.map((l) => l.dir), [second]);
});

test('a live web_fetch profile does not occupy a browser_* slot: the pools are separate', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  liveLock(path.join(cache, 'playwright-mcp', 'profile'));
  const [base] = browserPool(cache);

  await launchBrowser();
  assert.deepEqual(launches.map((l) => l.dir), [base]);
});

test('every browser_* slot held falls back to a pid-keyed temp profile of its own', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  for (const dir of browserPool(cache)) liveLock(dir);

  await launchBrowser();
  const temp = path.join(os.tmpdir(), `pwmcp-browser-${hashOf(process.cwd())}-${process.pid}`);
  assert.deepEqual(launches.map((l) => l.dir), [temp]);
});

// ── the temp fallback is shared /tmp: never write a profile into someone else's dir ──

/** Fill this workspace's pool so selection falls back, and return the temp path. */
function forceTempFallback(cache) {
  for (const dir of browserPool(cache)) liveLock(dir);
  const temp = path.join(os.tmpdir(), `pwmcp-browser-${hashOf(process.cwd())}-${process.pid}`);
  fs.rmSync(temp, { recursive: true, force: true });
  return temp;
}

test('a missing temp fallback is created private (0700) before chrome is given it', { skip: POSIX_LOCK_SKIP }, async () => {
  const temp = forceTempFallback(freshCache());
  onPersistent = async (dir) => {
    assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, 'exists and is 0700 at launch time');
    return fakeContext(dir);
  };
  await launchBrowser();
  assert.deepEqual(launches.map((l) => l.dir), [temp]);
  await launchBrowser(); // our own private dir from before is reused, not refused
  assert.equal(launches.length, 2);
});

test('a temp fallback path that is a SYMLINK is refused, never launched on', { skip: POSIX_LOCK_SKIP }, async () => {
  const temp = forceTempFallback(freshCache());
  const elsewhere = fixtureDir();
  fs.chmodSync(elsewhere, 0o700);
  fs.symlinkSync(elsewhere, temp);

  await assert.rejects(launchBrowser(), /refusing temp profile/);
  assert.deepEqual(launches, [], 'chrome was never pointed at it');
  fs.rmSync(temp, { force: true });
});

test('a pre-existing temp fallback with group/other permission bits is refused', { skip: POSIX_LOCK_SKIP }, async () => {
  const temp = forceTempFallback(freshCache());
  fs.mkdirSync(temp, { mode: 0o700 });
  fs.chmodSync(temp, 0o777); // what another account's pre-created dir looks like to us

  await assert.rejects(launchBrowser(), /refusing temp profile/);
  assert.deepEqual(launches, []);
  fs.rmSync(temp, { recursive: true, force: true });
});

test('"already in use" mid-launch switches to a free slot and retries once', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base, second] = browserPool(cache);
  // A sibling instance takes slot 1 between selection and launch: chrome refuses
  // the profile, and by then the lock is live.
  onPersistent = async (dir) => {
    if (dir === base) {
      liveLock(base);
      throw new Error('Failed to create a ProcessSingleton for your profile directory');
    }
    return fakeContext(dir);
  };

  const ctx = await launchBrowser();
  assert.deepEqual(launches.map((l) => l.dir), [base, second]);
  assert.equal(ctx.dir, second);
});

test('an orphaned pwmcp-browser-<hash>-<dead pid> temp profile is reaped on launch', async () => {
  freshCache();
  const orphan = path.join(os.tmpdir(), `pwmcp-browser-0000000-${DEAD_PID}`);
  fs.mkdirSync(orphan, { recursive: true });
  fixtures.push(orphan); // cleanup if the reaper fails

  await launchBrowser();
  assert.equal(fs.existsSync(orphan), false, 'a dead owner\'s temp profile is removed');
});

// ── bound session: an in-memory context on a browser of its own ──────────────

test('a bound launch seeds storageState on a fresh browser, never a pooled profile', async () => {
  freshCache();
  const ctx = await launchBrowser('/nonexistent/session.json');

  assert.deepEqual(launches.map((l) => l.kind), ['launch']);
  assert.equal(ctx.options.storageState, '/nonexistent/session.json');
  await ctx.close();
  assert.equal(ctx.browser().closed, 1, 'closing the context takes its browser down with it');
});

// ── lifecycle: nothing outlives its owner ────────────────────────────────────

test('the next backend\'s launch closes the previous browser FIRST, and gets the same slot back', { skip: POSIX_LOCK_SKIP }, async () => {
  const cache = freshCache();
  const [base] = browserPool(cache);
  // Model chrome's lock: held from launch until close.
  onPersistent = async (dir) => {
    liveLock(dir);
    const ctx = fakeContext(dir);
    const close = ctx.close;
    ctx.close = async () => {
      fs.rmSync(path.join(dir, 'SingletonLock'), { force: true });
      await close();
    };
    return ctx;
  };
  const owner = browserOwner();

  const first = await owner.getContext(); // first browser_* call
  const second = await owner.getContext(); // after browser_close discarded upstream's state
  assert.equal(first.closed, 1, 'the ownerless browser is closed, not left holding its profile');
  assert.deepEqual(launches.map((l) => l.dir), [base, base], 'profile continuity: the freed slot is reused');
  assert.equal(second.closed, 0);

  await owner.closeBrowser();
  assert.equal(second.closed, 1, 'tearing the connection down closes its browser');
  await owner.closeBrowser(); // idempotent
  assert.equal(second.closed, 1);
});

test('a failed launch leaves nothing held, and the next call launches again', async () => {
  freshCache();
  let fail = true;
  const owner = browserOwner(undefined, async () => {
    if (fail) throw new Error('chrome would not start');
    return fakeContext('ok');
  });

  await assert.rejects(owner.getContext(), /would not start/);
  await owner.closeBrowser(); // nothing to close, must not throw
  fail = false;
  assert.equal((await owner.getContext()).dir, 'ok');
});

test('a bound connection\'s browser is closed with it', async () => {
  freshCache();
  const owner = browserOwner('/nonexistent/session.json');
  const ctx = await owner.getContext();
  await owner.closeBrowser();
  assert.equal(ctx.closed, 1);
  assert.ok(ctx.browser().closed >= 1, 'the browser, not just the context');
});

// ── real chrome through @playwright/mcp (opt-in) ─────────────────────────────

test('DEF-Q-17: navigate, close, navigate, close, close all succeed on real chrome', { skip: !BROWSER_TESTS && 'opt-in: needs a real chrome (PLAYWRIGHT_MCP_TEST_BROWSER=1)' }, async () => {
  freshCache();
  chromium.launchPersistentContext = realPersistent;
  chromium.launch = realLaunch;
  // Keep upstream's snapshot files out of the working tree.
  const cwd = process.cwd();
  process.chdir(fixtures[fixtures.length - 1]);
  const { initUpstream, getUpstream, releaseBrowser, closeUpstream } = await import('../dist/upstream.js');
  try {
    await initUpstream();
    const call = async (name, args = {}) => {
      const r = await getUpstream().callTool({ name, arguments: args });
      if (name === 'browser_close') await releaseBrowser(); // what src/index.ts does
      assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    };
    await call('browser_navigate', { url: 'about:blank' });
    await call('browser_close');
    await call('browser_navigate', { url: 'about:blank' }); // failed with "already in use" before the fix
    await call('browser_close');
    await call('browser_close'); // so did a second close
  } finally {
    await closeUpstream();
    process.chdir(cwd);
  }
});
