import fs from 'node:fs';
import { test as setup } from '@playwright/test';

import { SESSION_NAME, storageState } from '../playwright.config';

/**
 * Freshness GUARD — not a login.
 *
 * Every test project depends on this `setup` project, so it runs first and fails
 * the whole suite loudly if the captured session is missing, malformed, empty, or
 * (warned) old. Capture is owned by the playwright-mcp `session_login` tool; this
 * file deliberately holds no credentials and launches no browser. The true
 * freshness probe is the `session_status` tool — this is the cheap local check.
 */

const STALE_AFTER_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS ?? 7);

function recaptureHint(): string {
  return (
    `Capture or refresh it with the playwright-mcp tools, then re-run:\n` +
    `  session_login({ name: "${SESSION_NAME}", loginUrl: "<login URL>", ` +
    `successSignal: "<post-login selector or URL>", headed: true })  // headed:true for 2FA/SSO\n` +
    `  session_status({ name: "${SESSION_NAME}", probeUrl: "<an authenticated URL>" })  // confirm still valid\n` +
    `Or point STORAGE_STATE at a storageState file directly (e.g. a CI secret).`
  );
}

setup('captured session is present and fresh', async () => {
  if (!fs.existsSync(storageState)) {
    throw new Error(
      `No saved session at:\n  ${storageState}\n` +
        `This suite reuses a login captured once; it does not log in itself.\n${recaptureHint()}`,
    );
  }

  let parsed: { cookies?: unknown[]; origins?: unknown[] };
  try {
    parsed = JSON.parse(fs.readFileSync(storageState, 'utf8'));
  } catch (err) {
    throw new Error(
      `Saved session at ${storageState} is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}).\n${recaptureHint()}`,
    );
  }

  const cookieCount = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0;
  const originCount = Array.isArray(parsed.origins) ? parsed.origins.length : 0;
  if (cookieCount === 0 && originCount === 0) {
    throw new Error(
      `Saved session at ${storageState} has no cookies or localStorage — ` +
        `it is empty or logged out.\n${recaptureHint()}`,
    );
  }

  // A logged-out session causes confusing failures, not obvious ones — warn loudly
  // rather than fail, since age is a heuristic, not proof of expiry.
  const ageDays = (Date.now() - fs.statSync(storageState).mtimeMs) / 86_400_000;
  if (ageDays > STALE_AFTER_DAYS) {
    console.warn(
      `[auth.setup] session "${SESSION_NAME}" is ${ageDays.toFixed(1)} days old ` +
        `(> ${STALE_AFTER_DAYS}d). If tests fail as if logged out, refresh it with ` +
        `session_status / session_login.`,
    );
  }
});
