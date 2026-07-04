# Audit Workflow — run-driven, scripts-only maintenance

<!-- origin: playwright-mcp suite_scaffold | modifiable: true -->

For `/test-suite audit [spec ...]`: run the suite (or named specs), give every failure
exactly one evidence-backed verdict, and fix **e2e scripts only**.

**Write boundary (hard rule):** specs, `tests/helpers/*`, fixtures/test-data
registrations, `e2e-suite.config.json`. NEVER application code. NEVER relax an
assertion, add a skip, or widen a tolerance to make a PRODUCT-BUG failure pass.

## Phase 1 — Run and collect

1. From the project root: `npx playwright test [specs]` — or call the playwright-mcp
   `suite_audit` tool (`{ cwd, specs, run: true }`), which runs the suite and returns
   structured per-failure dossiers (error, location, attachments) ready to adjudicate.
   To triage the LAST run without re-running: `suite_audit({ cwd, reportPath: "test-results/last-run.json" })`.
2. Green → report "audit clean: N/N" and stop.
3. Failures → list them ALL first (a persistent checklist that survives interruption),
   then work strictly one at a time.

## Phase 2 — Adjudicate each failure (one at a time)

Evidence ladder, cheapest first: the failure's own artifacts (screenshots,
`page-errors.txt`, `page-integrity.txt`, error context), then server logs/state, then
live-page discovery (`KEEP_ENV=1` + `browser_navigate`/`browser_snapshot`).

**TEST-DEFECT signatures** (fix territory): stale selector vs live DOM; wrong/stale
fixture or test data; environment not established (login gate visible in the failure
snapshot → env-guard/config issue); session-shape violation (shared session on a
session-mutating spec; anonymous test inheriting storageState); timing budget too tight
under suite load (widen whole-test budgets, never blind sleeps); mis-declared
expectations; half-shaped seeded data (methodology § 5).

**PRODUCT-BUG signatures** (never touched): the app violates its own contract — error
text/artifacts rendered into the page, wrong totals, missing records, 5xx — while the
spec's expectation matches intended behavior AND it reproduces under a correct,
freshly-verified setup (setup-first hypothesis exhausted).

Verdicts:
- TEST-DEFECT → fix the script (authoring-workflow rules apply), re-run that spec in
  isolation to green.
- PRODUCT-BUG → record evidence + reproduction command + suspected code area; spec
  stays untouched; hand off to the project's debugging workflow as its own task.
- AMBIGUOUS → present both readings with the evidence to a human. Never default toward
  the side you're allowed to edit.

## Phase 3 — Synthesize

1. Verdict table: `spec.test → verdict → one-line evidence → action taken/handoff`.
2. If any script was fixed, re-run the full audited set once (isolation reruns miss
   shared-fixture interactions).
3. Exit criteria: every audited spec green OR carrying a documented PRODUCT-BUG
   verdict. A red spec with no verdict = incomplete audit; say so plainly.
<!-- /origin -->
