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

import type { BrowserContextOptions } from 'playwright';

/**
 * Real desktop UA matching the bundled Chromium MAJOR version, with the
 * `HeadlessChrome` token replaced by `Chrome`. Bundled Chromium is currently
 * major 149 (playwright 1.61.0-alpha; chrome-headless-shell 149.x).
 * MAINTENANCE: bump this major in lockstep with the pinned playwright upgrade.
 */
export const CHROME_MAJOR = 149;
export const STEALTH_UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

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
