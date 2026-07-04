---
name: test-suite
description: "E2E regression suite for __PROJECT_NAME__ (scaffolded by playwright-mcp suite_scaffold). Modes: run [spec|grep], author <what to cover>, audit [spec] (run e2e + fix test scripts only). Usage: /test-suite [mode] [args]"
---

# Test Suite — __PROJECT_NAME__

Playwright e2e suite built on the playwright-mcp methodology pack: captured-session
reuse (`__SESSION_NAME__`), an environment guard on every invocation, report-only
error capture, and an ENFORCING page-integrity gate.

<!-- origin: playwright-mcp suite_scaffold | modifiable: true -->
## Modes

| Mode | What it does |
|------|--------------|
| `run [spec\|--grep pattern]` | Run the suite (or a slice). Environment guard + session guard fire automatically. Always run from the PROJECT ROOT. |
| `author <what to cover>` | Create or update a spec. Read [references/authoring-workflow.md](references/authoring-workflow.md) FIRST — live-page discovery before assertions, session opt-in decision, integrity default. |
| `audit [spec ...]` | Run all/named specs, adjudicate every failure TEST-DEFECT vs PRODUCT-BUG, fix **e2e scripts only**. Read [references/audit-workflow.md](references/audit-workflow.md) FIRST. Product bugs are reported + handed off, never papered over. |

## Non-negotiable rules (condensed — full rationale in references/methodology.md)

1. **Real flows only.** Tests drive the real app through the real browser. No mocked
   backends, no DB rows inserted to fake a flow's outcome, no login bypass outside the
   captured-session mechanism.
2. **One failure at a time.** Investigate each failure individually with evidence
   (artifacts → report attachments → live page via playwright-mcp browser tools).
   Never bulk-skip, never bulk-fix.
3. **Scripts-only audit boundary.** `audit` may edit specs, helpers, fixtures, and
   config — NEVER application code, and NEVER relax an assertion to make a product-bug
   failure pass. A product bug gets a verdict and a handoff, byte-for-byte untouched spec.
4. **Session isolation.** Shared storageState is opt-in per file and FORBIDDEN for
   session-mutating specs (carts/checkout/login/negative-auth) — see
   `tests/helpers/session-state.ts`. Anonymous tests inside opted-in files need an
   explicitly empty storageState (the `request` fixture inherits it).
5. **Integrity gate stays on.** `pageIntegrity: 'off'` needs a written reason in the
   spec. Grandfathered findings go in `e2e-suite.config.json` `integrity.allow` with a
   tracking note, and the list only shrinks.
6. **Evidence over error text.** Two different bugs can share one error banner.
   Classify by artifacts, server state, and reproduction under clean conditions —
   never by message string alone.

## Project blanks (fill these in — the scaffold cannot know them)

- [ ] `e2e-suite.config.json` → `env.up` / `env.down` / `verifyUrl` / `verifyAbsent`
      (what "test mode" means for __PROJECT_NAME__, if anything)
- [ ] Capture the login once: `session_login({ name: "__SESSION_NAME__", loginUrl: …, successSignal: …, headed: true })`
- [ ] Replace `tests/example.spec.ts` with real specs
- [ ] Document project fixtures/test data conventions here (IDs, seed scripts, cleanup
      boundaries — keep them in THIS repo, never in shared tooling)

## Grounding

- [references/methodology.md](references/methodology.md) — the portable lessons this
  suite is built on (read before changing suite infrastructure)
- [references/authoring-workflow.md](references/authoring-workflow.md) — before creating/updating any spec
- [references/audit-workflow.md](references/audit-workflow.md) — before running an audit
- playwright-mcp tools: `session_login` / `session_status` (session), `suite_audit`
  (run + failure dossiers), `suite_methodology` (this playbook on demand),
  `browser_navigate` → `browser_snapshot` (live-page discovery)
<!-- /origin -->
