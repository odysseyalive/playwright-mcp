/**
 * session.ts — authenticated-session helpers: session_login + session_status.
 * Thin wrappers over Playwright's native storageState (capture-once, reuse-
 * everywhere). The MCP NEVER holds a live session through a test cycle; it emits
 * a portable owner-only artifact that both interactive debugging (the wrapped
 * browser_* tools via contextOptions.storageState / userDataDir) and generated
 * Playwright suites (setup-project + dependencies) load.
 *
 * Spec: /session-method. Identity stays ISOLATED: the shared persistent
 * web_fetch scraping profile (src/browser.ts) never carries auth cookies. An
 * explicit authed read — web_fetch({ session }) — loads a captured storageState
 * into its OWN ephemeral context (separate cookie jar), so auth and the shared
 * scraping profile still never merge; only the stealth *disguise* (src/stealth.ts)
 * is shared. storageState files are secrets: owner-only (0o600 on POSIX, an
 * owner-only ACL on win32 — both applied by ownerOnlyFile in src/secrets.ts,
 * never chmod-ed here), gitignored, never echoed into tool output/logs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Type-only, so nothing is imported at runtime and the registry that imports THIS
// module is not part of a require cycle. ToolContext carries the surface trust
// tier (and the progress channel) the tool handlers below need.
import type { ToolContext } from '../tools.js';
import type { SurfaceTrust } from '../index.js';

import {
  sessionsDir,
  sessionFilePath,
  getSecret,
  ownerOnlyDir,
  ownerOnlyFile,
  reassertOwnerOnly,
  OwnerOnlyError,
} from '../secrets.js';
import { storageStateDomains, wrapUntrusted } from '../exfil.js';
import { bindSession } from '../upstream.js';
import {
  STEALTH_LAUNCH,
  STEALTH_INIT,
  stealthContextOptions,
  resolveChromePath,
  defaultChromeUserDataDir,
} from '../stealth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:session]', ...args);

// ── session_login ─────────────────────────────────────────────────────────────

export interface LoginOptions {
  name: string;
  loginUrl: string;
  // Optional confirmation marker: a CSS/XPath selector, visible text, or a
  // substring of the *post-login* URL. Omit in headed mode to auto-detect login —
  // "moved past the login page", OR (for a same-origin SPA whose URL never changes,
  // e.g. iCloud) a newly issued auth cookie. See waitForLogin / makeAuthCookieProbe.
  successSignal?: string;
  headed?: boolean; // required for 2FA / SSO / hardware keys
  // Capture via a plain, human-solved Chrome (connectOverCDP) instead of a
  // Playwright-driven browser. Use for sites behind a Cloudflare/Turnstile
  // challenge that rejects CDP-driven automation (the challenge loops forever
  // otherwise). A real Chrome window opens; the human clears the challenge and
  // logs in, and the authenticated storageState is harvested passively.
  attach?: boolean;
  // Which Chrome profile the attach capture uses:
  //   'temp'   (default) — a fresh throwaway profile; correct for soft walls.
  //   'system' — the host's REAL default Chrome profile, so an established
  //              browser's earned trust (cf_clearance, history) carries the
  //              capture past a HARD Cloudflare wall that hard-challenges a
  //              fresh profile. The user must fully quit Chrome first. Export
  //              is auto-scoped to the login site's domain (never the whole jar).
  //   <path>   — an explicit user-data-dir (e.g. a dedicated persistent capture
  //              profile that accumulates trust across runs).
  profile?: 'temp' | 'system' | string;
  // Capture a CLEARED BOT WALL rather than a login: the human solves the CAPTCHA
  // and nothing else, so the page never leaves `loginUrl` and the login-shaped
  // "moved past the login page" predicate can never fire. Completion is instead
  // "the challenge markers are gone on the SAME url". Implies attach (a wall that
  // needs a human is exactly the wall that rejects a driven browser).
  challenge?: boolean;
  // An OPT-IN cap on the wait. Absent is the normal case for a human login: see
  // `wait` below and resolveHumanWait(). The HEADLESS credential path still reads
  // this directly and still defaults to 30s — there is no human there to wait for.
  timeoutMs?: number;
  /**
   * The resolved human-present wait. Set by the TOOL HANDLER, which is the only
   * layer that knows the surface trust tier, and therefore the only layer that can
   * ask for `{ deadline: 'none' }`. Absent means the surface is unknown, and an
   * unknown surface is treated as a non-stdio one — capped, not unbounded.
   */
  wait?: WaitBudget;
  credKeys?: { user: string; pass: string }; // dotenv key names (project .env / secrets.env)
  envFile?: string; // explicit dotenv file for credKeys (default: ./.env in cwd, then secrets.env)
  selectors?: { user?: string; pass?: string; submit?: string };
}

export interface LoginResult {
  name: string;
  path: string;
  capturedAt: string;
  mode: 'headless' | 'headed' | 'attach' | 'challenge';
  ok: boolean;
  /**
   * Server-authored, and only that. A capture failure is diagnosed in this
   * server's own words — including advice the model is meant to ACT on ("pass a
   * successSignal", "complete the login in THAT window"), which is why it must
   * not be marked as untrusted data. Anything the page had a hand in goes in
   * `capturedDetail` instead.
   */
  error?: string;
  /**
   * The failure was the human closing the window, not the site or the capture. Set
   * only for a LoginCancelledError, so a caller can tell "you stopped" from "it
   * broke" without reading the sentence.
   */
  cancelled?: true;
  /**
   * The CAPTURED half of a failure diagnosis: the final URL after redirects and
   * the page's own `<title>`. Both are attacker-choosable on a hostile or
   * hijacked login page, so `bindAndReport` fences this with `wrapUntrusted`
   * rather than letting it ride inside `error`'s sentence.
   */
  capturedDetail?: string;
  /** Where `capturedDetail` was read from — the fence's `source=` attribute. */
  capturedSource?: string;
  // Challenge captures are SHORT-LIVED in a way logins are not — a cf_clearance
  // measures in minutes, and it expires without ever redirecting to a login page,
  // so session_status's login-shaped staleness check cannot see it die. Report the
  // earliest clearance-cookie expiry so the caller can decide, and warn loudly when
  // no clearance cookie was captured at all (the capture "succeeded" but is empty).
  expiresAt?: string;
  warning?: string;
  // Proof the capture is authenticated rather than an anonymous visit: how many
  // cookies appeared between landing on the login page and finishing, and which
  // hosts issued them. A caller (or a human reading the tool result) can sanity-
  // check that the auth domain is present instead of trusting `ok` alone.
  cookiesGained?: number;
  authHosts?: string[];
}

/**
 * A failure whose message is server prose and whose `captured` half is text a
 * PAGE controlled — a final URL after redirects, a `<title>`.
 *
 * The two provenances travel as two values all the way to the MCP boundary
 * instead of being interpolated into one sentence at the throw site. A throw is
 * the reason this exists: `error: err.message` flattens everything a capture
 * knew into a single string, and once flattened the boundary cannot tell which
 * half a page wrote.
 *
 * Interpolating instead is not merely untidy, it is FORGEABLE: the previous
 * form wrapped the title in curly quotes (`(“${title}”)`) and a page can put
 * curly quotes in its own title. `wrapUntrusted` defangs its own delimiter;
 * a punctuation convention defangs nothing.
 */
class CapturedTextError extends Error {
  constructor(
    message: string,
    readonly captured: string,
    readonly source: string,
  ) {
    super(message);
    this.name = 'CapturedTextError';
  }
}

// ── how long a human gets, and what ends the wait ─────────────────────────────
// A human login has no honest duration. Password-only, password + TOTP, an SSO
// hop through two identity providers, a CAPTCHA in the middle — the caller cannot
// tell which it is from outside, and the old 300s default cut the long ones off
// mid-2FA. So a human-present capture waits with NO deadline and ends on a real
// END SIGNAL instead: the human finished, or the window is gone.
//
// The deadline is replaced, never merely lengthened, because every finite number
// is wrong for somebody. What replaces it has to be load-bearing: if the window
// is gone and nothing notices, the tool hangs for the life of the process.

/** The wait the human gets. `'none'` is UNBOUNDED — only the tool handler may ask for it. */
export type WaitBudget = { deadline: 'none' } | { deadline: 'capped'; ms: number };

/**
 * The bounded default kept for every surface that is NOT stdio, and the fail-closed
 * default anywhere the surface is unknown.
 */
export const CAPPED_HUMAN_WAIT_MS = 300_000;

/**
 * Resolve the human-present wait from the caller's `timeoutMs` and the SURFACE the
 * call arrived on (engineering-lead's trust-tier rule, 2026-09-29):
 *
 *  • an explicit positive `timeoutMs` always arms a real deadline — an opt-in cap;
 *  • otherwise `stdio` (the local Claude Code process, a human at this display)
 *    waits with no deadline;
 *  • otherwise — `local` and `cloud` HTTP surfaces — the 300s cap STAYS. The headed
 *    window opens on the SERVER host, so on a non-stdio surface there is nobody at
 *    that display and an unbounded wait is an unreclaimable browser.
 *
 * NaN / zero / negative are treated as ABSENT (the surface decides) rather than as
 * Playwright's "0 means forever": a caller that passes garbage asked for nothing.
 *
 * Pure, so the tier rule is testable without a surface or a browser.
 */
export function resolveHumanWait(explicit: number | undefined, trust: SurfaceTrust): WaitBudget {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0)
    return { deadline: 'capped', ms: explicit };
  return trust === 'stdio' ? { deadline: 'none' } : { deadline: 'capped', ms: CAPPED_HUMAN_WAIT_MS };
}

/** `Infinity` for an unbounded budget — so one `while (Date.now() < deadline)` shape covers both. */
const deadlineOf = (w: WaitBudget): number => (w.deadline === 'none' ? Infinity : Date.now() + w.ms);

/** Playwright's own timeout convention: 0 disables it. Only reached for an unbounded budget. */
const pwTimeout = (w: WaitBudget): number => (w.deadline === 'none' ? 0 : w.ms);

/**
 * The human closed the window (or the browser went away) before the login finished.
 *
 * A NAMED error, not a timeout: nothing was saved, nothing is wrong with the site,
 * and the remedy is different — reopen and leave the window alone until the tool
 * reports the session saved. It is also what guarantees the unbounded wait can end:
 * every human-present path races this against completion.
 */
export class LoginCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginCancelledError';
  }
}

const CANCELLED_DRIVEN =
  'login cancelled: the window was closed before the login finished — nothing was saved. The capture ' +
  'waits as long as you need, so reopen it with session_login and leave the window open until the tool ' +
  'reports the session saved.';
const CANCELLED_ATTACH =
  'login cancelled: the Chrome window was closed before the login finished — nothing was saved. The ' +
  'capture waits as long as you need, so reopen it and leave the window open until the tool reports the ' +
  'session saved.';
const CANCELLED_CHALLENGE =
  'challenge cancelled: the Chrome window was closed before the wall was cleared — nothing was saved. ' +
  'Reopen it and stay on the page until the tool reports the session saved.';

/** The end signal a human-present wait races against completion. */
export interface CaptureCancel {
  /** Rejects with LoginCancelledError once the window is gone; otherwise never settles. */
  readonly promise: Promise<never>;
  /** Already fired — every unbounded poll loop checks this so none can spin on forever. */
  cancelled(): boolean;
}

/**
 * Grace between "a window closed" and giving up.
 *
 * Two jobs. It lets an in-flight completion win the race — the human who finishes
 * and immediately closes the window is the common case, and the 1.5s stability hold
 * in waitPastLogin has to land somewhere. And it lets an SSO POPUP appear: an
 * identity provider that opens a popup and closes the original tab would otherwise
 * read as "the window was closed" and cancel the very login this exists to fix.
 */
const WINDOW_CLOSE_GRACE_MS = 3000;

/**
 * "The window is gone", for the DRIVEN (chromium.launch) capture path.
 *
 * MEASURED 2026-09-29 on playwright 1.61.0-alpha, headed AND headless: closing the
 * last page does NOT disconnect the browser — `isConnected()` stays true and
 * `context.pages()` drops to 0. So `disconnected` alone can never end this wait;
 * the zero-pages arm is the load-bearing one, and both are wired.
 *
 * A closed PAGE is deliberately not a cancel by itself. An SSO provider that pops a
 * window and closes the original tab is a login in progress, not an abandoned one —
 * so after the grace we ask again whether ANY page is left. Fully injectable
 * (`probe` + `schedule`), the same way makeAuthCookieProbe takes its clock, so the
 * decision is testable with no browser and no wall-clock wait.
 */
export function makeWindowClosedWatch(
  probe: { pagesOpen: () => number; connected: () => boolean },
  deps: { schedule?: (fn: () => void, ms: number) => void; graceMs?: number; message?: string } = {},
): CaptureCancel & { pageClosed(): void; browserGone(): void } {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref();
    });
  const graceMs = deps.graceMs ?? WINDOW_CLOSE_GRACE_MS;
  let fired = false;
  let reject!: (err: Error) => void;
  const promise = new Promise<never>((_, rj) => {
    reject = rj;
  });
  // One handler attached at birth so a cancel nobody raced (the capture already
  // finished) is never an unhandled rejection. Promise.race still sees it.
  promise.catch(() => {});
  const fire = () => {
    if (fired) return;
    fired = true;
    reject(new LoginCancelledError(deps.message ?? CANCELLED_DRIVEN));
  };
  return {
    promise,
    cancelled: () => fired,
    /** A page closed — cancel only once nothing is left to log in with. */
    pageClosed() {
      schedule(() => {
        if (!probe.connected() || probe.pagesOpen() === 0) fire();
      }, graceMs);
    },
    /** The browser itself is gone; nothing can complete after this. */
    browserGone() {
      schedule(fire, graceMs);
    },
  };
}

/** A LoginCancelledError anywhere in `err`, including inside Promise.any's AggregateError. */
function cancellation(err: unknown): LoginCancelledError | undefined {
  if (err instanceof LoginCancelledError) return err;
  if (err instanceof AggregateError)
    return (err.errors as unknown[]).map(cancellation).find((e): e is LoginCancelledError => !!e);
  return undefined;
}

/**
 * Cookies a bot wall issues to mark a browser as cleared. Presence of one is the
 * only positive proof a challenge capture actually got something; their expiry is
 * the real lifetime of the artifact.
 */
const CLEARANCE_COOKIES = /^(cf_clearance|__cf_bm|datadome|_abck|bm_sz|reese84|visid_incap_|incap_ses_)/i;

const DEFAULT_SELECTORS = {
  user: 'input[type="email"], input[name="username"], input[name="email"], input[type="text"]',
  pass: 'input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], button',
};

/**
 * Create and restrict the sessions directory before a capture writes into it.
 * Runs BEFORE the write, so a failure leaves nothing behind. On win32 the dir's
 * inheritable owner-only ACL also means the artifact is owner-only from its
 * first byte, not only after restrictCapturedArtifact runs. A mkdir failure
 * propagates untouched, exactly as before; only the win32 ACL failure is
 * reworded to say the capture was abandoned.
 */
function prepareSessionsDir(): void {
  try {
    ownerOnlyDir(sessionsDir());
  } catch (err) {
    if (!(err instanceof OwnerOnlyError)) throw err;
    throw new Error(`session not saved — ${err.message}. Nothing was written.`);
  }
}

/**
 * Restrict a just-captured artifact to the owning account, or DELETE it and fail
 * the capture. FAIL LOUD, the same ethos as the SPA truth gate in sessionLogin:
 * never leave a bad artifact behind. A session file another account can read is
 * an impersonation credential handed to that account, and `ok:true` over it is
 * the silent failure this module refuses everywhere else. Returns the truthful
 * descriptor for the "saved session" log line.
 */
function restrictCapturedArtifact(out: string): string {
  try {
    return ownerOnlyFile(out);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      fs.rmSync(out, { force: true });
    } catch (rmErr) {
      throw new Error(
        `session not saved — the captured file could not be restricted to your account (${why}), and ` +
          `deleting it ALSO failed (${rmErr instanceof Error ? rmErr.message : String(rmErr)}). ` +
          `Delete ${out} by hand: it holds live session cookies.`,
      );
    }
    throw new Error(
      `session not saved — the captured file could not be restricted to your account (${why}), ` +
        'so it was deleted rather than left readable by others.',
    );
  }
}

/**
 * Wire the driven browser's own events to makeWindowClosedWatch.
 *
 * Kept apart from the watch so the DECISION ("is anything left to log in with?")
 * stays pure and testable and only this thin adapter touches Playwright. Every
 * page is watched, not just the first — a popup that becomes the login is the
 * page whose closing matters, and `context.on('page')` is how it arrives.
 */
function watchDrivenWindow(
  browser: Browser,
  context: BrowserContext,
  first: PwPage,
  message: string,
): CaptureCancel {
  const watch = makeWindowClosedWatch(
    { pagesOpen: () => context.pages().filter((p) => !p.isClosed()).length, connected: () => browser.isConnected() },
    { message },
  );
  const onPage = (p: PwPage) => p.once('close', () => watch.pageClosed());
  onPage(first);
  context.on('page', onPage);
  context.once('close', () => watch.browserGone());
  browser.once('disconnected', () => watch.browserGone());
  return watch;
}

export async function sessionLogin(opts: LoginOptions): Promise<LoginResult> {
  const mode: 'headless' | 'headed' = opts.headed ? 'headed' : 'headless';
  const out = sessionFilePath(opts.name);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: !opts.headed, ...STEALTH_LAUNCH });
    // Disguise the capture context (own cookie jar — never the web_fetch profile)
    // so bot-protected login pages don't flag the headless browser and fail the
    // capture. Identity stays isolated; only the anti-detection technique is shared.
    const context = await browser.newContext({ ...stealthContextOptions, ignoreHTTPSErrors: true });
    await context.addInitScript(STEALTH_INIT);
    const page = await context.newPage();
    await page.goto(opts.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // An app URL usually REDIRECTS to the identity provider (apps.docusign.com/send
    // → account.docusign.com/oauth/auth). Comparing against the caller's URL then
    // reads that redirect as "left the login page" and completes instantly. Let the
    // redirect chain settle and treat where we LAND as the real login page.
    await page.waitForLoadState('networkidle').catch(() => {});
    const loginUrl = page.url() || opts.loginUrl;
    if (loginUrl !== opts.loginUrl) log(`login page resolved: ${opts.loginUrl} → ${loginUrl}`);

    // Baseline for the auth-delta check below, taken AFTER landing on the login
    // page so cookies the site drops on arrival are already accounted for.
    const before = (await context.storageState()) as StorageState;

    // Completion signal for a SAME-ORIGIN SPA login whose URL never changes
    // (iCloud, and any app that keeps its pathname constant through sign-in): a
    // newly issued auth-named cookie, the same authority the attach path already
    // trusts (pollAttachedLogin / gainedAuthCookie). Consulted ONLY by the no-signal
    // auto-detect fallback in waitForLogin — never when the caller gave an explicit
    // successSignal, which stays authoritative.
    const authGained = makeAuthCookieProbe(() => context.cookies(), before, loginUrl);

    if (opts.headed) {
      // Human completes the challenge in the SEPARATE automation window this
      // launched (not their everyday browser). We auto-detect completion when
      // they move past the login page; an explicit successSignal, if given,
      // also resolves. NO deadline on the stdio surface — a person typing a
      // password, waiting for an SMS code and clicking through two SSO hops takes
      // however long it takes. The wait ends when they finish or when the window
      // is gone (cancel), never on a clock somebody guessed.
      //
      // An absent `wait` is a DIRECT caller, not a surface: capped, never unbounded.
      const wait = opts.wait ?? resolveHumanWait(opts.timeoutMs, 'local');
      log(
        `headed login for "${opts.name}" — a SEPARATE automation window opened; complete the login in THAT window` +
          (wait.deadline === 'none' ? ' (no time limit; closing the window cancels)' : ''),
      );
      const cancel = watchDrivenWindow(browser, context, page, CANCELLED_DRIVEN);
      await waitForLogin(page, loginUrl, opts.successSignal, wait, authGained, cancel);
    } else {
      const sel = { ...DEFAULT_SELECTORS, ...opts.selectors };
      const lookup = { envFile: opts.envFile };
      const user = opts.credKeys ? getSecret(opts.credKeys.user, lookup) : undefined;
      const pass = opts.credKeys ? getSecret(opts.credKeys.pass, lookup) : undefined;
      if (!user || !pass)
        throw new Error(
          'missing credentials — credKeys not found in the project .env, secrets.env, or process.env (set credKeys / envFile)',
        );
      await page.fill(sel.user, user);
      await page.fill(sel.pass, pass);
      await Promise.all([
        page.click(sel.submit).catch(() => page.keyboard.press('Enter')),
        page.waitForLoadState('domcontentloaded').catch(() => {}),
      ]);
      // UNCHANGED: the credential path has no human in it, so a clock is the right
      // instrument and 30s is still the default.
      await waitForLogin(
        page,
        loginUrl,
        opts.successSignal,
        { deadline: 'capped', ms: opts.timeoutMs ?? 30_000 },
        authGained,
      );
    }

    // The wait heuristics can resolve while the human is still mid-login (see
    // newCookies). Writing an anonymous storageState and reporting ok:true is the
    // worst outcome: every later web_fetch({session}) silently reads as a logged-out
    // visitor. Require evidence — no new cookies means no login happened.
    const after = (await context.storageState()) as StorageState;
    const gained = newCookies(before, after);
    if (!gained.length) {
      // The final URL is reported, not interpolated: after redirects it is the
      // page's choice, so it travels as the captured half (see CapturedTextError).
      throw new CapturedTextError(
        `no session was captured — the browser gained no new cookies, so the login did not complete. ` +
          `Nothing was saved. The final URL is quarantined below. ` +
          `If the site uses a multi-step login (email first, password/2FA after), pass a successSignal ` +
          `naming something only visible AFTER login — e.g. a post-login URL fragment or on-page text.`,
        `final URL: ${page.url()}`,
        page.url(),
      );
    }

    prepareSessionsDir();
    await context.storageState({ path: out });
    const restriction = restrictCapturedArtifact(out); // secret: never readable by another account

    // SPA truth gate. When the login completed with NO caller marker and the URL never
    // left the login page (the same-origin SPA path), a live-probe hit on a strong auth
    // cookie is the ONLY completion evidence — and a transient handshake cookie can trip
    // it and then be cleared before this write, persisting a logged-out session while the
    // delta check above still counted "cookies gained". The durable proof is the artifact
    // itself: it must carry a strong auth cookie for the login site, or the login had not
    // finalized. (URL-change and marker completions never reach this branch, so no
    // ordinary login is affected.)
    if (!opts.successSignal?.trim() && samePath(page.url(), loginUrl)) {
      const saved = JSON.parse(fs.readFileSync(out, 'utf8')) as StorageState;
      if (!artifactHasSiteAuthCookie(saved, loginUrl)) {
        fs.rmSync(out, { force: true }); // never leave a logged-out artifact behind
        // `loginUrl` here is the LANDED url (page.url() after the goto), so both
        // it and the domain derived from it are page-influenced — they are
        // reported below the sentence rather than inside it.
        throw new CapturedTextError(
          `login did not finalize — a same-origin SPA login (the URL never changed) completed but ` +
            `the saved session carries no durable auth cookie for the login site, so it would read as ` +
            `logged out. The URL and the site it was checked against are quarantined below. This usually ` +
            `means the window closed before sign-in fully finished; retry and complete every step ` +
            `(2FA + "trust this browser") until the app's own content is on screen.`,
          `final URL: ${page.url()}\nauth cookie looked for on: ${siteDomain(loginUrl) || 'the site'}`,
          page.url(),
        );
      }
    }

    const hosts = [...new Set(gained.map((c) => (c.domain ?? '').replace(/^\./, '')))].filter(Boolean);
    log(`saved session "${opts.name}" → ${out} (${restriction}; ${gained.length} new cookies on ${hosts.join(', ')})`);
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode,
      ok: true,
      cookiesGained: gained.length,
      authHosts: hosts,
    };
  } catch (err) {
    // A CapturedTextError kept its two halves apart on the way here; every other
    // failure on this path is server-authored (missing credentials, a bad
    // selector, a filesystem error) and carries no captured half at all.
    // sessionAttach has no equivalent branch on purpose: none of its throws read
    // anything from a page — they name a local profile dir or the caller's own
    // loginUrl.
    const captured = err instanceof CapturedTextError ? err : undefined;
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof LoginCancelledError ? { cancelled: true as const } : {}),
      ...(captured ? { capturedDetail: captured.captured, capturedSource: captured.source } : {}),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ── session_login (attach mode) ─────────────────────────────────────────────────
// For sites behind a Cloudflare/Turnstile "Just a moment…" managed challenge that
// rejects CDP-driven browsers (the challenge loops: 403 → challenge → 403). We do
// NOT try to out-stealth it — that is an arms race. Instead we spawn a PLAIN real
// Chrome (a normal child process, not chromium.launch — so it carries none of
// Playwright's automation instrumentation while the human solves the challenge),
// let the person clear the challenge + log in, then connectOverCDP and read the
// authenticated storageState back out. A dedicated throwaway profile keeps the
// user's real Chrome profile untouched.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a JSON document from the local DevTools HTTP endpoint. */
function devtoolsJson(port: number, route: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('devtools endpoint timeout')));
  });
}

/**
 * A free local TCP port for Chrome's DevTools endpoint.
 *
 * NEVER `--remote-debugging-port=0`. Chrome sets navigator.webdriver=true in every
 * page when the debugging port is 0 (MDN, Navigator.webdriver). MEASURED 2026-09-14
 * on Chrome 153: port 0 → `webdriver=true`, a fixed port → `webdriver=false`. With
 * port 0 the "plain" attach window told chatgpt.com and auth.openai.com it was
 * automated, and sign-in failed with "Route Error (400 Invalid content type:
 * text/html)" — HTML (a challenge) where the login step expected JSON. A fixed port
 * also means Chrome writes no DevToolsActivePort file, so readiness is polled on the
 * endpoint itself (waitForDevtools).
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('attach: could not reserve a local port'))));
    });
  });
}

/** Chrome launch arguments for an attach capture. Exported so the port rule is testable. */
export function attachChromeArgs(profileDir: string, port: number, url: string): string[] {
  if (!(Number.isInteger(port) && port > 0))
    throw new Error(`attach: refusing debugging port ${port} — port 0 marks every page navigator.webdriver=true`);
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ];
}

/** Wait until Chrome's DevTools HTTP endpoint answers on `port`. */
async function waitForDevtools(port: number, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await devtoolsJson(port, '/json/version');
      return;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('Chrome did not open a debugging port (is Google Chrome installed? set PLAYWRIGHT_MCP_CHROME_PATH)');
}

/** True once the human has moved off the login page (host changed, or path left it). */
export function leftLoginPage(currentUrl: string, loginUrl: string): boolean {
  try {
    const cur = new URL(currentUrl);
    const lg = new URL(loginUrl);
    if (cur.host !== lg.host) return true;
    return !samePath(currentUrl, loginUrl);
  } catch {
    return false;
  }
}

// Markers that say a bot wall is still in front of the human. Titles cover the
// interstitials; the URL patterns cover walls that park the browser on a dedicated
// challenge path. DevTools /json/list exposes only type/url/title, so these two are
// the entire signal available WITHOUT attaching over CDP — and we deliberately do
// not attach mid-solve, because driving the page is what makes the wall loop.
const WALL_TITLE =
  /just a moment|attention required|checking your browser|verifying you are human|one moment,? please|please wait|access denied|are you a robot|security check/i;
const WALL_PATH = /\/(sorry|cdn-cgi\/challenge|challenge-platform|captcha|_incapsula_)/i;

/**
 * THE single authority on "is a bot wall still in front of the human". Both capture
 * modes compose this one predicate rather than carrying their own idea of a wall:
 *
 *   login mode     → navigated away  AND NOT wallUp()
 *   challenge mode → still on target AND NOT wallUp()
 *
 * The modes genuinely differ in the FIRST half — a login navigates, a CAPTCHA solve
 * does not — and share the second half completely. Keeping the shared half in one
 * place is what stops the two from drifting as new wall vendors get added.
 *
 * NEVER inline a challenge-title/path check anywhere else in this file. A second
 * definition is the whole failure mode this exists to prevent, and
 * scripts/test-session.mjs fails the build if one appears.
 */
export function wallUp(currentUrl: string, title: string): boolean {
  if (WALL_TITLE.test(title)) return true;
  try {
    return WALL_PATH.test(new URL(currentUrl).pathname);
  } catch {
    return false; // an unparseable url is not evidence of a wall
  }
}

/**
 * True once the bot wall on `targetUrl` appears cleared — the SAME-url counterpart
 * to leftLoginPage(). A CAPTCHA solve ends where it started, so "moved off the page"
 * proves nothing here; what we look for is wallUp() going false while still on the
 * target host.
 *
 * Deliberately conservative: an empty title is the challenge shell mid-load, and a
 * foreign host is some other tab the human opened — neither is evidence of success.
 * A false negative costs a longer wait; a false positive saves a worthless artifact.
 */
export function challengeCleared(currentUrl: string, targetUrl: string, title: string): boolean {
  let cur: URL;
  let tgt: URL;
  try {
    cur = new URL(currentUrl);
    tgt = new URL(targetUrl);
  } catch {
    return false;
  }
  if (cur.host !== tgt.host) return false; // another tab says nothing about our wall
  if (!title.trim()) return false; // the challenge shell before the real document
  return !wallUp(currentUrl, title);
}

/**
 * Is a DevTools read failure evidence the endpoint is GONE, or just a miss?
 *
 * Both poll loops used to swallow every failure as "endpoint hiccup — keep
 * waiting". With a deadline that merely wasted time; with NO deadline it is the
 * forever-hang, so the two cases have to be told apart. A connection-level refusal
 * means nothing is listening on that port any more — Chrome exited. A read that
 * timed out, or answered with something unparseable, is a busy browser mid-navigation
 * and says nothing about whether it is alive.
 *
 * Pure, so the classification is testable with a synthetic error.
 */
export function devtoolsUnreachable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code))
    return true;
  return /socket hang up/i.test(err instanceof Error ? err.message : '');
}

/** Consecutive unreachable reads before the endpoint counts as gone on its own evidence. */
const DEVTOOLS_GONE_STRIKES = 3;
/** Consecutive polls with NO page target at all before a windowless Chrome counts as gone. */
const NO_TARGET_STRIKES = 10;

/**
 * "Has the attached Chrome gone away?", accumulated across polls.
 *
 * Strikes rather than a single failure, because one refused read during Chrome's own
 * teardown of a tab is not proof; a run of them is. A spawned Chrome that has ALSO
 * exited collapses that to one strike — but the endpoint stays the authority, which
 * is what keeps a wrapper script that execs and exits (or hands off to a running
 * Chrome) from reading as a cancelled login.
 *
 * `noTargets` covers the other shape of gone: the endpoint still answers while the
 * human has closed every window. There is nothing left to log in with, and no
 * completion can ever arrive.
 */
export function makeEndpointWatch(strikes = DEVTOOLS_GONE_STRIKES, targetStrikes = NO_TARGET_STRIKES) {
  let unreachable = 0;
  let empty = 0;
  return {
    /** A read succeeded — reset the unreachable run. */
    alive(): void {
      unreachable = 0;
    },
    /** A read failed. True once the endpoint is gone for good. */
    failed(err: unknown, chromeExited: boolean): boolean {
      if (!devtoolsUnreachable(err)) {
        unreachable = 0;
        return false;
      }
      unreachable += 1;
      return chromeExited || unreachable >= strikes;
    },
    /** How many page targets this poll saw. True once a windowless Chrome counts as gone. */
    targets(count: number): boolean {
      empty = count > 0 ? 0 : empty + 1;
      return empty >= targetStrikes;
    },
  };
}

/** What ends an attach wait: the budget, and whether the Chrome we spawned has exited. */
interface AttachWait {
  wait: WaitBudget;
  /** The spawned child exited — a hint that makes one unreachable read conclusive. */
  chromeExited: () => boolean;
}

/**
 * Poll the DevTools endpoint until `isDone` holds for one of the open page targets,
 * stable for 2s (a challenge clear flickers through intermediate states before the
 * real document settles). Passive by construction: HTTP reads of /json/list only,
 * never a CDP attach, so nothing drives the page while the human works.
 *
 * Shared by BOTH attach callers (login and challenge), so the gone-detection above
 * lands once for both.
 */
async function pollAttached(
  port: number,
  isDone: (page: { url: string; title: string }) => boolean,
  w: AttachWait,
  timeoutMessage: string,
  cancelMessage: string,
): Promise<void> {
  const deadline = deadlineOf(w.wait);
  const endpoint = makeEndpointWatch();
  let stableSince = 0;
  while (Date.now() < deadline) {
    let pages: Array<{ type?: string; url?: string; title?: string }> = [];
    try {
      pages = (await devtoolsJson(port, '/json/list')) as typeof pages;
      endpoint.alive();
    } catch (err) {
      // A hiccup keeps waiting, exactly as before; an endpoint that is GONE ends it.
      if (endpoint.failed(err, w.chromeExited())) throw new LoginCancelledError(cancelMessage);
    }
    const targets = pages.filter((p) => p.type === 'page');
    if (endpoint.targets(targets.length)) throw new LoginCancelledError(cancelMessage);
    const done = targets.some(
      (p) => typeof p.url === 'string' && isDone({ url: p.url, title: p.title ?? '' }),
    );
    if (done) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 2000) return;
    } else {
      stableSince = 0;
    }
    await sleep(1000);
  }
  throw new Error(timeoutMessage);
}

/**
 * "Has the human finished logging in", for attach mode.
 *
 * Two traps, both of which challengeCleared() already avoids and this did not:
 *
 *  1. The caller's URL is usually an APP url that redirects to the identity
 *     provider. leftLoginPage()'s host rule then fires on the redirect INTO the
 *     login screen — the redirect that STARTS an SSO login reads as finishing
 *     one. So latch the first page actually observed as the real login page,
 *     the same settled-URL baseline sessionLogin() takes.
 *  2. A page whose title has not rendered yet is not evidence of anything;
 *     judging it races the browser. challengeCleared() guards this explicitly.
 *
 * Exported as a factory because the latch is per-capture state: each call gets
 * its own baseline, and tests can drive the sequence directly.
 */
export function makeAttachLoginCheck(): (p: { url: string; title: string }) => boolean {
  let baseline: string | undefined;
  return (p) => {
    if (!p.title.trim()) return false; // shell before the document rendered
    if (!baseline) {
      baseline = p.url; // first real page = where the login actually lives
      return false;
    }
    return leftLoginPage(p.url, baseline) && !wallUp(p.url, p.title);
  };
}

const safeHostname = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/**
 * Wait for the human to finish logging in, using the AUTH-COOKIE signal rather than
 * a URL change. A same-origin SPA login — and any multi-step / SSO login — can finish
 * without the pathname ever leaving the login page, so the URL heuristic
 * (makeAttachLoginCheck / leftLoginPage) times out on it while the login has plainly
 * succeeded. The cookie gate is the completion authority the driven path already
 * trusts (newCookies: "a real login always issues at least one new cookie").
 *
 * CDP-safety: cookies are read only via a passive connectOverCDP, and only once a
 * login-host page is showing a NON-wall document — never while a managed challenge is
 * still up, because reading during the solve is what makes a Cloudflare wall loop.
 * wallUp() is the same shared predicate both capture modes compose.
 *
 * The CDP connection is NEVER held. MEASURED 2026-09-14 on chatgpt.com: with a
 * connection held open (the previous shape — connect once, keep it for the whole
 * wait), the human's sign-in on auth.openai.com turned into "Oops, an error occurred!"
 * and Cloudflare looped; the same sign-in with nothing connected reached the password
 * page normally. So each read is connect → cookies → close, gated by
 * attachCookieReadDecision.
 */
async function pollAttachedLogin(port: number, loginUrl: string, w: AttachWait): Promise<void> {
  const reg = siteDomain(loginUrl);
  const onSite = (host: string) => {
    const h = host.replace(/^\./, '').toLowerCase();
    return h === reg || h.endsWith('.' + reg);
  };
  const nameKey = (c: { domain?: string; name?: string }) =>
    `${(c.domain ?? '').replace(/^\./, '').toLowerCase()}|${c.name ?? ''}`;
  const valKey = (c: { domain?: string; name?: string; value?: string }) => `${nameKey(c)}|${c.value ?? ''}`;
  const urlCheck = makeAttachLoginCheck(); // URL arm — latches the login page, fires once it is left
  let baseNames: Set<string> | null = null;
  let baseVals: Set<string> | null = null;
  let lastReadKey = '';
  let lastReadAt = 0;
  let lastDone = false; // the verdict of the most recent read, carried across skipped polls
  const start = Date.now();
  const deadline = deadlineOf(w.wait);
  const endpoint = makeEndpointWatch();
  let stableSince = 0;
  while (Date.now() < deadline) {
    let pages: Array<{ type?: string; url?: string; title?: string }> = [];
    try {
      pages = (await devtoolsJson(port, '/json/list')) as typeof pages;
      endpoint.alive();
    } catch (err) {
      // Same split as pollAttached: a hiccup keeps waiting, a GONE endpoint cancels.
      // Without this the "CDP hiccup" catch below would keep an unbounded wait alive
      // forever after the human closed Chrome.
      if (endpoint.failed(err, w.chromeExited())) throw new LoginCancelledError(CANCELLED_ATTACH);
    }
    if (endpoint.targets(pages.filter((p) => p.type === 'page').length))
      throw new LoginCancelledError(CANCELLED_ATTACH);
    // The login-host page, if its document has rendered. The URL arm observes it
    // every poll (latching the login page, firing when the human leaves it) — that is
    // HTTP only and touches no page. The cookie arms need CDP, so they run only when
    // attachCookieReadDecision says a brief connection is safe.
    const sitePage = pages.find(
      (p) => p.type === 'page' && typeof p.url === 'string' && onSite(safeHostname(p.url)) && (p.title ?? '').trim() !== '',
    );
    const urlLeft = sitePage ? urlCheck({ url: sitePage.url ?? '', title: sitePage.title ?? '' }) : false;
    const readKey = sitePage ? `${sitePage.url}|${sitePage.title}` : '';
    const decision = attachCookieReadDecision(pages, onSite, readKey, lastReadKey, Date.now() - lastReadAt);
    if (decision === 'read') {
      lastReadKey = readKey;
      lastReadAt = Date.now();
      lastDone = false;
      let cdp: Browser | undefined;
      try {
        cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const ctx = cdp.contexts()[0];
        const cookies = (ctx ? await ctx.cookies() : []).filter((c) => onSite(c.domain ?? ''));
        const names = new Set(cookies.map(nameKey));
        // value-keyed, infra excluded — catches a session cookie ROTATED in place
        // (same name, new value on login) that a name-only delta would miss.
        const vals = new Set(cookies.filter((c) => !isInfraCookieName(c.name ?? '')).map(valKey));
        if (baseNames === null) {
          baseNames = names;
          baseVals = vals; // first clean read = the pre-login cookie floor
        } else {
          lastDone = attachLoginDone(baseNames, names, baseVals!, vals, urlLeft, Date.now() - start > 15_000);
        }
      } catch {
        /* CDP hiccup — keep waiting */
      } finally {
        await cdp?.close().catch(() => {}); // never held past the read
      }
    } else if (decision === 'blocked') {
      lastDone = false;
    }
    const done = decision !== 'blocked' && lastDone;
    if (done) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 2000) return; // held 2s → real
    } else {
      stableSince = 0;
    }
    await sleep(1000);
  }
  throw new Error(
    'attach: login was not completed before the timeout — solve any challenge and finish logging in ' +
      'in the Chrome window that opened, then it captures automatically',
  );
}

/**
 * attach-mode completion verdict for one cookie read.
 *
 *  • A STRONG auth-named cookie (isAuthCookieName) proves login on its own — the
 *    same-origin SPA case, where the URL never moves.
 *  • Anything weaker — the post-settle opaque-cookie fallback, or a jar change —
 *    counts ONLY once the URL has left the login page. MEASURED 2026-09-14 on
 *    chatgpt.com: with the fallback un-gated, `oai-asli` / `precise_location_permission`
 *    appeared on the still-logged-out login page past the 15s settle window and the
 *    capture saved a logged-out session reported ok:true, while the human was still
 *    on auth.openai.com. Requiring the URL arm keeps a multi-step login's email screen
 *    and a pre-login analytics drop from completing early.
 */
export function attachLoginDone(
  baseNames: Set<string>,
  names: Set<string>,
  baseVals: Set<string>,
  vals: Set<string>,
  urlLeft: boolean,
  settled: boolean,
): boolean {
  if (gainedAuthCookie(baseNames, names, false) !== null) return true; // strong names only
  if (!urlLeft) return false;
  const jarChanged = [...vals].some((k) => !baseVals.has(k)); // added or rotated
  return jarChanged || gainedAuthCookie(baseNames, names, settled) !== null;
}

/** How often attach re-reads cookies while the login-site page is unchanged. */
const ATTACH_READ_EVERY_MS = 5000;

/**
 * May attach mode briefly connect over CDP to read cookies on this poll?
 *
 *   'blocked' — no rendered login-site page, OR any http(s) tab is on a bot wall, OR
 *               any tab is off the login site (an identity provider mid-sign-in, e.g.
 *               auth.openai.com). A connection then is what breaks the sign-in.
 *   'read'    — safe, and the login-site page changed or the last read is stale.
 *   'reuse'   — safe, but nothing changed since the last read: keep its verdict.
 *
 * Pure, so the gate is testable without a browser.
 */
export function attachCookieReadDecision(
  pages: Array<{ type?: string; url?: string; title?: string }>,
  onSite: (host: string) => boolean,
  key: string,
  lastKey: string,
  sinceLastReadMs: number,
): 'read' | 'reuse' | 'blocked' {
  if (!key) return 'blocked';
  const tabs = pages.filter((p) => p.type === 'page' && typeof p.url === 'string' && /^https?:/i.test(p.url));
  if (tabs.some((p) => wallUp(p.url ?? '', p.title ?? '') || !onSite(safeHostname(p.url ?? '')))) return 'blocked';
  return key !== lastKey || sinceLastReadMs >= ATTACH_READ_EVERY_MS ? 'read' : 'reuse';
}

/** Wait for the human to clear the wall only — no login expected, same url throughout. */
const pollAttachedChallenge = (port: number, url: string, w: AttachWait): Promise<void> =>
  pollAttached(
    port,
    (p) => challengeCleared(p.url, url, p.title),
    w,
    'attach: the challenge was not cleared before the timeout — solve the CAPTCHA in the Chrome window ' +
      'that opened and stay on the page; it captures automatically once the real content loads',
    CANCELLED_CHALLENGE,
  );

const TEMP_PROFILE_MARK = 'pwmcp-attach-';
const mkTempProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PROFILE_MARK));

interface AttachProfile {
  dir: string; // the user-data-dir Chrome actually drives
  cleanup: boolean; // rm `dir` afterwards (fresh temp + profile copies; NEVER a real profile)
  scope: boolean; // domain-scope the export (a real cookie jar is involved)
  guardDir?: string; // a running Chrome on this dir blocks the capture (SingletonLock)
  copyFrom?: string; // copy trust-bearing essentials from here into `dir` before launch
}

/**
 * Resolve which Chrome profile the attach capture drives.
 *  - 'temp'   → fresh throwaway (fine for soft walls).
 *  - 'system' → Chrome 136+ DISABLES --remote-debugging-port on the DEFAULT
 *               user-data-dir (an anti-cookie-theft security fix), so we cannot
 *               drive it in place. Instead copy its trust-bearing essentials
 *               (Local State + cookies) into a fresh NON-default dir and drive
 *               that — the copy carries the same cf_clearance the real browser
 *               earned, and the debug port is allowed. Export is domain-scoped.
 *  - <path>   → an explicit non-default user-data-dir, driven in place.
 */
function resolveAttachProfile(profile: LoginOptions['profile']): AttachProfile {
  if (!profile || profile === 'temp') return { dir: mkTempProfile(), cleanup: true, scope: false };
  if (profile === 'system') {
    const src = defaultChromeUserDataDir();
    return { dir: mkTempProfile(), cleanup: true, scope: true, guardDir: src, copyFrom: src };
  }
  return { dir: profile, cleanup: false, scope: true, guardDir: profile };
}

/**
 * Copy just the trust-bearing profile files (cookies + the Local State that
 * holds the OS-keyring-wrapped cookie key, so the copied cookies still decrypt)
 * into a fresh dir. Small and fast — never the multi-GB caches.
 */
function copyProfileEssentials(src: string, dst: string): void {
  const rels = [
    'Local State',
    'Default/Cookies',
    'Default/Cookies-journal',
    'Default/Network/Cookies',
    'Default/Network/Cookies-journal',
    'Default/Preferences',
    'Default/Secure Preferences',
  ];
  for (const rel of rels) {
    const s = path.join(src, rel);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dst, rel);
    try {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    } catch {
      /* skip a file we can't read */
    }
  }
  try {
    fs.writeFileSync(path.join(dst, 'First Run'), ''); // skip the first-run UI
  } catch {
    /* ignore */
  }
}

/** Chrome keeps a SingletonLock in its user-data-dir while running → refuse to fight the lock. */
function profileInUse(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SingletonLock')) || fs.existsSync(path.join(dir, 'SingletonSocket'));
}

/** The registrable-ish domain of a URL (last two labels) — good enough to scope a cookie jar. */
function siteDomain(u: string): string {
  try {
    return new URL(u).hostname.split('.').slice(-2).join('.').toLowerCase();
  } catch {
    return '';
  }
}

type StorageState = {
  cookies?: Array<{ domain?: string; name?: string; expires?: number }>;
  origins?: Array<{ origin?: string }>;
};

/**
 * Summarise what a challenge capture actually caught. Playwright records `expires`
 * as a Unix SECONDS float, with -1 for a session cookie (dies with the browser —
 * useless to us, since the browser is killed on the way out).
 */
export function clearanceSummary(state: StorageState): { expiresAt?: string; warning?: string } {
  const cleared = (state.cookies ?? []).filter((c) => CLEARANCE_COOKIES.test(c.name ?? ''));
  if (!cleared.length)
    return {
      warning:
        'no clearance cookie (cf_clearance/datadome/_abck/…) was captured — the wall may not have been ' +
        'cleared, or it marks trust some other way; verify with a web_fetch({session}) read before relying on this',
    };
  const expiries = cleared.map((c) => c.expires ?? -1).filter((e) => e > 0);
  if (!expiries.length)
    return { warning: 'the clearance cookie is a SESSION cookie — it does not survive the captured browser closing' };
  return { expiresAt: new Date(Math.min(...expiries) * 1000).toISOString() };
}

/**
 * Cookies gained between two captures — the only trustworthy "a login actually
 * happened" signal.
 *
 * Every URL/DOM heuristic here fails on email-first IdP screens. DocuSign,
 * Google and Microsoft all ask for the email address on a page that has NO
 * password field, reached by redirecting to a different host AND path than the
 * one the caller passed. So `samePath()` reports "moved off the login page" and
 * `hasPasswordField()` reports "no login form present" — while the human is
 * still looking at step one of the login. A real login always issues at least
 * one new cookie.
 *
 * Compared by (domain, name) rather than by count, so analytics/consent cookies
 * dropped on arrival — present in BOTH captures — never read as authentication.
 */
export function newCookies(before: StorageState, after: StorageState): NonNullable<StorageState['cookies']> {
  const key = (c: { domain?: string; name?: string }) =>
    `${(c.domain ?? '').replace(/^\./, '').toLowerCase()}|${c.name ?? ''}`;
  const seen = new Set((before.cookies ?? []).map(key));
  return (after.cookies ?? []).filter((c) => !seen.has(key(c)));
}

/**
 * Sign-in FLOW cookies: set by the login page itself before the human types anything
 * (CSRF, OAuth callback/state/nonce, PKCE verifier). By name they look like auth —
 * next-auth's `__Host-next-auth.csrf-token` matches both the `auth` and `token` arms of
 * isAuthCookieName — so an attach capture of chatgpt.com completed on page load and
 * saved a logged-out session reported ok:true. They are pre-login infrastructure:
 * never proof of login, and never a "real cookie change" for the settle fallback.
 */
const PRE_LOGIN_FLOW_COOKIE = /csrf|xsrf|callback|nonce|pkce|code[-_.]?verifier|[-_.]state$/i;

/**
 * Cookies set BEFORE any login — dropped on first page load by the app, analytics
 * or the CDN. A new one of these is not evidence of authentication (an ASP.NET app
 * drops ASP.NET_SessionId and a Marketo _mkto_trk before the user has typed a
 * thing), so the attach auth-completion gate must ignore them.
 */
export function isInfraCookieName(name: string): boolean {
  if (PRE_LOGIN_FLOW_COOKIE.test(name)) return true;
  return /^(?:_mkto_trk|marketo|__cf|cf_|_ga(?:$|_)|_gid|_gcl|_hj|optimizely|ai_session|ai_user|srv_id|cookiesession\d*|_fbp|_uetsid|_uetvid|visitor|_pk_|s_|utag_)/i.test(
    name,
  );
}

/**
 * A cookie NAME that looks like a real authentication ticket/token (forms-auth,
 * ASP.NET Core auth, an identity/JWT/bearer/login token). Excludes the pre-login
 * ASP.NET_SessionId, which exists before the user authenticates.
 */
export function isAuthCookieName(name: string): boolean {
  if (/^ASP\.NET_SessionId$/i.test(name)) return false;
  if (PRE_LOGIN_FLOW_COOKIE.test(name)) return false;
  return /aspxauth|\.aspnet\.|\.aspnetcore|fedauth|identity|\bauth\b|token|jwt|bearer|logintoken/i.test(name);
}

/**
 * The signal attach-login completes on — the same "a real login issues a new
 * cookie" authority the driven path uses (see newCookies), adapted for a passive
 * poll. Returns the name of a gained cookie that proves login, else null:
 *   • a STRONG auth-named cookie (isAuthCookieName) counts the instant it appears;
 *   • any other NON-infra new cookie counts only once `settled` (past the pre-login
 *     cookie-settle window), so a late CSRF/analytics drop cannot false-complete.
 * `before`/`after` are (domain|name) key sets for the login site's own cookies.
 */
export function gainedAuthCookie(before: Set<string>, after: Set<string>, settled: boolean): string | null {
  let fallback: string | null = null;
  for (const k of after) {
    if (before.has(k)) continue;
    const name = k.slice(k.indexOf('|') + 1);
    if (isInfraCookieName(name)) continue;
    if (isAuthCookieName(name)) return name;
    if (settled && fallback === null) fallback = name;
  }
  return fallback;
}

// How long a strong auth cookie must persist CONTINUOUSLY before the driven SPA path
// treats it as a finalized login. A multi-redirect sign-in (iCloud's) sets transient
// auth-named cookies mid-handshake and then clears them; the durable session ticket is
// issued only once the login truly finalizes and then stays. Requiring continuous
// presence across this window is what tells the two apart — a flapping handshake cookie
// resets the timer, a settled ticket clears it. Generous because the cost is a one-time
// few-second wait on a capture a human is already sitting through.
const AUTH_COOKIE_SETTLE_MS = 4000;

/**
 * The completion probe the DRIVEN capture path (sessionLogin) uses to recognise a
 * SAME-ORIGIN SPA login — iCloud, and any app that keeps its URL constant through
 * sign-in — where waitPastLogin's pathname-change test can never fire. It reuses the
 * exact authority the attach path trusts (gainedAuthCookie over the login site's own
 * cookies), in STRONG-ONLY form (`settled` = false): an auth-NAMED ticket completes it,
 * while an opaque analytics/CSRF cookie never does. On the driven path waitPastLogin
 * still governs the URL-change case, so the loose opaque-cookie fallback is deliberately
 * withheld here. STRONG-only is also the real safety boundary for cross-origin-iframe
 * auth (iCloud): waitPastLogin's "password field is gone" gate cannot see an iframe
 * form, so completion there rests entirely on an auth-NAMED ticket.
 *
 * DURABILITY, not mere presence. A multi-redirect sign-in issues transient auth-named
 * cookies during the handshake and clears them before the login finalizes — completing
 * on one of those saves an unauthenticated session (measured on iCloud: the cookie that
 * tripped the probe was gone by save time). So the probe fires only after a strong auth
 * cookie has been present CONTINUOUSLY for AUTH_COOKIE_SETTLE_MS: a cookie that flaps or
 * is replaced resets the clock, and only a settled ticket clears it. sessionLogin adds a
 * second, decisive gate — the PERSISTED artifact must still carry that cookie.
 *
 * `before` is the pre-login cookie floor (context.storageState() taken after landing on
 * the login page); `cookiesNow` reads the live jar each poll. Both are filtered to the
 * login site's own domain, matching pollAttachedLogin's scoping.
 */
export function makeAuthCookieProbe(
  cookiesNow: () => Promise<Array<{ domain?: string; name?: string }>>,
  before: StorageState,
  loginUrl: string,
  now: () => number = () => Date.now(), // injectable clock so the durability logic is unit-testable
): () => Promise<boolean> {
  const reg = siteDomain(loginUrl);
  const onSite = (host: string) => {
    const h = (host ?? '').replace(/^\./, '').toLowerCase();
    return !!reg && (h === reg || h.endsWith('.' + reg));
  };
  const key = (c: { domain?: string; name?: string }) =>
    `${(c.domain ?? '').replace(/^\./, '').toLowerCase()}|${c.name ?? ''}`;
  const base = new Set((before.cookies ?? []).filter((c) => onSite(c.domain ?? '')).map(key));
  let trackedKey: string | null = null; // the auth cookie whose continuous presence we are timing
  let firstSeen = 0;
  return async () => {
    const jar = (await cookiesNow()).filter((c) => onSite(c.domain ?? ''));
    const names = new Set(jar.map(key));
    const gained = gainedAuthCookie(base, names, false); // strong-named only; returns the cookie NAME
    if (!gained) {
      trackedKey = null; // no auth cookie present → nothing to time
      return false;
    }
    const gainedKey = [...names].find((k) => k.slice(k.indexOf('|') + 1) === gained) ?? null;
    if (gainedKey !== trackedKey) {
      trackedKey = gainedKey; // a new/replaced auth cookie → restart the durability clock
      firstSeen = now();
      return false;
    }
    return now() - firstSeen >= AUTH_COOKIE_SETTLE_MS;
  };
}

/** Does the persisted storageState carry a strong auth cookie for `loginUrl`'s own domain? */
function artifactHasSiteAuthCookie(state: StorageState, loginUrl: string): boolean {
  const reg = siteDomain(loginUrl);
  if (!reg) return false;
  return (state.cookies ?? []).some((c) => {
    const h = (c.domain ?? '').replace(/^\./, '').toLowerCase();
    const onSite = h === reg || h.endsWith('.' + reg);
    return onSite && isAuthCookieName(c.name ?? '');
  });
}

/**
 * Cookies belonging to `domain` (or a subdomain). Shares `scopeStorageState`'s
 * host-matching rule deliberately: if the two disagreed, a capture could be scoped
 * to nothing and still pass the "did we capture anything" check.
 */
export function siteCookies(state: StorageState, domain: string): NonNullable<StorageState['cookies']> {
  const all = state.cookies ?? [];
  if (!domain) return all;
  return all.filter((c) => {
    const host = (c.domain ?? '').replace(/^\./, '').toLowerCase();
    return host === domain || host.endsWith('.' + domain);
  });
}

/** Keep only cookies/origins belonging to `domain` (and its subdomains) — never persist the whole jar. */
export function scopeStorageState(state: StorageState, domain: string): StorageState {
  if (!domain) return state;
  const onSite = (host: string) => host === domain || host.endsWith('.' + domain);
  return {
    cookies: (state.cookies ?? []).filter((c) => onSite((c.domain ?? '').replace(/^\./, '').toLowerCase())),
    origins: (state.origins ?? []).filter((o) => {
      try {
        return onSite(new URL(o.origin ?? '').hostname.toLowerCase());
      } catch {
        return false;
      }
    }),
  };
}

// ── orphan-proof cleanup ────────────────────────────────────────────────────────
// A spawned Chrome must never be left running if the tool is interrupted mid-wait.
// We spawn it in its own process group and record it; the next attach run reaps any
// TEMP-profile Chrome a prior interrupted run orphaned (verified by cmdline so a
// reused PID is never mis-killed). A real/system profile is NEVER force-reaped.

interface AttachRec {
  pid: number;
  profile: string;
  startedAt: string;
}
const registryPath = () => path.join(sessionsDir(), '.attach-chromes.json');
function readRegistry(): AttachRec[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
  } catch {
    return [];
  }
}
function writeRegistry(recs: AttachRec[]): void {
  try {
    try {
      ownerOnlyDir(sessionsDir());
    } catch (err) {
      // The registry holds pids and temp-profile paths, not a secret, and losing
      // it is what leaks an orphaned Chrome — so an ACL failure here (win32 only;
      // NOT VERIFIED ON WINDOWS) warns and still writes. No secret lands in the
      // unrestricted dir because every capture re-restricts it and fails loud.
      // A mkdir failure is not an OwnerOnlyError and ends here as it always did.
      if (!(err instanceof OwnerOnlyError)) throw err;
      log(`warning: ${err.message} — writing the attach-chrome registry anyway (it holds no secret)`);
    }
    fs.writeFileSync(registryPath(), JSON.stringify(recs));
  } catch {
    /* best effort */
  }
}
function cmdlineMatches(pid: number, needle: string): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle);
  } catch {
    // /proc unavailable (non-Linux) — the temp path is unique enough to trust the record.
    return process.platform !== 'linux';
  }
}
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
/** Reap any TEMP-profile Chrome an interrupted prior run left behind (safe: never touches a real profile). */
function reapOrphans(): void {
  const recs = readRegistry();
  if (!recs.length) return;
  for (const r of recs) {
    if (!r.profile.includes(TEMP_PROFILE_MARK)) continue; // only temp spawns are auto-reaped
    if (cmdlineMatches(r.pid, r.profile)) killGroup(r.pid);
    try {
      fs.rmSync(r.profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  writeRegistry([]);
}

export async function sessionAttach(opts: LoginOptions): Promise<LoginResult> {
  reapOrphans(); // clean up anything a previous interrupted run left running
  const out = sessionFilePath(opts.name);
  const prof = resolveAttachProfile(opts.profile);
  const chromePath = resolveChromePath();
  let child: ReturnType<typeof spawn> | undefined;
  let cdp: Browser | undefined;
  try {
    if (prof.guardDir && profileInUse(prof.guardDir))
      throw new Error(
        `attach: Chrome is running on ${prof.guardDir} — fully quit it first (all windows AND any ` +
          "background process) so its trust cookies can be read cleanly, then retry",
      );
    // 'system' rides the real profile's trust: copy its cookies into the fresh
    // (non-default) dir we drive, so Chrome 136+ still allows the debug port.
    if (prof.copyFrom) copyProfileEssentials(prof.copyFrom, prof.dir);

    const port = await freePort(); // never 0 — see freePort()
    const args = attachChromeArgs(prof.dir, port, opts.loginUrl);
    child = spawn(chromePath, args, { stdio: 'ignore', detached: true }); // own process group → clean tree-kill
    child.on('error', (e) => log(`attach: chrome spawn error: ${e.message}`));
    // The end signal for the unbounded wait, HINT half: the Chrome we spawned is
    // gone. Deliberately only a hint — the DevTools endpoint stays the authority,
    // because a launcher script that execs (or hands off to an already-running
    // Chrome) exits while the browser the human is using lives on.
    let chromeExited = false;
    child.on('exit', () => {
      chromeExited = true;
    });
    if (child.pid && prof.cleanup) registerAttachRecord(child.pid, prof.dir); // temp/copy dirs are reap-eligible
    log(
      opts.challenge
        ? `attach challenge for "${opts.name}" — a real Chrome window opened; solve the CAPTCHA there and stay on the page`
        : `attach login for "${opts.name}" — a real Chrome window opened; solve the challenge and log in there`,
    );

    await waitForDevtools(port, 20_000); // startup, not a human wait — still bounded
    // No deadline on the stdio surface: a Cloudflare solve plus a two-hop SSO login
    // takes as long as it takes. An absent `wait` is a direct caller, not a surface,
    // so it stays capped (resolveHumanWait).
    const w: AttachWait = {
      wait: opts.wait ?? resolveHumanWait(opts.timeoutMs, 'local'),
      chromeExited: () => chromeExited,
    };
    if (w.wait.deadline === 'none') log('attach: no time limit — closing the Chrome window cancels the capture');
    if (opts.challenge) await pollAttachedChallenge(port, opts.loginUrl, w);
    else await pollAttachedLogin(port, opts.loginUrl, w);

    // Challenge cleared + logged in. Attach passively and read the session out.
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = cdp.contexts()[0];
    if (!ctx) throw new Error('attach: no browser context to export');
    let state = (await ctx.storageState()) as StorageState;
    // A real/shared profile carries the user's whole cookie jar — persist ONLY the
    // login site's cookies. A throwaway temp profile only ever holds the target site.
    if (prof.scope) state = scopeStorageState(state, siteDomain(opts.loginUrl));

    // Same invariant sessionLogin() enforces, adapted: attach connects AFTER the
    // human is done, so there is no before/after delta to take. What holds for both
    // profile modes is that the target site must have issued SOMETHING — a temp
    // profile starts empty, and a scoped system profile keeps only this site — so
    // zero cookies here means the capture is worthless whatever the mode. Writing it
    // anyway is the harmful outcome: later web_fetch({session}) reads silently
    // deauthenticated. (Whether a *clearance-named* cookie is present stays a
    // warning below — walls mark trust in ways that allowlist cannot know.)
    if (!siteCookies(state, siteDomain(opts.loginUrl)).length) {
      throw new Error(
        `${opts.challenge ? 'challenge' : 'attach'}: nothing was captured — no cookies for ` +
          `${siteDomain(opts.loginUrl) || 'the target site'} are present, so the ` +
          `${opts.challenge ? 'wall was not cleared' : 'login did not complete'}. Nothing was saved.`,
      );
    }

    prepareSessionsDir();
    fs.writeFileSync(out, JSON.stringify(state));
    const restriction = restrictCapturedArtifact(out);
    const kind = opts.challenge ? 'challenge' : 'attach';
    log(
      `saved session "${opts.name}" → ${out} (${restriction}, ${kind}${prof.scope ? ', domain-scoped' : ''}, ` +
        `${state.cookies?.length ?? 0} cookies)`,
    );
    // Only challenge captures get clearance telemetry — for a login the meaningful
    // lifetime is the auth cookie's, which session_status already probes for.
    const clearance = opts.challenge ? clearanceSummary(state) : {};
    if (clearance.warning) log(`warning: ${clearance.warning}`);
    // The same proof-of-capture sessionLogin reports: which hosts the saved cookies
    // belong to. Attach has no before/after delta, so this is the site's whole jar.
    const saved = siteCookies(state, siteDomain(opts.loginUrl));
    const hosts = [...new Set(saved.map((c) => (c.domain ?? '').replace(/^\./, '')))].filter(Boolean);
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode: opts.challenge ? 'challenge' : 'attach',
      ok: true,
      cookiesGained: saved.length,
      authHosts: hosts,
      ...clearance,
    };
  } catch (err) {
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode: opts.challenge ? 'challenge' : 'attach',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof LoginCancelledError ? { cancelled: true as const } : {}),
    };
  } finally {
    await cdp?.close().catch(() => {}); // detaches the CDP client — does not close the browser
    if (child?.pid) {
      killGroup(child.pid); // kill the Chrome WE spawned (its own process group)
      unregisterAttachRecord(child.pid);
    }
    if (prof.cleanup) fs.rmSync(prof.dir, { recursive: true, force: true }); // NEVER delete a real profile
  }
}

function registerAttachRecord(pid: number, profile: string): void {
  const recs = readRegistry();
  recs.push({ pid, profile, startedAt: new Date().toISOString() });
  writeRegistry(recs);
}
function unregisterAttachRecord(pid: number): void {
  writeRegistry(readRegistry().filter((r) => r.pid !== pid));
}

type PwPage = import('playwright').Page;

/** Compare two URLs by pathname only (ignore query/hash, normalize trailing /). */
function samePath(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      return new URL(u).pathname.replace(/\/+$/, '').toLowerCase() || '/';
    } catch {
      return u.toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * Does `sig` identify the page we LANDED on, read as a post-login URL marker?
 *
 * Matched against origin+pathname, never the query string. An OAuth login page
 * carries its own callback in the query — DocuSign's is
 * `…/oauth/auth?redirect_uri=https%3A%2F%2Fapps.docusign.com%2Fauthenticate` —
 * so a perfectly sensible marker like "apps.docusign.com" is already present on
 * the login page and matches instantly. A marker describes where the human ends
 * up, not what is embedded in the URL of where they are.
 *
 * The samePath() guard is kept for the case the marker names the login host
 * itself: the flow may walk several paths on that host before it is done.
 */
export function urlMarkerHit(currentUrl: string, sig: string, loginUrl: string): boolean {
  const bare = (u: string) => {
    try {
      const { origin, pathname } = new URL(u);
      return (origin + pathname).toLowerCase();
    } catch {
      return u.toLowerCase();
    }
  };
  if (!bare(currentUrl).includes(sig.toLowerCase())) return false;
  return !samePath(currentUrl, loginUrl);
}

/** Is a password field still on the page? (⇒ almost certainly still the login form.) */
async function hasPasswordField(page: PwPage): Promise<boolean> {
  return (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
}

/**
 * Generic "the human got past the login page" detector — no marker needed.
 * Success = the password field is gone AND the URL is no longer the login page,
 * held stable briefly so a mid-redirect flicker doesn't false-trigger. Rejects
 * on timeout so it never counts as success in the race.
 */
async function waitPastLogin(
  page: PwPage,
  loginUrl: string,
  wait: WaitBudget,
  authGained?: () => Promise<boolean>,
  cancel?: CaptureCancel,
): Promise<void> {
  const deadline = deadlineOf(wait);
  let stableSince = 0;
  // `cancel.cancelled()` is in the loop condition, not just in the race: with an
  // unbounded budget the loser of Promise.race would otherwise keep polling a dead
  // page for the life of the process — one spinning loop per cancelled capture.
  while (Date.now() < deadline && !cancel?.cancelled()) {
    const url = page.url();
    const movedOff = !samePath(url, loginUrl);
    const noPassword = !(await hasPasswordField(page).catch(() => false));
    // A same-origin SPA login (iCloud, and any app that keeps its URL constant
    // through sign-in) never changes pathname, so movedOff alone can never fire.
    // A freshly issued auth cookie is the equivalent "past the login" proof — the
    // same authority the attach path trusts. Requiring the password field to be gone
    // guards the pre-submit window for a MAIN-FRAME credential form; when that form
    // lives in a cross-origin iframe (iCloud's does), this locator cannot see it, so
    // the guard is absent there and safety rests on makeAuthCookieProbe's STRONG-name-
    // only detection — an auth-named ticket the IdP issues only AFTER authentication.
    const pastLogin = movedOff || (authGained ? await authGained().catch(() => false) : false);
    if (noPassword && pastLogin) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 1500) return;
    } else {
      stableSince = 0;
    }
    // A plain sleep, NOT page.waitForTimeout: on a closed page that rejects at once,
    // and its .catch() would turn this poll into a tight CPU loop.
    await sleep(500);
  }
  if (cancel?.cancelled()) throw new LoginCancelledError(CANCELLED_DRIVEN);
  throw new Error('waitPastLogin: timed out');
}

/**
 * Wait for a successful login, robust to how the caller (often a human or an
 * LLM) phrased the confirmation. Races several interpretations; the first to
 * resolve wins. On total timeout, throws a DIAGNOSTIC error (final URL, page
 * title, whether a login form is still showing, how the marker was read) rather
 * than the opaque AggregateError "All promises were rejected".
 */
async function waitForLogin(
  page: PwPage,
  loginUrl: string,
  signal: string | undefined,
  wait: WaitBudget,
  authGained?: () => Promise<boolean>,
  cancel?: CaptureCancel,
): Promise<void> {
  const sig = signal?.trim();
  const timeout = pwTimeout(wait); // 0 == no Playwright timeout, for an unbounded budget
  // The generic heuristic is a FALLBACK, not a co-equal racer. Multi-step logins
  // walk through several pages that all satisfy it — DocuSign goes
  // /oauth/auth → /username for email entry: new path, no password field, so
  // waitPastLogin() calls it done while the human is still on step one. Under
  // Promise.any the loosest signal always wins, which silently defeats the very
  // marker the caller supplied to prevent that. When the caller has said what
  // success looks like, only that counts; a marker that never matches must
  // surface as a diagnostic timeout, not as a wrong success.
  //
  // authGained is the SPA-login completion signal (a new auth cookie) and it rides
  // with the fallback for the same reason: it is consulted only when the caller gave
  // no marker, so an explicit successSignal stays the sole authority.
  const arms: Promise<unknown>[] = sig ? [] : [waitPastLogin(page, loginUrl, wait, authGained, cancel)];
  if (sig) {
    // (a) CSS/XPath/Playwright-engine selector, (b) visible text, (c) URL
    // substring — but guarded so the login URL itself never counts (D).
    arms.push(page.waitForSelector(sig, { timeout }).then(() => {}));
    arms.push(
      page
        .getByText(sig)
        .first()
        .waitFor({ timeout })
        .then(() => {}),
    );
    arms.push(
      page
        .waitForURL((u) => urlMarkerHit(u.toString(), sig, loginUrl), { timeout })
        .then(() => {}),
    );
  }
  // The cancel arm is RACED, never added to Promise.any: `any` waits for every arm
  // to reject, so a cancel inside it would sit behind a marker arm that (unbounded)
  // never settles. Promise.race lets the end signal win the instant it fires.
  const completed = Promise.any(arms).then(() => {});
  try {
    await (cancel ? Promise.race([completed, cancel.promise]) : completed);
  } catch (err) {
    // "The window was closed" is not a diagnosis of the site — report it as itself.
    const stopped = cancellation(err);
    if (stopped) throw stopped;
    throw await loginDiagnostic(page, loginUrl, sig, wait);
  }
}

/**
 * Build an actionable timeout message instead of "All promises were rejected".
 *
 * Returns the error rather than a string, because the diagnosis has two
 * provenances and a string can only carry one. The advice — "complete the login
 * in THAT window", "pass a successSignal" — is this server's, and is meant to be
 * ACTED on; the final URL and the page's `<title>` are the page's, and the title
 * in particular is free-form attacker text on a hostile login page. The second
 * kind is carried in `captured` and fenced at the MCP boundary; it is never
 * spliced into the first.
 */
async function loginDiagnostic(
  page: PwPage,
  loginUrl: string,
  signal: string | undefined,
  wait: WaitBudget,
): Promise<CapturedTextError> {
  let url = '';
  let title = '';
  let pw = false;
  try {
    url = page.url();
  } catch {
    /* page may be gone */
  }
  try {
    title = await page.title();
  } catch {
    /* ignore */
  }
  try {
    pw = await hasPasswordField(page);
  } catch {
    /* ignore */
  }
  // The old form was `final URL: ${url} (“${title}”)` inside this list — one
  // string, two authors, with the title's boundary marked by curly quotes a page
  // can simply type into its own <title>. What is observed goes below; what is
  // advised stays here.
  const parts = [
    // An unbounded wait cannot have "timed out" — it ended because a completion arm
    // failed, so the sentence must not claim a clock that was never set.
    wait.deadline === 'capped'
      ? `login capture timed out after ${Math.round(wait.ms / 1000)}s`
      : 'the login capture ended without a completion signal',
    'the final URL and page title observed at that moment are quarantined below',
  ];
  const observed = [`final URL: ${url || 'unknown'}`];
  if (title) observed.push(`page title: ${title}`);
  if (pw) {
    parts.push(
      'the page still shows a login form — a SEPARATE automation window was opened for this capture; ' +
        'complete the login in THAT window (not your everyday browser), then it saves automatically',
    );
  } else if (samePath(url, loginUrl)) {
    parts.push(
      'the URL never left the login page and no new auth cookie was detected — for a single-page app whose ' +
        'URL does not change on sign-in, pass a successSignal naming an element or text visible only after ' +
        'login, or use attach:true',
    );
  }
  if (signal) {
    parts.push(
      `the success marker ${JSON.stringify(signal)} never matched as a selector, visible text, or a ` +
        'changed-URL substring — verify it against the post-login page, or omit it in headed mode to auto-detect',
    );
  }
  return new CapturedTextError(parts.join('; ') + '.', observed.join('\n'), url);
}

// ── in-flight human captures ──────────────────────────────────────────────────
// A human login can outlive the CALL that started it. Claude Code aborts a tool
// call that stays silent (MEASURED 2026-09-29 on Claude Code 2.1.284: a silent call
// was killed at 30s with `sent no response or progress for 30s`. WHICH internal limit
// that 30s is was never established, so no mechanism is claimed here), and the
// CallToolRequest handler in src/index.ts deliberately never reads extra.signal —
// so an abandoned call does NOT stop the login: the window stays open and the save
// still happens server-side. This registry is how the agent finds that out. It is
// the durable-handle-and-poll shape ledger DEC-2026-07-28 recorded as DEFERRED and
// "implementable as plain tools TODAY with no protocol dependency" — session_status
// is the poll, and no protocol extension was needed.
//
// Server-authored values ONLY: enums, ISO timestamps, a count, and the artifact path
// this server chose. No page text, no title, no final URL, not even the caller's
// loginUrl — session_status is exempt from the untrusted-content marking
// (CUSTOM_TOOL_EXEMPTIONS in src/index.ts) and this record must keep that true.

export type CaptureState = 'waiting' | 'saved' | 'cancelled' | 'failed';

export interface CaptureProgress {
  mode: LoginResult['mode'];
  state: CaptureState;
  startedAt: string;
  /** Absent while `state` is 'waiting'. */
  endedAt?: string;
  /** Set only on 'saved' — the proof the long login landed on disk. */
  savedTo?: string;
  cookiesGained?: number;
  /** What the agent should do about this record, in this server's own words. */
  note: string;
}

const NOTES: Record<CaptureState, string> = {
  waiting:
    'a capture is IN PROGRESS: a window is open and the human is logging in. It has no deadline — poll ' +
    'this tool again rather than starting a second login, and never tell the user it failed.',
  saved: 'the capture COMPLETED and the session was saved, even if the tool call that started it was abandoned.',
  cancelled: 'the human closed the window before the login finished. Nothing was saved; start a new capture.',
  failed: 'the capture failed. Read the session_login result for the diagnosis.',
};

const inFlight = new Map<string, CaptureProgress>();

/** The last capture attempt for `name`, if this process ran one. */
export function captureProgress(name: string): CaptureProgress | undefined {
  return inFlight.get(name);
}

/** Record a capture as under way. Returns the record `endCapture` closes. */
function beginCapture(name: string, mode: LoginResult['mode']): CaptureProgress {
  const rec: CaptureProgress = {
    mode,
    state: 'waiting',
    startedAt: new Date().toISOString(),
    note: NOTES.waiting,
  };
  inFlight.set(name, rec);
  return rec;
}

/** Close a capture record from its result. Mutated in place: session_status reads the same object. */
function endCapture(rec: CaptureProgress, result: LoginResult): void {
  closeCapture(rec, result.ok ? 'saved' : result.cancelled ? 'cancelled' : 'failed');
  if (result.ok) {
    rec.savedTo = result.path;
    rec.cookiesGained = result.cookiesGained;
  }
}

/**
 * Close a record whose capture THREW instead of returning a result.
 *
 * Both engines convert their own failures into an `ok: false` LoginResult, so this is
 * only reachable from the handful of lines that run BEFORE their `try` —
 * sessionFilePath, resolveAttachProfile, resolveChromePath. Reachable or not, the
 * record must never be left 'waiting': session_status reads that state as "in
 * progress, poll again, never tell the user it failed", and a stranded record would
 * keep saying that for the life of the process.
 */
function failCapture(rec: CaptureProgress): void {
  closeCapture(rec, 'failed');
}

/** The one place a record leaves 'waiting' — so no exit path can forget the note. */
function closeCapture(rec: CaptureProgress, state: CaptureState): void {
  rec.state = state;
  rec.endedAt = new Date().toISOString();
  rec.note = NOTES[state];
}

/** Which capture engine a set of options selects — the `mode` a record starts with. */
function captureMode(opts: LoginOptions): LoginResult['mode'] {
  if (opts.challenge) return 'challenge';
  if (opts.attach) return 'attach';
  return opts.headed ? 'headed' : 'headless';
}

/**
 * How often a human wait tells the client it is still alive, and what it says.
 *
 * The client's own limit is IDLE, not total, so a periodic notification is what keeps
 * a long login's call open — and nothing else does, so this interval IS the whole
 * safety margin. MEASURED 2026-09-29 against Claude Code 2.1.284 (the full two-run
 * method is recorded on callContext in src/index.ts): a 45s silent call was killed
 * with `sent no response or progress for 30s`, while the same 45s call sending
 * notifications/progress returned normally. 30s is what was OBSERVED, on that one
 * client at that one version — it is the client's number, not ours, and a client
 * default can change under us, so re-measure rather than trusting this line.
 *
 * The arithmetic, stated because a bare number would be unreviewable: 30_000 observed
 * deadline / 8_000 interval = a 3.75x margin. Ticks land at 8s, 16s and 24s — three
 * inside the deadline with 6s to spare, so a tick delayed by a busy event loop, a GC
 * pause, or a slow browser operation on this thread still leaves only a ~16s silence,
 * well short of 30s. 10_000 was rejected: its third tick lands ON the 30s deadline,
 * which is a coincidence rather than a margin.
 *
 * The message builder is pure and separate from the timer so it can be asserted
 * without waiting for one.
 */
const HEARTBEAT_EVERY_MS = 8_000;

export function heartbeatMessage(what: string, elapsedMs: number): string {
  return `${what} — still waiting for the human (${Math.round(elapsedMs / 1000)}s). No deadline; closing the window cancels.`;
}

/**
 * Start telling the client this call is alive. Returns the stop function.
 *
 * Sends NOTHING unless the incoming request carried a progressToken: ctx.progress is
 * undefined then, and a progress notification for a token the client never issued
 * makes it complain about an unknown token. The guard is not optional.
 */
function startHeartbeat(ctx: ToolContext | undefined, what: string): () => void {
  const progress = ctx?.progress;
  if (!progress) return () => {};
  const started = Date.now();
  const timer = setInterval(() => progress(heartbeatMessage(what, Date.now() - started)), HEARTBEAT_EVERY_MS);
  timer.unref(); // a heartbeat must never be the reason this process stays alive
  return () => clearInterval(timer);
}

// ── session_status ────────────────────────────────────────────────────────────

export interface StatusOptions {
  name: string;
  /** Omit for the OFFLINE artifact verdict — see `artifactStatus`. */
  probeUrl?: string;
  loginIndicator?: string; // selector/URL substring meaning "logged out"
}

/** What the stored artifact says about itself — domains, origins, expiry. Never cookie values. */
export interface ArtifactSummary {
  /** Registrable domains the capture actually carries identity for. */
  domains: string[];
  /** Origins the capture holds localStorage for (origin only, never its entries). */
  origins: string[];
  cookieCount: number;
  /** Earliest FIXED cookie expiry, ISO. `null` when no cookie has one. */
  expiresAt: string | null;
  /** Cookies with no fixed expiry — storageState records those as `expires: -1`. */
  sessionCookies: number;
  /** The earliest fixed expiry is already past. Advisory: the server may have rolled it forward. */
  expired: boolean;
  /** Plain-language reading of `expiresAt: null`, for a model that would otherwise guess. */
  expiryNote?: string;
}

export interface StatusResult {
  name: string;
  state: 'fresh' | 'stale' | 'missing' | 'unreachable' | 'present';
  checkedAt: string;
  /** Set only on the offline branch — its absence means a live probe ran. */
  check?: 'artifact';
  artifact?: ArtifactSummary;
  /**
   * A capture this process started for this name — in progress, or how it ended.
   * Present on BOTH branches: an in-flight headed capture has no file yet, so the
   * artifact verdict alone would read 'missing' while a window is open.
   */
  capture?: CaptureProgress;
}

/**
 * Summarise a parsed storageState by ALLOWLIST — every field below is
 * constructed explicitly, so a cookie value can never ride along in the output.
 * Playwright records `expires` in Unix SECONDS, with -1 for a session cookie;
 * a naive min over that returns -1 and would report a nonsense 1969 date.
 */
function summariseArtifact(state: unknown, now: number): ArtifactSummary {
  const s = (state ?? {}) as StorageState;
  const cookies = Array.isArray(s.cookies) ? s.cookies : [];
  const fixed = cookies
    .map((c) => (typeof c.expires === 'number' ? c.expires : -1))
    .filter((e) => e > 0);
  const earliest = fixed.length ? Math.min(...fixed) : null;
  const origins = (Array.isArray(s.origins) ? s.origins : [])
    .map((o) => o?.origin)
    .filter((o): o is string => typeof o === 'string');
  const summary: ArtifactSummary = {
    domains: [...storageStateDomains(state)].sort(),
    origins,
    cookieCount: cookies.length,
    expiresAt: earliest === null ? null : new Date(earliest * 1000).toISOString(),
    sessionCookies: cookies.length - fixed.length,
    expired: earliest !== null && earliest * 1000 <= now,
  };
  if (earliest === null && summary.sessionCookies > 0)
    summary.expiryNote = 'session cookies only — no fixed expiry; they die with the capturing browser';
  return summary;
}

/**
 * OFFLINE artifact verdict — what the saved file itself says, with NO browser
 * and NO network. It answers "do I already have access to this site?" so a
 * headless agent stops proposing a headed re-login for access it already has.
 *
 * It reports `present`, never `fresh`: only the live probe can know the server
 * still accepts the session. `expired` is advisory for the same reason — the
 * keepalive write-back below means the server routinely rolls expiry forward.
 */
function artifactStatus(name: string, file: string, checkedAt: string): StatusResult {
  if (!fs.existsSync(file)) return { name, state: 'missing', checkedAt, check: 'artifact' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // A corrupt artifact needs a recapture, exactly as the live probe reports it.
    // Nothing from the file is echoed here — the read never produced a value.
    return { name, state: 'stale', checkedAt, check: 'artifact' };
  }
  return {
    name,
    state: 'present',
    checkedAt,
    check: 'artifact',
    artifact: summariseArtifact(parsed, Date.now()),
  };
}

/**
 * The session verdict, plus any capture this process ran for the name.
 *
 * The capture record is attached HERE rather than inside each branch so every
 * verdict carries it — including 'missing', which is exactly what an in-flight
 * headed capture looks like on disk while the human is still typing.
 */
export async function sessionStatus(opts: StatusOptions): Promise<StatusResult> {
  const verdict = await statusVerdict(opts);
  const capture = captureProgress(opts.name);
  return capture ? { ...verdict, capture } : verdict;
}

async function statusVerdict(opts: StatusOptions): Promise<StatusResult> {
  const file = sessionFilePath(opts.name);
  const checkedAt = new Date().toISOString();
  // No probe URL to hit ⇒ answer from the artifact alone. Blank and whitespace
  // count as absent: a live probe of '' can only ever report 'unreachable'.
  const probeUrl = (opts.probeUrl ?? '').trim();
  if (!probeUrl) return artifactStatus(opts.name, file, checkedAt);
  if (!fs.existsSync(file)) return { name: opts.name, state: 'missing', checkedAt };

  // A corrupt artifact needs a recapture, exactly like an expired one → stale.
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { name: opts.name, state: 'stale', checkedAt };
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
    // Same disguise as capture: a naked headless probe can trip bot detection and
    // land on a challenge page, which would false-report a good session as 'stale'.
    const context = await browser.newContext({
      ...stealthContextOptions,
      storageState: file,
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript(STEALTH_INIT);
    const page = await context.newPage();
    try {
      await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch {
      // The probe never completed (app down, DNS/network failure) — that says
      // nothing about the session itself. Never report it as expired.
      return { name: opts.name, state: 'unreachable', checkedAt };
    }

    const url = page.url();
    let stale = /\/(login|signin|sign-in|auth)(\b|\/|\?)/i.test(url);
    if (!stale && opts.loginIndicator) {
      if (url.includes(opts.loginIndicator)) stale = true;
      else stale = (await page.$(opts.loginIndicator).catch(() => null)) !== null;
    }
    if (!stale) {
      // Rolling session write-back: a fresh probe just made an authed request,
      // and the site answered with refreshed cookies. Persisting them turns a
      // periodic status check into a KEEPALIVE — the session's expiry rolls
      // forward on every probe instead of aging toward its capture-time expiry.
      try {
        await context.storageState({ path: file });
        reassertOwnerOnly(file); // never throws; a failure is a stderr warning, not silence
      } catch {
        /* best-effort; the verdict stands either way */
      }
    }
    return { name: opts.name, state: stale ? 'stale' : 'fresh', checkedAt };
  } catch {
    // Browser/context failure — environmental, not a session verdict.
    return { name: opts.name, state: 'unreachable', checkedAt };
  } finally {
    await browser?.close().catch(() => {});
  }
}

// ── MCP tool wrappers ─────────────────────────────────────────────────────────

const loginDefinition: Tool = {
  name: 'session_login',
  description:
    'Log into a site once and save the authenticated session (cookies + storage) to a named file ' +
    'for reuse in debugging and generated Playwright tests. ' +
    'For ANY login, use headed:true. A SEPARATE automation window opens and the human completes ' +
    'every step (password, 2FA, SSO, CAPTCHA) at their own pace. Do NOT probe the login form with ' +
    'browser_* tools to work out what kind of login it is. Just call session_login({headed:true}) ' +
    'and let the person handle it. On the stdio surface there is no time limit; the wait ends when ' +
    'the human finishes or closes the window. successSignal is OPTIONAL (headed logins auto-detect ' +
    'completion, including single-page apps like iCloud, via the auth cookie). ' +
    "Credentials are looked up by credKeys name in the project's ./.env (or envFile), then the " +
    'user-scoped secrets.env, then process.env. Tokens are never echoed back. ' +
    'For a site fronted by Cloudflare/Turnstile or a similar human check, including one embedded in ' +
    'the login form (e.g. dash.cloudflare.com, chatgpt.com), use attach:true FROM THE START: the ' +
    'headed automation window is rejected by these checks. attach:true opens a real Chrome window ' +
    'and the session is harvested passively (no CDP driving during the solve). ' +
    'If your own call is cut short while the human is still logging in, the capture KEEPS GOING and ' +
    'still saves; poll session_status({name}) to see it finish instead of starting a second login. ' +
    'To capture a CLEARED BOT WALL with NO login at all, use session_solve_challenge instead. ' +
    'To freeze a flow as a deterministic test suite that reuses this session, call ' +
    'session_scaffold_tests.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A name for the saved session (file basename).' },
      loginUrl: { type: 'string', description: 'The login page URL.' },
      successSignal: {
        type: 'string',
        description:
          'OPTIONAL confirmation marker: a CSS/XPath selector, the visible text of a post-login ' +
          'element (e.g. "Sign out"), or a substring of the post-login URL. Omit in headed mode to ' +
          'auto-detect login by leaving the login page. Whatever form you give, all three ' +
          'interpretations are tried.',
      },
      headed: {
        type: 'boolean',
        description:
          'Open a visible browser for the human to log in. Use this for ANY login, not just 2FA/SSO. ' +
          'A SEPARATE automation window opens. Complete the login there, not in your normal browser.',
      },
      attach: {
        type: 'boolean',
        description:
          'Capture by attaching to a plain, human-solved real Chrome (connectOverCDP) instead of a ' +
          'Playwright-driven browser. Use for Cloudflare/Turnstile-gated sites whose challenge loops ' +
          'under automation. A real Chrome window opens; the human clears the challenge and logs in, ' +
          'then the authenticated session is read out passively. Ignores successSignal/credKeys.',
      },
      profile: {
        type: 'string',
        description:
          'attach-mode Chrome profile. "temp" (default) = fresh throwaway, fine for soft walls. ' +
          '"system" = copy the host\'s REAL Chrome profile\'s trust cookies (cf_clearance) into the ' +
          'driven profile, so an established browser\'s trust carries the capture past a HARD ' +
          'Cloudflare wall that hard-challenges a fresh profile (Chrome 136+ blocks the debug port on ' +
          'the default dir, hence the copy); the user must fully quit Chrome first and the export is ' +
          'auto-scoped to the login site\'s domain. Or an explicit user-data-dir path.',
      },
      timeoutMs: {
        type: 'number',
        description:
          'Optional timeout cap in ms. On the stdio surface, headed and attach modes wait indefinitely ' +
          'by default (the human takes as long as they need). On HTTP surfaces the default is 300000. ' +
          'Headless credKeys mode defaults to 30000 everywhere.',
      },
      credKeys: {
        type: 'object',
        description:
          'Dotenv key names for credentials, e.g. {user:"ACME_USER",pass:"ACME_PASS"} — resolved ' +
          "from the project's .env, then secrets.env, then process.env. Only these keys are read.",
        properties: { user: { type: 'string' }, pass: { type: 'string' } },
      },
      envFile: {
        type: 'string',
        description:
          'Path to the dotenv file holding the credKeys values. Default: ./.env in the working ' +
          'directory (the consuming project), falling back to the user-scoped secrets.env.',
      },
      selectors: {
        type: 'object',
        description: 'Optional field selectors {user,pass,submit} if the defaults do not match.',
        properties: { user: { type: 'string' }, pass: { type: 'string' }, submit: { type: 'string' } },
      },
    },
    required: ['name', 'loginUrl'],
  },
};

async function loginHandler(args: Record<string, unknown>, ctx?: ToolContext): Promise<CallToolResult> {
  const opts: LoginOptions = {
    name: String(args.name ?? ''),
    loginUrl: String(args.loginUrl ?? ''),
    successSignal: args.successSignal != null ? String(args.successSignal) : undefined,
    headed: Boolean(args.headed),
    attach: Boolean(args.attach),
    profile: args.profile != null ? (String(args.profile) as LoginOptions['profile']) : undefined,
    timeoutMs: args.timeoutMs != null ? Number(args.timeoutMs) : undefined,
    credKeys: args.credKeys as LoginOptions['credKeys'],
    envFile: args.envFile ? String(args.envFile) : undefined,
    selectors: args.selectors as LoginOptions['selectors'],
  };
  // Only the handler knows the SURFACE, so only the handler can grant an unbounded
  // wait; a missing ctx is an unknown surface, and an unknown surface is capped.
  const human = opts.headed === true || opts.attach === true;
  if (human) opts.wait = resolveHumanWait(opts.timeoutMs, ctx?.trust ?? 'local');
  return bindAndReport(await runCapture(opts, ctx, human));
}

/**
 * Run a capture with the two things a LONG human wait needs around it: a heartbeat
 * that keeps the client's idle timer from aborting the call, and a registry record
 * that makes the outcome recoverable even if the call is abandoned anyway.
 *
 * Shared by session_login and session_solve_challenge — the two tools that block on
 * a person — for the same reason bindAndReport is shared. It deliberately stops at
 * the LoginResult: binding stays the callers' single `return bindAndReport(...)`, so
 * there is still exactly one bind path and it is still visible in each handler.
 */
async function runCapture(
  opts: LoginOptions,
  ctx: ToolContext | undefined,
  human: boolean,
): Promise<LoginResult> {
  const mode = captureMode(opts);
  const rec = beginCapture(opts.name, mode);
  const stop = human ? startHeartbeat(ctx, `${mode} capture of "${opts.name}"`) : () => {};
  let result: LoginResult;
  try {
    // attach mode harvests a human-solved real Chrome (Cloudflare/Turnstile sites);
    // otherwise the standard Playwright-driven capture runs.
    result = opts.attach ? await sessionAttach(opts) : await sessionLogin(opts);
  } catch (err) {
    failCapture(rec); // never leave the record claiming a login is still under way
    throw err;
  } finally {
    stop();
  }
  endCapture(rec, result);
  return result;
}

/**
 * Point the browser_* tools at a capture that just succeeded, then report it.
 *
 * Shared by session_login AND session_solve_challenge on purpose: both write the
 * same kind of storageState artifact into the same store, so both must leave the
 * interactive tools able to USE it. A cleared bot wall that browser_* cannot see
 * is exactly as useless as a login they cannot see — and two copies of this
 * logic would be two chances for the modes to drift apart.
 *
 * A bind failure never masquerades as a capture failure: the artifact is on disk
 * either way, so `ok` still reflects the capture and the bind problem is
 * reported alongside it.
 *
 * It is also the provenance boundary, the same way frameFetchResult is for
 * web_fetch: the JSON envelope is what this server wrote, and a `capturedDetail`
 * is pulled OUT of it and emitted as a fenced block after it. Pulled out, not
 * copied — leaving it in the envelope would ship the page's text unmarked and
 * fenced, which is worse than either alone. On the success path there is no
 * detail and the result is a single JSON document exactly as before.
 */
async function bindAndReport(result: LoginResult): Promise<CallToolResult> {
  let boundTo: string | undefined;
  let bindError: string | undefined;
  if (result.ok) {
    try {
      await bindSession(result.name);
      boundTo = result.name;
    } catch (err) {
      bindError = err instanceof Error ? err.message : String(err);
    }
  }
  const { capturedDetail, capturedSource, ...envelope } = result;
  const text = JSON.stringify({ ...envelope, boundTo, bindError }, null, 2);
  return {
    content: [
      {
        type: 'text',
        text: capturedDetail
          ? `${text}\n${wrapUntrusted(capturedDetail, capturedSource ?? '')}`
          : text,
      },
    ],
    isError: !result.ok,
  };
}

const attachDefinition: Tool = {
  name: 'session_attach',
  description:
    'Point the browser_* tools at a login captured earlier (by name), so interactive browsing runs ' +
    'authenticated — the way to reuse a session in a LATER run without logging in again. ' +
    'session_login already does this for the session it captures; use this to switch between saved ' +
    'sessions, or to re-bind after a server restart. Pass name:null to drop back to the anonymous profile. ' +
    'Rebinding swaps the browser underneath any open page, so re-navigate afterwards.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: ['string', 'null'],
        description: 'Saved session name to bind, or null to unbind and browse anonymously.',
      },
    },
    required: ['name'],
  },
};

async function attachHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name == null ? null : String(args.name);
  try {
    const { session } = await bindSession(name);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              boundTo: session,
              note: session
                ? 'browser_* are now authenticated as this session; re-navigate to pick it up'
                : 'browser_* are now anonymous',
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

const statusDefinition: Tool = {
  name: 'session_status',
  description:
    'Ask what a saved session covers, before spending a login on access you may already have. ' +
    'OMIT probeUrl for an instant OFFLINE check of the stored artifact — no browser, no network: ' +
    'reports whether the named session exists ("present" / "missing"), which registrable domains and ' +
    'origins it carries identity for, and the earliest cookie expiry. Use it first when you are about ' +
    'to propose a headed session_login: if the domains already cover your target, just call ' +
    'web_fetch({url, session}) or session_attach({name}) instead. ' +
    'PASS probeUrl to additionally live-probe an authenticated route; that reports fresh / stale / ' +
    'missing / unreachable. "unreachable" means the probe itself failed (app down, network error) — ' +
    'the session may still be fine, so fix reachability instead of re-logging-in. ' +
    'It ALSO reports a capture this server is still running for that name, and whether it finished and ' +
    'saved: if a session_login call of yours was cut short while the human was mid-login, poll this ' +
    'instead of starting a second one. The login keeps going and still saves. ' +
    'Cookie values are never returned by either mode.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The saved session name.' },
      probeUrl: {
        type: 'string',
        description:
          'OPTIONAL. An authenticated route to live-probe. Omit it for the offline artifact check ' +
          '(exists / covered domains / earliest expiry) with no browser launch.',
      },
      loginIndicator: { type: 'string', description: 'A selector/URL substring that means "logged out".' },
    },
    required: ['name'],
  },
};

async function statusHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  // A blank or whitespace probeUrl is NOT a probe target — coerce it to absent
  // here so the offline branch is chosen, not a live probe that must fail.
  const probeUrl = typeof args.probeUrl === 'string' ? args.probeUrl.trim() : '';
  const result = await sessionStatus({
    name: String(args.name ?? ''),
    probeUrl: probeUrl || undefined,
    loginIndicator: args.loginIndicator ? String(args.loginIndicator) : undefined,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

// ── session_solve_challenge ───────────────────────────────────────────────────
// A separate FRONT DOOR over the same capture engine (sessionAttach) and the same
// wall predicate (wallUp). It exists because the two jobs read nothing alike to a
// caller — "log in" wants credentials and a success marker, "clear this wall" wants
// neither and would have to document them as ignored. The IMPLEMENTATION is shared
// on purpose: a second copy of the capture logic, or a second idea of what a wall
// is, is exactly the drift this split must not introduce.

const solveChallengeDefinition: Tool = {
  name: 'session_solve_challenge',
  description:
    'Get past a CAPTCHA / bot wall (Cloudflare, Turnstile, DataDome) by having the human solve it ' +
    'ONCE, then save the cleared session for reuse — the no-login counterpart to session_login. ' +
    'A real Chrome window opens on the walled page; the person solves the challenge and stays put; ' +
    'the cleared session is harvested passively (never CDP-driven during the solve, which is what ' +
    'makes a managed challenge loop forever) and written to a mode-600 storageState file. Reuse it ' +
    'with web_fetch({url, session}) to read a page that is otherwise unreachable. NOTE the artifact ' +
    'is SHORT-LIVED — a clearance cookie lasts minutes, not days; the result reports expiresAt, and ' +
    'session_status cannot detect this kind of expiry. If a fresh profile keeps getting hard-' +
    'challenged, retry with profile:"system" to ride your real browser\'s established trust.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A name for the saved session (file basename).' },
      url: { type: 'string', description: 'The walled page to open and clear.' },
      profile: {
        type: 'string',
        description:
          '"temp" (default) = fresh throwaway profile, fine for soft walls. "system" = copy the host\'s ' +
          "REAL Chrome profile's trust cookies (cf_clearance) into the driven profile so an established " +
          'browser\'s trust carries the capture past a HARD wall (the user must fully quit Chrome first; ' +
          'the export is auto-scoped to the site\'s domain). Or an explicit user-data-dir path.',
      },
      timeoutMs: {
        type: 'number',
        description:
          'Optional timeout cap in ms. On the stdio surface the default is no limit (the human takes ' +
          'as long as they need to clear the challenge). On HTTP surfaces the default is 300000.',
      },
    },
    required: ['name', 'url'],
  },
};

/**
 * Delegates to the SAME engine session_login's attach mode uses — only the
 * completion predicate differs, and that difference lives in sessionAttach. The
 * human wait, its heartbeat and its capture record come from the same runCapture,
 * so a CAPTCHA solve gets exactly the patience a login does.
 *
 * Same binding as a login: clearing a wall is only worth doing if the tools that hit
 * the wall can then get past it. Note the clearance is short-lived (see
 * clearanceSummary's expiresAt) — the bind lasts as long as the cookies do.
 */
async function solveChallengeHandler(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<CallToolResult> {
  const timeoutMs = args.timeoutMs != null ? Number(args.timeoutMs) : undefined;
  return bindAndReport(
    await runCapture(
      {
        name: String(args.name ?? ''),
        loginUrl: String(args.url ?? ''),
        challenge: true,
        attach: true,
        profile:
          args.profile != null ? (String(args.profile) as LoginOptions['profile']) : undefined,
        timeoutMs,
        // Always human-present: the whole point is a person clearing the wall by hand.
        wait: resolveHumanWait(timeoutMs, ctx?.trust ?? 'local'),
      },
      ctx,
      true,
    ),
  );
}

export const sessionLoginTool = { definition: loginDefinition, handler: loginHandler };
export const sessionStatusTool = { definition: statusDefinition, handler: statusHandler };
export const sessionSolveChallengeTool = { definition: solveChallengeDefinition, handler: solveChallengeHandler };
export const sessionAttachTool = { definition: attachDefinition, handler: attachHandler };
