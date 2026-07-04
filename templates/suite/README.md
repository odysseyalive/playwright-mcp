# E2E Suite — scaffolded by playwright-mcp `suite_scaffold`

An authenticated Playwright regression suite carrying a battle-tested methodology pack,
plus a project-local Claude skill (`.claude/skills/test-suite/`) that teaches an AI
assistant how to run, author, and audit it safely.

## What's here

| Piece | File(s) | Job |
|-------|---------|-----|
| Config | `playwright.config.ts` | setup project guards the captured session; JSON report at a stable path for `suite_audit` |
| Project config | `e2e-suite.config.json` | THE file for project specifics: test-mode commands, allowlists (see its `_doc` key) |
| Env guard | `tests/global-setup.ts` / `global-teardown.ts` | puts the site in test mode on EVERY run, verifies it took, restores after (`SKIP_ENV_GUARD`, `KEEP_ENV`) |
| Session guard | `tests/auth.setup.ts` | fails loudly if the captured session is missing/stale — capture stays with `session_login` |
| Fixture | `tests/fixture.ts` | import `{ test, expect }` from here: report-only error capture + ENFORCING page-integrity gate |
| Helpers | `tests/helpers/*` | integrity scanner, error capture, session opt-in rules, config loader |
| AI skill | `.claude/skills/test-suite/` | run/author/audit discipline for AI-assisted test work (methodology, workflows) |

## First run

```bash
npm i -D @playwright/test && npx playwright install chromium
# 1. Fill e2e-suite.config.json (env.up/down may stay empty if no mode switch needed)
# 2. Capture the login once (via the playwright-mcp tools):
#    session_login({ name: "__SESSION_NAME__", loginUrl: "…", successSignal: "…", headed: true })
# 3. Run:
BASE_URL=https://your-app.example npx playwright test
```

CI: point `STORAGE_STATE` at a file materialized from a masked secret; it overrides the
local session path. The storageState file is a bearer credential — never commit it.

## Auditing failures

`suite_audit({ cwd: "<this project>", run: true })` (or `reportPath:
"test-results/last-run.json"` to triage the last run) returns per-failure dossiers plus
the adjudication rubric. The rule that keeps the suite honest: failures are classified
TEST-DEFECT (fix the script) or PRODUCT-BUG (report + hand off — the spec is never
relaxed to go green). Full workflow: `.claude/skills/test-suite/references/audit-workflow.md`.
