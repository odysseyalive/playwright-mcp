# E2E Suite Methodology — the portable lessons

<!-- origin: playwright-mcp suite_scaffold | modifiable: true -->

Project-agnostic principles this suite pack encodes. Each was learned the expensive way
on a production suite; the helpers implement them, and this file is why.

## 1. Environment first — most "flaky tests" are mode bugs

A spec authored or run against a site in the wrong mode (login gate up, sandbox off,
feature flag stale) produces failures that look like anything but what they are. So the
environment guard runs on EVERY invocation — full runs and one-off spec runs alike
(`tests/global-setup.ts`), and `env.verifyAbsent` PROVES the mode took effect instead of
trusting the flip.

**Stale-worker corollary:** if the app server caches config per worker process
(mod_php + immutable dotenv, preforked anything), flipping a flag WITHOUT reloading the
server leaves warm workers serving the old mode *intermittently* — the nastiest failure
shape there is. The reload belongs INSIDE `env.up`.

## 2. Session reuse is a scalpel, not a default

One captured login (playwright-mcp `session_login` → storageState) makes read-style specs
fast. But a shared storageState means ONE server-side session across every test in the
file. Session-mutating flows — carts that hold inventory, checkout, POS terminals, login
flows, negative-auth assertions — accumulate state across tests and fail in ways that
implicate innocent code (e.g. abandoned payment attempts leaving stock holds that starve
the next test). Rules and the verified `request`-fixture gotcha live in
`tests/helpers/session-state.ts`. Fresh-session-per-test is the DEFAULT; opt-in is the
exception with a reason.

## 3. Two error layers with different verdicts

- **Rendered-DOM artifacts** (server error text, leaked template tokens, raw markup as
  text, `undefined`/`NaN` in visible content) are deterministic first-party defects →
  the page-integrity gate FAILS the test (`tests/helpers/page-integrity.ts`).
- **Console/network noise** (beacons, third-party 4xx, transient aborts) is ambient →
  captured and ATTACHED to the report, never failing (`tests/helpers/error-capture.ts`).

Collapsing the two layers either drowns signal (fail on everything) or ships artifacts
(report everything). Keep them apart. The gate catches real shipped bugs on day one more
often than you'd expect.

## 4. Failure adjudication: TEST-DEFECT vs PRODUCT-BUG

Every failure gets exactly one verdict, evidence-first, one failure at a time:

- **TEST-DEFECT** — the software is right, the test is wrong: stale selector, wrong
  fixture/test data, timing budget, session-shape violation (rule 2), mis-declared
  expectation, environment not established (rule 1). → Fix the SCRIPT, re-run to green.
- **PRODUCT-BUG** — the software violates its own contract while the test's expectation
  matches intended behavior, reproduced under a correct, freshly-verified setup. → The
  spec stays byte-for-byte untouched. Fixing the product is a separate, deliberate task
  with its own review — never a quiet side effect of "making tests pass".
- **AMBIGUOUS** — evidence supports both. → Present both readings to a human. Never
  default toward the side you're allowed to edit.

**Evidence over error text:** two unrelated bugs can render the same user-facing error.
Classify by artifacts (failure screenshots, page snapshots, attachments), server-side
state, and clean-condition reproduction — never by message string alone. And an empty
log next to a user-visible error means the failing branch has no logging, not that
nothing failed.

## 5. Test data must match real-world row shape

Seeded/fixture data that fills only the columns the happy path reads will pass counts
and then violate invariants some OTHER code path enforces (an org/tenant scoping column,
a nullable foreign key some cleanup routine interpolates into SQL). Seed by copying the
shape of real rows, deriving scoping values from parent records — never hardcoding
zeros. Internally-consistent synthetic worlds are fine; half-shaped rows are time bombs.

## 6. The suite protects inventory it tests against

Purchase-style tests consume finite resources (stock, seats, rate limits). Leave
headroom, and treat "resource exhausted" failures as a fixture-hygiene signal before
suspecting product code.

## 7. Run discipline

- Always run from the project root (a wrong cwd silently loses the Playwright config).
- Serial workers by default when tests reconcile against a shared backend.
- After any suite-infrastructure change, re-run a known-green slice before trusting new
  results.
<!-- /origin -->
