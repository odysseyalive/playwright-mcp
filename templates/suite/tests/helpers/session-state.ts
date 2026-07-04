import fs from 'node:fs';

import { storageState } from '../../playwright.config';

/**
 * Shared-session opt-in rules — READ THIS BEFORE ADDING test.use({ storageState }).
 *
 * The suite reuses ONE captured login (playwright.config storageState, written
 * by playwright-mcp's session_login). Reusing it makes specs fast (no per-test
 * login) but shares the SERVER-SIDE session across every test in the file.
 *
 * MAY opt in (read/report-style work): dashboards, reports, listings, admin
 * pages that don't accumulate session state between requests.
 *
 * MUST NOT opt in (each keeps fresh per-test sessions — the suite default):
 *   - anything with a session-held CART or basket (web checkout, POS/terminal
 *     flows, wishlist-style accumulators): abandoned/declined attempts leave
 *     state (e.g. seat/stock holds) that starves later tests;
 *   - login/logout/auth flows and negative-auth assertions ("redirects when
 *     anonymous") — a shared session inverts them;
 *   - anything asserting per-session server state (presale unlocks, wizards).
 *
 * GOTCHA (verified): the `request` fixture AND playwright.request.newContext()
 * both inherit a file-level storageState. An "unauthenticated" API test inside
 * an opted-in file must build an explicitly anonymous context:
 *   const anon = await playwright.request.newContext({
 *     baseURL, storageState: { cookies: [], origins: [] },
 *   });
 */

/** True if the captured storageState file exists and holds content. */
export function sessionStateUsable(): boolean {
  try {
    const state = JSON.parse(fs.readFileSync(storageState, 'utf8'));
    return (state.cookies?.length ?? 0) > 0 || (state.origins?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export { storageState };
