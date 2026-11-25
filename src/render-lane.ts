/**
 * render-lane.ts — the RENDER lane of the machine-wide scheduler: every browser_*
 * call and every web_fetch page render, from every playwright-mcp server on the
 * machine, takes one of a few render slots. The SUITE lane is src/e2e-slot.ts;
 * both share its state directory, its liveness rules and its status output.
 *
 * Why (2026-11-25): after the e2e slot was designed, Francis: "maybe the
 * playwright-mcp should queue up all these type of calls, especially if there is
 * a lot of activity to it from different sessions". ~10 servers, one per Claude
 * session, each with its own browsers, render at once with nothing between them;
 * src/queue.ts orders calls only inside one server.
 *
 * Rules, as agreed with cpu-dev:
 *   - Concurrency is half the cores while the suite lane is free, and 1 while a
 *     suite holds it. A render never waits for a suite, only for a render slot:
 *     short page checks keep flowing through a 4 h regression, and a subagent
 *     driving the browser inside the work order whose suite holds the slot cannot
 *     deadlock against it.
 *   - Taken per call, not per lease, and released as soon as the page work ends.
 *     web_fetch holds it only while a page renders, never through a bot-wall wait.
 *   - Round-robin across sessions (Claude Code's session id, else the server pid),
 *     FIFO within one, so a busy session cannot starve the others. "Whose turn"
 *     is the waiting session served longest ago, read from render/served/<key>.
 *   - A wait is bounded (10 min by default). Past it the call goes ahead anyway
 *     and says so: a user's page check is never failed by this lane.
 *   - Cheap when uncontended: no waiters and a free slot is a couple of readdirs
 *     and one rename, no ticket file, no process table. Liveness checks and the
 *     stale sweep run only on the slow path, when the lane looks full.
 *
 * Layout under <slot dir>/render/:
 *   slots/<i>/<id>        a claim; the file holds the holder's JSON (session,
 *                         pid, start, tool, since), so the fast path writes nothing else
 *   tickets/<id>.json     a waiter (slow path only); id sorts by enqueue time
 *   served/<session key>  when that session last got a slot, for the round-robin
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  clamp,
  cpuCount,
  newTicketId,
  ownStart,
  sleep,
  slotDir,
  suiteHeldFast,
  suiteSweep,
  ticketAlive,
  writeAtomic,
} from './e2e-slot.js';

const DEFAULT_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 100;
/** A liveness answer is reused this long on the slow path. */
const ALIVE_CACHE_MS = 2_000;
/** The suite lane's own sweep, from a render waiter, at most this often. */
const SUITE_SWEEP_EVERY_MS = 5_000;
/** A served/ entry older than this is no longer anyone's recent turn. */
const SERVED_KEEP_MS = 3_600_000;
/** Waits shorter than this are not mentioned in a result. */
const NOTE_AFTER_MS = 1_000;

function envPositive(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Render slots while no suite runs. PLAYWRIGHT_MCP_RENDER_SLOTS, default half the cores. */
export const renderSlots = () => envPositive('PLAYWRIGHT_MCP_RENDER_SLOTS', Math.max(1, Math.floor(cpuCount() / 2)));
/** Render slots while a suite holds the suite lane. PLAYWRIGHT_MCP_RENDER_SLOTS_DURING_SUITE, default 1. */
export const renderSlotsDuringSuite = () => envPositive('PLAYWRIGHT_MCP_RENDER_SLOTS_DURING_SUITE', 1);
/** PLAYWRIGHT_MCP_RENDER_MAX_WAIT_MS: past it a render goes ahead without a slot. */
export const renderMaxWaitMs = () => envPositive('PLAYWRIGHT_MCP_RENDER_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS);
const pollMs = () => envPositive('PLAYWRIGHT_MCP_RENDER_POLL_MS', DEFAULT_POLL_MS);

/** The round-robin key: the client session, else this server. */
export function sessionKey(): string {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || `pid-${process.pid}`;
}
const fileKey = (key: string) => key.replace(/[^\w.-]/g, '_').slice(0, 80);

const laneDir = () => path.join(slotDir(), 'render');
const slotsDir = () => path.join(laneDir(), 'slots');
const ticketsDir = () => path.join(laneDir(), 'tickets');
const servedDir = () => path.join(laneDir(), 'served');

export interface RenderHolder {
  id: string;
  session: string;
  pid: number;
  start: number | null;
  tool: string;
  since: string;
}
type RenderWaiter = Omit<RenderHolder, 'since'> & { enqueuedAt: string };

let startPromise: Promise<number | null> | undefined;
const myStart = () => (startPromise ??= ownStart());

/** This lane's limit right now: fewer while a suite runs. */
export function renderLimit(): number {
  return suiteHeldFast() ? renderSlotsDuringSuite() : renderSlots();
}

function readClaims(): { slot: number; holder?: RenderHolder; id: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(slotsDir());
  } catch {
    return [];
  }
  const out: { slot: number; holder?: RenderHolder; id: string }[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const dir = path.join(slotsDir(), n);
    try {
      const id = fs.readdirSync(dir).find((f) => !f.startsWith('.'));
      if (!id) continue;
      let holder: RenderHolder | undefined;
      try {
        holder = JSON.parse(fs.readFileSync(path.join(dir, id), 'utf8')) as RenderHolder;
      } catch {
        /* released between the reads */
      }
      out.push({ slot: Number(n), holder, id });
    } catch {
      /* released between the reads */
    }
  }
  return out;
}

function waiterNames(): string[] {
  try {
    return fs.readdirSync(ticketsDir()).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
}

function readWaiters(): RenderWaiter[] {
  const out: RenderWaiter[] = [];
  for (const n of waiterNames().sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(ticketsDir(), n), 'utf8')) as RenderWaiter);
    } catch {
      /* left the queue between the reads */
    }
  }
  return out;
}

/** The claim protocol of src/e2e-slot.ts: a populated directory renamed into place; one winner. */
function tryClaim(slot: number, holder: RenderHolder): boolean {
  const tmp = path.join(slotsDir(), `.tmp-${holder.id}`);
  try {
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.writeFileSync(path.join(tmp, holder.id), JSON.stringify(holder));
    fs.renameSync(tmp, path.join(slotsDir(), String(slot)));
    return true;
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
    return false;
  }
}

/** Unlink exactly this id's claim, then rmdir, which fails if a successor already moved in. */
function breakClaim(slot: number, id: string): void {
  const dir = path.join(slotsDir(), String(slot));
  try {
    fs.unlinkSync(path.join(dir, id));
  } catch {
    /* gone */
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* a successor's claim, or gone */
  }
}

/** Free indices under the limit, when the lane's holders are under it at all. */
function freeSlots(claims: { slot: number }[], limit: number): number[] {
  if (claims.length >= limit) return [];
  return [...Array(limit).keys()].filter((i) => !claims.some((c) => c.slot === i));
}

const aliveCache = new Map<string, { at: number; alive: boolean }>();
async function alive(p: { id: string; pid: number; start: number | null }): Promise<boolean> {
  const hit = aliveCache.get(p.id);
  if (hit && Date.now() - hit.at < ALIVE_CACHE_MS) return hit.alive;
  const a = await ticketAlive(p);
  aliveCache.set(p.id, { at: Date.now(), alive: a });
  if (aliveCache.size > 500) aliveCache.clear();
  return a;
}

let lastSuiteSweep = 0;

/** The slow path's sweep: dead holders' claims broken, dead waiters dropped, old served/ entries pruned. */
async function sweep(): Promise<void> {
  for (const c of readClaims()) {
    if (!c.holder) continue;
    if (!(await alive(c.holder))) breakClaim(c.slot, c.id);
  }
  for (const w of readWaiters()) {
    if (!(await alive(w))) fs.rmSync(path.join(ticketsDir(), `${w.id}.json`), { force: true });
  }
  // A dead suite holder would pin this lane at its during-suite limit until the
  // suite lane's own participants noticed; a render waiter clears it too.
  if (Date.now() - lastSuiteSweep > SUITE_SWEEP_EVERY_MS) {
    lastSuiteSweep = Date.now();
    await suiteSweep();
  }
}

function lastServed(key: string): number {
  try {
    return Number(fs.readFileSync(path.join(servedDir(), fileKey(key)), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function markServed(key: string): void {
  try {
    fs.mkdirSync(servedDir(), { recursive: true, mode: 0o700 });
    writeAtomic(path.join(servedDir(), fileKey(key)), String(Date.now()));
    for (const n of fs.readdirSync(servedDir())) {
      const p = path.join(servedDir(), n);
      if (!n.startsWith('.') && Date.now() - fs.statSync(p).mtimeMs > SERVED_KEEP_MS) fs.rmSync(p, { force: true });
    }
  } catch {
    /* fairness bookkeeping only */
  }
}

/**
 * The waiters in the order they get slots: sessions served longest ago first
 * (never served = first, ties to the earliest ticket), dealt round-robin, one
 * ticket per session per round, FIFO within a session.
 */
export function roundRobin<T extends { id: string; session: string }>(waiters: T[], served: (key: string) => number): T[] {
  const bySession = new Map<string, T[]>();
  for (const w of [...waiters].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const list = bySession.get(w.session) ?? [];
    list.push(w);
    bySession.set(w.session, list);
  }
  const order = [...bySession.keys()].sort((a, b) => served(a) - served(b) || (bySession.get(a)![0].id < bySession.get(b)![0].id ? -1 : 1));
  const out: T[] = [];
  for (let round = 0; out.length < waiters.length; round++) {
    for (const k of order) {
      const t = bySession.get(k)![round];
      if (t) out.push(t);
    }
  }
  return out;
}

export interface RenderOptions {
  /** Abort while waiting leaves the queue (the call is rejected). */
  signal?: AbortSignal;
  /**
   * The request's progress channel. A wait sends a heartbeat on it: Claude Code
   * aborts a call with no response or progress for 30 s (src/index.ts,
   * callContext), and with one render slot during a suite a wait can be longer.
   */
  progress?: (message: string) => void;
}

/** Under the client's 30 s idle cut, as startHeartbeat's (src/tools/session.ts). */
const HEARTBEAT_EVERY_MS = 8_000;

export interface RenderTurn {
  waitedMs: number;
  /** Sessions that held render slots while this call waited, shortened. */
  behind: string[];
  /** The bounded wait ran out and the call went ahead without a slot. */
  unslotted: boolean;
  /** The lane could not be used at all (its files could not be written); the call went ahead. */
  unavailable?: string;
  release(): void;
}

const short = (key: string) => (key.startsWith('pid-') ? `server ${key.slice(4)}` : `session ${key.slice(0, 8)}`);

/**
 * Take a render slot for one call. Never rejects except on abort: past the max
 * wait it resolves unslotted. The handle's release is idempotent and also runs
 * on process exit; a SIGKILLed holder is freed by the next waiter's sweep.
 */
export async function takeRender(tool: string, opts: RenderOptions = {}): Promise<RenderTurn> {
  try {
    return await queueForRender(tool, opts);
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    // A page check is never failed by this lane: a state directory that cannot
    // be written (read-only home, full disk) means no slot, not no page.
    const reason = err instanceof Error ? err.message : String(err);
    return { waitedMs: 0, behind: [], unslotted: true, unavailable: reason, release: () => {} };
  }
}

async function queueForRender(tool: string, opts: RenderOptions): Promise<RenderTurn> {
  const started = Date.now();
  const key = sessionKey();
  const holder: RenderHolder = {
    id: newTicketId(started),
    session: key,
    pid: process.pid,
    start: await myStart(),
    tool: clamp(tool),
    since: '',
  };
  let claimed: number | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    if (claimed !== undefined) breakClaim(claimed, holder.id);
  };
  const granted = (unslotted: boolean, behind: Set<string>): RenderTurn => {
    if (!unslotted) process.on('exit', release);
    return { waitedMs: Date.now() - started, behind: [...behind].map(short), unslotted, release };
  };
  const claimAny = (slots: number[]): boolean => {
    holder.since = new Date().toISOString();
    for (const i of slots) {
      if (tryClaim(i, holder)) {
        claimed = i;
        return true;
      }
    }
    return false;
  };

  // Fast path: nobody waiting and a slot free under the limit.
  fs.mkdirSync(slotsDir(), { recursive: true, mode: 0o700 });
  if (waiterNames().length === 0 && claimAny(freeSlots(readClaims(), renderLimit()))) {
    markServed(key);
    return granted(false, new Set());
  }

  // Slow path: queue as a ticket, round-robin by session.
  fs.mkdirSync(ticketsDir(), { recursive: true, mode: 0o700 });
  const ticketFile = path.join(ticketsDir(), `${holder.id}.json`);
  const waiter: RenderWaiter = { id: holder.id, session: key, pid: holder.pid, start: holder.start, tool: holder.tool, enqueuedAt: new Date(started).toISOString() };
  writeAtomic(ticketFile, JSON.stringify(waiter));
  const behind = new Set<string>();
  const maxWait = renderMaxWaitMs();
  const beat = opts.progress
    ? setInterval(
        () =>
          opts.progress!(
            `waiting ${Math.round((Date.now() - started) / 1000)}s for a machine-wide render slot` +
              (behind.size ? ` behind ${[...behind].slice(0, 3).map(short).join(', ')}` : ''),
          ),
        HEARTBEAT_EVERY_MS,
      )
    : undefined;
  beat?.unref();
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('render slot: the call was cancelled while waiting');
      await sweep();
      if (!fs.existsSync(ticketFile)) writeAtomic(ticketFile, JSON.stringify(waiter));
      const claims = readClaims();
      for (const c of claims) if (c.holder && c.holder.session !== key) behind.add(c.holder.session);
      const free = freeSlots(claims, renderLimit());
      const order = roundRobin(readWaiters(), lastServed);
      const idx = order.findIndex((w) => w.id === holder.id);
      if (idx >= 0 && idx < free.length && claimAny(free)) {
        markServed(key);
        return granted(false, behind);
      }
      if (Date.now() - started >= maxWait) return granted(true, behind);
      await sleep(pollMs(), opts.signal);
    }
  } finally {
    if (beat) clearInterval(beat);
    fs.rmSync(ticketFile, { force: true });
  }
}

/** One short line for a result that waited, or undefined for one that did not. */
export function renderNote(turn: RenderTurn): string | undefined {
  if (turn.unavailable) return undefined; // logged nowhere useful to the caller; the page ran as before
  const s = Math.round(turn.waitedMs / 1000);
  const who = turn.behind.length ? ` behind ${turn.behind.slice(0, 3).join(', ')}${turn.behind.length > 3 ? ` +${turn.behind.length - 3}` : ''}` : '';
  if (turn.unslotted) return `[render slot: none free after ${s}s${who}; ran anyway]`;
  if (turn.waitedMs < NOTE_AFTER_MS) return undefined;
  return `[render slot: waited ${s}s${who}]`;
}

/** Run fn holding a render slot; the note is set when the wait is worth mentioning. */
export async function withRender<T>(tool: string, fn: () => Promise<T>, opts: RenderOptions = {}): Promise<{ value: T; note?: string }> {
  const turn = await takeRender(tool, opts);
  try {
    return { value: await fn(), note: renderNote(turn) };
  } finally {
    turn.release();
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export interface RenderStatus {
  limit: number;
  limitIdle: number;
  limitDuringSuite: number;
  holders: { session: string; pid: number; tool: string; since: string; heldSec: number }[];
  waiting: { session: string; count: number; oldestWaitSec: number; tools: string[] }[];
}

/** The render lane as it stands. Read-only: dead entries are left out, not removed. */
export async function renderStatus(now = Date.now()): Promise<RenderStatus> {
  const holders: RenderStatus['holders'] = [];
  for (const c of readClaims()) {
    if (!c.holder || !(await ticketAlive(c.holder))) continue;
    holders.push({
      session: c.holder.session,
      pid: c.holder.pid,
      tool: c.holder.tool,
      since: c.holder.since,
      heldSec: Math.round((now - Date.parse(c.holder.since)) / 1000),
    });
  }
  const bySession = new Map<string, RenderStatus['waiting'][number]>();
  for (const w of readWaiters()) {
    if (!(await ticketAlive(w))) continue;
    const row = bySession.get(w.session) ?? { session: w.session, count: 0, oldestWaitSec: 0, tools: [] };
    row.count += 1;
    row.oldestWaitSec = Math.max(row.oldestWaitSec, Math.round((now - Date.parse(w.enqueuedAt)) / 1000));
    if (row.tools.length < 3 && !row.tools.includes(w.tool)) row.tools.push(w.tool);
    bySession.set(w.session, row);
  }
  return {
    limit: renderLimit(),
    limitIdle: renderSlots(),
    limitDuringSuite: renderSlotsDuringSuite(),
    holders,
    waiting: [...bySession.values()],
  };
}

export function formatRenderStatus(r: RenderStatus): string {
  const lines = [
    `Render lane (browser_* calls and web_fetch renders; ${r.holders.length}/${r.limit} in use; ` +
      `limit ${r.limitIdle}, ${r.limitDuringSuite} while a suite runs):`,
  ];
  for (const h of r.holders) lines.push(`  RENDER  ${short(h.session)} ${h.tool} for ${h.heldSec}s [pid ${h.pid}]`);
  for (const w of r.waiting)
    lines.push(`  WAIT    ${short(w.session)}: ${w.count} call${w.count === 1 ? '' : 's'} (${w.tools.join(', ')}), oldest ${w.oldestWaitSec}s`);
  if (!r.holders.length && !r.waiting.length) lines.push('  idle');
  return lines.join('\n') + '\n';
}
