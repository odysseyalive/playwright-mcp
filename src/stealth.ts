/**
 * stealth.ts — the anti-detection DISGUISE primitives, shared by every context
 * that must pass as a real person: the web_fetch scraping context (browser.ts)
 * and the authenticated-capture/probe contexts (tools/session.ts).
 *
 * Isolation note: sharing these primitives is NOT "merging" the contexts. The
 * DEC-2026-06-07-authenticated-session-storagestate-artifact isolation rule is
 * about IDENTITY — separate BrowserContext, profile, and cookie jar so authed
 * cookies never ride along with scraping and the scraping profile's fingerprint
 * never bleeds into an authed capture. The disguise *technique* (UA, launch
 * args, webdriver erasure, locale/viewport) is anti-bot hardening, not an
 * identity; every context is entitled to it. web_fetch keeps its own persistent
 * profile; session.ts uses ephemeral contexts — they never share a cookie jar.
 *
 * Stealth is manual only — NO playwright-extra/stealth plugin (it wraps
 * Playwright and is a dedupe/compat hazard against the exact-pinned playwright
 * version). WebGL/canvas spoofing is escalation-only and intentionally absent.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import type { BrowserContextOptions } from 'playwright';

/**
 * Resolve the host's REAL Google Chrome executable — the same binary
 * STEALTH_LAUNCH starts (`channel:'chrome'`) and the attach-mode capture spawns.
 * Override with PLAYWRIGHT_MCP_CHROME_PATH. Shared so the UA below and
 * tools/session.ts resolve Chrome identically.
 */
export function resolveChromePath(): string {
  const env = process.env.PLAYWRIGHT_MCP_CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/opt/google/chrome/chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'chrome.exe' : 'google-chrome-stable';
}

/**
 * The host's default Google Chrome user-data-dir — the REAL profile a person
 * browses with. attach-mode capture can ride this profile so an established
 * browser's earned trust (e.g. a Cloudflare `cf_clearance` cookie, real history)
 * carries the capture past a hard bot wall that hard-challenges a fresh profile.
 * Override with PLAYWRIGHT_MCP_CHROME_USER_DATA_DIR.
 */
export function defaultChromeUserDataDir(): string {
  const env = process.env.PLAYWRIGHT_MCP_CHROME_USER_DATA_DIR;
  if (env) return env;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') return `${home}/Library/Application Support/Google/Chrome`;
  if (process.platform === 'win32')
    return `${process.env.LOCALAPPDATA || `${home}\\AppData\\Local`}\\Google\\Chrome\\User Data`;
  return `${home}/.config/google-chrome`;
}

/** OS platform token the real Chrome reports in its UA, keyed off this host. */
const PLATFORM_TOKEN =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';

/**
 * Detect the host's installed Chrome MAJOR at startup so the UA can never drift
 * out of lockstep with the browser we actually launch. Chrome's own reduced UA
 * is `<major>.0.0.0`, so the major is all we need for a self-consistent string.
 * A UA that lies about the version (vs `navigator.userAgentData` Client Hints)
 * is a Cloudflare/Turnstile tell — this reads the truth instead of hardcoding it.
 * Runs once at module load (~1 subprocess); falls back to a recent major if the
 * binary can't be queried. NOTE: attach-mode capture uses the plain real Chrome's
 * NATIVE UA and never touches this — this only masks the Playwright-driven path.
 */
function detectChromeMajor(): number {
  const FALLBACK = 150;
  try {
    const out = execFileSync(resolveChromePath(), ['--version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = out.match(/\b(\d+)\.\d+\.\d+/);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* Chrome not queryable — use the fallback below */
  }
  return FALLBACK;
}

export const CHROME_MAJOR = detectChromeMajor();
export const STEALTH_UA = `Mozilla/5.0 (${PLATFORM_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

export const LOCALE = 'en-US';
export const TIMEZONE = 'America/New_York';
export const VIEWPORT = { width: 1366, height: 768 };

/** Launch args that strip the automation tell. Reused by every launch. */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];

/**
 * Launch options for a stealth browser: the REAL installed Google Chrome
 * (`channel:'chrome'`) plus the automation-tell strip. Bundled Chromium is a
 * distinct fingerprint that aggressive bot walls (DataDome, PerimeterX) flag on
 * sight, and a session captured under one engine is re-challenged when replayed
 * under another — so capture (session_login), probe (session_status), and authed
 * read (web_fetch) all launch the same Chrome the shared scraping context uses.
 * Requires Google Chrome installed on the host. Spread into chromium.launch().
 */
export const STEALTH_LAUNCH = { channel: 'chrome', args: STEALTH_ARGS };

/** addInitScript payload: erase the headless tells before any page script runs. */
export const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'Plugin ' + i })),
  });
  window.chrome = window.chrome || { runtime: {} };
`;

/**
 * Context options that make a headless context look like a real desktop browser.
 * Spread into newContext()/launchPersistentContext(); merge caller-specific keys
 * (storageState, ignoreHTTPSErrors) alongside.
 */
export const stealthContextOptions: BrowserContextOptions = {
  userAgent: STEALTH_UA,
  locale: LOCALE,
  timezoneId: TIMEZONE,
  viewport: VIEWPORT,
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};
