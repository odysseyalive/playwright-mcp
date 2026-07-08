/**
 * browser.ts — the shared STEALTH Chromium context for web_fetch.
 *
 * Separate from the wrapped @playwright/mcp browser (that one drives debugging;
 * this one is disguised to pass as a real person while fetching/rendering pages).
 * One persistent lifecycle — launch once, reuse.
 *
 * Stealth layer is manual only — NO playwright-extra/stealth plugin (it wraps
 * Playwright and is a dedupe/compat hazard against the exact-pinned playwright
 * version). WebGL/canvas spoofing is escalation-only and intentionally absent.
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContext } from 'playwright';

import { CHROME_MAJOR, STEALTH_ARGS, STEALTH_INIT, stealthContextOptions } from './stealth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:browser]', ...args);

function profileDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(base, 'playwright-mcp', 'profile');
}

let ctxPromise: Promise<BrowserContext> | undefined;

/**
 * Lazily launch (once) and return the shared stealth context. Persistent profile
 * so cookies + reputation accumulate across runs. Subsequent calls reuse it.
 */
export function getStealthContext(): Promise<BrowserContext> {
  if (!ctxPromise) ctxPromise = launch();
  return ctxPromise;
}

async function launch(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(profileDir(), {
    channel: 'chrome',
    headless: true,
    args: STEALTH_ARGS,
    ...stealthContextOptions,
  });
  await context.addInitScript(STEALTH_INIT);
  await seedConsent(context);
  log(`stealth context up (chrome/${CHROME_MAJOR}, profile=${profileDir()})`);
  return context;
}

/** Pre-seed engine consent cookies so the SERP renders instead of a wall. */
async function seedConsent(context: BrowserContext): Promise<void> {
  try {
    await context.addCookies([
      { name: 'SOCS', value: 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg', domain: '.google.com', path: '/' },
      { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
    ]);
  } catch (err) {
    log('consent seed skipped:', err instanceof Error ? err.message : err);
  }
}

/**
 * Jittered pacing delay — never fire scrapes in a tight synchronous burst.
 * Deterministic jitter from a seed so a parity run is reproducible; defaults to
 * a fixed mid-range delay (Math.random is unavailable in some sandboxes).
 */
export function paceMs(base = 350, jitterSeed = 0.5): number {
  const clamped = Math.max(0, Math.min(1, jitterSeed));
  return Math.round(base + clamped * base);
}

export function pace(base = 350, jitterSeed = 0.5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, paceMs(base, jitterSeed)));
}

/** Close the shared context (server shutdown / tests). */
export async function closeBrowser(): Promise<void> {
  if (!ctxPromise) return;
  const ctx = await ctxPromise;
  ctxPromise = undefined;
  await ctx.close();
}
