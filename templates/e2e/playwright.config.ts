import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config — scaffolded by playwright-mcp's `scaffold:e2e` generator.
 *
 * It reuses a login captured ONCE by the playwright-mcp `session_login` tool
 * (cookies + localStorage saved to a mode-600 `storageState` file). The `setup`
 * project below only GUARDS that the saved session exists and looks fresh — it
 * never logs in. Capture (including headed 2FA/SSO, which a test runner cannot
 * do) stays with the `session_login` tool.
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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },
  projects: [
    // Runs first. Guards the captured session; does not authenticate.
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState },
      dependencies: ['setup'],
    },
  ],
});
