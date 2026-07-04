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
npm run build
npx playwright install chromium
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

## Remote connector for claude.ai

Everything above is the local setup. The server runs over stdio for Claude Code on your own machine, and that's the default. Nothing changes unless you turn this on.

Set `PLAYWRIGHT_MCP_PUBLIC_URL` and the same server also exposes a remote Streamable-HTTP transport, so claude.ai can use it as a custom connector. The draw is the same reason the rest of this exists. claude.ai's built-in fetch just reads text. This one renders JavaScript and actually interacts with the page.

The remote side is a separate, hardened deployment, not something you run on your laptop. The tools that run code or touch credentials are stripped from what claude.ai can reach. GitHub OAuth locks it to a single login. The instance itself runs with no secrets on it at all. It needs nginx, TLS, and a firewall, so the full walkthrough lives in its own runbook, [docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md).

## License

MIT
