# Authoring Workflow — creating or updating a spec

<!-- origin: playwright-mcp suite_scaffold | modifiable: true -->

For `/test-suite author <what to cover>` and any spec edit. The core discipline:
**discover live, then assert** — never author against remembered or assumed DOM.

## 1. Discovery (before any assertion is written)

1. List the behavior's implied attributes: which pages, which login context
   (shared session / fresh / anonymous), what data it needs, what it mutates.
2. Establish the environment: `KEEP_ENV=1 npx playwright test tests/auth.setup.ts`
   (runs env.up + the session guard, leaves test mode up for browsing;
   restore later with any normal run, or SKIP_ENV_GUARD honored throughout).
3. Open the page(s) with the playwright-mcp browser tools:
   `browser_navigate` → `browser_snapshot` (accessibility tree). Verify every selector
   you will use against the LIVE snapshot and keep the evidence in your notes — a bare
   "verified" is not evidence. Check `browser_console_messages` while you're there.
4. If the session is missing/stale: `session_login({ name: "__SESSION_NAME__", … })`,
   confirm with `session_status`.

## 2. Decisions each new spec must make explicitly

- **Session** (see `tests/helpers/session-state.ts`): read-style → may opt in with
  `test.use({ storageState })`; session-mutating (cart/checkout/login/negative-auth) →
  fresh sessions, and say so in a comment. Anonymous request tests inside an opted-in
  file build an explicitly empty-storageState context.
- **Integrity**: stays on. `pageIntegrity: 'report'`/`'off'` requires a written reason.
- **Data**: use this project's documented fixtures (SKILL.md § Project blanks). Seed
  full real-world row shape (methodology § 5). Never consume the last of a finite
  resource (§ 6).

## 3. Write the smallest honest spec

- Import `{ test, expect }` from `../fixture` (never `@playwright/test` directly) so
  capture + integrity apply.
- Assert OUTCOMES the user would see, plus (where the project supports it) the
  server-side state the flow claims to produce. A spec that only checks "no crash"
  is a smoke test, not regression coverage.
- Updating an existing assertion because behavior changed ON PURPOSE is fine; updating
  it because the test went red and you want green is the papering-over anti-pattern —
  route through the audit adjudication instead.

## 4. Prove it

Run the spec in isolation from the project root → green. If it touched shared fixtures,
re-run the neighboring specs that share them. Then run it once more — a spec that only
passes on its first run against fresh state is not idempotent, fix that now.
<!-- /origin -->
