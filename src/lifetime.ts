/**
 * lifetime.ts — every browser this server launches belongs to it, is closed when
 * nothing has used it for a while, and dies with it.
 *
 * Why this module exists
 * ----------------------
 * 2026-11-24 ~11:06: four headless Chromes launched by playwright-mcp servers were
 * still running, 45 processes and 4.4 GB RSS, with the machine 11 GB into swap.
 * Three had sat at ~0% CPU for 11+ hours. Two servers (one per Claude session)
 * owned them: web_fetch's shared profile, an ephemeral launch, profile-3 and the
 * browser_* browser. Every MCP server is a long-lived stdio process, one per
 * Claude Code or Codex session, and a browser launched once stayed up for as long
 * as that session did. Nothing closed an idle one, and nothing noticed the client
 * going away: the SDK's stdio transport ignores stdin EOF, Playwright's own
 * SIGHUP handler closes browsers but takes away Node's default exit, and Chrome's
 * pipes keep the event loop alive. The user's words: "there needs to be a way
 * through the playwright-mcp that we use to assign the browser to a session and
 * make sure they get closed when they are no longer needed", and "this should
 * never happen again".
 *
 * So:
 *   - OWNERSHIP. Every launch site calls trackBrowser(). The browser's root pid
 *     (found in /proc: Playwright spawns Chrome detached, so it is a direct child
 *     of this process and its own process-group leader), its user-data-dir, kind,
 *     launch time and last use are written to one file per server,
 *     <cache>/playwright-mcp/browsers/<server pid>.json, with the client that owns
 *     the server (parent pid, CLAUDE_CODE_SESSION_ID, initialize's clientInfo).
 *     One writer per file, so there is no read-modify-write race to lose.
 *   - IDLE CLOSE. A browser whose kind allows it (web_fetch's shared profile, the
 *     browser_* browser) closes after PLAYWRIGHT_MCP_BROWSER_IDLE_MS (10 min) with
 *     no use, and the next call relaunches it. Never while it is in use: a fetch
 *     holding a page, a browser_* call running, a lease held, a waiter queued.
 *     Call-scoped browsers (read profiles, movie, captures) close in their own
 *     `finally`; a capture waits on a human with no time limit and is never
 *     idle-closed.
 *   - SHUTDOWN. closeAllBrowsers() closes gracefully with a deadline, then kills
 *     each browser's whole process group; an 'exit' hook does the same
 *     synchronously as the last resort. src/index.ts calls it on every way the
 *     client can leave (watchOwner).
 *   - REAPER. At start and every few minutes: browsers in another server's file
 *     whose owner is dead are killed and the file removed; an UNREGISTERED Chrome
 *     on a playwright-mcp profile is killed only when it has been orphaned
 *     (its launcher is gone). See planReap for the rule.
 *
 * Linux, macOS and Windows: the process table comes from src/proctable.ts (/proc,
 * one `ps`, or one PowerShell CIM query, each with a timeout). A tree is killed by
 * process group on Linux and macOS (Chrome is spawned detached and leads its own)
 * and with `taskkill /T /F` on Windows, which has no groups. VERIFIED ON REAL
 * LINUX ONLY; macOS and Windows are tested only against hand-written fixtures in
 * the documented ps / CIM formats.
 *
 * No import-time side effects: tests import this through browser.ts and
 * upstream.ts. Timers start only from startLifetime(), and every one is unref'd.
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  PLATFORM,
  readProc,
  rssOf,
  snapshot,
  snapshotSync,
  taskkillTree,
  type Platform,
  type ProcInfo,
} from './proctable.js';

export type { ProcInfo } from './proctable.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:lifetime]', ...args);

export type BrowserKind = 'web_fetch' | 'read-profile' | 'browser_*' | 'movie' | 'capture' | 'solve' | 'other';

/** One browser, as the registry file records it. */
export interface BrowserEntry {
  id: string;
  kind: BrowserKind;
  /** Chrome's root process, its group, and its start time (clock ticks since boot, /proc/<pid>/stat). */
  pid?: number;
  pgid?: number;
  start?: number;
  userDataDir?: string;
  /** The session a browser_* or read-profile browser carries. A name, never its contents. */
  session?: string;
  launchedAt: string;
  lastUsedAt: string;
  /** In use at the last write: a held page, a running call, a lease, a waiting human. */
  inUse: boolean;
  /** Whether idle close applies to it at all. */
  idleClose: boolean;
  /**
   * false for a Chrome on the user's REAL profile (a capture driven in place):
   * listed, killed by its own server's shutdown, never by another server's reaper.
   */
  reapable?: boolean;
}

/** The file one server keeps. */
export interface ServerFile {
  format: 1;
  server: { pid: number; start?: number; version?: string; startedAt: string };
  client: { pid: number; session?: string; name?: string };
  browsers: BrowserEntry[];
}

export interface TrackOptions {
  kind: BrowserKind;
  userDataDir?: string;
  /** Known root pid (a Chrome we spawned ourselves). Otherwise found in /proc. */
  pid?: number;
  session?: string;
  /** Close it for idle or to make room. Must not throw; must leave it untracked (call done()). */
  close: () => Promise<void>;
  /** Default false: only kinds that relaunch transparently may be idle-closed. */
  idleClose?: boolean;
  /** True while something outside this module is using it (a lease, a queued call). */
  busy?: () => boolean;
  /** Default true. false: another server's reaper never kills it (see BrowserEntry). */
  reapable?: boolean;
}

export interface BrowserHandle {
  readonly id: string;
  /** It was just used: restart its idle clock. */
  touch(): void;
  /** Mark it in use until the returned function is called. Idempotent release. */
  hold(): () => void;
  /** It is closed: forget it. Idempotent. */
  done(): void;
}

interface Tracked {
  entry: BrowserEntry;
  holds: number;
  close: () => Promise<void>;
  busy?: () => boolean;
  closing?: Promise<void>;
}

const tracked = new Map<string, Tracked>();

// ── settings ────────────────────────────────────────────────────────────────

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_MAX_BROWSERS = 3;
const REAP_EVERY_MS = 5 * 60_000;
/** How long a graceful close gets before the process group is killed. */
export const CLOSE_GRACE_MS = 3_000;

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** PLAYWRIGHT_MCP_BROWSER_IDLE_MS tunes it; read per call so a test can set it before starting. */
export const idleMs = () => envNumber('PLAYWRIGHT_MCP_BROWSER_IDLE_MS', DEFAULT_IDLE_MS);
/** Live browsers one server keeps before a new launch closes the least recently used idle one. */
export const maxBrowsers = () => envNumber('PLAYWRIGHT_MCP_MAX_BROWSERS', DEFAULT_MAX_BROWSERS);

const cacheRoot = () => process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');

/** Where every server's file lives. PLAYWRIGHT_MCP_BROWSER_REGISTRY overrides it (the tests use it). */
export function registryDir(): string {
  return process.env.PLAYWRIGHT_MCP_BROWSER_REGISTRY ?? path.join(cacheRoot(), 'playwright-mcp', 'browsers');
}

// ── the process table ──────────────────────────────────────────────────────

/** The newest table, for the few readers that cannot wait for one (the file's own start time). */
let lastTable: Map<number, ProcInfo> | undefined;
let snapshotFailureLogged = false;

/** A snapshot, remembered as the newest; a failure is logged once and reads as "no table". */
async function loadTable(): Promise<{ ok: boolean; table: Map<number, ProcInfo> }> {
  const snap = await snapshot();
  if (snap.ok) lastTable = snap.table;
  else if (!snapshotFailureLogged && PLATFORM !== 'other') {
    snapshotFailureLogged = true;
    log(`could not read the process table (${snap.error}); the reaper kills nothing until it can`);
  }
  return snap;
}

/** Every process on the machine, synchronously (Linux reads /proc; elsewhere one child process). */
export function procTable(): Map<number, ProcInfo> {
  const snap = snapshotSync();
  if (snap.ok) lastTable = snap.table;
  return snap.table;
}

/**
 * The user-data-dir of a Chrome ROOT process, or undefined for anything else. A
 * root has no --type; its helpers (zygote, renderer, gpu, crashpad) all do. On
 * Linux the root's argv is NUL-split and the helpers rewrite theirs into one
 * string; macOS and Windows give one command string, where the dir may be quoted
 * (Windows quotes a path with spaces) and runs to the next " --" flag.
 */
export function chromeRootDir(p: ProcInfo): string | undefined {
  if (p.argv && p.argv.length >= 2) {
    if (p.argv.some((a) => a.startsWith('--type='))) return undefined;
    return p.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
  }
  const cmd = p.command;
  if (!cmd || /(^|\s)--type=/.test(cmd)) return undefined;
  const m = /(?:^|\s)("?)--user-data-dir=/.exec(cmd);
  if (!m) return undefined;
  const rest = cmd.slice(m.index + m[0].length);
  // Quoted, either the value ("--user-data-dir=\"C:\…\"") or the whole argument.
  if (rest.startsWith('"')) return rest.slice(1).split('"')[0];
  if (m[1] === '"') return rest.split('"')[0];
  // Unquoted. A Windows path holds no space here (Node quotes any argument that
  // has one), so it ends at the first space; ps on macOS never quotes, so a path
  // there runs to the next flag.
  const value = rest.split(/\s--/)[0].trimEnd();
  return /^[A-Za-z]:\\/.test(value) ? value.split(/\s/)[0] : value;
}

/** The process and everything under it, root first. */
export function treeOf(root: number, table: Map<number, ProcInfo>): ProcInfo[] {
  const out: ProcInfo[] = [];
  const top = table.get(root);
  if (!top) return out;
  out.push(top);
  for (let i = 0; i < out.length; i++)
    for (const p of table.values())
      if (p.ppid === out[i].pid && p.pid !== out[i].pid && !out.includes(p) && p.start >= out[i].start) out.push(p);
  return out;
}

/** Resident memory of a whole tree, in bytes. */
export function treeRss(root: number, table: Map<number, ProcInfo>): number {
  return treeOf(root, table).reduce((sum, p) => sum + rssOf(p), 0);
}

/** This process's start time, so a reused pid is never mistaken for it. */
const selfStart = (): number | undefined => readProc(process.pid)?.start ?? lastTable?.get(process.pid)?.start;

/** Alive AND the same process: a pid that was reused since `start` was read is a different one. */
export function sameProcess(table: Map<number, ProcInfo>, pid: number, start?: number): boolean {
  const p = table.get(pid);
  return p !== undefined && (start === undefined || p.start === start);
}

/**
 * The Chrome roots this process launched that no tracked browser has claimed yet:
 * direct children with a user-data-dir and no --type.
 */
function unclaimedChildren(table: Map<number, ProcInfo>): ProcInfo[] {
  const claimed = new Set([...tracked.values()].map((t) => t.entry.pid));
  return [...table.values()].filter(
    (p) => p.ppid === process.pid && chromeRootDir(p) !== undefined && !claimed.has(p.pid),
  );
}

/** Fill in the root pid, group and start of an entry that has none, from a process table. */
function discover(entry: BrowserEntry, table: Map<number, ProcInfo>): void {
  if (entry.pid === undefined) {
    const candidates = unclaimedChildren(table);
    const exact = entry.userDataDir
      ? candidates.find((p) => samePath(chromeRootDir(p)!, entry.userDataDir!))
      : undefined;
    // An ephemeral launch's dir is Playwright's own temp name, unknown in advance:
    // the newest unclaimed child on such a dir is the one that just started. A
    // persistent profile launching beside it at the same moment is never taken.
    const ephemeral = candidates
      .filter((p) => /playwright_chromiumdev_profile-[^\\/]*$/.test(chromeRootDir(p)!))
      .sort((a, b) => b.start - a.start);
    const pick = exact ?? (entry.userDataDir ? undefined : ephemeral[0]);
    if (!pick) return;
    entry.pid = pick.pid;
    entry.userDataDir ??= chromeRootDir(pick);
  }
  const p = table.get(entry.pid);
  if (p) {
    entry.pgid = p.pgid;
    entry.start ??= p.start;
    entry.userDataDir ??= chromeRootDir(p);
  }
}

// ── the registry file ──────────────────────────────────────────────────────

interface Owner {
  clientPid: number;
  session?: string;
  name?: string;
  version?: string;
  startedAt: string;
  start?: number;
}

const owner: Owner = {
  clientPid: process.ppid,
  session: process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || undefined,
  startedAt: new Date().toISOString(),
};

/** Set the client name and version from initialize, and the version of this server. */
export function setOwnerInfo(info: { clientName?: string; version?: string }): void {
  if (info.clientName) owner.name = info.clientName;
  if (info.version) owner.version = info.version;
  writeSoon();
}

const ownFile = () => path.join(registryDir(), `${process.pid}.json`);

function ownServerFile(): ServerFile {
  owner.start ??= selfStart();
  return {
    format: 1,
    server: { pid: process.pid, start: owner.start, version: owner.version, startedAt: owner.startedAt },
    client: { pid: owner.clientPid, session: owner.session, name: owner.name },
    browsers: [...tracked.values()].map((t) => ({ ...t.entry, inUse: inUse(t) })),
  };
}

let registryOn = false;

/**
 * Write this server's file: a temp file in the same dir, mode 600, renamed over
 * the old one, so a reader never sees half of it. Never throws: losing the file
 * costs visibility and the cross-server reap, never a tool call.
 */
export function writeRegistry(): void {
  if (!registryOn) return;
  try {
    const dir = registryDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const tmp = path.join(dir, `.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(ownServerFile(), null, 1), { mode: 0o600 });
    fs.renameSync(tmp, ownFile());
  } catch (err) {
    log(`could not write the browser registry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let writeTimer: NodeJS.Timeout | undefined;
/** Coalesce the writes a burst of touches would make. */
function writeSoon(): void {
  if (!registryOn || writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = undefined;
    writeRegistry();
  }, 1_000);
  writeTimer.unref();
}

function removeOwnFile(): void {
  try {
    fs.rmSync(ownFile(), { force: true });
  } catch {
    /* best effort */
  }
}

/** Every server file on this machine. A corrupt one is skipped, not fatal. */
export function readRegistries(): { file: string; data: ServerFile }[] {
  const dir = registryDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; data: ServerFile }[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ServerFile;
      if (data?.format === 1 && typeof data.server?.pid === 'number' && Array.isArray(data.browsers))
        out.push({ file, data });
    } catch {
      /* mid-rename or corrupt: the next pass reads it */
    }
  }
  return out;
}

// ── tracking ────────────────────────────────────────────────────────────────

const inUse = (t: Tracked) => t.holds > 0 || (t.busy?.() ?? false) || t.closing !== undefined;

/**
 * Register a browser this server just launched. Every chromium.launch,
 * launchPersistentContext and Chrome spawn in src/ goes through here
 * (scripts/test-browser-ownership.mjs checks that no new one skips it).
 */
export function trackBrowser(opts: TrackOptions): BrowserHandle {
  const now = new Date().toISOString();
  const entry: BrowserEntry = {
    id: randomBytes(6).toString('hex'),
    kind: opts.kind,
    pid: opts.pid,
    userDataDir: opts.userDataDir,
    session: opts.session,
    launchedAt: now,
    lastUsedAt: now,
    inUse: false,
    idleClose: opts.idleClose ?? false,
    ...(opts.reapable === false ? { reapable: false } : {}),
  };
  // Linux finds the pid at once from /proc; elsewhere a snapshot is a child
  // process, so the next sweep tick finds it from the one snapshot it takes.
  if (PLATFORM === 'linux') discover(entry, procTable());
  const t: Tracked = { entry, holds: 0, close: opts.close, busy: opts.busy };
  tracked.set(entry.id, t);
  writeRegistry();
  void makeRoom(entry.id);
  return {
    id: entry.id,
    touch: () => {
      entry.lastUsedAt = new Date().toISOString();
      writeSoon();
    },
    hold: () => {
      t.holds += 1;
      entry.lastUsedAt = new Date().toISOString();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        t.holds -= 1;
        entry.lastUsedAt = new Date().toISOString();
        writeSoon();
      };
    },
    done: () => {
      if (tracked.delete(entry.id)) writeRegistry();
    },
  };
}

/** What this server has open right now. Copies; for tests and the status view. */
export function trackedBrowsers(): (BrowserEntry & { holds: number })[] {
  return [...tracked.values()].map((t) => ({ ...t.entry, inUse: inUse(t), holds: t.holds }));
}

/** Close one tracked browser through its own close, at most once at a time. */
function closeTracked(t: Tracked, why: string): Promise<void> {
  t.closing ??= (async () => {
    log(`closing ${t.entry.kind} browser${t.entry.pid ? ` (pid ${t.entry.pid})` : ''}: ${why}`);
    try {
      await t.close();
    } catch (err) {
      log(`close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })().finally(() => {
    t.closing = undefined;
  });
  return t.closing;
}

/**
 * One idle pass. A browser is closed when its kind allows it, nothing holds it,
 * nothing outside says it is busy, and it was last used longer than idleMs ago.
 * Being busy counts as being used, so a lease that ends after a long hold gets
 * the full idle time from then, not from its last call. `now` is injectable so
 * the unit tests drive it without waiting.
 */
export async function sweepIdle(now = Date.now()): Promise<number> {
  const limit = idleMs();
  const due: Tracked[] = [];
  for (const t of tracked.values()) {
    if (!t.entry.idleClose || t.closing) continue;
    if (inUse(t)) {
      t.entry.lastUsedAt = new Date(now).toISOString();
      continue;
    }
    if (now - Date.parse(t.entry.lastUsedAt) >= limit) due.push(t);
  }
  await Promise.all(due.map((t) => closeTracked(t, `idle for ${Math.round(limit / 1000)}s`)));
  if (due.length) writeRegistry();
  return due.length;
}

/**
 * The per-server cap. Each kind is already one at a time by construction (one
 * web_fetch context, one browser_* connection, one read per session name), so
 * this only bites when several kinds are up at once: past maxBrowsers, the least
 * recently used idle-closable browser that nothing is using AND nothing has used
 * for CAP_QUIET_MS closes. Never queues a launch, never closes one in use or just
 * used (an unleased browser_* caller between two calls would lose its tabs),
 * never closes the one just launched. When every candidate is busy, the launch
 * simply goes over the cap.
 */
const CAP_QUIET_MS = 60_000;
export async function makeRoom(justLaunched: string, now = Date.now()): Promise<void> {
  const live = [...tracked.values()].filter((t) => !t.closing);
  if (live.length <= maxBrowsers()) return;
  const victim = live
    .filter((t) => t.entry.id !== justLaunched && t.entry.idleClose && !inUse(t))
    .filter((t) => now - Date.parse(t.entry.lastUsedAt) >= CAP_QUIET_MS)
    .sort((a, b) => Date.parse(a.entry.lastUsedAt) - Date.parse(b.entry.lastUsedAt))[0];
  if (victim) await closeTracked(victim, `over the cap of ${maxBrowsers()} browsers per server; least recently used`);
}

// ── killing ─────────────────────────────────────────────────────────────────

/**
 * Signal a browser's whole tree. Windows: `taskkill /T /F`, since it has no
 * process groups (and no signals to speak of). Elsewhere a group kill when the
 * root leads its own group (Playwright and session.ts both spawn Chrome
 * detached) and that group is not ours; otherwise each process of the tree,
 * snapshotted before the root goes.
 */
export function signalTree(pid: number, signal: NodeJS.Signals, table: Map<number, ProcInfo>, sync = false): void {
  if (PLATFORM === 'win32') return taskkillTree(pid, sync);
  const root = table.get(pid);
  const ownGroup = table.get(process.pid)?.pgid;
  if (root && root.pgid === pid && pid !== ownGroup) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* fall through to the per-process kill */
    }
  }
  const tree = root ? treeOf(pid, table) : [];
  for (const p of tree.length ? tree : [{ pid } as ProcInfo]) {
    try {
      process.kill(p.pid, signal);
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** SIGTERM the tree, wait up to `graceMs` for it, then SIGKILL whatever of it is left. */
export async function killTree(pid: number, start?: number, graceMs = 2_000): Promise<void> {
  let { table } = await loadTable();
  if (!sameProcess(table, pid, start)) return;
  const tree = treeOf(pid, table);
  signalTree(pid, 'SIGTERM', table);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(PLATFORM === 'linux' ? 100 : 500);
    table = (await loadTable()).table;
    if (!tree.some((p) => sameProcess(table, p.pid, p.start))) return;
  }
  if (sameProcess(table, pid, start)) signalTree(pid, 'SIGKILL', table);
  if (PLATFORM === 'win32') return;
  for (const p of tree)
    if (sameProcess(table, p.pid, p.start))
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
}

/** SIGKILL every browser this server still has a pid for, and every Chrome child it launched. Sync. */
function killEverythingNow(): void {
  if (PLATFORM === 'other') return;
  // Nothing to look for: skip the snapshot (a child process off Linux).
  if (PLATFORM !== 'linux' && tracked.size === 0) return;
  const { ok, table } = snapshotSync();
  if (!ok) return;
  const roots = new Set<number>();
  for (const t of tracked.values())
    if (t.entry.pid && sameProcess(table, t.entry.pid, t.entry.start)) roots.add(t.entry.pid);
  for (const p of table.values()) if (p.ppid === process.pid && chromeRootDir(p) !== undefined) roots.add(p.pid);
  for (const pid of roots) signalTree(pid, 'SIGKILL', table, true);
}

let shuttingDown: Promise<void> | undefined;

/**
 * Close every browser this server owns: each through its own close, all at once,
 * for at most `graceMs`; then kill what is left, process groups and all. The
 * callers' own closes (closeUpstream, closeBrowser) run alongside, from
 * src/index.ts. Idempotent.
 */
export function closeAllBrowsers(graceMs = CLOSE_GRACE_MS): Promise<void> {
  shuttingDown ??= (async () => {
    stopTimers();
    const closes = [...tracked.values()].map((t) => closeTracked(t, 'server shutting down'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled(closes), new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
    clearTimeout(timer);
    killEverythingNow();
    tracked.clear();
    removeOwnFile();
  })();
  return shuttingDown;
}

// ── the reaper ─────────────────────────────────────────────────────────────

/**
 * The profiles only playwright-mcp launches Chrome on (and Playwright's generic
 * temp profile, which an ephemeral launch here uses). Anchored, so the human's
 * login-profiles/<name>, their own Chrome and anything else never match.
 */
export function profilePatterns(platform: Platform = PLATFORM): RegExp[] {
  const cache = path.join(cacheRoot(), 'playwright-mcp');
  let msp: string | undefined;
  try {
    const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle');
    msp = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registry.registryDirectory;
  } catch {
    /* no playwright registry: that family is simply not matched */
  }
  return buildPatterns(
    {
      cache,
      readProfiles: process.env.PLAYWRIGHT_MCP_READ_PROFILES ?? path.join(cache, 'read-profiles'),
      msp,
      tmp: os.tmpdir(),
    },
    platform,
  );
}

/** The patterns from explicit roots, so a test can build another platform's set on this one. */
export function buildPatterns(
  roots: { cache: string; readProfiles: string; msp?: string; tmp: string },
  platform: Platform = PLATFORM,
): RegExp[] {
  const esc = (s: string) => normDir(s, platform).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = platform === 'win32' ? 'i' : '';
  return [
    new RegExp(`^${esc(roots.cache)}/profile(-\\d+)?$`, flags),
    new RegExp(`^${esc(roots.readProfiles)}/[^/]+$`, flags),
    ...(roots.msp ? [new RegExp(`^${esc(roots.msp)}/mcp-chrom(e|ium)-[0-9a-f]{7}(-\\d+)?$`, flags)] : []),
    new RegExp(`^${esc(roots.tmp)}/(playwright_chromiumdev_profile-[^/]+|pwmcp-(fetch|browser)-[^/]+)$`, flags),
  ];
}

/**
 * A dir as the patterns compare it: forward slashes, no trailing slash, and on
 * Windows the backslashes turned and the case folded (NTFS paths are
 * case-insensitive, and Chrome gets whatever spelling the launcher passed).
 */
export function normDir(dir: string, platform: Platform = PLATFORM): string {
  const d = platform === 'win32' ? dir.replace(/\\/g, '/').toLowerCase() : dir;
  return d.length > 1 ? d.replace(/\/+$/, '') : d;
}

const samePath = (a: string, b: string, platform: Platform = PLATFORM) => normDir(a, platform) === normDir(b, platform);

export const isPwmcpProfile = (dir: string, patterns = profilePatterns(), platform: Platform = PLATFORM) =>
  patterns.some((re) => re.test(normDir(dir, platform)));

/** What a reparented orphan's parent is on Linux: init, or the user's systemd acting as subreaper. */
const SUBREAPERS = new Set(['systemd', 'init']);

/**
 * Whether the process that launched `p` is gone, per platform:
 *   - Linux: reparented to pid 1 or to a systemd subreaper (`systemd --user`);
 *   - macOS: reparented to launchd, pid 1;
 *   - Windows: never reparents, so the parent pid no longer exists, or exists
 *     with a LATER creation time than `p` (the pid was reused by someone else).
 */
export function isOrphaned(p: ProcInfo, table: Map<number, ProcInfo>, platform: Platform = PLATFORM): boolean {
  const parent = table.get(p.ppid);
  if (platform === 'win32') return parent === undefined || parent.start > p.start;
  if (p.ppid === 1) return true;
  return platform === 'linux' && parent !== undefined && SUBREAPERS.has(parent.comm);
}

export interface ReapTarget {
  pid: number;
  start: number;
  userDataDir?: string;
  why: string;
}

export interface ReapPlan {
  kill: ReapTarget[];
  /** Server files whose owner is dead: delete after the kills. */
  staleFiles: string[];
}

/**
 * Decide what to reap. PURE over its inputs (a process table and the registry
 * files), so the unit tests drive every branch with a fake machine.
 *
 * The safety rule, in full:
 *   1. A REGISTERED browser is killed only when its owning server is dead (gone,
 *      or its pid now belongs to a process with a different start time) AND the
 *      Chrome is still the same process (same start time) and still a Chrome root
 *      on the recorded user-data-dir, and not marked unreapable (the user's real
 *      profile, driven in place by a capture). A live owner's browsers are never touched.
 *   2. An UNREGISTERED Chrome root is killed only when ALL of: it runs as this
 *      user; its user-data-dir is a playwright-mcp profile (profilePatterns); no
 *      live server's file lists it; and it has been ORPHANED, i.e. its parent is
 *      init or a systemd subreaper, which is where Chrome lands when the process
 *      that launched it is gone (isOrphaned, per platform). A Chrome whose parent is alive is never killed,
 *      whatever that parent is: Playwright's temp profile is shared by every
 *      Playwright program, the user's own test runs included, so "the parent is
 *      not a playwright-mcp server" proves nothing about who needs it.
 */
export function planReap(
  table: Map<number, ProcInfo>,
  registries: { file: string; data: ServerFile }[],
  opts: { uid?: number; selfPid?: number; patterns?: RegExp[]; platform?: Platform } = {},
): ReapPlan {
  const selfPid = opts.selfPid ?? process.pid;
  const platform = opts.platform ?? PLATFORM;
  const uid = 'uid' in opts ? opts.uid : process.getuid?.();
  const patterns = opts.patterns ?? profilePatterns(platform);
  const kill: ReapTarget[] = [];
  const staleFiles: string[] = [];
  const liveClaims = new Set<number>();

  for (const { file, data } of registries) {
    if (data.server.pid === selfPid) continue;
    const alive = sameProcess(table, data.server.pid, data.server.start);
    if (alive) {
      for (const b of data.browsers) if (b.pid) liveClaims.add(b.pid);
      continue;
    }
    staleFiles.push(file);
    for (const b of data.browsers) {
      if (b.reapable === false) continue; // the user's real profile: never ours to kill
      if (!b.pid || !sameProcess(table, b.pid, b.start)) continue;
      const p = table.get(b.pid)!;
      const dir = chromeRootDir(p);
      if (dir === undefined || (b.userDataDir && !samePath(dir, b.userDataDir, platform))) continue;
      kill.push({ pid: b.pid, start: p.start, userDataDir: dir, why: `its server (pid ${data.server.pid}) is gone` });
    }
  }

  for (const p of table.values()) {
    if (liveClaims.has(p.pid) || kill.some((k) => k.pid === p.pid)) continue;
    if (p.ppid === selfPid) continue; // ours: tracked or about to be
    if (uid !== undefined && p.uid !== undefined && p.uid !== uid) continue;
    const dir = chromeRootDir(p);
    if (dir === undefined || !isPwmcpProfile(dir, patterns, platform)) continue;
    if (!isOrphaned(p, table, platform)) continue;
    kill.push({ pid: p.pid, start: p.start, userDataDir: dir, why: 'orphaned: the process that launched it is gone' });
  }
  return { kill, staleFiles };
}

/** Run one reap pass: plan it, kill, log each kill, drop the dead servers' files. */
export async function reapOrphans(): Promise<ReapTarget[]> {
  const { ok, table } = await loadTable();
  if (!ok) return []; // no table, no proof: kill nothing (logged once by loadTable)
  const plan = planReap(table, readRegistries());
  await Promise.all(
    plan.kill.map(async (k) => {
      log(`reaping Chrome pid ${k.pid} on ${k.userDataDir ?? 'an unknown profile'}: ${k.why}`);
      await killTree(k.pid, k.start);
    }),
  );
  for (const f of plan.staleFiles)
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* best effort */
    }
  return plan.kill;
}

// ── timers ──────────────────────────────────────────────────────────────────

let idleTimer: NodeJS.Timeout | undefined;
let reapTimer: NodeJS.Timeout | undefined;
let exitHooked = false;

function stopTimers(): void {
  clearInterval(idleTimer);
  clearInterval(reapTimer);
  clearTimeout(writeTimer);
  idleTimer = reapTimer = writeTimer = undefined;
}

/** One sweep tick: at most one process snapshot, and only when an entry still lacks its pid. */
let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const missing = [...tracked.values()].filter((t) => t.entry.pid === undefined);
    if (missing.length && PLATFORM !== 'other') {
      const { ok, table } = await loadTable();
      if (ok) {
        for (const t of missing) discover(t.entry, table);
        writeSoon();
      }
    }
    await sweepIdle();
  } finally {
    ticking = false;
  }
}

/**
 * Turn the registry, the idle sweep and the reaper on. Called once from main();
 * nothing here runs for a module that is only imported.
 */
export function startLifetime(opts: { version?: string; reap?: boolean } = {}): void {
  registryOn = true;
  if (opts.version) owner.version = opts.version;
  writeRegistry();
  const every = Math.max(250, Math.min(60_000, Math.floor(idleMs() / 4)));
  idleTimer = setInterval(() => void tick(), every);
  idleTimer.unref();
  // `reap: false` is for unit tests running on a real machine: they must never
  // kill anything outside their own fixtures.
  if (opts.reap !== false) {
    void reapOrphans().catch(() => {});
    reapTimer = setInterval(() => void reapOrphans().catch(() => {}), REAP_EVERY_MS);
    reapTimer.unref();
  }
  if (!exitHooked) {
    exitHooked = true;
    // The last resort, for a path that skipped closeAllBrowsers (an uncaught
    // throw, a process.exit elsewhere). 'exit' runs synchronously only.
    process.on('exit', () => {
      killEverythingNow();
      if (registryOn) removeOwnFile();
    });
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export interface StatusRow {
  serverPid: number;
  serverAlive: boolean;
  serverVersion?: string;
  clientPid?: number;
  clientSession?: string;
  clientName?: string;
  kind: BrowserKind | 'unregistered';
  pid?: number;
  alive: boolean;
  profile?: string;
  session?: string;
  ageSec?: number;
  idleSec?: number;
  inUse?: boolean;
  rssBytes?: number;
  /** Why an unregistered one is or is not reapable. */
  note?: string;
}

/**
 * Every browser on this machine a playwright-mcp server registered, plus Chromes
 * on playwright-mcp profiles that no file lists (a pre-0.10 server's, or an
 * orphan the reaper will take). Read-only: it reaps nothing.
 */
export async function browserStatus(now = Date.now()): Promise<StatusRow[]> {
  if (registryOn) writeRegistry();
  const { table } = await loadTable();
  const rows: StatusRow[] = [];
  const listed = new Set<number>();
  for (const { data } of readRegistries()) {
    const serverAlive = data.server.pid === process.pid || sameProcess(table, data.server.pid, data.server.start);
    for (const b of data.browsers) {
      if (b.pid) listed.add(b.pid);
      const alive = b.pid !== undefined && sameProcess(table, b.pid, b.start);
      rows.push({
        serverPid: data.server.pid,
        serverAlive,
        serverVersion: data.server.version,
        clientPid: data.client.pid,
        clientSession: data.client.session,
        clientName: data.client.name,
        kind: b.kind,
        pid: b.pid,
        alive,
        profile: b.userDataDir,
        session: b.session,
        ageSec: Math.round((now - Date.parse(b.launchedAt)) / 1000),
        idleSec: b.inUse ? 0 : Math.round((now - Date.parse(b.lastUsedAt)) / 1000),
        inUse: b.inUse,
        rssBytes: alive && b.pid ? treeRss(b.pid, table) : undefined,
      });
    }
  }
  const patterns = profilePatterns();
  const uid = process.getuid?.();
  for (const p of table.values()) {
    if (listed.has(p.pid) || (uid !== undefined && p.uid !== undefined && p.uid !== uid)) continue;
    const dir = chromeRootDir(p);
    if (dir === undefined || !isPwmcpProfile(dir, patterns)) continue;
    const parent = table.get(p.ppid);
    const orphaned = isOrphaned(p, table);
    rows.push({
      serverPid: p.ppid,
      serverAlive: !orphaned,
      kind: 'unregistered',
      pid: p.pid,
      alive: true,
      profile: dir,
      rssBytes: treeRss(p.pid, table),
      note: orphaned
        ? 'orphaned: the next reap pass of any playwright-mcp server closes it'
        : `launched by pid ${p.ppid} (${parent?.comm ?? '?'}), which is still running; ` +
          'an older playwright-mcp keeps it until that process exits',
    });
  }
  return rows;
}

const mb = (b?: number) => (b === undefined ? '-' : `${Math.round(b / 1048576)}M`);
const dur = (s?: number) =>
  s === undefined ? '-' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;

/** The status as a plain table, for `node dist/index.js --browsers`. */
export function formatStatus(rows: StatusRow[]): string {
  if (!rows.length) return 'No playwright-mcp browsers are running.\n';
  const head = ['SERVER', 'CLIENT', 'KIND', 'PID', 'AGE', 'IDLE', 'RSS', 'PROFILE'];
  const body = rows.map((r) => [
    `${r.serverPid}${r.serverAlive ? '' : ' (dead)'}`,
    r.clientPid ? `${r.clientPid}${r.clientSession ? ` ${r.clientSession.slice(0, 8)}` : ''}` : '-',
    r.kind,
    r.pid ? `${r.pid}${r.alive ? '' : ' (gone)'}` : '-',
    dur(r.ageSec),
    r.inUse ? 'in use' : dur(r.idleSec),
    mb(r.rssBytes),
    `${r.profile ?? '-'}${r.note ? `  # ${r.note}` : ''}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ');
  return [line(head), ...body.map(line)].join('\n') + '\n';
}

// ── the owner watch ─────────────────────────────────────────────────────────

/**
 * This process's parent as the kernel has it now, where that is cheap to read
 * (Linux). process.ppid is read once at start-up and never changes; elsewhere
 * the poll relies on the parent pid's liveness alone.
 */
function currentPpid(): number {
  return readProc(process.pid)?.ppid ?? process.ppid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Call `onGone` once, the first time the client is gone: stdin ends or closes,
 * the stdio transport closes, SIGTERM/SIGINT/SIGHUP, or the parent process dies
 * (polled every PLAYWRIGHT_MCP_PARENT_POLL_MS, 30s by default, since a SIGKILLed
 * parent sends nothing). Returns the trigger, for a caller with one more way to
 * learn of it (the transport's onclose). `stdio: false` leaves stdin and the parent alone: a
 * server whose job is the HTTP port (Docker's CMD has no stdin at all, and its
 * parent is pid 0) must not read either as its client leaving.
 */
export function watchOwner(onGone: (why: string) => void, opts: { stdio: boolean }): (why: string) => void {
  let fired = false;
  const fire = (why: string) => {
    if (fired) return;
    fired = true;
    log(`shutting down: ${why}`);
    onGone(why);
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => fire(sig));
  if (!opts.stdio) return fire;
  process.stdin.once('end', () => fire('stdin ended (the client closed the pipe)'));
  process.stdin.once('close', () => fire('stdin closed'));
  const parent = process.ppid;
  if (parent <= 1) return fire; // already reparented, or pid 1 in a container: nothing to watch
  const poll = setInterval(() => {
    if (currentPpid() !== parent || !pidAlive(parent)) fire(`the client process (pid ${parent}) is gone`);
  }, envNumber('PLAYWRIGHT_MCP_PARENT_POLL_MS', 30_000));
  poll.unref();
  return fire;
}
