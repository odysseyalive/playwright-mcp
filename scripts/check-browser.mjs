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
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

import { BROWSER_CHANNEL, STEALTH_LAUNCH, glibcDir, legacyGlibc } from '../dist/stealth.js';
import { upstreamLaunch } from '../dist/upstream.js';

const which = BROWSER_CHANNEL
  ? 'Google Chrome'
  : 'bundled Chromium (no Google Chrome on this host; the hardest bot walls are more likely to challenge it)';

// Say so when this host is one whose browsers were patched onto a private glibc —
// on SUCCESS, not only in a failure branch. It changes what a failure below means,
// it is the one place the installer proves the library step's work is what the launch
// path actually picks up, and, per the security review of 2026-09-29, the person
// installing this must be told that their browser now renders untrusted pages with
// no sandbox. A posture that is only discoverable from the source is not stated.
if (legacyGlibc()) {
  const stamp = path.join(glibcDir(), '.el8-release');
  const release = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : '8';
  console.log(`Private glibc runtime in use: ${glibcDir()}`);
  console.log(
    `  This host's own C library is older than Chromium needs, so the browser runs against a\n` +
      `  frozen AlmaLinux ${release} userland from that directory, and WITHOUT Chromium's sandbox —\n` +
      `  it cannot start on this class of host. Pages you open are rendered unsandboxed.\n` +
      `  See "Older Linux hosts" in README.md.`,
  );
}

// Both launch shapes the server uses: web_fetch/session (STEALTH_LAUNCH) and
// browser_* (upstreamLaunch, which carries the sandbox decision).
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
  if (/relocation error|version `GLIBC_|GLIBCXX_/.test(msg))
    console.error(
      "That is a C-library version error: this host's own libraries are older than the browser needs. " +
        'The installer\'s library step builds a private runtime for exactly that case — re-run the ' +
        `installer, and if it already did, delete ${glibcDir()} so it is rebuilt from scratch.`,
    );
  if (/sandbox/i.test(msg))
    console.error(
      legacyGlibc()
        ? "Chromium's sandbox is already off on this host, because its browsers run on the private glibc " +
            `in ${glibcDir()} — so a sandbox error here is not the usual disabled-user-namespaces one.`
        : "browser_* runs Chromium's sandbox — it is off only as root, or on a host whose browsers were " +
            'patched onto a private glibc — and the sandbox needs unprivileged user namespaces; this ' +
            'host appears to have them disabled.',
    );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
