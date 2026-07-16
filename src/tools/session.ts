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

import fs from 'node:fs';

import { chromium, type Browser } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { sessionsDir, sessionFilePath, getSecret } from '../secrets.js';
import { STEALTH_LAUNCH, STEALTH_INIT, stealthContextOptions } from '../stealth.js';

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
  timeoutMs?: number; // how long to wait for login (default 300s headed / 30s headless)
  credKeys?: { user: string; pass: string }; // dotenv key names (project .env / secrets.env)
  envFile?: string; // explicit dotenv file for credKeys (default: ./.env in cwd, then secrets.env)
  selectors?: { user?: string; pass?: string; submit?: string };
}

export interface LoginResult {
  name: string;
  path: string;
  capturedAt: string;
  mode: 'headless' | 'headed';
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
      timeoutMs: {
        type: 'number',
        description:
          'How long to wait for the login to complete, in ms. Default 300000 (headed) / 30000 ' +
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
  const result = await sessionLogin({
    name: String(args.name ?? ''),
    loginUrl: String(args.loginUrl ?? ''),
    successSignal: args.successSignal != null ? String(args.successSignal) : undefined,
    headed: Boolean(args.headed),
    timeoutMs: args.timeoutMs != null ? Number(args.timeoutMs) : undefined,
    credKeys: args.credKeys as LoginOptions['credKeys'],
    envFile: args.envFile ? String(args.envFile) : undefined,
    selectors: args.selectors as LoginOptions['selectors'],
  });
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
