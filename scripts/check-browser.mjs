#!/usr/bin/env node
// Installer step: prove the browser the server will launch actually launches.
//
// Measured 2026-09-26: on two no-sudo hosting accounts with no Google Chrome,
// install.sh downloaded Chromium, printed "Done", and every browser tool then
// failed on its first launch. Downloading a browser is not the same as having one
// that runs, so the installers finish only after this launch succeeds.
//
// Launches exactly what web_fetch, session_login, and browser_* launch (from the
// built dist/): the real Google Chrome when the host has it, else the bundled
// Chromium. Headless, one blank page, then closed. Exits
// non-zero with the real error, so the installer stops loudly instead.
import { chromium } from 'playwright';

import { BROWSER_CHANNEL, STEALTH_LAUNCH } from '../dist/stealth.js';
import { upstreamLaunch } from '../dist/upstream.js';

const which = BROWSER_CHANNEL
  ? 'Google Chrome'
  : 'bundled Chromium (no Google Chrome on this host; the hardest bot walls are more likely to challenge it)';

// Both launch shapes the server uses: web_fetch/session (STEALTH_LAUNCH) and
// browser_* (upstreamLaunch, which also turns on Chromium's sandbox).
let browser;
let version;
try {
  for (const opts of [{ headless: true, ...STEALTH_LAUNCH }, upstreamLaunch().launchOptions]) {
    browser = await chromium.launch({ ...opts, timeout: 60_000 });
    const page = await browser.newPage();
    await page.goto('about:blank');
    version = browser.version();
    await browser.close();
  }
  console.log(`Browser OK: ${which}, version ${version}.`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`The browser failed to launch: ${which}.\n${msg}`);
  if (/shared object file|missing dependencies/i.test(msg))
    console.error(
      'Its system libraries are missing. On Linux, re-run the installer: its library step fetches ' +
        'them into ~/.cache/playwright-mcp/sysroot without root, or names the ones it could not.',
    );
  if (/sandbox/i.test(msg))
    console.error(
      "browser_* runs Chromium's sandbox (except as root), which needs unprivileged user namespaces; " +
        'this host appears to have them disabled.',
    );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
