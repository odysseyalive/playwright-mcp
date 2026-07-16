/**
 * session.ts — authenticated-session helpers: session_login + session_status.
 * Thin wrappers over Playwright's native storageState (capture-once, reuse-
 * everywhere). The MCP NEVER holds a live session through a test cycle; it emits
 * a portable mode-600 artifact that both interactive debugging (the wrapped
 * browser_* tools via contextOptions.storageState / userDataDir) and generated
 * Playwright suites (setup-project + dependencies) load.
 *
 * Spec: /session-method. Identity stays ISOLATED: the shared persistent
 * web_fetch scraping profile (src/browser.ts) never carries auth cookies. An
 * explicit authed read — web_fetch({ session }) — loads a captured storageState
 * into its OWN ephemeral context (separate cookie jar), so auth and the shared
 * scraping profile still never merge; only the stealth *disguise* (src/stealth.ts)
 * is shared. storageState files are secrets: mode 600, gitignored, never echoed
 * into tool output/logs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium, type Browser } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { sessionsDir, sessionFilePath, getSecret } from '../secrets.js';
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
  // substring of the *post-login* URL. Omit in headed mode to auto-detect
  // login by "moved past the login page" (see waitForLogin).
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
  timeoutMs?: number; // how long to wait for login (default 300s headed/attach / 30s headless)
  credKeys?: { user: string; pass: string }; // dotenv key names (project .env / secrets.env)
  envFile?: string; // explicit dotenv file for credKeys (default: ./.env in cwd, then secrets.env)
  selectors?: { user?: string; pass?: string; submit?: string };
}

export interface LoginResult {
  name: string;
  path: string;
  capturedAt: string;
  mode: 'headless' | 'headed' | 'attach';
  ok: boolean;
  error?: string;
}

const DEFAULT_SELECTORS = {
  user: 'input[type="email"], input[name="username"], input[name="email"], input[type="text"]',
  pass: 'input[type="password"]',
  submit: 'button[type="submit"], input[type="submit"], button',
};

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

    if (opts.headed) {
      // Human completes the challenge in the SEPARATE automation window this
      // launched (not their everyday browser). We auto-detect completion when
      // they move past the login page; an explicit successSignal, if given,
      // also resolves. Generous timeout for typing + 2FA.
      log(
        `headed login for "${opts.name}" — a SEPARATE automation window opened; complete the login in THAT window`,
      );
      await waitForLogin(page, opts.loginUrl, opts.successSignal, opts.timeoutMs ?? 300_000);
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
      await waitForLogin(page, opts.loginUrl, opts.successSignal, opts.timeoutMs ?? 30_000);
    }

    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    await context.storageState({ path: out });
    fs.chmodSync(out, 0o600); // secret: never world-readable
    log(`saved session "${opts.name}" → ${out} (mode 600)`);
    return { name: opts.name, path: out, capturedAt: new Date().toISOString(), mode, ok: true };
  } catch (err) {
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
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

/** Chrome writes its chosen port to <profile>/DevToolsActivePort once it is up. */
async function readDevtoolsPort(profile: string, timeout: number): Promise<number> {
  const f = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const port = parseInt(fs.readFileSync(f, 'utf8').split('\n')[0], 10);
      if (port > 0) return port;
    } catch {
      /* not written yet */
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

/** Poll the DevTools endpoint until a page target leaves the login page (challenge cleared + logged in). */
async function pollAttachedLogin(port: number, loginUrl: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let stableSince = 0;
  while (Date.now() < deadline) {
    let pages: Array<{ type?: string; url?: string; title?: string }> = [];
    try {
      pages = (await devtoolsJson(port, '/json/list')) as typeof pages;
    } catch {
      /* endpoint hiccup — keep waiting */
    }
    const done = pages.some(
      (p) =>
        p.type === 'page' &&
        typeof p.url === 'string' &&
        leftLoginPage(p.url, loginUrl) &&
        !/just a moment/i.test(p.title ?? ''),
    );
    if (done) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 2000) return;
    } else {
      stableSince = 0;
    }
    await sleep(1000);
  }
  throw new Error(
    'attach: login was not completed before the timeout — solve the Cloudflare check and finish logging in ' +
      'in the Chrome window that opened, then it captures automatically',
  );
}

const TEMP_PROFILE_MARK = 'pwmcp-attach-';

/** Resolve which Chrome profile the attach capture drives. */
function resolveAttachProfile(profile: LoginOptions['profile']): { dir: string; isTemp: boolean } {
  if (!profile || profile === 'temp')
    return { dir: fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PROFILE_MARK)), isTemp: true };
  if (profile === 'system') return { dir: defaultChromeUserDataDir(), isTemp: false };
  return { dir: profile, isTemp: false };
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

type StorageState = { cookies?: Array<{ domain?: string }>; origins?: Array<{ origin?: string }> };

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
    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
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
  const { dir: profileDir, isTemp } = resolveAttachProfile(opts.profile);
  const chromePath = resolveChromePath();
  let child: ReturnType<typeof spawn> | undefined;
  let cdp: Browser | undefined;
  try {
    if (!isTemp && profileInUse(profileDir))
      throw new Error(
        `attach: Chrome is already running on ${profileDir} — fully quit Chrome first so this can drive that ` +
          'profile (needed to ride its established trust past a hard bot wall), then retry',
      );

    const args = [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0', // 0 = free port, reported via DevToolsActivePort
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      opts.loginUrl,
    ];
    child = spawn(chromePath, args, { stdio: 'ignore', detached: true }); // own process group → clean tree-kill
    child.on('error', (e) => log(`attach: chrome spawn error: ${e.message}`));
    if (child.pid && isTemp) registerAttachRecord(child.pid, profileDir);
    log(
      `attach login for "${opts.name}" — a real Chrome window opened (${isTemp ? 'temp profile' : profileDir}); ` +
        'solve the challenge and log in there',
    );

    const port = await readDevtoolsPort(profileDir, 20_000);
    await pollAttachedLogin(port, opts.loginUrl, opts.timeoutMs ?? 300_000);

    // Challenge cleared + logged in. Attach passively and read the session out.
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = cdp.contexts()[0];
    if (!ctx) throw new Error('attach: no browser context to export');
    let state = (await ctx.storageState()) as StorageState;
    // A real/shared profile carries the user's whole cookie jar — persist ONLY the
    // login site's cookies. A throwaway temp profile only ever holds the target site.
    if (!isTemp) state = scopeStorageState(state, siteDomain(opts.loginUrl));
    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, JSON.stringify(state));
    fs.chmodSync(out, 0o600);
    log(
      `saved session "${opts.name}" → ${out} (mode 600, attach${isTemp ? '' : ', domain-scoped'}, ` +
        `${state.cookies?.length ?? 0} cookies)`,
    );
    return { name: opts.name, path: out, capturedAt: new Date().toISOString(), mode: 'attach', ok: true };
  } catch (err) {
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode: 'attach',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await cdp?.close().catch(() => {}); // detaches the CDP client — does not close the browser
    if (child?.pid) {
      killGroup(child.pid); // kill the Chrome WE spawned (its own process group), whatever profile
      unregisterAttachRecord(child.pid);
    }
    if (isTemp) fs.rmSync(profileDir, { recursive: true, force: true }); // NEVER delete a real profile
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
async function waitPastLogin(page: PwPage, loginUrl: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const url = page.url();
    const movedOff = !samePath(url, loginUrl);
    const noPassword = !(await hasPasswordField(page).catch(() => false));
    if (movedOff && noPassword) {
      if (!stableSince) stableSince = Date.now();
      else if (Date.now() - stableSince >= 1500) return;
    } else {
      stableSince = 0;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
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
  timeout: number,
): Promise<void> {
  const arms: Promise<unknown>[] = [waitPastLogin(page, loginUrl, timeout)];
  const sig = signal?.trim();
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
        .waitForURL((u) => u.toString().includes(sig) && !samePath(u.toString(), loginUrl), { timeout })
        .then(() => {}),
    );
  }
  try {
    await Promise.any(arms);
  } catch {
    throw new Error(await loginDiagnostic(page, loginUrl, sig, timeout));
  }
}

/** Build an actionable timeout message instead of "All promises were rejected". */
async function loginDiagnostic(
  page: PwPage,
  loginUrl: string,
  signal: string | undefined,
  timeoutMs: number,
): Promise<string> {
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
  const parts = [
    `login capture timed out after ${Math.round(timeoutMs / 1000)}s`,
    `final URL: ${url || 'unknown'}${title ? ` (“${title}”)` : ''}`,
  ];
  if (pw || samePath(url, loginUrl)) {
    parts.push(
      'the page still shows a login form — a SEPARATE automation window was opened for this capture; ' +
        'complete the login in THAT window (not your everyday browser), then it saves automatically',
    );
  }
  if (signal) {
    parts.push(
      `the success marker ${JSON.stringify(signal)} never matched as a selector, visible text, or a ` +
        'changed-URL substring — verify it against the post-login page, or omit it in headed mode to auto-detect',
    );
  }
  return parts.join('; ') + '.';
}

// ── session_status ────────────────────────────────────────────────────────────

export interface StatusOptions {
  name: string;
  probeUrl: string;
  loginIndicator?: string; // selector/URL substring meaning "logged out"
}

export interface StatusResult {
  name: string;
  state: 'fresh' | 'stale' | 'missing' | 'unreachable';
  checkedAt: string;
}

export async function sessionStatus(opts: StatusOptions): Promise<StatusResult> {
  const file = sessionFilePath(opts.name);
  const checkedAt = new Date().toISOString();
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
      await page.goto(opts.probeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        fs.chmodSync(file, 0o600);
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
    'for reuse in debugging and generated Playwright tests. Use headed:true for 2FA/SSO — this opens ' +
    'a SEPARATE automation window; the human must complete the login in THAT window (not their ' +
    'everyday browser), and it saves automatically once past the login page. successSignal is ' +
    'OPTIONAL (headed logins auto-detect completion). ' +
    "Credentials are looked up by credKeys name in the project's ./.env (or envFile), then the " +
    'user-scoped secrets.env, then process.env — never embedded; tokens are never echoed back. ' +
    'For a site behind a Cloudflare/Turnstile "Just a moment…" challenge that loops forever under ' +
    'automation, set attach:true — a real Chrome window opens, the human clears the challenge and ' +
    'logs in, and the session is harvested passively (no CDP driving during the solve). ' +
    'To freeze a flow as a deterministic test suite that reuses this session, call the ' +
    'session_scaffold_tests tool.',
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
          'Open a visible browser for 2FA/SSO/hardware keys. Default false. A SEPARATE automation ' +
          'window opens — complete the login there, not in your normal browser.',
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
          '"system" = the host\'s REAL Chrome profile, so an established browser\'s trust ' +
          '(cf_clearance, history) carries the capture past a HARD Cloudflare wall that ' +
          'hard-challenges a fresh profile; the user must fully quit Chrome first and the export is ' +
          'auto-scoped to the login site\'s domain. Or an explicit user-data-dir path.',
      },
      timeoutMs: {
        type: 'number',
        description:
          'How long to wait for the login to complete, in ms. Default 300000 (headed/attach) / 30000 ' +
          '(headless credKeys).',
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

async function loginHandler(args: Record<string, unknown>): Promise<CallToolResult> {
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
  // attach mode harvests a human-solved real Chrome (Cloudflare/Turnstile sites);
  // otherwise the standard Playwright-driven capture runs.
  const result = opts.attach ? await sessionAttach(opts) : await sessionLogin(opts);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.ok };
}

const statusDefinition: Tool = {
  name: 'session_status',
  description:
    'Check whether a saved session is still valid before reusing it; reports fresh / stale / ' +
    'missing / unreachable. "unreachable" means the probe itself failed (app down, network error) — ' +
    'the session may still be fine, so fix reachability instead of re-logging-in.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The saved session name.' },
      probeUrl: { type: 'string', description: 'An authenticated route to probe.' },
      loginIndicator: { type: 'string', description: 'A selector/URL substring that means "logged out".' },
    },
    required: ['name', 'probeUrl'],
  },
};

async function statusHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await sessionStatus({
    name: String(args.name ?? ''),
    probeUrl: String(args.probeUrl ?? ''),
    loginIndicator: args.loginIndicator ? String(args.loginIndicator) : undefined,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export const sessionLoginTool = { definition: loginDefinition, handler: loginHandler };
export const sessionStatusTool = { definition: statusDefinition, handler: statusHandler };
