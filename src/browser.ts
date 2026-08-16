/**
 * browser.ts — the shared STEALTH Chromium context for web_fetch.
 *
 * Separate from the wrapped @playwright/mcp browser (that one drives debugging;
 * this one is disguised to pass as a real person while fetching/rendering pages).
 * One persistent lifecycle — launch once, reuse.
 *
 * Stealth layer is manual only — NO playwright-extra/stealth plugin (it wraps
 * Playwright and is a dedupe/compat hazard against the exact-pinned playwright
 * version). WebGL/canvas spoofing is escalation-only and intentionally absent.
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext } from 'playwright';

import { seedConsent } from './consent.js';
import { CHROME_MAJOR, STEALTH_ARGS, STEALTH_INIT, stealthContextOptions } from './stealth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:browser]', ...args);

function profileDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'playwright-mcp', 'profile');
}

let ctxPromise: Promise<BrowserContext> | undefined;
let liveContext: BrowserContext | undefined;

/**
 * Lazily launch (once) and return the shared stealth context. Persistent profile
 * so cookies + reputation accumulate across runs. Subsequent calls reuse it.
 *
 * The memo holds only a WORKING context. A failed launch is never cached: the
 * usual causes (a stale profile lock from a chrome that died, a browser mid-
 * upgrade) are transient, and memoizing the rejected promise turned a passing
 * fault into a permanent one that only an MCP-server restart could clear —
 * every later call replaying one byte-identical error. Same for a context that
 * dies after a good launch: `close` drops it from the memo, so the next caller
 * relaunches instead of getting a corpse.
 */
export async function getStealthContext(): Promise<BrowserContext> {
  const pending = (ctxPromise ??= launch());
  try {
    return await pending;
  } catch (err) {
    if (ctxPromise === pending) ctxPromise = undefined;
    throw err;
  }
}

async function launch(): Promise<BrowserContext> {
  const dir = profileDir();
  clearStaleSingletons(dir);
  let context: BrowserContext;
  try {
    context = await openProfile(dir);
  } catch (err) {
    // A chrome that dies without cleaning up leaves its singleton files behind
    // and every later launch refuses the profile. If the lock went stale during
    // this launch, clear it and retry once rather than making the user delete
    // files by hand.
    if (!clearStaleSingletons(dir)) throw err;
    log('retrying launch after clearing a stale profile lock');
    context = await openProfile(dir);
  }
  liveContext = context;
  context.once('close', () => {
    if (liveContext !== context) return;
    liveContext = undefined;
    ctxPromise = undefined;
    log('stealth context closed — next fetch will relaunch');
  });
  log(`stealth context up (chrome/${CHROME_MAJOR}, profile=${dir})`);
  return context;
}

async function openProfile(dir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless: true,
    args: STEALTH_ARGS,
    ...stealthContextOptions,
  });
  await context.addInitScript(STEALTH_INIT);
  await seedConsent(context);
  return context;
}

/** Chrome's profile-ownership markers. SingletonLock is a symlink to `host-pid`. */
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/**
 * True when the profile's SingletonLock names a process that is gone (or another
 * machine) — i.e. the lock is a corpse, not a live conflict. Exported for tests.
 */
export function isStaleLock(dir: string): boolean {
  let target: string;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false; // no lock, or not a symlink — nothing to recover
  }
  const dash = target.lastIndexOf('-');
  const pid = Number(target.slice(dash + 1));
  if (dash === -1 || !Number.isInteger(pid) || pid <= 0) return true;
  if (target.slice(0, dash) !== os.hostname()) return true; // written on another host
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
    return false; // the owner is alive: a real conflict, not ours to clear
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM'; // EPERM = alive, not ours
  }
}

/** Remove a dead chrome's singleton files. Returns true if it cleared any. */
function clearStaleSingletons(dir: string): boolean {
  if (!isStaleLock(dir)) return false;
  for (const f of SINGLETON_FILES) fs.rmSync(path.join(dir, f), { force: true });
  log('cleared a stale profile lock left by a dead chrome');
  return true;
}

/**
 * Jittered pacing delay — never fire scrapes in a tight synchronous burst.
 * Deterministic jitter from a seed so a parity run is reproducible; defaults to
 * a fixed mid-range delay (Math.random is unavailable in some sandboxes).
 */
export function paceMs(base = 350, jitterSeed = 0.5): number {
  const clamped = Math.max(0, Math.min(1, jitterSeed));
  return Math.round(base + clamped * base);
}

export function pace(base = 350, jitterSeed = 0.5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, paceMs(base, jitterSeed)));
}

/** Close the shared context (server shutdown / tests). Never throws — a context
 *  that failed to launch is already gone, and shutdown must not hang on it. */
export async function closeBrowser(): Promise<void> {
  const pending = ctxPromise;
  ctxPromise = undefined;
  liveContext = undefined;
  if (!pending) return;
  await pending.then((ctx) => ctx.close()).catch(() => {});
}
