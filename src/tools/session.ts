/**
 * session.ts — authenticated-session helpers: session_login + session_status.
 * Thin wrappers over Playwright's native storageState (capture-once, reuse-
 * everywhere). The MCP NEVER holds a live session through a test cycle; it emits
 * a portable mode-600 artifact that both interactive debugging (the wrapped
 * browser_* tools via contextOptions.storageState / userDataDir) and generated
 * Playwright suites (setup-project + dependencies) load.
 *
 * Spec: /session-method. The auth context is ISOLATED from the stealth
 * web_search/web_fetch context (src/browser.ts) — they never merge. storageState
 * files are secrets: mode 600, gitignored, never echoed into tool output/logs.
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium, type Browser } from 'playwright';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { sessionsDir, getSecret } from '../secrets.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:session]', ...args);

function sessionPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(sessionsDir(), `${safe}.json`);
}

// ── session_login ─────────────────────────────────────────────────────────────

export interface LoginOptions {
  name: string;
  loginUrl: string;
  successSignal: string; // selector or substring of the post-login URL
  headed?: boolean; // required for 2FA / SSO / hardware keys
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
  const out = sessionPath(opts.name);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(opts.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (opts.headed) {
      // Human completes the challenge; wait (generously) for the success signal.
      log(`headed login for "${opts.name}" — complete the challenge in the browser window`);
      await waitForSuccess(page, opts.successSignal, 300_000);
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
      await waitForSuccess(page, opts.successSignal, 30_000);
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

async function waitForSuccess(
  page: import('playwright').Page,
  signal: string,
  timeout: number,
): Promise<void> {
  // signal is a selector OR a URL substring — race both interpretations.
  await Promise.any([
    page.waitForSelector(signal, { timeout }),
    page.waitForURL((u) => u.toString().includes(signal), { timeout }),
  ]);
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
  const file = sessionPath(opts.name);
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
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: file, ignoreHTTPSErrors: true });
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
    'for reuse in debugging and generated Playwright tests. Use headed:true for 2FA/SSO. ' +
    "Credentials are looked up by credKeys name in the project's ./.env (or envFile), then the " +
    'user-scoped secrets.env, then process.env — never embedded; tokens are never echoed back. ' +
    'To freeze a flow as a deterministic test suite that reuses this session, call the ' +
    'session_scaffold_tests tool.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A name for the saved session (file basename).' },
      loginUrl: { type: 'string', description: 'The login page URL.' },
      successSignal: { type: 'string', description: 'A post-login selector or URL substring that confirms success.' },
      headed: { type: 'boolean', description: 'Open a visible browser for 2FA/SSO/hardware keys. Default false.' },
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
    required: ['name', 'loginUrl', 'successSignal'],
  },
};

async function loginHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await sessionLogin({
    name: String(args.name ?? ''),
    loginUrl: String(args.loginUrl ?? ''),
    successSignal: String(args.successSignal ?? ''),
    headed: Boolean(args.headed),
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
