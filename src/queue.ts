/**
 * The browser queue: one caller at a time on the wrapped @playwright/mcp
 * connection, and an explicit lease for a caller that needs several calls in a row.
 *
 * Why this module exists
 * ----------------------
 * Every browser_* tool runs on ONE upstream connection (src/upstream.ts): one
 * current tab, one bound session. Within a Claude Code session the main agent and
 * all of its subagents share one MCP connection to this server, so nothing on the
 * wire says which of them sent a call. Two of them browsing at once used to
 * collide: on 2026-10-29 a browser_evaluate for one job ran on a LinkedIn tab
 * another agent was still using, read back "0 notifications total", and the retry
 * died with "Connection closed". A session_attach from a third job tore the
 * connection down mid-flow. Callers were left serialising themselves in prose,
 * which was over-applied until a job that only needed web_fetch was banned from
 * every playwright tool. The user's words: "you don't need to guard, you need to
 * queue".
 *
 * So:
 *   - every browser_* call and every rebind (bindSession) waits its turn here,
 *     FIFO, and only one runs against the upstream connection at a time;
 *   - a caller that needs a multi-call turn (navigate → snapshot → click) takes a
 *     LEASE. While it is held, only calls carrying its token run; every other call,
 *     every other acquire, and every rebind without it waits. The holder's own
 *     calls skip ahead of those waiters, in their own FIFO order;
 *   - nothing waits forever. A lease ends after `idleMs` with no call carrying it
 *     (paused while one of its calls is running, so a long browser_wait_for does
 *     not expire it mid-call) and at `maxLeaseMs` whatever happens. A waiter gives
 *     up after `maxWaitMs` with an error that says who holds the browser and for
 *     how long. A waiter whose request is aborted leaves the queue.
 *
 * Identity is explicit because it has to be: the server cannot tell the main agent
 * from a subagent, so the lease token IS the caller's identity, and a call without
 * one is "somebody else".
 *
 * web_fetch never comes through here. It renders on its own stealth context
 * (src/browser.ts), a different browser from the one browser_* drives.
 *
 * Ending a lease never aborts anything. A call that is running when its lease
 * ends finishes; the lease only stops being given priority. Mutual exclusion is
 * the queue's job, independent of any lease.
 *
 * Pure: no browser, no MCP. The clock is injectable so the T1 tier drives every
 * timer without waiting for one (scripts/test-browser-queue.mjs).
 */

import { randomBytes } from 'node:crypto';

/** What the queue needs from time. Defaults to the real one. */
export interface QueueClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface QueueLimits {
  /** A lease ends after this long with no call carrying it. */
  idleMs: number;
  /** A lease ends this long after it was granted, however busy it is. */
  maxLeaseMs: number;
  /** A waiter gives up after this long in the queue. */
  maxWaitMs: number;
}

export interface WaitOptions {
  /** Shown to other waiters as what is running ("browser_navigate", "session_attach rebind"). */
  label: string;
  /** Abort while waiting removes the waiter. Once running, the call is not interrupted. */
  signal?: AbortSignal;
  /**
   * Called only if the caller actually has to wait; returns the function that stops
   * whatever it started (the heartbeat). Not called for a caller served at once.
   */
  onWait?: () => () => void;
}

export interface RunOptions extends WaitOptions {
  /** The caller's lease token, if it holds one. */
  lease?: string;
}

export interface AcquireOptions extends Omit<WaitOptions, 'label'> {
  /** Free-text name of whoever holds the lease, shown to everyone it makes wait. */
  holder?: string;
}

export interface LeaseGrant {
  lease: string;
  holder: string;
  idleMs: number;
  maxLeaseMs: number;
}

/** Every refusal the queue makes. The message is written for the model to act on. */
export class BrowserQueueError extends Error {
  override name = 'BrowserQueueError';
}

interface Waiter {
  kind: 'call' | 'acquire';
  label: string;
  lease?: string;
  /** Take the turn. Called with the waiter already out of the queue and cleaned up. */
  dispatch: () => void;
  /** Leave the queue with this error. */
  fail: (err: Error) => void;
  /** Drop this waiter's timer, abort listener and heartbeat. Idempotent. */
  cleanup: () => void;
}

interface Lease {
  token: string;
  holder: string;
  grantedAt: number;
  lastUsedAt: number;
  idleTimer?: unknown;
  maxTimer: unknown;
}

/** How many ended tokens are remembered, so a late call gets "expired", not "unknown". */
const ENDED_MEMORY = 64;

const UNKNOWN_TOKEN =
  'browser queue: unknown lease token — it was never issued by this server (a server restart forgets every lease).';

/** Longest holder name kept. It is echoed to other callers, so it stays short and printable. */
const HOLDER_MAX = 64;

export const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

/** A short, printable holder name, or a default built from the token. */
function cleanHolder(raw: string | undefined, token: string): string {
  // Printable ASCII minus markup and quote characters: it lands in other callers'
  // results unmarked, so it must not be able to open a tag or close a quote there.
  const cleaned = (raw ?? '').replace(/[^\x20-\x7e]|[<>"`\\]/g, '').trim().slice(0, HOLDER_MAX);
  return cleaned || `lease …${token.slice(-4)}`;
}

const realClock: QueueClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref(); // a queue timer must never be the reason this process stays alive
    return t;
  },
  clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout),
};

export class BrowserQueue {
  private readonly waiting: Waiter[] = [];
  private running: { label: string; startedAt: number; lease?: string } | undefined;
  private lease: Lease | undefined;
  /** token → the sentence saying how it ended. Insertion-ordered, so the oldest is dropped first. */
  private readonly ended = new Map<string, string>();

  constructor(
    readonly limits: QueueLimits,
    private readonly clock: QueueClock = realClock,
  ) {}

  /**
   * Run `fn` when it is this caller's turn: nothing else running, and either no
   * lease held or the caller holding it. A token that is not the live lease is
   * refused before anything waits, so a caller learns at once that its turn is
   * over rather than queueing as somebody else.
   */
  async run<T>(fn: () => Promise<T>, opts: RunOptions): Promise<T> {
    if (opts.lease !== undefined) this.assertLive(opts.lease);
    return new Promise<T>((resolve, reject) => {
      this.enqueue(
        {
          kind: 'call',
          label: opts.label,
          lease: opts.lease,
          dispatch: () => {
            const lease = this.lease?.token === opts.lease ? this.lease : undefined;
            this.running = { label: opts.label, startedAt: this.clock.now(), lease: opts.lease };
            if (lease) this.pauseIdle(lease);
            void (async () => fn())()
              .then(resolve, reject)
              .finally(() => {
                this.running = undefined;
                // The lease may have ended (released, max lifetime) while this ran.
                if (lease && this.lease === lease) this.touch(lease);
                this.pump();
              });
          },
          fail: reject,
        },
        opts,
      );
    });
  }

  /** Wait for the browser to be free, then hold it as a lease until release or expiry. */
  acquire(opts: AcquireOptions = {}): Promise<LeaseGrant> {
    return new Promise<LeaseGrant>((resolve, reject) => {
      this.enqueue(
        {
          kind: 'acquire',
          label: 'browser_lease_acquire',
          dispatch: () => resolve(this.grant(opts.holder)),
          fail: reject,
        },
        { ...opts, label: 'browser_lease_acquire' },
      );
    });
  }

  /**
   * End a lease. Idempotent: releasing a lease that already ended is a no-op that
   * says how it ended. A token this queue never issued is an error, because it
   * means the caller is holding something it thinks is a lease and is not.
   */
  release(token: string): { released: boolean; note: string } {
    if (this.lease?.token === token) {
      this.end(this.lease, 'was released');
      return { released: true, note: 'lease released; the next caller in the queue has the browser' };
    }
    const how = this.ended.get(token);
    if (how) return { released: false, note: `nothing to do: this lease ${how}` };
    throw new BrowserQueueError(`${UNKNOWN_TOKEN} Nothing was released.`);
  }

  /** True while `token` is the live lease. */
  isLive(token: string | undefined): boolean {
    return token !== undefined && this.lease?.token === token;
  }

  /**
   * Who has the browser right now, in a sentence another caller can act on. Empty
   * when nobody does.
   */
  describe(): string {
    const now = this.clock.now();
    const parts: string[] = [];
    if (this.lease) {
      const l = this.lease;
      const idleLeft = this.running?.lease === l.token ? 'paused while its call runs' : `${secs(this.limits.idleMs - (now - l.lastUsedAt))} if unused`;
      parts.push(
        `held by lease "${l.holder}" for ${secs(now - l.grantedAt)} (last used ${secs(now - l.lastUsedAt)} ago; ` +
          `it ends in ${idleLeft}, ${secs(this.limits.maxLeaseMs - (now - l.grantedAt))} at most)`,
      );
    }
    if (this.running) {
      const by = this.running.lease ? '' : 'an unleased ';
      parts.push(`in use by ${by}${this.running.label} call (running ${secs(now - this.running.startedAt)})`);
    }
    return parts.join('; ');
  }

  /** The heartbeat line a waiter sends while it waits. */
  waitMessage(what: string, elapsedMs: number): string {
    const who = this.describe() || 'the caller ahead of you';
    return `${what} — queued for the shared browser (${secs(elapsedMs)}): ${who}. ${this.waiting.length} waiting.`;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Throw the caller-facing error unless `token` is the live lease. */
  assertLive(token: string): void {
    if (this.isLive(token)) return;
    const how = this.ended.get(token);
    throw new BrowserQueueError(
      how
        ? `browser queue: this lease ${how}, so your turn is over. Acquire a new one with browser_lease_acquire, or call without a lease to queue normally.`
        : `${UNKNOWN_TOKEN} Acquire one with browser_lease_acquire, or call without a lease.`,
    );
  }

  private enqueue(
    w: Omit<Waiter, 'cleanup'>,
    opts: WaitOptions,
  ): void {
    if (opts.signal?.aborted) {
      w.fail(new BrowserQueueError(`browser queue: ${opts.label} was cancelled before it reached the browser`));
      return;
    }
    let timer: unknown;
    let stopWait: (() => void) | undefined;
    const onAbort = () => {
      this.drop(waiter);
      waiter.fail(new BrowserQueueError(`browser queue: ${opts.label} was cancelled while waiting for the browser`));
    };
    const waiter: Waiter = {
      ...w,
      cleanup: () => {
        if (timer !== undefined) this.clock.clearTimeout(timer);
        timer = undefined;
        opts.signal?.removeEventListener('abort', onAbort);
        stopWait?.();
        stopWait = undefined;
      },
    };
    this.waiting.push(waiter);
    this.pump();
    if (!this.waiting.includes(waiter)) return; // served at once: no timer, no heartbeat

    opts.signal?.addEventListener('abort', onAbort, { once: true });
    timer = this.clock.setTimeout(() => {
      const blocker = this.describe() || 'another caller';
      const behind = this.waiting.indexOf(waiter);
      this.drop(waiter);
      waiter.fail(
        new BrowserQueueError(
          `browser queue: ${opts.label} gave up after waiting ${secs(this.limits.maxWaitMs)} for the shared browser. ` +
            `The browser is ${blocker}${behind > 0 ? `, with ${behind} caller(s) ahead of you` : ''}. Nothing ran. ` +
            'Retry later; a lease ends on its own when idle or at its maximum lifetime.',
        ),
      );
    }, this.limits.maxWaitMs);
    stopWait = opts.onWait?.();
  }

  /** Take a waiter out of the queue without running it. */
  private drop(w: Waiter): void {
    const i = this.waiting.indexOf(w);
    if (i >= 0) this.waiting.splice(i, 1);
    w.cleanup();
  }

  /**
   * Hand the browser to whoever is next. With a lease held, that is the holder's
   * oldest waiting call, skipping everyone else; without one, the head of the queue,
   * whatever it is. A grant can be followed at once by more dispatches, hence the loop.
   */
  private pump(): void {
    while (!this.running && this.waiting.length > 0) {
      const token = this.lease?.token;
      const i = token === undefined ? 0 : this.waiting.findIndex((w) => w.kind === 'call' && w.lease === token);
      if (i < 0) return;
      const [next] = this.waiting.splice(i, 1);
      next.cleanup();
      next.dispatch();
    }
  }

  private grant(holder: string | undefined): LeaseGrant {
    const token = randomBytes(16).toString('hex');
    const now = this.clock.now();
    const lease: Lease = {
      token,
      holder: cleanHolder(holder, token),
      grantedAt: now,
      lastUsedAt: now,
      maxTimer: undefined,
    };
    lease.maxTimer = this.clock.setTimeout(
      () => this.end(lease, `reached its maximum lifetime of ${secs(this.limits.maxLeaseMs)}`),
      this.limits.maxLeaseMs,
    );
    this.lease = lease;
    this.touch(lease);
    return { lease: token, holder: lease.holder, idleMs: this.limits.idleMs, maxLeaseMs: this.limits.maxLeaseMs };
  }

  /** The lease was just used: restart its idle clock. */
  private touch(lease: Lease): void {
    this.pauseIdle(lease);
    lease.lastUsedAt = this.clock.now();
    lease.idleTimer = this.clock.setTimeout(
      () => this.end(lease, `expired after ${secs(this.limits.idleMs)} with no call carrying it`),
      this.limits.idleMs,
    );
  }

  private pauseIdle(lease: Lease): void {
    if (lease.idleTimer !== undefined) this.clock.clearTimeout(lease.idleTimer);
    lease.idleTimer = undefined;
  }

  /**
   * End a lease: remember how, refuse its waiting calls (their turn is over, and
   * letting them queue as strangers would interleave them with whoever is next),
   * and hand the browser on.
   */
  private end(lease: Lease, how: string): void {
    if (this.lease !== lease) return;
    this.pauseIdle(lease);
    this.clock.clearTimeout(lease.maxTimer);
    this.lease = undefined;
    this.ended.set(lease.token, how);
    if (this.ended.size > ENDED_MEMORY) this.ended.delete(this.ended.keys().next().value as string);
    for (const w of this.waiting.filter((x) => x.lease === lease.token)) {
      this.drop(w);
      w.fail(
        new BrowserQueueError(
          `browser queue: this lease ${how} while ${w.label} was waiting, so it did not run. Acquire a new lease, or call without one.`,
        ),
      );
    }
    this.pump();
  }
}

/** Optional `lease` argument, added to every browser_* schema and to session_attach/login/solve_challenge. */
export const LEASE_PROPERTY = {
  type: 'string',
  description:
    'Optional token from browser_lease_acquire. Pass it on every call of your multi-step turn: while a ' +
    'lease is held only calls carrying it run, and everyone else waits. Omit it if you hold no lease; ' +
    'the call then waits its turn in the browser queue.',
} as const;

/**
 * Read the `lease` argument. Absent or null is "no lease"; anything that is not a
 * string is refused rather than coerced, because a coerced token is somebody
 * else's identity at best.
 */
export function leaseArg(args: Record<string, unknown>): string | undefined {
  const raw = args.lease;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new BrowserQueueError('browser queue: `lease` must be the string token browser_lease_acquire returned');
  return raw;
}

const DEFAULT_LEASE_IDLE_MS = 90_000;
const DEFAULT_LEASE_MAX_MS = 600_000;
const DEFAULT_QUEUE_WAIT_MS = 600_000;

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * The limits, from the environment. ENVIRONMENT-ONLY, never tool arguments, like
 * the exfil knobs (src/exfil.ts): an injected page can talk the model into
 * passing a huge lease time, but it cannot reach your shell.
 */
function envQueueLimits(): QueueLimits {
  return {
    idleMs: envMs('PLAYWRIGHT_MCP_LEASE_IDLE_MS', DEFAULT_LEASE_IDLE_MS),
    maxLeaseMs: envMs('PLAYWRIGHT_MCP_LEASE_MAX_MS', DEFAULT_LEASE_MAX_MS),
    maxWaitMs: envMs('PLAYWRIGHT_MCP_QUEUE_WAIT_MS', DEFAULT_QUEUE_WAIT_MS),
  };
}

/**
 * The one queue in front of the one upstream connection. Process-wide, so the
 * stdio surface and every HTTP session share it, exactly as they share the browser.
 */
export const browserQueue = new BrowserQueue(envQueueLimits());
