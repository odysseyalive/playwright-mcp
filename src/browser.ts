/**
 * browser.ts — the shared STEALTH Chromium context for web_fetch.
 *
 * Separate from the wrapped @playwright/mcp browser (that one drives debugging;
 * this one is disguised to pass as a real person while fetching/rendering pages).
 * One persistent lifecycle — launch once, reuse.
 *
 * CONCURRENCY: the profile is drawn from a small numbered POOL, not one fixed dir.
 * Chromium holds a SingletonLock on a persistent profile for the life of the
 * browser, so two user-scoped instances (two concurrent Claude Code sessions)
 * sharing one dir meant the second's launch was refused — correctly, the lock is
 * live, not stale — and every web_fetch on it read back `blocked`. Each instance
 * now takes the first pool slot no live chrome holds, so every session keeps a
 * STABLE dir and its cookie/reputation continuity, not just whoever launched
 * first. This profile carries no identity (auth lives in session_* storageState
 * artifacts, see stealth.ts), so per-instance isolation costs nothing but that
 * continuity — which is exactly what the pool preserves.
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

/** How many persistent pool slots to try before the pid-keyed temp fallback. */
const PROFILE_POOL_SIZE = 8;

/** Marks the temp profiles this module creates, so the reaper can recognize them. */
const TEMP_PROFILE_MARK = 'pwmcp-fetch-';

/**
 * An explicit override wins so a SECOND instance (e.g. the krull-web-broker's
 * dedicated HTTP host instance running alongside a Claude Code stdio instance)
 * can be pinned to its own persistent profile: one dir, no pool, no fallback.
 */
const profileOverride = (): string | undefined => process.env.PLAYWRIGHT_MCP_PROFILE_DIR;

/**
 * The pool candidates, best first: slot 1 is the historical `profile` dir (so a
 * single instance keeps the reputation it already accumulated), slots 2..N are
 * its numbered siblings. Read from the environment on every call — the cache
 * root is not fixed for the life of the process.
 */
function profilePool(): string[] {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  const first = path.join(base, 'playwright-mcp', 'profile');
  return [first, ...Array.from({ length: PROFILE_POOL_SIZE - 1 }, (_, i) => `${first}-${i + 2}`)];
}

/** Last resort when every pool slot is held: unique by construction, so it cannot collide. */
const tempProfileDir = (): string => path.join(os.tmpdir(), `${TEMP_PROFILE_MARK}${process.pid}`);

/**
 * Pick the profile dir to launch on. Pure — it only reads locks; making a stale
 * slot usable is `launch()`'s pre-clear, unchanged.
 *
 * A stale lock does NOT count as occupied: that slot is recoverable and stays
 * preferred over a lower-reputation one further down the pool.
 */
function selectProfile(): string {
  const override = profileOverride();
  if (override) return override;
  for (const dir of profilePool()) if (!isOccupied(dir)) return dir;
  const temp = tempProfileDir();
  log(`all ${PROFILE_POOL_SIZE} pooled profiles are in use — falling back to ${temp}`);
  return temp;
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
  reapOrphanTempProfiles();
  let dir = selectProfile();
  clearStaleSingletons(dir);
  let context: BrowserContext;
  try {
    context = await openProfile(dir);
  } catch (err) {
    // A chrome that dies without cleaning up leaves its singleton files behind
    // and every later launch refuses the profile. If the lock went stale during
    // this launch, clear it and retry once rather than making the user delete
    // files by hand.
    if (clearStaleSingletons(dir)) {
      log('retrying launch after clearing a stale profile lock');
      context = await openProfile(dir);
    } else if (!profileOverride() && isOccupied(dir)) {
      // Lost a start-up race: a sibling instance took this slot between the
      // occupancy check and the launch. Re-select once — contention must never
      // hard-fail a fetch. An override is pinned to its one dir and still throws.
      dir = selectProfile();
      log(`profile was taken mid-launch — retrying on ${dir}`);
      context = await openProfile(dir);
    } else throw err;
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
  return !pidAlive(pid); // a live owner is a real conflict, not ours to clear
}

/** Liveness probe. EPERM means the process exists but is another user's. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = probe, kills nothing
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * True when a LIVE chrome holds this profile — a conflict we must route around.
 * `isStaleLock` cannot answer this alone: it reports false both for "no lock"
 * (free) and "live lock" (occupied); the difference is whether a lock exists.
 */
function isOccupied(dir: string): boolean {
  try {
    fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false; // no lock, or not a symlink — the slot is free
  }
  return !isStaleLock(dir);
}

/**
 * Reap pid-keyed temp profiles left behind by an instance that was killed before
 * `closeBrowser()` could run. Follows the reap pattern in tools/session.ts: only
 * MARK-ed dirs are eligible and an owner that might still be alive is never
 * touched — here the dir name IS the record (the pid is in it), so there is no
 * registry file to keep in sync, and no process to kill: the browser is this
 * module's own Playwright child, which dies with it. Pooled profiles are
 * persistent and are never reaped.
 */
function reapOrphanTempProfiles(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return; // no readable tmpdir — nothing to reap
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PROFILE_MARK)) continue;
    const pid = Number(name.slice(TEMP_PROFILE_MARK.length));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || pidAlive(pid)) continue; // owner may still be running
    const dir = path.join(os.tmpdir(), name);
    if (isOccupied(dir)) continue; // a live chrome still holds it
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
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
 *  that failed to launch is already gone, and shutdown must not hang on it.
 *
 *  Also drops this process's temp fallback profile if the pool was full and one
 *  was created. Unconditional and stateless: the path is pid-keyed, so it is
 *  ours either way, and `force` makes it a no-op when we never fell back. A hard
 *  kill that skips this is the reaper's job, not a leak. */
export async function closeBrowser(): Promise<void> {
  const pending = ctxPromise;
  ctxPromise = undefined;
  liveContext = undefined;
  if (pending) await pending.then((ctx) => ctx.close()).catch(() => {});
  try {
    fs.rmSync(tempProfileDir(), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
