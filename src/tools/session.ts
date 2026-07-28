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
  // Capture a CLEARED BOT WALL rather than a login: the human solves the CAPTCHA
  // and nothing else, so the page never leaves `loginUrl` and the login-shaped
  // "moved past the login page" predicate can never fire. Completion is instead
  // "the challenge markers are gone on the SAME url". Implies attach (a wall that
  // needs a human is exactly the wall that rejects a driven browser).
  challenge?: boolean;
  timeoutMs?: number; // how long to wait for login (default 300s headed/attach / 30s headless)
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
  error?: string;
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

    if (opts.headed) {
      // Human completes the challenge in the SEPARATE automation window this
      // launched (not their everyday browser). We auto-detect completion when
      // they move past the login page; an explicit successSignal, if given,
      // also resolves. Generous timeout for typing + 2FA.
      log(
        `headed login for "${opts.name}" — a SEPARATE automation window opened; complete the login in THAT window`,
      );
      await waitForLogin(page, loginUrl, opts.successSignal, opts.timeoutMs ?? 300_000);
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
      await waitForLogin(page, loginUrl, opts.successSignal, opts.timeoutMs ?? 30_000);
    }

    // The wait heuristics can resolve while the human is still mid-login (see
    // newCookies). Writing an anonymous storageState and reporting ok:true is the
    // worst outcome: every later web_fetch({session}) silently reads as a logged-out
    // visitor. Require evidence — no new cookies means no login happened.
    const after = (await context.storageState()) as StorageState;
    const gained = newCookies(before, after);
    if (!gained.length) {
      throw new Error(
        `no session was captured — the browser gained no new cookies, so the login did not complete ` +
          `(final URL: ${page.url()}). Nothing was saved. ` +
          `If the site uses a multi-step login (email first, password/2FA after), pass a successSignal ` +
          `naming something only visible AFTER login — e.g. a post-login URL fragment or on-page text.`,
      );
    }

    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    await context.storageState({ path: out });
    fs.chmodSync(out, 0o600); // secret: never world-readable
    const hosts = [...new Set(gained.map((c) => (c.domain ?? '').replace(/^\./, '')))].filter(Boolean);
    log(`saved session "${opts.name}" → ${out} (mode 600; ${gained.length} new cookies on ${hosts.join(', ')})`);
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
 * Poll the DevTools endpoint until `isDone` holds for one of the open page targets,
 * stable for 2s (a challenge clear flickers through intermediate states before the
 * real document settles). Passive by construction: HTTP reads of /json/list only,
 * never a CDP attach, so nothing drives the page while the human works.
 */
async function pollAttached(
  port: number,
  isDone: (page: { url: string; title: string }) => boolean,
  timeout: number,
  timeoutMessage: string,
): Promise<void> {
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
      (p) => p.type === 'page' && typeof p.url === 'string' && isDone({ url: p.url, title: p.title ?? '' }),
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

/** Wait for the human to clear the wall AND finish logging in (page leaves the login url). */
const pollAttachedLogin = (port: number, loginUrl: string, timeout: number): Promise<void> =>
  pollAttached(
    port,
    (p) => leftLoginPage(p.url, loginUrl) && !wallUp(p.url, p.title),
    timeout,
    'attach: login was not completed before the timeout — solve the Cloudflare check and finish logging in ' +
      'in the Chrome window that opened, then it captures automatically',
  );

/** Wait for the human to clear the wall only — no login expected, same url throughout. */
const pollAttachedChallenge = (port: number, url: string, timeout: number): Promise<void> =>
  pollAttached(
    port,
    (p) => challengeCleared(p.url, url, p.title),
    timeout,
    'attach: the challenge was not cleared before the timeout — solve the CAPTCHA in the Chrome window ' +
      'that opened and stay on the page; it captures automatically once the real content loads',
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

    const args = [
      `--user-data-dir=${prof.dir}`,
      '--remote-debugging-port=0', // 0 = free port, reported via DevToolsActivePort
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      opts.loginUrl,
    ];
    child = spawn(chromePath, args, { stdio: 'ignore', detached: true }); // own process group → clean tree-kill
    child.on('error', (e) => log(`attach: chrome spawn error: ${e.message}`));
    if (child.pid && prof.cleanup) registerAttachRecord(child.pid, prof.dir); // temp/copy dirs are reap-eligible
    log(
      opts.challenge
        ? `attach challenge for "${opts.name}" — a real Chrome window opened; solve the CAPTCHA there and stay on the page`
        : `attach login for "${opts.name}" — a real Chrome window opened; solve the challenge and log in there`,
    );

    const port = await readDevtoolsPort(prof.dir, 20_000);
    const waitMs = opts.timeoutMs ?? 300_000;
    if (opts.challenge) await pollAttachedChallenge(port, opts.loginUrl, waitMs);
    else await pollAttachedLogin(port, opts.loginUrl, waitMs);

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

    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, JSON.stringify(state));
    fs.chmodSync(out, 0o600);
    const kind = opts.challenge ? 'challenge' : 'attach';
    log(
      `saved session "${opts.name}" → ${out} (mode 600, ${kind}${prof.scope ? ', domain-scoped' : ''}, ` +
        `${state.cookies?.length ?? 0} cookies)`,
    );
    // Only challenge captures get clearance telemetry — for a login the meaningful
    // lifetime is the auth cookie's, which session_status already probes for.
    const clearance = opts.challenge ? clearanceSummary(state) : {};
    if (clearance.warning) log(`warning: ${clearance.warning}`);
    return {
      name: opts.name,
      path: out,
      capturedAt: new Date().toISOString(),
      mode: opts.challenge ? 'challenge' : 'attach',
      ok: true,
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
  const sig = signal?.trim();
  // The generic heuristic is a FALLBACK, not a co-equal racer. Multi-step logins
  // walk through several pages that all satisfy it — DocuSign goes
  // /oauth/auth → /username for email entry: new path, no password field, so
  // waitPastLogin() calls it done while the human is still on step one. Under
  // Promise.any the loosest signal always wins, which silently defeats the very
  // marker the caller supplied to prevent that. When the caller has said what
  // success looks like, only that counts; a marker that never matches must
  // surface as a diagnostic timeout, not as a wrong success.
  const arms: Promise<unknown>[] = sig ? [] : [waitPastLogin(page, loginUrl, timeout)];
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
    'To capture a CLEARED BOT WALL with NO login at all (the human just solves the CAPTCHA), use the ' +
    'session_solve_challenge tool instead. ' +
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
          '"system" = copy the host\'s REAL Chrome profile\'s trust cookies (cf_clearance) into the ' +
          'driven profile, so an established browser\'s trust carries the capture past a HARD ' +
          'Cloudflare wall that hard-challenges a fresh profile (Chrome 136+ blocks the debug port on ' +
          'the default dir, hence the copy); the user must fully quit Chrome first and the export is ' +
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
        description: 'How long to wait for the human to clear the challenge, in ms. Default 300000.',
      },
    },
    required: ['name', 'url'],
  },
};

async function solveChallengeHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  // Delegates to the SAME engine session_login's attach mode uses — only the
  // completion predicate differs, and that difference lives in sessionAttach.
  const result = await sessionAttach({
    name: String(args.name ?? ''),
    loginUrl: String(args.url ?? ''),
    challenge: true,
    attach: true,
    profile: args.profile != null ? (String(args.profile) as LoginOptions['profile']) : undefined,
    timeoutMs: args.timeoutMs != null ? Number(args.timeoutMs) : undefined,
  });
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.ok };
}

export const sessionLoginTool = { definition: loginDefinition, handler: loginHandler };
export const sessionStatusTool = { definition: statusDefinition, handler: statusHandler };
export const sessionSolveChallengeTool = { definition: solveChallengeDefinition, handler: solveChallengeHandler };
