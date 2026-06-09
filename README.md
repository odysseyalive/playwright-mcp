# playwright-mcp

One install, and every Claude Code project gets a real headless browser. Page fetching with citations already attached, site debugging with persistent logins, and the full Playwright toolset underneath. Set it up once at user scope instead of wiring it into every project.

## What it is

An MCP server that wraps the official `@playwright/mcp` browser tools and adds three of its own. The installer denies Claude's built-in WebFetch and the claude-in-chrome extension, which leaves `web_fetch` as the only page-fetching path Claude has. Every time Claude fetches a page, the extra features come along for free.

### How it layers in

Claude's built-in WebFetch returns page text. That's it. When this server takes over that job, every fetch also comes back with structured citation metadata (author, date, publisher in CSL-JSON), a page-health classification (paywall, soft-404, parked, login-wall, blocked), and CMS detection. Claude doesn't have to ask for any of that. It's in every response, so when Claude summarizes a page or pulls a quote, the citation data is already sitting right there.

The other thing the built-in can't do is render. Single-page apps, JavaScript-heavy dashboards, pages behind consent walls. `web_fetch` runs a real headless Chromium with a stealth context, so it sees what a person would see.

This server has nothing to do with web search. Claude runs its own native WebSearch on Anthropic's infrastructure, gets back a list of URLs, and then calls `web_fetch` to actually visit the ones worth reading. The server only handles that last part. The `/web-search` skill that ships with this project is just a set of instructions that tells Claude to follow up its search results with `web_fetch` visits, so the citations and page-health data are there when it summarizes. The `/research-paper` skill takes that further and turns it into a verified 1300 to 1500 word cited paper with a four-agent team.

### The tools

Twenty-six total. Twenty-three are the wrapped `browser_*` set (navigate, snapshot, click, screenshot, and the rest). The three custom ones:

- **`web_fetch`** stealth-renders a URL (HTML or PDF), returns readable text plus the citation and health data described above.
- **`session_login`** and **`session_status`** handle authenticated debugging across your projects. Capture a logged-in session once to a mode-600 storageState file, then reuse it for interactive debugging and generated Playwright test suites in whatever project you're working on. Headed mode handles 2FA and SSO when you need it.

## Requirements

- Node 18 or newer
- The Claude Code CLI (`claude`) on your PATH
- About 170 MB for a one-time Chromium download. On Linux the installer pulls the system libraries Chromium needs too, which may ask for sudo.

## Install

The bundled installer handles the whole thing. Checks Node, installs dependencies, builds, downloads Chromium, registers the server at user scope. Before it touches anything global it shows you a diff and asks first.

**Linux / macOS**

```bash
./install.sh
```

**Windows PowerShell**

```powershell
.\install.ps1
```

It prompts before adding deny rules to `~/.claude/settings.json` that route page fetches and browser work through this server (`WebFetch` and `mcp__claude-in-chrome`). Native WebSearch stays enabled. If you're upgrading from an earlier version that denied WebSearch, the installer removes that deny rule for you. It also offers an optional steering note in `~/.claude/CLAUDE.md`. Skip either with `--no-deny` / `--no-steer` (PowerShell: `-NoDeny` / `-NoSteer`), or accept everything unattended with `--yes` (`-Yes`).

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

The full deterministic gate (build, 17 tests, then the smoke test) is one command.

```bash
npm run gate
```

## Configuration

Credentials for `session_login` live outside the repo in `~/.config/playwright-mcp/secrets.env`, mode 600 and gitignored. See `.env.example` for the format, and set `PLAYWRIGHT_MCP_SECRETS` if you want the file somewhere else.

## License

MIT
