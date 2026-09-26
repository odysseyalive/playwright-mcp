#!/usr/bin/env node
// Installer step: prove the browser the server will launch actually launches.
//
// Measured 2026-09-26: on two no-sudo hosting accounts with no Google Chrome,
// install.sh downloaded Chromium, printed "Done", and every browser tool then
// failed on its first launch. Downloading a browser is not the same as having one
// that runs, so the installers finish only after this launch succeeds.
//
// Launches exactly what web_fetch, session_login, and browser_* launch
// (STEALTH_LAUNCH from the built dist/): the real Google Chrome when the host has
// it, else the bundled Chromium. Headless, one blank page, then closed. Exits
// non-zero with the real error, so the installer stops loudly instead.
import { chromium } from 'playwright';

import { BROWSER_CHANNEL, STEALTH_LAUNCH } from '../dist/stealth.js';

const which = BROWSER_CHANNEL
  ? 'Google Chrome'
  : 'bundled Chromium (no Google Chrome on this host; the hardest bot walls are more likely to challenge it)';

let browser;
try {
  browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH, timeout: 60_000 });
  const page = await browser.newPage();
  await page.goto('about:blank');
  console.log(`Browser OK: ${which}, version ${browser.version()}.`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`The browser failed to launch: ${which}.\n${msg}`);
  if (/shared object file|missing dependencies/i.test(msg))
    console.error(
      'Its system libraries are missing. Install them with `npx playwright install-deps chromium` ' +
        '(needs root), or run the server in the official Playwright Docker image.',
    );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
