import { storageState } from './helpers/session-state';
import { test, expect } from './fixture';

/**
 * Example spec — replace with real tests. Demonstrates the two suite rules
 * every new spec must decide on:
 *
 * 1. SESSION: this file opts IN to the shared captured session because it is
 *    read-only dashboard-style work. Delete the test.use line for anything
 *    that mutates session state (carts, checkouts, login flows, negative-auth)
 *    — see helpers/session-state.ts for the full rules.
 *
 * 2. INTEGRITY: the page-integrity gate is on by default ('enforce' in
 *    e2e-suite.config.json). A page with rendered server errors, leaked
 *    template tokens, or "undefined" text FAILS even if your assertions pass.
 */

test.use({ storageState });

test('authenticated area renders', async ({ page }) => {
  await page.goto('/');
  // Replace with an assertion that proves YOUR app rendered authenticated
  // content (a user menu, an account name, a dashboard widget):
  await expect(page.locator('body')).toBeVisible();
});
