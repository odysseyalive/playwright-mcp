/**
 * browser.ts — the shared STEALTH Chromium context for web_fetch.
 *
 * Separate from the wrapped @playwright/mcp browser (that one drives debugging;
 * this one is disguised to pass as a real person while fetching/rendering pages).
 * One persistent lifecycle — launch once, reuse, and close after
 * PLAYWRIGHT_MCP_BROWSER_IDLE_MS with no fetch on it (src/lifetime.ts; the next
 * fetch relaunches). Every browser launched here is registered there.
 *
 * CONCURRENCY: the profile is drawn from a small numbered POOL, not one fixed dir.
 * Chromium holds a SingletonLock on a persistent profile for the life of the
 * browser (on Windows, an exclusively-held `lockfile` instead — see
 * lockfileState), so two user-scoped instances (two concurrent Claude Code sessions)
 * sharing one dir meant the second's launch was refused — correctly, the lock is
 * live, not stale — and every web_fetch on it read back `blocked`. Each instance
 * now takes the first pool slot no live chrome holds, so every session keeps a
 * STABLE dir and its cookie/reputation continuity, not just whoever launched
 * first. This profile carries no identity (auth lives in session_* storageState
 * artifacts, see stealth.ts), so per-instance isolation costs nothing but that
 * continuity — which is exactly what the pool preserves. The browser_* browser
 * draws from its own pool by the same mechanism (`launchOnPool`).
 *
 * Stealth layer is manual only — NO playwright-extra/stealth plugin (it wraps
 * Playwright and is a dedupe/compat hazard against the exact-pinned playwright
 * version). WebGL/canvas spoofing is escalation-only and intentionally absent.
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext } from 'playwright';

import { seedConsent } from './consent.js';
import { keepSavedBotCookies, type Jar } from './extract.js';
import { trackBrowser, type BrowserHandle } from './lifetime.js';
import { humanCapturePath, ownerOnlyDir, reassertOwnerOnly } from './secrets.js';
import {
  BROWSER_CHANNEL,
  browserGlibcEnv,
  CHROME_MAJOR,
  STEALTH_ARGS,
  STEALTH_INIT,
  STEALTH_LAUNCH,
  stealthContextOptions,
} from './stealth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:browser]', ...args);

/** How many persistent pool slots to try before the pid-keyed temp fallback. */
const PROFILE_POOL_SIZE = 8;

/**
 * One family of pooled profiles. Two exist: web_fetch's stealth profiles, and the
 * wrapped @playwright/mcp browser that drives browser_* (src/upstream.ts, which
 * defines that pool). They are separate pools on purpose — a login clicked
 * through in browser_* must not ride along on stealth fetches — but they share
 * every rule below.
 */
export interface ProfilePool {
  /** Slot 1's dir, resolved on every call; slots 2..N are `<slot 1>-2` and up. */
  slot1: () => string;
  /** Prefix of the pid-keyed temp fallback. Also how the reaper recognizes it. */
  tempMark: string;
  /** Put between the mark and the pid in the temp dir's name (e.g. a workspace key). */
  tempKey?: () => string;
  /** A dir pinned from the environment: one dir, no pool, no fallback. */
  override?: () => string | undefined;
}

export const FETCH_POOL: ProfilePool = {
  /**
   * Slot 1 is the historical `profile` dir, so a single instance keeps the
   * reputation it already accumulated. Read from the environment on every call —
   * the cache root is not fixed for the life of the process.
   */
  slot1: () =>
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'playwright-mcp', 'profile'),
  tempMark: 'pwmcp-fetch-',
  /**
   * An explicit override wins so a SECOND instance (e.g. the krull-web-broker's
   * dedicated HTTP host instance running alongside a Claude Code stdio instance)
   * can be pinned to its own persistent profile: one dir, no pool, no fallback.
   */
  override: () => process.env.PLAYWRIGHT_MCP_PROFILE_DIR,
};

/** The pool candidates, best first: slot 1, then its numbered siblings. */
function profilePool(pool: ProfilePool): string[] {
  const first = pool.slot1();
  return [first, ...Array.from({ length: PROFILE_POOL_SIZE - 1 }, (_, i) => `${first}-${i + 2}`)];
}

/** Last resort when every pool slot is held: unique by construction, so it cannot collide. */
const tempProfileDir = (pool: ProfilePool): string =>
  path.join(os.tmpdir(), `${pool.tempMark}${pool.tempKey?.() ?? ''}${process.pid}`);

/**
 * Pick the profile dir to launch on. Pure — it only reads locks; making a stale
 * slot usable is `launchOnPool()`'s pre-clear.
 *
 * A stale lock does NOT count as occupied: that slot is recoverable and stays
 * preferred over a lower-reputation one further down the pool.
 */
function selectProfile(pool: ProfilePool): string {
  const override = pool.override?.();
  if (override) return override;
  for (const dir of profilePool(pool)) if (!isOccupied(dir)) return dir;
  const temp = tempProfileDir(pool);
  log(`all ${PROFILE_POOL_SIZE} pooled profiles are in use — falling back to ${temp}`);
  return temp;
}

let ctxPromise: Promise<BrowserContext> | undefined;
let liveContext: BrowserContext | undefined;
/** The shared context's registry handle (src/lifetime.ts) while it is up. */
let liveHandle: BrowserHandle | undefined;
/** A close in flight: the next launch waits for it, so the profile's lock is free again. */
let closing: Promise<void> | undefined;

/**
 * Fetches using the shared context right now. Counted HERE, not from its pages:
 * the persistent context keeps its default page for its whole life, so a page
 * count is never zero. While this is above zero the context is never idle-closed.
 */
let users = 0;

/**
 * Take the shared context for one fetch. Call BEFORE getStealthContext() and
 * call what it returns when the fetch is done with its page, so an idle close
 * can never land between the two (src/tools/web-fetch.ts fetchOnce).
 */
export function useStealthContext(): () => void {
  users += 1;
  liveHandle?.touch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    liveHandle?.touch();
  };
}

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
  await closing;
  const { context, dir } = await launchOnPool(FETCH_POOL, openProfile);
  liveContext = context;
  // Idle close (src/lifetime.ts): the 2026-11-24 incident's web_fetch profile had
  // sat idle 11+ hours under a session that was still open. Closed after the idle
  // time with no fetch on it; the next fetch relaunches on the same pool slot.
  const handle = trackBrowser({
    kind: 'web_fetch',
    userDataDir: dir,
    idleClose: true,
    busy: () => users > 0,
    close: () => closeBrowser({ keepTemp: true }),
  });
  liveHandle = handle;
  context.once('close', () => {
    handle.done();
    if (liveContext !== context) return;
    liveContext = undefined;
    liveHandle = undefined;
    ctxPromise = undefined;
    log('stealth context closed — next fetch will relaunch');
  });
  log(`stealth context up (chrome/${CHROME_MAJOR}, profile=${dir})`);
  return context;
}

/**
 * Open a persistent profile from `pool` with `open`, never hard-failing on
 * contention: reap orphaned temp profiles, take the first free slot, and recover
 * once from a stale lock or a slot taken mid-launch. Shared by web_fetch and the
 * browser_* browser (src/upstream.ts), so there is one pool mechanism, not two.
 */
export async function launchOnPool<T>(
  pool: ProfilePool,
  open: (dir: string) => Promise<T>,
): Promise<{ context: T; dir: string }> {
  reapOrphanTempProfiles(pool);
  let dir = claimTempProfile(pool, selectProfile(pool));
  clearStaleSingletons(dir);
  let context: T;
  try {
    context = await open(dir);
  } catch (err) {
    // A chrome that dies without cleaning up leaves its singleton files behind
    // and every later launch refuses the profile. If the lock went stale during
    // this launch, clear it and retry once rather than making the user delete
    // files by hand.
    if (clearStaleSingletons(dir)) {
      log('retrying launch after clearing a stale profile lock');
      context = await open(dir);
    } else if (!pool.override?.() && isOccupied(dir)) {
      // Lost a start-up race: a sibling instance took this slot between the
      // occupancy check and the launch. Re-select once — contention must never
      // hard-fail a fetch. An override is pinned to its one dir and still throws.
      dir = claimTempProfile(pool, selectProfile(pool));
      log(`profile was taken mid-launch — retrying on ${dir}`);
      context = await open(dir);
    } else throw err;
  }
  return { context, dir };
}

/**
 * Make sure a temp fallback profile is a private dir of this user before chrome
 * writes into it. Pooled slots live under the user's own cache dir; the temp
 * fallback lives in the shared os.tmpdir() under a guessable name (mark,
 * workspace hash, pid). Chrome creates a missing profile dir 0700, but it takes
 * an EXISTING path as it finds it — a dir another local user made, or a symlink
 * to one — and a browser_* profile holds whatever logins the model clicked
 * through. So the dir is created here, 0700 and non-recursive, and a pre-existing
 * one is used only when it is a real dir (not a symlink) owned by this uid with
 * no group/other bits. Anything else fails the launch loudly rather than writing
 * a profile somewhere another account controls. Other dirs pass through as-is.
 * win32: os.tmpdir() is the per-user %TEMP% and there is no uid or mode to read,
 * so only the symlink check applies. NOT VERIFIED ON WINDOWS.
 */
function claimTempProfile(pool: ProfilePool, dir: string): string {
  if (dir !== tempProfileDir(pool)) return dir;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return dir;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const st = fs.lstatSync(dir);
  const posix = process.platform !== 'win32';
  const uid = process.getuid?.();
  const ours =
    st.isDirectory() &&
    (!posix || ((uid === undefined || st.uid === uid) && (st.mode & 0o077) === 0));
  if (!ours)
    throw new Error(
      `refusing temp profile ${dir}: it already exists and is not a private directory owned by this user`,
    );
  return dir;
}

/** One headless stealth Chrome on a persistent profile: the fetch pool's, or a session's read profile. */
async function launchStealthProfile(dir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(dir, {
    channel: BROWSER_CHANNEL,
    headless: true,
    args: STEALTH_ARGS,
    // The private glibc a legacy host's browser was patched onto (stealth.ts).
    // undefined everywhere else, which Playwright reads as "not given". This
    // launch is already unsandboxed — Playwright's chromiumSandbox default is
    // false — so it needs nothing else for such a host.
    env: browserGlibcEnv(),
    ...stealthContextOptions,
  });
  await context.addInitScript(STEALTH_INIT);
  return context;
}

async function openProfile(dir: string): Promise<BrowserContext> {
  const context = await launchStealthProfile(dir);
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
  if (process.platform === 'win32') return lockfileState(dir) === 'live'; // NOT VERIFIED ON WINDOWS
  try {
    fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false; // no lock, or not a symlink — the slot is free
  }
  return !isStaleLock(dir);
}

/** What a Windows profile's `lockfile` says about who holds the profile. */
export type LockfileState = 'free' | 'stale' | 'live';

/** Open for write WITHOUT creating or truncating, then close at once. */
const openForWrite = (file: string): void => fs.closeSync(fs.openSync(file, 'r+'));

/**
 * The win32 occupancy probe. Chrome on Windows never creates the POSIX
 * Singleton* files (process_singleton_win.cc); it holds `<profile>/lockfile`
 * open for the life of the browser with GENERIC_WRITE, share mode
 * FILE_SHARE_READ only, and FILE_FLAG_DELETE_ON_CLOSE. So:
 *   - no file (ENOENT)              → 'free'
 *   - opens for write               → 'stale': nobody holds it. A chrome that lost
 *                                     power never ran its delete-on-close; chrome
 *                                     itself reclaims such a file (CREATE_ALWAYS
 *                                     succeeds), so the slot is usable and there is
 *                                     nothing for us to clear
 *   - any other error               → 'live': EBUSY is the sharing violation a
 *                                     running chrome's handle causes; EPERM/EACCES
 *                                     is a delete-pending or foreign-owned file.
 *                                     Conservative on purpose — a slot we cannot
 *                                     probe is a slot we do not take, and the pool's
 *                                     last resort is a temp dir, never a hard fail.
 * Existence alone is NOT the test: it would burn a slot for good after one power
 * loss. `'r+'` rather than `'w'` so a free dir never gets a lockfile of ours.
 * The probe holds its handle for one open/close; a sibling chrome starting in
 * exactly that instant would see a sharing violation and fail its launch once.
 *
 * Pure apart from `probe`, and platform-independent, so tests drive it on any
 * OS: real files cover 'free' and 'stale'; an injected probe throwing an EBUSY
 * errno covers 'live', which needs a real Windows sharing violation otherwise.
 * NOT VERIFIED ON WINDOWS.
 */
export function lockfileState(dir: string, probe: (file: string) => void = openForWrite): LockfileState {
  try {
    probe(path.join(dir, 'lockfile'));
    return 'stale';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'free' : 'live';
  }
}

/**
 * Reap `pool`'s pid-keyed temp profiles (any workspace's) left behind by an
 * instance that was killed before `closeBrowser()` or `closeUpstream()` could
 * run. Follows the reap pattern in tools/session.ts: only MARK-ed dirs are eligible and an owner
 * that might still be alive is never touched — here the dir name IS the record
 * (the pid is in it), so there is no registry file to keep in sync, and no
 * process to kill: the browser is this module's own Playwright child, which dies
 * with it. Pooled profiles are persistent and are never reaped.
 */
function reapOrphanTempProfiles(pool: ProfilePool): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return; // no readable tmpdir — nothing to reap
  }
  for (const name of entries) {
    if (!name.startsWith(pool.tempMark)) continue;
    const pid = Number(name.slice(name.lastIndexOf('-') + 1)); // the pid is always last
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
export async function closeBrowser({ keepTemp = false } = {}): Promise<void> {
  const pending = ctxPromise;
  const handle = liveHandle;
  ctxPromise = undefined;
  liveContext = undefined;
  liveHandle = undefined;
  const done = (async () => {
    if (pending) await pending.then((ctx) => ctx.close()).catch(() => {});
    handle?.done();
  })();
  closing = done;
  await done;
  if (closing === done) closing = undefined;
  // An idle close keeps the temp fallback: the relaunch takes the first free
  // slot again, and this pid's temp dir is still ours either way.
  if (!keepTemp) dropTempProfile(FETCH_POOL);
}

/** Remove this process's temp fallback profile for `pool`, if one was ever made. */
export function dropTempProfile(pool: ProfilePool): void {
  try {
    fs.rmSync(tempProfileDir(pool), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── named-session reads ─────────────────────────────────────────────────────────

/**
 * Where web_fetch({session}) and the session_status probe read a named session:
 * one persistent profile per name. PLAYWRIGHT_MCP_READ_PROFILES overrides it (the
 * tests use it).
 *
 * WHY persistent. Every such read used to cold-launch a fresh headless Chrome with
 * only the saved cookies in it: no cache, no localStorage or IndexedDB the site's
 * scripts had written, no history with the site at all, every single time. That is
 * a new device on every request, and eBay's bot defences (Akamai, Radware) treated
 * it as one (2026-11-23). A profile per name keeps all of that between reads.
 *
 * WHY not the login profile session_login keeps for the same name
 * (login-profiles/<name>, tools/session.ts dedicatedProfileDir). That one belongs
 * to the human's headed captures, and the trust it carries is the reason it
 * exists. A headless read in it would leave its own bot-manager state there, the
 * very state that got eBay's jar flagged, and the next login would meet it.
 * Playwright also launches Chrome with --password-store=basic while the login
 * window is a plain Chrome on the desktop keyring, so the two would not even read
 * each other's cookie store. So a sibling root, only ever driven headless.
 */
export function readProfilesDir(): string {
  return (
    process.env.PLAYWRIGHT_MCP_READ_PROFILES ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'playwright-mcp', 'read-profiles')
  );
}

/** The read profile for one session name, owner-only: it holds that session's logged-in jar. */
function readProfileDir(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || /^\.+$/.test(safe)) throw new Error(`session name ${JSON.stringify(name)} cannot name a read profile`);
  const root = readProfilesDir();
  const dir = path.join(root, safe);
  for (const d of [root, dir]) {
    ownerOnlyDir(d);
    if (process.platform !== 'win32') fs.chmodSync(d, 0o700);
  }
  return dir;
}

/**
 * One read at a time per profile in this process, from launch through write-back.
 * Two Chromes cannot share a user-data-dir, and two write-backs of one session
 * would race. A read waits for the one ahead of it rather than falling back, so
 * every read of a name gets the profile.
 */
const readLocks = new Map<string, Promise<void>>();
async function lockReadProfile(key: string): Promise<() => void> {
  const ahead = readLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = ahead.then(() => mine);
  readLocks.set(key, tail);
  await ahead;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (readLocks.get(key) === tail) readLocks.delete(key);
  };
}

/** Which saved jar a read profile was last seeded from or wrote back. Inside the profile, so it goes with it. */
const SEED_STAMP = '.pwmcp-session-seed';
const stampOf = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Put the saved session into the profile. The FILE is the identity, never the
 * profile: its cookies replace the profile's on every read, so a re-capture takes
 * effect at once and whatever a headless read was handed by a bot defence and kept
 * out of the file (keepSavedBotCookies) does not live on in the profile either.
 * What carries over between reads is the rest: cache, localStorage, IndexedDB.
 *
 * Only when the file is one this profile has not seen (a new capture, or the first
 * read) is its whole storageState applied, localStorage with it. setStorageState
 * clears every origin's storage first, so doing that on every read would throw the
 * carried-over state away.
 */
async function seedFromSession(context: BrowserContext, dir: string, file: string): Promise<void> {
  const text = fs.readFileSync(file, 'utf8');
  const state = JSON.parse(text) as Parameters<BrowserContext['setStorageState']>[0] & object;
  let seen = '';
  try {
    seen = fs.readFileSync(path.join(dir, SEED_STAMP), 'utf8').trim();
  } catch {
    /* never seeded */
  }
  if (seen !== stampOf(text)) {
    await context.setStorageState(state);
    fs.writeFileSync(path.join(dir, SEED_STAMP), stampOf(text), { mode: 0o600 });
    return;
  }
  await context.clearCookies();
  await context.addCookies(state.cookies ?? []);
}

export interface SessionContext {
  context: BrowserContext;
  /** The read profile it runs on; undefined on the ephemeral fallback. */
  profile?: string;
  /** Close the browser and let the next read of this name in. Never throws. */
  close(): Promise<void>;
}

/**
 * A headless stealth context carrying the named session, for one read. Its
 * persistent read profile when that can be had; otherwise, exactly as before, an
 * ephemeral browser seeded from the file. The fallback covers a profile another
 * process holds (a second MCP server on this account reading the same name) and
 * any failure to launch or seed on the profile: a read never fails for want of it.
 *
 * Hold the result only for the one read, and call writeBackSessionJar before close().
 */
export async function openSessionContext(name: string, file: string): Promise<SessionContext> {
  let dir: string | undefined;
  try {
    dir = readProfileDir(name);
  } catch (err) {
    log(`session "${name}": no read profile (${err instanceof Error ? err.message : String(err)}); reading ephemeral`);
  }
  if (dir) {
    const release = await lockReadProfile(dir);
    let context: BrowserContext | undefined;
    let tracker: BrowserHandle | undefined;
    try {
      clearStaleSingletons(dir);
      if (isOccupied(dir)) throw new Error('another process is reading with it');
      context = await launchStealthProfile(dir);
      // Registered for ownership, status and shutdown. Call-scoped, so never
      // idle-closed: it closes when its one read is done.
      const ctx = context;
      const handle = (tracker = trackBrowser({ kind: 'read-profile', userDataDir: dir, session: name, close: () => ctx.close() }));
      await seedFromSession(context, dir, file);
      return {
        context: ctx,
        profile: dir,
        close: async () => {
          await ctx.close().catch(() => {});
          handle.done();
          release();
        },
      };
    } catch (err) {
      await context?.close().catch(() => {});
      tracker?.done();
      release();
      log(`session "${name}": read profile unavailable (${err instanceof Error ? err.message : String(err)}); reading ephemeral`);
    }
  }
  const browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
  const handle = trackBrowser({ kind: 'read-profile', session: name, close: () => browser.close() });
  try {
    const context = await browser.newContext({ ...stealthContextOptions, storageState: file });
    await context.addInitScript(STEALTH_INIT);
    return {
      context,
      close: async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        handle.done();
      },
    };
  } catch (err) {
    await browser.close().catch(() => {});
    handle.done();
    throw err;
  }
}

/**
 * Rolling write-back after a headless read that came back as content: the
 * refreshed jar over the saved one, so each read prolongs the session instead of
 * letting it age toward its capture-time expiry. Two things are never written:
 *
 *   - a bot-manager cookie from this read (keepSavedBotCookies): the saved ones,
 *     earned by the human, stay as they are;
 *   - over the human's own capture without a copy: the first write-back after a
 *     capture keeps that capture once, as humanCapturePath(file).
 *
 * Throws on a failed write; callers treat the write-back as best-effort.
 */
export async function writeBackSessionJar(context: BrowserContext, file: string, profile?: string): Promise<void> {
  const refreshed = (await context.storageState()) as Jar;
  const savedText = fs.readFileSync(file, 'utf8');
  let saved: Jar = {};
  try {
    saved = JSON.parse(savedText) as Jar;
  } catch {
    /* a corrupt file has no cookies worth keeping */
  }
  const human = humanCapturePath(file);
  if (!fs.existsSync(human)) {
    try {
      fs.writeFileSync(human, savedText, { mode: 0o600, flag: 'wx' });
      reassertOwnerOnly(human);
    } catch {
      /* another write-back made it first, or it cannot be made; the write-back goes on */
    }
  }
  const text = JSON.stringify(keepSavedBotCookies(saved, refreshed));
  fs.writeFileSync(file, text);
  reassertOwnerOnly(file); // never throws; a failure is a stderr warning, not silence
  // This profile now holds what the file says, so the next read reseeds cookies only.
  if (profile) fs.writeFileSync(path.join(profile, SEED_STAMP), stampOf(text), { mode: 0o600 });
}
