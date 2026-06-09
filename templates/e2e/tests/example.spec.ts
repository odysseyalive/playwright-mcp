import { test, expect } from '@playwright/test';

/**
 * Example authenticated spec.
 *
 * Because the `chromium` project depends on `setup` and loads the captured
 * storageState, this test's browser context starts ALREADY LOGGED IN — no login
 * code here.
 *
 * This is the "freeze the flow" half of the playwright-mcp model: an agent drives
 * the browser_* tools to DISCOVER a flow interactively, then you encode the
 * known-good path here as deterministic, runner-executed assertions that
 * `npx playwright test` replays with no model in the loop.
 *
 * Replace the body with your real flow.
 */
test('authenticated page loads', async ({ page }) => {
  await page.goto('/');

  // Replace with an assertion that only holds when logged in, e.g.:
  //   await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page).toHaveTitle(/.+/);
});
