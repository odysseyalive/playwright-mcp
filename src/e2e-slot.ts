/**
 * e2e-slot.ts — one machine-wide slot for e2e suites, shared by every
 * playwright-mcp server, every shell-launched suite and every session.
 *
 * Why this module exists
 * ----------------------
 * On 2026-11-25 several e2e runs at once locked up this 4-core laptop (load
 * average 16, CPU pressure ~50%). One session ran `npx playwright test
 * tests/journeys/workbook-pricing.spec.ts` behind its own per-project flock,
 * pushing ~1,100 requests a minute into a local container, while another ran a
 * live test with tmux test servers and a headless Chrome. src/queue.ts could not
 * have stopped it: it serializes browser_* calls inside ONE server, there are ~10
 * servers (one per Claude session), and a shell-launched suite never goes through
 * any of them. Francis: "your new queue should prevent that". Design agreed with
 * cpu-dev the same day; the usage numbers (ra-dev: ~372 tests over ~3.8 h about
 * daily, 3.5–60 min targeted runs, always `--workers=1 --retries=0`, started from
 * Bash by subagents whose tool calls time out) set the defaults below.
 *
 * The state is plain files, so any process can take part with no daemon:
 *
 *   <dir>/tickets/<id>.json   one per waiter or holder. The id starts with the
 *                             enqueue time in ms, zero-padded, so name order IS
 *                             queue order for every reader. Written to a temp
 *                             file and renamed into place: never seen half-written.
 *   <dir>/slots/<i>/<id>      the claim on slot i. A claim is a directory holding
 *                             one file named by the holder's ticket id, built
 *                             under a temp name and renamed into place. rename()
 *                             onto an existing non-empty directory fails, so of
 *                             two claimants exactly one wins, and that, not the
 *                             queue order, is what makes a holder. The order only
 *                             decides who may TRY.
 *   <dir>/logs/               detached runs' default logs.
 *   <dir>/wrapper.json        where the wrapper lives, for generated projects'
 *                             tests/e2e-slot.mjs (the installer puts nothing on
 *                             PATH).
 *
 * No flock: a lock file a dead holder leaves behind is the failure this replaces.
 * A ticket whose pid is gone, or whose pid now belongs to a process with another
 * start time (pid reuse, via src/proctable.ts), is dead, and any participant
 * drops it and breaks its claim. Breaking a claim unlinks that exact id file and
 * then rmdir()s, which fails when a successor has already renamed its own claim
 * in, so two participants judging the same holder dead can never remove the
 * claim of the one that came after it.
 *
 * Past its max hold a holder is reported OVERDUE, to waiters and in the status,
 * and never killed or preempted: breaking the slot mid-suite would recreate the
 * very overlap it exists to stop. Waiters give up after their max wait, naming
 * who holds the slot.
 *
 * browser_* calls never take, wait for or defer to this slot (cpu-dev,
 * 2026-11-25): a subagent drives the browser while its own work order's suite
 * holds the slot, so deferring would deadlock it against itself.
 *
 * The state is per user (it lives in the user's state directory): on this
 * machine every Claude session runs as the same user, which is the case it
 * exists for.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PLATFORM, readProc, snapshot, type ProcInfo } from './proctable.js';

// ── settings ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_HOLD_MS = 5 * 3_600_000;
const DEFAULT_MAX_WAIT_MS = 4 * 3_600_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_PROGRESS_MS = 60_000;
/** Off Linux a liveness check is a whole `ps` or PowerShell listing: reuse one this long. */
const SNAPSHOT_REUSE_MS = 30_000;
/** A temp file or claim directory this old was left by a crash mid-write. */
const TMP_STALE_MS = 10 * 60_000;
/** Detached logs older than this are pruned when the next detached run starts. */
const LOG_KEEP_MS = 7 * 24 * 3_600_000;
/** Other processes' cwd and command are shown to everyone: clamp them. */
const TEXT_MAX = 200;

/** The env marker a holder sets on its command, so a nested wrapper passes through. */
export const HELD_ENV = 'PLAYWRIGHT_MCP_E2E_SLOT_HELD';
/** The workers cap, exported to the command so a generated config can read it. */
export const WORKERS_ENV = 'PLAYWRIGHT_MCP_E2E_WORKERS';

/**
 * "5h", "90m", "30s", "1500ms", or a bare number of minutes. Returns undefined
 * for anything else, so a typo in a flag is an error and not a silent default.
 */
export function parseDuration(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const ms = unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'h' ? n * 3_600_000 : n * 60_000;
  return ms > 0 ? Math.round(ms) : undefined;
}

function envPositive(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Concurrent holders. PLAYWRIGHT_MCP_E2E_SLOTS, default 1. */
export const slotCount = () => envPositive('PLAYWRIGHT_MCP_E2E_SLOTS', 1);
/** PLAYWRIGHT_MCP_E2E_MAX_HOLD ("5h", "300m"…), default 5 h. Past it a holder is overdue, never killed. */
export const defaultMaxHoldMs = () => parseDuration(process.env.PLAYWRIGHT_MCP_E2E_MAX_HOLD) ?? DEFAULT_MAX_HOLD_MS;
/** PLAYWRIGHT_MCP_E2E_MAX_WAIT, default 4 h. */
export const defaultMaxWaitMs = () => parseDuration(process.env.PLAYWRIGHT_MCP_E2E_MAX_WAIT) ?? DEFAULT_MAX_WAIT_MS;
/** How often a waiter looks again. PLAYWRIGHT_MCP_E2E_POLL_MS (the tests make it fast). */
export const pollMs = () => envPositive('PLAYWRIGHT_MCP_E2E_POLL_MS', DEFAULT_POLL_MS);
/** How often a waiter says where it stands. PLAYWRIGHT_MCP_E2E_PROGRESS_MS. */
export const progressMs = () => envPositive('PLAYWRIGHT_MCP_E2E_PROGRESS_MS', DEFAULT_PROGRESS_MS);
/** Logical cores, counted the way Playwright counts them for "50%" (os.cpus().length). */
export const cpuCount = () => Math.max(1, os.cpus().length);
/** Upper limit on Playwright workers inside the slot. PLAYWRIGHT_MCP_E2E_WORKERS, default half the cores. */
export const workersCap = () => envPositive(WORKERS_ENV, Math.max(1, Math.floor(cpuCount() / 2)));

/**
 * Where the slot lives. PLAYWRIGHT_MCP_E2E_SLOT_DIR overrides it (the tests use
 * it, so they never touch the live slot); then %LOCALAPPDATA% on Windows, and
 * XDG_STATE_HOME or ~/.local/state elsewhere. tests/e2e-slot.mjs in the
 * templates mirrors this: change both together.
 */
export function slotDir(): string {
  if (process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR) return process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'playwright-mcp', 'state', 'e2e-slot');
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'playwright-mcp', 'e2e-slot');
}

const ticketsDir = () => path.join(slotDir(), 'tickets');
const slotsDir = () => path.join(slotDir(), 'slots');
export const logsDir = () => path.join(slotDir(), 'logs');
const ticketPath = (id: string) => path.join(ticketsDir(), `${id}.json`);

function ensureDirs(): void {
  for (const d of [ticketsDir(), slotsDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}

// ── tickets ─────────────────────────────────────────────────────────────────

export type SlotVia = 'cli' | 'detached' | 'suite_audit';

export interface Ticket {
  id: string;
  pid: number;
  /** Process start time from src/proctable.ts; null when no table could be read. */
  start: number | null;
  session?: string;
  cwd: string;
  command: string;
  via: SlotVia;
  enqueuedAt: string;
  acquiredAt?: string;
  /** This run's own max hold: waiters judge "overdue" by the holder's value, not theirs. */
  maxHoldMs: number;
  /** A detached run's log. */
  log?: string;
  /**
   * The command's own process. It runs in a process group of its own, so a
   * SIGKILLed wrapper leaves it running; while it lives the ticket is live, or
   * a waiter would start a second suite beside it, the 2026-11-25 overlap.
   */
  childPid?: number;
  childStart?: number | null;
}

export const clamp = (s: string) => {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
};

/** A new ticket id: enqueue time first, so the names sort into queue order. */
export function newTicketId(now = Date.now()): string {
  return `${String(now).padStart(14, '0')}-${process.pid}-${randomBytes(3).toString('hex')}`;
}

export function writeAtomic(file: string, body: string): void {
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  // Windows can refuse a rename over a file another process has open this very
  // moment (EPERM/EBUSY). A reader holds it for microseconds; a few retries do.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    }
  }
}

function readTicket(id: string): Ticket | undefined {
  try {
    const t = JSON.parse(fs.readFileSync(ticketPath(id), 'utf8')) as Ticket;
    return t && t.id === id && Number.isInteger(t.pid) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** Every ticket on disk, in queue order. */
function readTickets(): Ticket[] {
  let names: string[];
  try {
    names = fs.readdirSync(ticketsDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .sort()
    .map((n) => readTicket(n.slice(0, -'.json'.length)))
    .filter((t): t is Ticket => t !== undefined);
}

export interface Claim {
  slot: number;
  id: string;
}

function readClaims(): Claim[] {
  let names: string[];
  try {
    names = fs.readdirSync(slotsDir());
  } catch {
    return [];
  }
  const claims: Claim[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const id = fs.readdirSync(path.join(slotsDir(), n)).find((f) => !f.startsWith('.'));
      if (id) claims.push({ slot: Number(n), id });
    } catch {
      /* released between the two reads */
    }
  }
  return claims.sort((a, b) => a.slot - b.slot);
}

/** Remove one claim, only if it is still this id's: see the header on why rmdir and not rm -r. */
function breakClaim(c: Claim): void {
  const dir = path.join(slotsDir(), String(c.slot));
  try {
    fs.unlinkSync(path.join(dir, c.id));
  } catch {
    /* already gone */
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* a successor's claim is in it now, or it is gone */
  }
}

/** Try to take slot i for ticket id. True only for the one claimant whose rename landed. */
function tryClaim(slot: number, id: string): boolean {
  const tmp = path.join(slotsDir(), `.tmp-${id}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.writeFileSync(path.join(tmp, id), '');
    fs.renameSync(tmp, path.join(slotsDir(), String(slot)));
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  // The rename can land on a directory a releaser had just emptied, which is a free
  // slot taken fairly. Read back that the claim inside is ours all the same.
  try {
    return fs.readdirSync(path.join(slotsDir(), String(slot))).includes(id);
  } catch {
    return false;
  }
}

function removeTicket(id: string): void {
  for (const c of readClaims()) if (c.id === id) breakClaim(c);
  try {
    fs.unlinkSync(ticketPath(id));
  } catch {
    /* already gone */
  }
}

function sweepTmp(): void {
  const now = Date.now();
  for (const dir of [ticketsDir(), slotsDir()]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.startsWith('.tmp-')) continue;
      const p = path.join(dir, n);
      try {
        if (now - fs.statSync(p).mtimeMs > TMP_STALE_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  }
}

// ── liveness ────────────────────────────────────────────────────────────────

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

let cachedTable: { at: number; table: Map<number, ProcInfo> } | undefined;

/**
 * The process table off Linux, reused for SNAPSHOT_REUSE_MS: on Windows each one
 * is a PowerShell launch, and a waiter polls every few seconds for hours. A failed
 * snapshot is undefined, which every caller reads as "cannot tell", never "dead".
 */
async function sharedTable(): Promise<Map<number, ProcInfo> | undefined> {
  if (cachedTable && Date.now() - cachedTable.at < SNAPSHOT_REUSE_MS) return cachedTable.table;
  const snap = await snapshot();
  if (!snap.ok) return undefined;
  cachedTable = { at: Date.now(), table: snap.table };
  return snap.table;
}

/** This process's start time, read from the same source a liveness check compares it with. */
export async function ownStart(pid = process.pid): Promise<number | null> {
  if (PLATFORM === 'linux') return readProc(pid)?.start ?? null;
  if (PLATFORM === 'other') return null;
  cachedTable = undefined; // a fresh table, so a just-started process is in it
  return (await sharedTable())?.get(pid)?.start ?? null;
}

/**
 * Is the process that wrote this ticket still the one running under its pid?
 * Cheap kill(pid, 0) first; the start time is compared only when the pid exists.
 */
export async function ticketAlive(t: Pick<Ticket, 'pid' | 'start'>): Promise<boolean> {
  if (!pidExists(t.pid)) return false;
  if (t.start === null || t.start === undefined) return true;
  if (PLATFORM === 'linux') {
    const info = readProc(t.pid);
    return info === undefined || info.start === t.start; // unreadable is "cannot tell"
  }
  if (PLATFORM === 'other') return true;
  const table = await sharedTable();
  if (!table) return true;
  const info = table.get(t.pid);
  // Absent from a table up to 30 s old while kill(pid, 0) still finds it: a
  // process newer than the table. Its start cannot be compared yet; it is alive.
  return info === undefined || info.start === t.start;
}

/** A ticket is live while its taker or the command it started is. */
async function holderAlive(t: Ticket): Promise<boolean> {
  if (await ticketAlive(t)) return true;
  return t.childPid !== undefined && (await ticketAlive({ pid: t.childPid, start: t.childStart ?? null }));
}

interface View {
  /** Live tickets in queue order. */
  tickets: Ticket[];
  /** Live claims, each with its holder's ticket. */
  holders: { slot: number; ticket: Ticket }[];
}

/**
 * Read the slot, dropping dead tickets and breaking their claims when `prune`.
 * Status readers pass prune:false and only filter, so `--slot-status` and
 * browser_status stay read-only.
 */
async function view(prune: boolean): Promise<View> {
  if (prune) sweepTmp();
  const live: Ticket[] = [];
  for (const t of readTickets()) {
    if (await holderAlive(t)) live.push(t);
    else if (prune) removeTicket(t.id);
  }
  const byId = new Map(live.map((t) => [t.id, t]));
  const holders: View['holders'] = [];
  for (const c of readClaims()) {
    let t = byId.get(c.id);
    if (!t) {
      // Not in the ticket list read a moment ago: it may have been enqueued and
      // claimed since. Read it directly before calling the claim stale.
      const fresh = readTicket(c.id);
      if (fresh && (await holderAlive(fresh))) {
        t = fresh;
        live.push(fresh);
        byId.set(fresh.id, fresh);
      }
    }
    if (t) holders.push({ slot: c.slot, ticket: t });
    else if (prune) breakClaim(c);
  }
  live.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { tickets: live, holders };
}

// ── describing who is where ─────────────────────────────────────────────────

const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))}m`;

/** Session (Claude Code's id, shortened) when there is one, else the cwd. */
export function whoOf(t: Ticket): string {
  return t.session ? `session ${t.session.slice(0, 8)} (${t.cwd})` : t.cwd;
}

export function isOverdue(t: Ticket, now = Date.now()): boolean {
  return !!t.acquiredAt && now - Date.parse(t.acquiredAt) > t.maxHoldMs;
}

/** "<who> running <command> for 12m", plus the overdue flag past the holder's max hold. */
export function describeHolder(t: Ticket, now = Date.now()): string {
  const held = t.acquiredAt ? now - Date.parse(t.acquiredAt) : 0;
  const late = isOverdue(t, now) ? ` (OVERDUE: past its ${minutes(t.maxHoldMs)} max hold; not killed)` : '';
  return `${whoOf(t)} running ${t.command} for ${minutes(held)}${late}`;
}

// ── acquiring ───────────────────────────────────────────────────────────────

export interface AcquireOptions {
  command: string;
  via: SlotVia;
  cwd?: string;
  maxWaitMs?: number;
  maxHoldMs?: number;
  /** A detached run's log, shown in the status. */
  log?: string;
  /** Use this id (a detached launcher picks it, so it can find the runner's ticket). */
  id?: string;
  signal?: AbortSignal;
  /** Called once when the wait starts, then every progressMs, with a ready-made line. */
  onProgress?: (line: string, position: number) => void;
}

export interface SlotHandle {
  ticket: Ticket;
  waitedMs: number;
  /** Idempotent. Also runs on this process's exit. */
  release(): void;
  /** Record the command's pid in the ticket, so the slot outlives a killed wrapper while it runs. */
  attachChild(pid: number): Promise<void>;
}

export class SlotError extends Error {
  override name = 'SlotError';
  constructor(
    message: string,
    readonly kind: 'timeout' | 'aborted',
  ) {
    super(message);
  }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** The line a waiter prints: "waiting: position k behind <who> running <cmd> for Nm". */
function waitingLine(position: number, ahead: Ticket | undefined, now: number): string {
  if (!ahead) return `waiting: position ${position}, the slot is being handed over`;
  return ahead.acquiredAt
    ? `waiting: position ${position} behind ${describeHolder(ahead, now)}`
    : `waiting: position ${position} behind ${whoOf(ahead)} (queued) running ${ahead.command}`;
}

/** Who holds the slot, for the timeout error and the status. */
function holdersText(v: View, now: number): string {
  return v.holders.length
    ? v.holders.map((h) => describeHolder(h.ticket, now)).join('; ')
    : 'nobody (the queue ahead was still moving)';
}

/**
 * Queue for the slot and hold it. Resolves once this caller holds a claim; the
 * handle releases it. Rejects with SlotError on max wait (naming the holder) or
 * abort, having left the queue either way.
 */
export async function acquireSlot(opts: AcquireOptions): Promise<SlotHandle> {
  ensureDirs();
  const started = Date.now();
  const id = opts.id ?? newTicketId(started);
  const maxWaitMs = opts.maxWaitMs ?? defaultMaxWaitMs();
  const ticket: Ticket = {
    id,
    pid: process.pid,
    start: await ownStart(),
    ...(process.env.CLAUDE_CODE_SESSION_ID ? { session: clamp(process.env.CLAUDE_CODE_SESSION_ID) } : {}),
    cwd: clamp(opts.cwd ?? process.cwd()),
    command: clamp(opts.command),
    via: opts.via,
    enqueuedAt: new Date(started).toISOString(),
    maxHoldMs: opts.maxHoldMs ?? defaultMaxHoldMs(),
    ...(opts.log ? { log: opts.log } : {}),
  };
  writeAtomic(ticketPath(id), JSON.stringify(ticket, null, 1));

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    removeTicket(id);
  };
  // A crash or process.exit() still releases; SIGKILL is the dead-pid rule's job.
  process.on('exit', release);

  let lastProgress = 0;
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new SlotError('e2e slot: the wait was cancelled; left the queue', 'aborted');
      const v = await view(true);
      if (!fs.existsSync(ticketPath(id))) writeAtomic(ticketPath(id), JSON.stringify(ticket, null, 1));
      const n = slotCount();
      const held = new Set(v.holders.map((h) => h.ticket.id));
      const free = [...Array(n).keys()].filter((i) => !v.holders.some((h) => h.slot === i));
      const waiters = v.tickets.filter((t) => !held.has(t.id));
      const idx = Math.max(0, waiters.findIndex((t) => t.id === id));
      if (idx < free.length) {
        // FIFO: only the first free.length waiters may try, each on every free slot.
        if (free.some((i) => tryClaim(i, id))) {
          ticket.acquiredAt = new Date().toISOString();
          writeAtomic(ticketPath(id), JSON.stringify(ticket, null, 1));
          const attachChild = async (pid: number) => {
            ticket.childPid = pid;
            ticket.childStart = await ownStart(pid);
            if (!released) writeAtomic(ticketPath(id), JSON.stringify(ticket, null, 1));
          };
          return { ticket, waitedMs: Date.now() - started, release, attachChild };
        }
      }
      const now = Date.now();
      if (now - started >= maxWaitMs) {
        throw new SlotError(
          `e2e slot: gave up after ${minutes(maxWaitMs)} waiting. The slot is held by ${holdersText(v, now)}. ` +
            'Nothing ran. Retry later, or raise --max-wait / PLAYWRIGHT_MCP_E2E_MAX_WAIT.',
          'timeout',
        );
      }
      if (opts.onProgress && (lastProgress === 0 || now - lastProgress >= progressMs())) {
        lastProgress = now;
        const position = idx - free.length + 1;
        // Named after the holder, the run everyone is waiting on; the waiter just
        // ahead only while the slot is changing hands.
        const ahead = v.holders[0]?.ticket ?? (idx > 0 ? waiters[idx - 1] : undefined);
        opts.onProgress(waitingLine(Math.max(1, position), ahead, now), Math.max(1, position));
      }
      await sleep(Math.min(pollMs(), Math.max(1, maxWaitMs - (now - started))), opts.signal);
    }
  } catch (err) {
    release();
    throw err;
  }
}

/**
 * Is this process inside a command that already holds the slot? True when the
 * HELD_ENV marker names a ticket that is still live and still holds a claim.
 * A nested wrapper (a suite whose npm script calls the wrapper again) must then
 * run at once, or it would queue behind its own parent forever.
 */
export async function heldByAncestor(env: NodeJS.ProcessEnv = process.env): Promise<Ticket | undefined> {
  const id = env[HELD_ENV];
  if (!id || !/^[\w-]+$/.test(id)) return undefined;
  const t = readTicket(id);
  if (!t || !(await holderAlive(t))) return undefined;
  return readClaims().some((c) => c.id === id) ? t : undefined;
}

/** Where the queue stands for one ticket (a detached launcher reports it). */
export async function positionOf(id: string): Promise<{ holding: boolean; position: number } | undefined> {
  const v = await view(false);
  if (v.holders.some((h) => h.ticket.id === id)) return { holding: true, position: 0 };
  const held = new Set(v.holders.map((h) => h.ticket.id));
  const waiters = v.tickets.filter((t) => !held.has(t.id));
  const idx = waiters.findIndex((t) => t.id === id);
  if (idx < 0) return undefined;
  const free = Math.max(0, slotCount() - v.holders.length);
  return { holding: false, position: Math.max(1, idx - free + 1) };
}

/**
 * Does any claim sit in the suite lane? A readdir or two, no liveness check: the
 * render lane (src/render-lane.ts) asks on every browser call, and a dead holder
 * is cleared by suiteSweep(), which it runs only when its own lane looks full.
 */
export const suiteHeldFast = () => readClaims().length > 0;

/** Drop the suite lane's dead tickets and stale claims. */
export async function suiteSweep(): Promise<void> {
  await view(true);
}

/** Is a ticket file there yet (a detached launcher waits for its runner's)? */
export const ticketExists = (id: string) => fs.existsSync(ticketPath(id));

// ── status ──────────────────────────────────────────────────────────────────

export interface SlotRow {
  id: string;
  pid: number;
  session?: string;
  cwd: string;
  command: string;
  via: SlotVia;
  log?: string;
  enqueuedAt: string;
}

export interface SlotStatus {
  dir: string;
  slots: number;
  workersCap: number;
  holders: (SlotRow & { slot: number; acquiredAt?: string; heldSec: number; maxHoldSec: number; overdue: boolean })[];
  waiting: (SlotRow & { position: number; waitingSec: number })[];
}

const row = (t: Ticket): SlotRow => ({
  id: t.id,
  pid: t.pid,
  ...(t.session ? { session: t.session } : {}),
  cwd: t.cwd,
  command: t.command,
  via: t.via,
  ...(t.log ? { log: t.log } : {}),
  enqueuedAt: t.enqueuedAt,
});

/** The slot as it stands. Read-only: dead tickets are left out, not removed. */
export async function slotStatus(now = Date.now()): Promise<SlotStatus> {
  const v = await view(false);
  const held = new Set(v.holders.map((h) => h.ticket.id));
  return {
    dir: slotDir(),
    slots: slotCount(),
    workersCap: workersCap(),
    holders: v.holders.map(({ slot, ticket: t }) => ({
      ...row(t),
      slot,
      ...(t.acquiredAt ? { acquiredAt: t.acquiredAt } : {}),
      heldSec: t.acquiredAt ? Math.round((now - Date.parse(t.acquiredAt)) / 1000) : 0,
      maxHoldSec: Math.round(t.maxHoldMs / 1000),
      overdue: isOverdue(t, now),
    })),
    waiting: v.tickets
      .filter((t) => !held.has(t.id))
      .map((t, i) => ({ ...row(t), position: i + 1, waitingSec: Math.round((now - Date.parse(t.enqueuedAt)) / 1000) })),
  };
}

/** The status as text, for `--slot-status` and the tail of `--browsers`. */
export function formatSlotStatus(s: SlotStatus): string {
  const who = (r: SlotRow) => (r.session ? `session ${r.session.slice(0, 8)} (${r.cwd})` : r.cwd);
  const lines = [`E2E slot (${s.slots} slot${s.slots === 1 ? '' : 's'}, workers cap ${s.workersCap}; ${s.dir}):`];
  if (!s.holders.length) lines.push('  free');
  for (const h of s.holders) {
    lines.push(
      `  HOLDER  ${who(h)} running ${h.command} for ${minutes(h.heldSec * 1000)}` +
        `${h.overdue ? ` OVERDUE (max hold ${minutes(h.maxHoldSec * 1000)}; not killed)` : ''} [pid ${h.pid}, ${h.via}]` +
        (h.log ? `\n          log ${h.log}` : ''),
    );
  }
  for (const w of s.waiting) {
    lines.push(
      `  WAIT ${w.position}  ${who(w)} running ${w.command}, waiting ${minutes(w.waitingSec * 1000)} [pid ${w.pid}, ${w.via}]` +
        (w.log ? `\n          log ${w.log}` : ''),
    );
  }
  return lines.join('\n') + '\n';
}

// ── workers ─────────────────────────────────────────────────────────────────

/** Basename without the extension a shim or script carries (playwright.cmd, cli.js). */
const bare = (tok: string) => path.basename(tok).replace(/\.(cmd|bat|exe|ps1|js|mjs|cjs)$/i, '').toLowerCase();

/** The index of `test` in a `… playwright test …` argv, or -1. */
export function playwrightTestIndex(argv: string[]): number {
  for (let i = 0; i < argv.length - 1; i++) if (bare(argv[i]) === 'playwright' && argv[i + 1] === 'test') return i + 1;
  return -1;
}

/** Playwright's own resolution (resolveWorkers in playwright/lib/common): "50%" is floor(cores × 0.5), at least 1. */
export function resolveWorkers(raw: string, cpus = cpuCount()): number | undefined {
  if (raw.endsWith('%')) {
    const pct = parseInt(raw, 10);
    return Number.isFinite(pct) ? Math.max(1, Math.floor(cpus * (pct / 100))) : undefined;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

/**
 * Cap a `playwright test` command's workers. The cap is an upper limit only
 * (cpu-dev, 2026-11-25): an explicit --workers/-j at or under it is kept as
 * written (`--workers=1` stays 1), one above it, percent forms resolved against
 * the core count first, is lowered to it.
 *
 * With no explicit value nothing is added. `--workers` on the command line beats
 * the config's `workers` (takeFirst(cli, config, "50%") in Playwright's config
 * loader), so appending the cap would RAISE a config that asks for fewer, as the
 * suite template's serial `workers: 1` does. A config that sets none gets
 * Playwright's 50%, which is the default cap; a generated config reads the cap
 * from PLAYWRIGHT_MCP_E2E_WORKERS.
 */
export function capWorkers(
  argv: string[],
  cap = workersCap(),
  cpus = cpuCount(),
): { argv: string[]; note: string } {
  const at = playwrightTestIndex(argv);
  if (at < 0) return { argv, note: `workers: not a \`playwright test\` command, left alone (cap ${cap} exported as ${WORKERS_ENV})` };
  const out = argv.slice();
  const seen: string[] = [];
  const lowered: string[] = [];
  for (let i = at + 1; i < out.length; i++) {
    const tok = out[i];
    let value: string | undefined;
    let set: (v: string) => void = () => {};
    let m: RegExpExecArray | null;
    if ((m = /^--workers=(.*)$/.exec(tok))) {
      value = m[1];
      set = (v) => (out[i] = `--workers=${v}`);
    } else if (tok === '--workers' || tok === '-j') {
      if (i + 1 >= out.length) continue;
      value = out[i + 1];
      const j = i + 1;
      set = (v) => (out[j] = v);
      i++;
    } else if ((m = /^-j=?(.+)$/.exec(tok))) {
      value = m[1];
      set = (v) => (out[i] = `-j${v}`);
    } else continue;
    const n = resolveWorkers(value);
    if (n === undefined) continue;
    seen.push(value);
    if (n > cap) {
      set(String(cap));
      lowered.push(`${value}${value.endsWith('%') ? ` (= ${n})` : ''}`);
    }
  }
  if (lowered.length) return { argv: out, note: `workers: lowered ${lowered.join(', ')} to the cap ${cap} (${WORKERS_ENV})` };
  if (seen.length) return { argv: out, note: `workers: --workers=${seen[seen.length - 1]} kept (cap ${cap})` };
  return {
    argv: out,
    note: `workers: none given, so the config's own value applies, or Playwright's 50% (${Math.max(1, Math.floor(cpus / 2))}) when it sets none; cap ${cap} not forced over a config`,
  };
}

// ── the wrapper pointer ─────────────────────────────────────────────────────

/**
 * Record where this install's wrapper is, so a generated project's
 * tests/e2e-slot.mjs finds it with no env var and no PATH entry: the installer
 * registers `node <dir>/dist/index.js` and puts nothing on PATH, and a clone run
 * in place lives wherever the clone is. Written at server start; best-effort.
 */
export function writeWrapperPointer(bin: string): void {
  try {
    fs.mkdirSync(slotDir(), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(slotDir(), 'wrapper.json'), JSON.stringify({ node: process.execPath, bin }, null, 1));
  } catch {
    /* a read-only home must not stop the server */
  }
}

/** Delete detached logs older than LOG_KEEP_MS. */
export function pruneLogs(now = Date.now()): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(logsDir());
  } catch {
    return;
  }
  for (const n of names) {
    const p = path.join(logsDir(), n);
    try {
      if (now - fs.statSync(p).mtimeMs > LOG_KEEP_MS) fs.rmSync(p, { force: true });
    } catch {
      /* gone */
    }
  }
}
