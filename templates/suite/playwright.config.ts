import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E-SUITE config — scaffolded by playwright-mcp's `suite_scaffold`.
 *
 * Superset of the basic `session_scaffold_tests` template: same captured-session
 * reuse (setup project GUARDS the session, never logs in), plus the suite
 * methodology pack — environment guard (global setup/teardown driven by
 * e2e-suite.config.json), page-integrity gate, and report-only error capture
 * (wired in tests/fixture.ts).
 *
 * storageState resolution below mirrors playwright-mcp's `src/secrets.ts`
 * `sessionsDir()` precedence. If that precedence ever changes, change it here
 * too — these two copies must stay in lockstep (a generated config cannot import
 * the MCP server's internals).
 */

/** Mirror of playwright-mcp src/secrets.ts sessionsDir() — keep byte-compatible. */
function sessionsDir(): string {
  if (process.env.PLAYWRIGHT_MCP_SESSIONS) return process.env.PLAYWRIGHT_MCP_SESSIONS;
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'playwright-mcp', 'sessions');
}

/** Session name baked at scaffold time; override per-run with PLAYWRIGHT_MCP_SESSION_NAME. */
export const SESSION_NAME = process.env.PLAYWRIGHT_MCP_SESSION_NAME ?? '__SESSION_NAME__';

/**
 * Where the authenticated storageState comes from:
 *   - CI: set STORAGE_STATE to a file the job materialized from a masked secret.
 *   - Local: the user-scoped artifact `session_login` wrote, resolved portably
 *     (no hard-coded home path).
 */
export const storageState =
  process.env.STORAGE_STATE ?? path.join(sessionsDir(), `${SESSION_NAME}.json`);

/** Base URL of the app under test (local dev server or a deployed environment). */
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  // Serial by default: suites that reconcile against a shared backend (DB rows,
  // order counters) misattribute state under parallelism. Raise deliberately.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  reporter: [
    ['list'],
    // Stable JSON path so `suite_audit` can parse the last run without re-running.
    ['json', { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT || './test-results/last-run.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    // Runs first. Guards the captured session; does not authenticate.
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts/,
      // NOTE: no project-level storageState. Specs OPT IN per file with
      //   test.use({ storageState })   (import { storageState } from '../playwright.config')
      // Session-mutating specs (carts, checkouts, login flows, negative-auth)
      // must stay on fresh per-test sessions — see tests/helpers/session-state.ts.
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
});
