# Authenticated E2E tests

Deterministic `npx playwright test` end-to-end tests that reuse a login captured
once with the playwright-mcp `session_login` tool. The agent drives the browser to
*discover* a flow; you freeze the known-good path here so a runner replays it with
no model in the loop.

## How it fits together

```
session_login  ──writes──▶  ~/.config/playwright-mcp/sessions/<name>.json   (mode 600, a secret)
                                       │
                  playwright.config.ts │ resolves storageState from that path
                                       ▼
        setup project (auth.setup.ts) ── guards the file is present & fresh
                                       │  dependencies: ['setup']
                                       ▼
        chromium project ── starts already logged in ── your *.spec.ts run
```

The `setup` project does **not** log in — it only guards the captured session.
Capture (including headed 2FA/SSO, which a test runner cannot do) belongs to the
`session_login` tool.

## One-time setup in this project

```bash
npm install -D @playwright/test
npx playwright install chromium
```

## Capture a session (once)

Use the playwright-mcp tools from Claude Code:

```
session_login({ name: "<name>", loginUrl: "<login URL>", successSignal: "<post-login selector or URL>", headed: true })
session_status({ name: "<name>", probeUrl: "<an authenticated URL>" })
```

`headed: true` opens a real window so you can complete 2FA/SSO. The session name
is baked into `playwright.config.ts` (`SESSION_NAME`); override it per-run with
`PLAYWRIGHT_MCP_SESSION_NAME`.

## Run

```bash
BASE_URL=http://localhost:3000 npx playwright test
```

`BASE_URL` defaults to `http://localhost:3000`. If the session is missing, empty,
or unreadable, the `setup` project fails loudly and tells you which
`session_login` call to make.

## CI

The session file is a gitignored secret and is absent in CI. Supply it
out-of-band — never re-login and never put credentials in the suite:

1. Store the storageState JSON as a masked CI secret (e.g. base64-encoded).
2. In a pre-test step, write it to a path **outside** the repo and point
   `STORAGE_STATE` at it:

   ```bash
   echo "$SESSION_B64" | base64 -d > "$RUNNER_TEMP/session.json"
   export STORAGE_STATE="$RUNNER_TEMP/session.json"
   npx playwright test
   ```

`STORAGE_STATE` takes precedence over the local user-scoped path, so nothing else
changes.

## Security

The storageState file holds **live session tokens** — treat it as a secret:
mode 600, never commit it, never echo it into logs. This scaffold references it
only by resolved path; it never copies session data into the project.
