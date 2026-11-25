/**
 * web-fetch.ts — stealth-renders a URL (HTML or PDF) and returns readable text +
 * CSL-JSON citation + page-health + CMS, and (on request) outbound links + the
 * reference section. Replaces native WebFetch.
 *
 * Owns all rendering and extraction. The session-side web-search skill drives it
 * over MCP to verify/cite the top native-WebSearch results (links mode harvests
 * leads for research). The MCP tool (webFetch) is a thin wrapper over fetchUrl().
 *
 * Spec: /web-fetch-method. Extraction internals live in src/extract.ts.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';

import type { Page, Response } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getStealthContext, openSessionContext, pace, useStealthContext, writeBackSessionJar } from '../browser.js';
import { dismissConsent } from '../consent.js';
import {
  egressRestricted,
  assertEgressAllowed,
  installEgressGuard,
  EgressBlockedError,
  type EgressGuardHandle,
} from '../egress.js';
import { guardOutbound, sessionAllowsUrl, wrapUntrusted } from '../exfil.js';
import { TtlCache, canonicalUrl } from '../cache.js';
import { sessionFilePath, secretInventory } from '../secrets.js';
import type { ToolContext } from '../tools.js';
import {
  solveChallenge,
  startHeartbeat,
  CAPPED_HUMAN_WAIT_MS,
  WALL_SESSION_PREFIX,
  type LoginResult,
} from './session.js';
import { looksLikeSignIn } from '../login-done.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:web_fetch]', ...args);
import {
  classifyHealth,
  extractReadable,
  extractCitation,
  detectCms,
  harvestLinks,
  extractLinkIndex,
  extractPdfText,
  jarWorthKeeping,
  wallVendor,
  type Citation,
  type FetchStatus,
  type ContentType,
  type LinkScope,
} from '../extract.js';

const FETCH_TIMEOUT_MS = 20_000;
const cache = new TtlCache<FetchResult>(5 * 60_000); // 5-min page cache

export interface FetchResult {
  url: string;
  fetchStatus: FetchStatus;
  contentType: ContentType;
  cms: string | null;
  text: string;
  citation: Citation;
  links?: string[];
  references?: string[];
  /** Present only when quality:"research" — a marker for the session to run the
   *  source-appraiser agent (the server has no LLM; it never fills this). */
  appraisalRequested?: boolean;
  /** Set when the body is not article prose (e.g. a rescued link index). */
  note?: string;
  /**
   * Server-authored, and only that. `error` is emitted OUTSIDE the quarantine
   * because the envelope is this server talking to the model, so nothing a page
   * influenced may be interpolated into it — put that in `errorDetail`.
   */
  error?: string;
  /**
   * The CAPTURED half of a failure: a raw caught-exception message, which for a
   * Playwright error carries the URL the page chose via redirect and whatever
   * text the browser echoed back. Page-influenced, so it rides INSIDE the
   * quarantine (see frameFetchResult) while `error` stays a server sentence.
   * Truncated by `briefly` before it ever gets here.
   */
  errorDetail?: string;
}

export interface FetchOptions {
  url: string;
  links?: boolean;
  quality?: 'fast' | 'research';
  /**
   * Named session_login artifact to read authenticated (paywalled) content with,
   * e.g. "ft" or "nyt". Read in that name's own persistent read profile (an
   * ephemeral context when the profile is busy), seeded from the file, with its
   * own cookie jar — the authed identity never touches the shared scraping profile
   * (the storageState-isolation rule). Local instance only (refused on remote).
   */
  session?: string;
  /**
   * Which links `links:true` returns. Defaults to `outbound` (research leads),
   * which is what every pre-existing caller expects. Use `same-origin` to
   * enumerate a site's own pages (archives, indexes, tables of contents).
   */
  linkScope?: LinkScope;
}

/**
 * Render + extract, getting past a bot wall with the human's help. Never throws
 * into the caller — failures come back as a FetchResult with an error and a
 * best-effort fetchStatus.
 *
 * A wall is handled the way session_solve_challenge handles it, without anyone
 * having to ask: the clearance a human produced for a host is saved as
 * `wall-<host>` and replayed by every later fetch there; when there is none, or it
 * has lapsed, the same real Chrome window opens on the walled page for the human to
 * clear, and the fetch retries once it is. Only where session_solve_challenge
 * itself is allowed (stdio and the local surface, never cloud), and never for a
 * caller that named its own session. A direct caller with no ctx is an unknown
 * surface and gets the plain render.
 *
 * Unlike session_solve_challenge, nobody asked this call to wait for a person, and
 * an unattended fetch once sat on a window for 3.5 hours (atergolupi.com,
 * 2026-11-08). So the fetch waits WALL_WAIT_MS, then returns 'awaiting-human'
 * saying a window is waiting. The window outlives the call: a clear after that still
 * saves `wall-<host>`, and the retry reads with it. A fetch that finds the window
 * already open returns the same answer at once.
 *
 * 'awaiting-human', not 'blocked': the user, 2026-11-25, "he's happy to solve
 * captchas himself; what he doesn't want is research silently losing a page". A
 * plain 'blocked' read the same as a hard 403, and an agent (a background subagent
 * most of all) dropped the source. 'blocked' is kept for a wall no window can open
 * for (no display, the cloud surface) and for refusals.
 */
export async function fetchUrl(
  opts: FetchOptions,
  ctx?: ToolContext,
  // Replaces opening the window, so the solved-then-still-walled path is testable
  // without a human. The real opener stays below as the one solveChallenge call.
  openWindow?: () => Promise<LoginResult>,
  // The wait bound and the desktop notice, so the awaiting-human paths are testable
  // in milliseconds and without a real notification on the user's screen.
  seams: WallSeams = {},
): Promise<FetchResult> {
  const trusted = ctx?.trust === 'stdio' || ctx?.trust === 'local';
  const wall = wallSessionName(opts.url);
  // A caller-named session never opens the window (see above), so a wall it meets
  // has to say what happened and how to get back in. A `wall-<host>` name is a
  // saved clearance, where "it may have lapsed" is the whole story.
  if (opts.session && !opts.session.toLowerCase().startsWith(WALL_SESSION_PREFIX)) {
    return fetchOnce(opts, sessionWallAdvice(opts.session, wall, trusted && canShowWindow()));
  }
  if (!trusted || opts.session || !wall) return fetchOnce(opts);

  const saved = fs.existsSync(sessionFilePath(wall));
  const first = await fetchOnce(saved ? { ...opts, session: wall } : opts);
  // An unreachable read used no clearance: nothing answered to be shown one.
  if (!walled.has(first)) {
    return saved && first.fetchStatus !== 'unreachable'
      ? withNote(first, `read with the saved bot-wall clearance "${wall}"`)
      : first;
  }
  if (!canShowWindow()) {
    return {
      ...first,
      error:
        'a bot check was returned instead of page content, and there is no display here to open the ' +
        'window a human clears it in. Clear it from a machine with a screen using session_solve_challenge.',
    };
  }

  const host = wall.slice(WALL_SESSION_PREFIX.length);
  // The capture gets no `progress`: its own heartbeat would keep this call open for as
  // long as the window is, which is the hang this bound exists to end. This call
  // heartbeats only for the wait it does itself.
  const windowMs = ctx.trust === 'stdio' ? WALL_WINDOW_MS : CAPPED_HUMAN_WAIT_MS;
  const notify = seams.notify ?? notifyWallWindow;
  const stop = startHeartbeat(ctx, `bot wall at ${host}`, wallHeartbeat);
  let waited: WallWait;
  try {
    waited = await awaitWallSolve(
      wall,
      openWindow ??
        (() => {
          // The name, not the url: a query string can carry a token, and stderr is a log.
          log(`${wall}: bot wall; opening a window for the human to clear it`);
          notify(host, { force: true });
          return solveChallenge(wall, opts.url, { trust: ctx.trust }, undefined, windowMs);
        }),
      seams.boundMs,
    );
  } finally {
    stop();
  }
  // A fetch that finds the window already up nudges the human again: the first
  // notice may have gone by while they were away. Throttled per host, so a
  // research run fanning out over one walled site does not stack them up.
  if (waited.state === 'busy') notify(host, {});
  // Got its page within the bound: not one of the fetches still waiting.
  if (waited.state === 'done') settledFetch(wall);
  if (waited.state !== 'done') {
    return {
      ...first,
      fetchStatus: 'awaiting-human',
      error: awaitingHumanAdvice(host, wall, windowMs),
    };
  }
  const solved = waited.result;
  if (!solved.ok) {
    return {
      ...first,
      error:
        `a bot check was returned instead of page content; a window opened for the human to clear it, ` +
        `and it ${solved.cancelled ? 'was closed before the wall cleared' : 'ended without clearing it'}. ` +
        'Retry web_fetch to open it again.',
    };
  }
  // The `wall-<host>` file is kept even when this retry is walled too: it is what a
  // real browser earned, it does no harm, and dropping it would not stop the next
  // fetch from opening the window again either (no file means a wall means a window).
  const retry = await fetchOnce({ ...opts, session: wall }, solvedStillWalledAdvice());
  return walled.has(retry) ? retry : withNote(retry, `bot wall cleared by the human; saved as "${wall}" for later fetches`);
}

/**
 * What a caller is told while a window waits on the human: the `error` of an
 * 'awaiting-human' result. Written for an agent that may be a background subagent
 * with no human of its own to ask, so it says what not to do (drop the source) as
 * plainly as what to do. gs1uk.org, 2026-11-25: a walled page reported as content
 * was dropped from a research run, and the user never saw the window.
 *
 * Server-authored only: `host` and `wall` come from the URL the caller asked for,
 * never the one the page redirected to, since this text lands outside the quarantine.
 */
export function awaitingHumanAdvice(host: string, wall: string, windowMs: number): string {
  const hours = windowMs / 3_600_000;
  const open =
    hours >= 1
      ? `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}`
      : `${Math.round(windowMs / 60_000)} minutes`;
  return (
    `A bot check at ${host} is waiting for the user to solve it in a window on their screen (it stays open ` +
    `up to ${open}). Do NOT drop this source: report this URL to your parent agent or the user, and retry ` +
    'web_fetch later, or once the user says it is cleared. The clearance is saved as ' +
    `"${wall}" and the retry reads with it.`
  );
}

/**
 * The retry right after the human's window saved is walled again. That is not a
 * clearance that lapsed: a real Chrome just got the page, so the site refuses THIS
 * headless browser on this page, and no clearance changes that. MEASURED 2026-11-24
 * 06:20Z on eBay /itm/ pages: the human's Chrome loaded them with no challenge, the
 * window saved within seconds, the retry got the "SORRY" page and the caller was told
 * the clearance "may have lapsed"; the same page read fine with web_fetch session:'ebay'.
 *
 * Server-authored only, with nothing from the URL in it: this text lands outside
 * the quarantine.
 */
export function solvedStillWalledAdvice(): string {
  return (
    'A window opened, the page loaded in a real browser and its clearance was saved, but this headless ' +
    'browser was refused again with that clearance: the site turns away this browser on this page, and ' +
    'no clearance will fix that, so do not retry or re-solve. A logged-in session may get through: ' +
    'capture one with session_login({name, loginUrl}) and read with web_fetch({url, session: name}).'
  );
}

/** Results that rendered a bot wall. A set, not a field: it never reaches the model. */
const walled = new WeakSet<FetchResult>();

/** How long a fetch waits on a window it opened before returning "a window is waiting". */
export const WALL_WAIT_MS = 90_000;
/**
 * How long that window stays open unattended on stdio. Its capture's own deadline,
 * so the capture's cleanup closes Chrome and nothing else has to track it. The HTTP
 * surfaces keep their 300s cap (resolveHumanWait).
 *
 * Four hours, up from 30 minutes (2026-11-25): research runs unattended, and a
 * window that closed before the human came back lost the page all the same. Only
 * the window waits that long; each fetch still waits WALL_WAIT_MS. The window is a
 * 'solve' browser in src/lifetime.ts, so it is never idle-closed or made room for,
 * and it is closed with its server: it never outlives the session that opened it.
 */
export const WALL_WINDOW_MS = 4 * 3_600_000;

/** Test seams for fetchUrl's wall handling. */
export interface WallSeams {
  /** Replaces WALL_WAIT_MS. */
  boundMs?: number;
  /** Replaces notifyWallWindow. */
  notify?: (host: string, opts: { force?: boolean }) => void;
}

function wallHeartbeat(what: string, elapsedMs: number): string {
  return (
    `${what} — waiting for the human (${Math.round(elapsedMs / 1000)}s of ` +
    `${WALL_WAIT_MS / 1000}s); after that the fetch returns and the window stays open.`
  );
}

/** One window per host. The promise never rejects (see awaitWallSolve). */
const solving = new Map<string, Promise<LoginResult>>();

/**
 * The windows waiting on the human, for browser_status. Kept beside `solving`
 * rather than read off it, since a promise says nothing about when it started or
 * who met it. A cleared one stays listed for CLEARED_LISTED_MS, so an agent
 * polling for it sees "cleared, retry now" rather than the entry just vanishing;
 * a cancelled or failed one goes at once, since there is nothing left to wait on.
 */
interface PendingWall {
  openedAt: number;
  lastFetchAt: number;
  fetches: number;
  clearedAt?: number;
}
const pending = new Map<string, PendingWall>();
const CLEARED_LISTED_MS = 10 * 60_000;

/** A fetch that met the window was answered in the same call: it waits on nothing now. */
function settledFetch(wall: string): void {
  const p = pending.get(wall);
  if (p && p.fetches > 0) p.fetches -= 1;
}

export interface PendingWallRow {
  host: string;
  /** The saved clearance a retry reads with. */
  session: string;
  openedAt: string;
  /** Seconds the human has been waited on: until now, or until they cleared it. */
  waitingSec: number;
  lastFetchAt: string;
  cleared: boolean;
  clearedAt?: string;
  /** Fetches that came back 'awaiting-human' on this window (or are in their wait now): each should be retried. */
  fetchesWaiting: number;
}

/** This server's bot-wall windows, oldest first. `now` is injectable for tests. */
export function pendingWalls(now = Date.now()): PendingWallRow[] {
  const rows: PendingWallRow[] = [];
  for (const [wall, p] of pending) {
    if (p.clearedAt !== undefined && now - p.clearedAt > CLEARED_LISTED_MS) {
      pending.delete(wall);
      continue;
    }
    rows.push({
      host: wall.slice(WALL_SESSION_PREFIX.length),
      session: wall,
      openedAt: new Date(p.openedAt).toISOString(),
      waitingSec: Math.round(((p.clearedAt ?? now) - p.openedAt) / 1000),
      lastFetchAt: new Date(p.lastFetchAt).toISOString(),
      cleared: p.clearedAt !== undefined,
      ...(p.clearedAt !== undefined ? { clearedAt: new Date(p.clearedAt).toISOString() } : {}),
      fetchesWaiting: p.fetches,
    });
  }
  return rows.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
}

export type WallWait =
  /** A window for this host was already open; nothing new was started. */
  | { state: 'busy' }
  /** A window was opened and is still up after the bound. */
  | { state: 'waiting' }
  | { state: 'done'; result: LoginResult };

/**
 * Open the window for `wall` unless one is already up, and wait at most `boundMs`
 * for it. The solve keeps running past the bound. It cannot reject: nothing awaits
 * it by then, and an unhandled rejection would take the server down. `open` is
 * injected so the bound is testable without a browser.
 */
export function awaitWallSolve(
  wall: string,
  open: () => Promise<LoginResult>,
  boundMs = WALL_WAIT_MS,
): Promise<WallWait> {
  if (solving.has(wall)) {
    const p = pending.get(wall);
    if (p) {
      p.fetches += 1;
      p.lastFetchAt = Date.now();
    }
    return Promise.resolve({ state: 'busy' });
  }
  const opened = Date.now();
  const entry: PendingWall = { openedAt: opened, lastFetchAt: opened, fetches: 1 };
  pending.set(wall, entry);
  const p = Promise.resolve()
    .then(open)
    .catch((err): LoginResult => ({
      name: wall,
      path: '',
      capturedAt: new Date().toISOString(),
      mode: 'challenge',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }))
    .then((result) => {
      // Only this window's entry: a later one for the same host replaces it.
      if (pending.get(wall) === entry) {
        if (result.ok) entry.clearedAt = Date.now();
        else pending.delete(wall);
      }
      return result;
    })
    .finally(() => solving.delete(wall));
  solving.set(wall, p);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<WallWait>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'waiting' }), boundMs);
    timer.unref();
  });
  return Promise.race([p.then((result): WallWait => ({ state: 'done', result })), bound]).finally(() =>
    clearTimeout(timer),
  );
}

type ExecFileLike = (
  file: string,
  args: string[],
  opts: { timeout: number },
  done: (err: Error | null) => void,
) => { on?(event: 'error', fn: () => void): unknown; unref?(): void };

/**
 * The least time between two notices for one host. A fetch that finds the window
 * already open re-notifies (the first notice may have gone by while the human was
 * away), and a research run can send dozens of fetches to one walled site.
 */
export const WALL_NOTIFY_EVERY_MS = 5 * 60_000;
const lastNotice = new Map<string, number>();

/**
 * Tell the human a window is waiting, since the fetch that opened it may be running
 * unattended. Fire-and-forget: argv only, never a shell; skipped without a display
 * or without notify-send; never throws and never delays the fetch. The
 * 'awaiting-human' tool result is the signal for everyone else.
 *
 * Critical urgency, which notification daemons keep on screen until dismissed (the
 * freedesktop spec: critical notices should not expire on their own): the human
 * this is for is away. Linux only, as before: no notice is sent on macOS or Windows.
 *
 * At most one per host per WALL_NOTIFY_EVERY_MS, unless `force` (a window just
 * opened). Only a notice actually sent starts the clock, so a skipped one (no
 * display) never uses up the slot. Returns whether it sent.
 */
export function notifyWallWindow(
  host: string,
  deps: {
    execFile?: ExecFileLike;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    now?: number;
    force?: boolean;
  } = {},
): boolean {
  const env = deps.env ?? process.env;
  if ((deps.platform ?? process.platform) !== 'linux') return false;
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const now = deps.now ?? Date.now();
  const last = lastNotice.get(host);
  if (!deps.force && last !== undefined && now - last < WALL_NOTIFY_EVERY_MS) return false;
  lastNotice.set(host, now);
  try {
    const child = (deps.execFile ?? (execFile as unknown as ExecFileLike))(
      'notify-send',
      [
        '--app-name=playwright-mcp',
        '--urgency=critical',
        // The host comes from a URL: never let one that starts with "-" read as an option.
        '--',
        `${host} needs you: a research fetch is waiting on a bot check`,
        'Solve it in the window playwright-mcp opened. The fetch reuses the clearance once it is cleared.',
      ],
      { timeout: 5_000 },
      () => {}, // a missing notify-send or a failed send is not the fetch's business
    );
    child.on?.('error', () => {});
    child.unref?.();
  } catch {
    /* never the reason a fetch fails */
  }
  return true;
}

/** The saved clearance for a host's wall. Per host, since that is what a clearance cookie covers. */
export function wallSessionName(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host ? `${WALL_SESSION_PREFIX}${host}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a wall in front of a caller-named session means, and the two ways back in.
 * It used to say the session's "clearance may have lapsed", which sent the model
 * looking for a clearance a login session never had. MEASURED 2026-11-23 on eBay:
 * the login was good; headless reads had rewritten the session's Akamai and Radware
 * cookies, and eBay answered every search with its 403 "SORRY" page.
 *
 * Server-authored only. `wall` comes from the URL the caller asked for, never the
 * one the page redirected to, since this text lands outside the quarantine.
 * `canOpenWindow` is false where a sessionless fetch could not open the window
 * either (an HTTP surface, no display), so the advice never promises one.
 */
export function sessionWallAdvice(session: string, wall: string | undefined, canOpenWindow: boolean): string {
  const name = JSON.stringify(session);
  const publicRead = canOpenWindow
    ? 'For a public page, retry web_fetch without `session`: that read uses the shared profile, opens a window ' +
      `for the human to clear the wall, and saves the clearance as ${wall ? `"${wall}"` : '"wall-<host>"'} for later fetches.`
    : 'For a public page, retry web_fetch without `session`; a wall there needs a window for the human, which ' +
      'cannot open from here (no display, or not the local surface), so clear it with session_solve_challenge on a machine with a screen.';
  return (
    `Session ${name} was turned away by the site's bot manager. The login may still be good: this read ` +
    "replays the session's bot-manager cookies from a headless browser, and the site may have flagged them. " +
    'No window opens for a named session. To recover, capture it again with ' +
    `session_login({name: ${name}, loginUrl: <the site's sign-in page>, attach: true}), which signs in from ` +
    `playwright-mcp's own Chrome profile for that name. ${publicRead}`
  );
}

/** A headed window needs a display; on Linux that is X or Wayland, elsewhere there always is one. */
function canShowWindow(): boolean {
  return process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function withNote(r: FetchResult, note: string): FetchResult {
  return { ...r, note: r.note ? `${r.note}; ${note}` : note };
}

/**
 * One render + extract, no wall handling. `wallAdvice` replaces the default tail of
 * a session read's wall error (see sessionWallAdvice).
 */
async function fetchOnce(opts: FetchOptions, wallAdvice?: string): Promise<FetchResult> {
  const url = canonicalUrl(opts.url);
  const linkScope: LinkScope = opts.linkScope ?? 'outbound';
  const cacheKey = `${url}|links=${opts.links ? 1 : 0}|scope=${linkScope}|session=${opts.session ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Outbound exfiltration guards (ledger DEC-2026-07-29). Runs on EVERY instance,
  // unlike the egress check below — this watches what leaves, not what we can be
  // pointed at. A cache hit skips it: that URL already shipped, so there is
  // nothing left to prevent.
  const guard = guardOutbound(url, secretInventory());
  if (!guard.ok) {
    return errorResult(url, 'blocked', guard.reason ?? 'refused by the exfiltration guard', opts.links);
  }

  // Remote (claude.ai) instance: refuse SSRF to metadata/localhost/private nets.
  if (egressRestricted()) {
    try {
      await assertEgressAllowed(url);
    } catch (err) {
      return errorResult(
        url,
        'blocked',
        'refused by the egress guard: the reason is quarantined below as `errorDetail` — ' +
          'it is a caught error message, not this server speaking',
        opts.links,
        briefly(err),
      );
    }
  }

  // Pick the render context. Anonymous → the shared persistent stealth profile.
  // Authenticated (opts.session) → that name's own read profile, seeded from its
  // storageState (browser.ts openSessionContext), so authed cookies live in their
  // own jar and never bleed into the shared scraping profile (the
  // storageState-isolation rule). Local-only:
  // a captured session is never loaded on the prompt-injectable remote surface.
  //
  // Acquiring the page is inside the try: a browser that will not start is a
  // fetch failure like any other, and must come back as a FetchResult. It used
  // to throw past this function, breaking the never-throw contract and reaching
  // the model as a bare `Error in web_fetch:` with no fetchStatus.
  let page: Page;
  let cleanup: (() => Promise<void>) | undefined;
  // Set only on the remote instance; reads back the reason a redirect hop was
  // refused, which page.goto reports only as net::ERR_ACCESS_DENIED.
  let egressGuard: EgressGuardHandle | undefined;
  // Whether a session read may write its jar back; set once the result is known.
  let keepJar = false;
  // Whether the navigation got an answer. A throw before that never reached the
  // site, so it may be 'unreachable'; a throw after it reached one.
  let navigated = false;
  try {
    if (opts.session) {
      if (egressRestricted()) {
        return errorResult(url, 'blocked', 'authenticated web_fetch (session) is disabled on the remote instance', opts.links);
      }
      const file = sessionFilePath(opts.session);
      if (!fs.existsSync(file)) {
        return errorResult(url, 'blocked', `session "${opts.session}" not found — capture it with session_login first`, opts.links);
      }
      // Session domain scoping (DEC-2026-07-29): a captured identity may only be
      // replayed against its own registrable domains, so an injected page cannot
      // get an authenticated context pointed at an attacker host. Reading the
      // artifact here also gives a corrupt one a clean refusal instead of letting
      // newContext() throw past fetchUrl's never-throw contract.
      let state: unknown;
      try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return errorResult(url, 'blocked', `session "${opts.session}" is unreadable or corrupt — recapture it with session_login`, opts.links);
      }
      if (!sessionAllowsUrl(state, url)) {
        return errorResult(
          url,
          'blocked',
          `refused: session "${opts.session}" holds no identity for this URL's domain. ` +
            'A captured session is only replayed against the site it was captured on — ' +
            'fetch this URL without the session parameter.',
          opts.links,
        );
      }
      // The session's own persistent read profile, or an ephemeral browser when
      // that cannot be had (openSessionContext). Either way a jar of its own.
      const session = await openSessionContext(opts.session, file);
      // Registered before the page exists: if newPage throws, the catch below
      // still has something that closes this browser.
      cleanup = () => session.close();
      const context = session.context;
      page = await context.newPage();
      cleanup = async () => {
        // Rolling session write-back (writeBackSessionJar), only after a read that
        // came back as content (jarWorthKeeping): a logged-out jar, or one a bot
        // wall just rewrote, must never overwrite the captured one. A read that
        // threw never sets `keepJar` at all.
        try {
          const landed = page.url();
          if (keepJar && !looksLikeSignIn(landed)) await writeBackSessionJar(context, file, session.profile);
        } catch {
          /* write-back is best-effort; the read result is unaffected */
        }
        await session.close();
      };
    } else {
      // Held from before the launch until the page is closed, so the shared
      // context's idle close (src/lifetime.ts) can never land mid-fetch.
      const release = useStealthContext();
      cleanup = async () => release();
      const context = await getStealthContext();
      page = await context.newPage();
      cleanup = async () => {
        await page.close().catch(() => {});
        release();
      };
      if (egressRestricted()) egressGuard = await installEgressGuard(page);
    }
  } catch (err) {
    await cleanup?.();
    // Two values, not one sentence. The launch failure's own text is a caught
    // exception — see errorResult, and `errorDetail` in FetchResult.
    return errorResult(
      url,
      'blocked',
      'browser unavailable: the render browser would not start; the failure text is quarantined ' +
        'below as `errorDetail`',
      opts.links,
      briefly(err),
    );
  }
  try {
    await pace();
    // Wait for the document to COMMIT, then for DOMContentLoaded separately.
    // DOMContentLoaded waits on every deferred and module script, so one stalled
    // script (ntrs.nasa.gov serves its Angular bundle as `type=module`) used to
    // time the whole goto out and throw away a server-rendered page that had
    // already arrived in full. Same 20s budget; past it, extract what rendered.
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: FETCH_TIMEOUT_MS });
    navigated = true;
    const loaded = await page
      .waitForLoadState('domcontentloaded', { timeout: Math.max(1, deadline - Date.now()) })
      .then(() => true, () => false);
    const status = resp?.status() ?? 0;
    const headers = resp?.headers() ?? {};
    const ctHeader = (headers['content-type'] ?? '').toLowerCase();
    const finalUrl = canonicalUrl(page.url());

    let result: FetchResult;
    // A `.pdf` URL that answered with HTML (an error page, a wall) is a page, and
    // is classified as one; it used to be fed to the PDF parser and come back
    // "blocked" with no reason.
    if (ctHeader.includes('application/pdf') || (/\.pdf($|\?)/i.test(url) && !ctHeader.includes('text/html'))) {
      const got = resp ? await pdfBytes(page, resp) : 'there was no response to read';
      const bytes = typeof got === 'string' ? undefined : got;
      const pdf = bytes ? await extractPdfText(bytes) : { title: '', text: '' };
      result = {
        url: finalUrl,
        fetchStatus: status === 404 ? '404' : bytes && status < 400 ? 'ok' : 'blocked',
        contentType: 'pdf',
        cms: 'PDF',
        text: pdf.text,
        citation: {
          type: 'article-journal',
          title: pdf.title || finalUrl,
          author: [],
          URL: finalUrl,
          dateConfidence: 'low',
        },
      };
      if (result.fetchStatus === 'blocked') {
        result.error =
          status >= 400
            ? `the site answered HTTP ${status} for this PDF; retry later`
            : `no PDF text could be read: ${typeof got === 'string' ? got : 'unknown reason'}`;
      } else if (result.fetchStatus === 'ok' && !pdf.text) {
        result.note = 'the PDF has no text layer (likely a scanned image); OCR is not done here';
      }
    } else {
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      // Dismiss any cookie-consent banner BEFORE extracting. On a link-dense
      // index page the notice is the only substantial prose block, so
      // Readability would otherwise select the privacy text AS the article and
      // discard the real content silently. The shared profile is persistent, so
      // this costs one click per domain, ever.
      await dismissConsent(page);
      const html = await page.content();
      let readable = extractReadable(html, finalUrl);
      let fetchStatus = classifyHealth(html, status, readable.text);
      // Sent somewhere that reads as a sign-in step: the page needs a login, or the
      // session's has lapsed. Checked before the wall test, since a login page that
      // carries a captcha widget is still a login page and must never open the
      // bot-wall window. Only a REDIRECT counts: fetching /login itself is fine.
      if (finalUrl !== url && looksLikeSignIn(finalUrl) && !looksLikeSignIn(url)) fetchStatus = 'login-wall';
      // A server error that is not a wall (nginx's rate-limit 503 on ntrs.nasa.gov)
      // used to come back 'ok' with the error page's text as the body. A challenge
      // served with a 5xx (Cloudflare's 503) is already 'blocked' above and stays a
      // wall; this one opens no window, since there is nothing for a human to solve.
      const serverError = status >= 500 && fetchStatus !== 'blocked';
      if (serverError) fetchStatus = 'blocked';
      const citation = extractCitation(html, finalUrl);
      if (!citation.title) citation.title = readable.title || finalUrl;

      // Index rescue: the page carries no usable prose (a surviving banner, or
      // simply a listing) but is dense with on-site links. Return that index as
      // the body rather than a privacy notice or an empty string.
      // Never rescue a wall the classifier already named: a bot-check page with
      // a link-dense footer would otherwise come back 'ok' with no content.
      let note: string | undefined;
      // Nor replace a results table already recovered from the page: its rows carry
      // the columns a link list would drop.
      if (fetchStatus === 'consent-wall' || (fetchStatus === 'ok' && readable.text.length < 600 && !readable.tableRows)) {
        const index = extractLinkIndex(html, finalUrl);
        if (index.split('\n').length >= 10) {
          readable = { title: readable.title, text: index };
          fetchStatus = 'ok';
          note = 'index page: body is a "label | url" list of on-site links, not prose';
        }
      }

      result = {
        url: finalUrl,
        fetchStatus,
        contentType: 'html',
        cms: detectCms(html, headers),
        text: readable.text,
        citation,
      };
      if (note) result.note = note;
      if (fetchStatus === 'login-wall') {
        result.error = opts.session
          ? `session "${opts.session}" is not logged in: the site sent this request to its sign-in page. ` +
            'Capture it again with session_login.'
          : 'this page needs a login: the site sent this request to its sign-in page. Capture one with ' +
            'session_login, then retry with web_fetch({url, session: name}).';
      }
      if (fetchStatus === 'consent-wall') {
        result.error =
          'a cookie-consent notice was returned instead of page content and could not be dismissed; ' +
          'the real content may still be in the DOM. Retry, or add an accept selector to ACCEPT_SELECTORS in src/consent.ts';
      }
      if (serverError) {
        result.error = `the site answered HTTP ${status} (unavailable or rate-limited); retry shortly`;
      } else if (fetchStatus === 'blocked') {
        walled.add(result);
        const vendor = wallVendor(html);
        result.error =
          `a bot check or CAPTCHA${vendor ? ` (${vendor})` : ''} was returned instead of page content. ` +
          (opts.session
            ? (wallAdvice ?? `Session "${opts.session}" did not get past it; its clearance may have lapsed.`)
            : 'Have the human clear it once with ' +
              'session_solve_challenge({name, url}), then retry with web_fetch({url, session: name})');
      }
      if (opts.links) {
        const leads = harvestLinks(html, finalUrl, linkScope);
        result.links = leads.links;
        result.references = leads.references;
      }
    }

    if (!loaded) {
      result = withNote(result, `the page had not finished loading after ${FETCH_TIMEOUT_MS / 1000}s; this is what had rendered`);
    }
    keepJar = jarWorthKeeping(result.fetchStatus);
    if (opts.quality === 'research') result.appraisalRequested = true;
    // A failure is not cached: a wall must be seen again after a solve, and a
    // transient one (a 503, a half-loaded page) must not stick for five minutes.
    if (!walled.has(result) && !result.error && loaded) cache.set(cacheKey, result);
    return result;
  } catch (err) {
    // A refused redirect hop reaches here as a bare chromium error code, so the
    // guard's own reason wins when it has one. Two branches, and they differ in
    // PROVENANCE, not only in wording: the guard's reason is server-authored and
    // belongs in the envelope; anything else is a caught error from a navigation
    // the page steered, so it is quarantined instead.
    //
    // A navigation that never reached a site is 'unreachable', not 'blocked'. It used
    // to be 'blocked' like every other throw, and a caller reads 'blocked' as a bot
    // wall: 2026-11-24 an eBay scan's machine lost its network
    // (net::ERR_INTERNET_DISCONNECTED), web_fetch said 'blocked', and the scan backed
    // off for hours from a site that had refused nothing. Checked after the guard:
    // a refused hop is ERR_ACCESS_DENIED, which is ours and stays 'blocked'.
    const refusedHop = egressGuard?.blocked();
    if (!refusedHop && !navigated && isUnreachable(err)) {
      return errorResult(
        url,
        'unreachable',
        'the page could not be reached: the network or DNS failed, or the host did not answer. This is not ' +
          'a bot wall and the site refused nothing; retry later. The browser error is quarantined below as `errorDetail`',
        opts.links,
        briefly(err),
      );
    }
    return refusedHop
      ? errorResult(url, 'blocked', refusedHop, opts.links)
      : errorResult(
          url,
          'blocked',
          'the page could not be fetched: the browser error is quarantined below as `errorDetail`',
          opts.links,
          briefly(err),
        );
  } finally {
    await cleanup?.();
  }
}

/** A PDF's header may sit anywhere in its first kilobyte (PDF 1.7, 7.5.2 note). */
function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');
}

/**
 * The PDF's own bytes, or a server-authored reason there are none. Real Chrome renders a PDF navigation in its built-in
 * viewer, and the navigation response's body() is then the viewer's 601-byte
 * HTML stub, not the document: every PDF came back empty and "blocked". The
 * bundled Chromium hands over the real body, so that is tried first; otherwise
 * the same URL is fetched again through the page's context, which carries its
 * cookies, UA and any session jar.
 *
 * That second request is not seen by the page's egress guard, so on the remote
 * instance it is held to what the guard enforces: the URL the navigation
 * actually landed on, re-validated, and no redirect followed.
 */
async function pdfBytes(page: Page, resp: Response): Promise<Uint8Array | string> {
  const body = await resp.body().catch(() => undefined);
  if (body && isPdf(body)) return new Uint8Array(body);
  try {
    const restricted = egressRestricted();
    if (restricted) await assertEgressAllowed(resp.url());
    const again = await page.context().request.get(resp.url(), {
      timeout: FETCH_TIMEOUT_MS,
      ...(restricted ? { maxRedirects: 0 } : {}),
    });
    if (!again.ok()) return `the site answered HTTP ${again.status()} when the PDF's bytes were requested; retry shortly`;
    const bytes = new Uint8Array(await again.body());
    return isPdf(bytes) ? bytes : 'the response was labelled a PDF but its bytes are not one';
  } catch (err) {
    // Server-authored only: a caught message is page-influenced and has no place in `error`.
    return err instanceof EgressBlockedError
      ? 'the PDF host was refused by the egress guard'
      : 'the request for the PDF\'s bytes failed or timed out';
  }
}

/**
 * Chromium's net errors for a network, DNS or connection failure: the request never
 * got an answer from the site, so the site cannot have refused it.
 *
 * Left out on purpose, so they stay 'blocked': ERR_ACCESS_DENIED (the egress guard
 * and the browser's own policy, ours to report), ERR_BLOCKED_BY_* (a refusal by
 * name), and the TLS and HTTP/2 errors. Certificate errors never reach here, since
 * every context sets ignoreHTTPSErrors; a handshake or protocol failure is a host
 * that answered, and a bot manager can refuse a headless client right there (an
 * HTTP/2 stream reset is a known one), so calling those "unreachable" would hide a wall.
 */
const UNREACHABLE_NET_ERRORS = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_CONNECTION_FAILED',
  'ERR_TIMED_OUT',
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_PROXY_CONNECTION_FAILED',
]);

/**
 * Whether a navigation's throw means the site was never reached. Playwright's
 * TimeoutError counts: goto waits only for the response to COMMIT, so a timeout
 * there is a host that never answered. Only the first net:: code is read; it comes
 * before the URL in the message, and the URL is the part a redirect chose.
 */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  const code = /net::(ERR_[A-Z0-9_]+)/.exec(msg)?.[1];
  return code ? UNREACHABLE_NET_ERRORS.has(code) : /^(page\.goto: )?Timeout \d+ms exceeded/.test(msg);
}

/** Playwright errors carry a whole browser log; keep the head of it, not all of it. */
function briefly(err: unknown, max = 400): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

/**
 * Two provenances, two arguments — never one interpolated sentence.
 *
 * `error` is the server's own words and lands in the envelope; `detail` is text
 * a page influenced (a caught browser error) and lands inside the quarantine.
 * `briefly()` it first: the field is bounded, not the fence.
 */
function errorResult(
  url: string,
  status: FetchStatus,
  error: string,
  links?: boolean,
  detail?: string,
): FetchResult {
  const r: FetchResult = {
    url,
    fetchStatus: status,
    contentType: 'html',
    cms: null,
    text: '',
    citation: { type: 'webpage', title: url, author: [], URL: url, dateConfidence: 'low' },
    error,
  };
  if (detail) r.errorDetail = detail;
  if (links) {
    r.links = [];
    r.references = [];
  }
  return r;
}

// ── MCP tool wrapper ──────────────────────────────────────────────────────────

const definition: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a URL via headless Playwright with full JS rendering (handles SPAs and PDFs). ' +
    'Replaces the built-in WebFetch tool. Returns readable main text plus author/date/publisher ' +
    'citation data (CSL-JSON, plus citation.image: the page\'s og:image / twitter:image lead image as an ' +
    'absolute URL, when it has one) and page-health status. Set links:true to also harvest outbound ' +
    'links and the reference section, and linkScope:"same-origin" to enumerate a site\'s own pages ' +
    '(archives, indexes, tables of contents). quality:"research" flags the result for source appraisal. ' +
    'Pass session:"name" to read paywalled content behind a session_login capture (local only). ' +
    'Cookie-consent banners are dismissed automatically; a notice that survives returns ' +
    'fetchStatus:"consent-wall" rather than being handed back as page content. ' +
    'On a CAPTCHA / bot wall (local only) a real Chrome window opens for the human to clear it and ' +
    'the fetch waits up to 90s, retrying once it clears; the clearance is saved as "wall-<host>" and ' +
    'reused by later fetches there. While the window still waits for the human, fetchStatus is ' +
    '"awaiting-human": do NOT drop that source; report the URL to your parent agent or the user and retry ' +
    'later, which reads with the clearance. fetchStatus:"blocked" is a wall no window can open for, or a refusal. ' +
    'fetchStatus:"unreachable" means the network, DNS or host failed before any site answered: not a wall, retry later.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http/https; HTML or PDF).' },
      links: {
        type: 'boolean',
        description: 'Also return outbound links + reference section (for research). Default false.',
      },
      quality: {
        type: 'string',
        enum: ['fast', 'research'],
        description: 'fast = mechanical (default); research = flag for in-session source-appraiser agent.',
      },
      session: {
        type: 'string',
        description:
          'Named session_login artifact (e.g. "ft", "nyt") to read authenticated/paywalled content. ' +
          'Read in an isolated browser profile of its own for that name, seeded from the saved file; local instance only.',
      },
      linkScope: {
        type: 'string',
        enum: ['outbound', 'same-origin', 'all'],
        description:
          'Which links to return when links:true. "outbound" (default) = research leads leaving the host. ' +
          '"same-origin" = the site\'s own pages, for enumerating an archive, index or table of contents. "all" = both.',
      },
    },
    required: ['url'],
  },
};

/**
 * Serialize a FetchResult for model context, partitioned by WHO AUTHORED each
 * field (ledger DEC-2026-07-29).
 *
 * Inside the quarantine go the fields the PAGE controls: `text`, `citation`
 * (its title/author come from the page's own `<title>`, `og:title` and JSON-LD),
 * `cms`, and the harvested `links` / `references` — those last two are
 * attacker-chosen fetch targets handed to the model on the very tool the
 * research skills use to pick the next fetch, so they belong inside the fence
 * more than anything except the body itself.
 *
 * Outside it stays everything THIS SERVER authored: `fetchStatus`, `error`,
 * `note`, `appraisalRequested`, plus the canonical `url` (which is also the
 * quarantine's own `source=` attribute) and `contentType`. Those are the server
 * talking to the model, and several of them are deliberately actionable
 * ("capture it with session_login first"). Marking them "data, not
 * instructions" would tell the model to ignore its own tool's guidance — a
 * false positive that costs real functionality.
 *
 * `errorDetail` is the correction that made that claim TRUE. `error` used to be
 * built as `browser unavailable: ${briefly(err)}` — one string with two
 * provenances, the second of which is a raw caught exception whose Playwright
 * text embeds the URL a page chose by redirecting. The envelope was exempted on
 * the reasoning that it is "the server talking to the model", which was a claim
 * about what the field is FOR rather than about what went INTO it. Splitting the
 * two halves does not merely avoid mixing them: it makes the partition's premise
 * true. The captured half moves INSIDE, as a field of the quarantined body —
 * not as a second fenced block — so the "fenced exactly once" invariant holds
 * for every result rather than only for results without a detail.
 *
 * Framed unconditionally, including on the error path. The alternative — skip
 * the wrap when the body is empty — leaks `citation.title` (read from a hostile
 * `<title>`) whenever a page returns markup but no prose, and teaches the model
 * that an unframed result is a trusted one.
 *
 * The text block is therefore deliberately NOT one JSON document: the envelope
 * and the quarantined body are each valid JSON with the delimiter between them.
 * A single document cannot carry a delimiter around a subtree without
 * re-escaping 50 KB of body text a second time. No consumer parses this string
 * (in-process callers use fetchUrl and never see the framing).
 *
 * Pure — no browser, no network — so the T1 tier exercises it directly.
 */
export function frameFetchResult(result: FetchResult): string {
  const { text, citation, cms, links, references, errorDetail, ...envelope } = result;
  const pageDerived: Record<string, unknown> = { cms, text, citation };
  // links/references are absent unless links:true was asked for; keep them that
  // way rather than inventing empty arrays the caller did not request.
  if (links) pageDerived.links = links;
  if (references) pageDerived.references = references;
  // Same rule, same reason: absent on the success path, so a result that has no
  // captured failure text does not grow an empty field announcing one.
  if (errorDetail !== undefined) pageDerived.errorDetail = errorDetail;
  return (
    `${JSON.stringify(envelope, null, 2)}\n` +
    wrapUntrusted(JSON.stringify(pageDerived, null, 2), result.url)
  );
}

async function handler(args: Record<string, unknown>, ctx?: ToolContext): Promise<CallToolResult> {
  const url = String(args.url ?? '');
  if (!url) {
    return { content: [{ type: 'text', text: 'Error: url is required' }], isError: true };
  }
  const scope = String(args.linkScope ?? 'outbound');
  const result = await fetchUrl({
    url,
    links: Boolean(args.links),
    quality: args.quality === 'research' ? 'research' : 'fast',
    session: args.session ? String(args.session) : undefined,
    linkScope: scope === 'same-origin' || scope === 'all' ? scope : 'outbound',
  }, ctx);
  // Provenance framing (DEC-2026-07-29): every page-derived field is quarantined
  // with its warning in the opening delimiter, adjacent to the content it is
  // warning about. Applied at the MCP boundary — fetchUrl's structured result is
  // what in-process callers want, the framing is for what enters model context.
  return { content: [{ type: 'text', text: frameFetchResult(result) }] };
}

export const webFetch = { definition, handler };
