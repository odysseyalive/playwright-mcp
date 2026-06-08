# playwright-mcp

One install, and every Claude Code project gets a real headless browser. Web search, page fetching with citations already attached, site debugging with persistent logins. It runs at user scope, so you set it up once instead of wiring it into every project.

## What it is

An MCP server that wraps the official `@playwright/mcp` browser tools and adds five of its own. It becomes the single path for web and browser work in Claude Code, replacing the built-in WebSearch and WebFetch and standing in for the claude-in-chrome extension.

Twenty-eight tools. Twenty-three are the wrapped `browser_*` set (navigate, snapshot, click, screenshot, and the rest). The five custom ones are where this project earns its keep.

- **`web_fetch`** stealth-renders a URL with a real browser, HTML or PDF, and hands back readable text, a CSL-JSON citation (author, date, publisher), and a page-health read.
- **`web_search`** scrapes Google, Bing, and DuckDuckGo, plus Google Scholar when you ask for it. It re-ranks results by its own relevance signals and cross-engine agreement rather than trusting any single engine's order, then confirm-fetches the best handful.
- **`deep_research`** drives those two in a loop. Follows references and outbound links, clusters what it finds, and hands back organized raw material. The companion `research-paper` skill turns that into a verified 1300 to 1500 word cited paper with a four-agent team.
- **`session_login`** and **`session_status`** are for debugging websites and building test environments across your projects. Capture a logged-in session once to a mode-600 storageState file, then reuse that same session for interactive debugging and generated Playwright test suites in whatever project you're working on. Headed mode handles 2FA and SSO when you need it.

## Requirements

- Node 18 or newer
- The Claude Code CLI (`claude`) on your PATH
- About 115 MB for a one-time Chromium download. On Linux the installer pulls the system libraries Chromium needs too, which may ask for sudo.

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

It prompts before adding deny rules that route web access through this server (`WebSearch`, `WebFetch`, and `mcp__claude-in-chrome` in `~/.claude/settings.json`), and again before adding an optional steering note to `~/.claude/CLAUDE.md`. Skip either with `--no-deny` / `--no-steer` (PowerShell: `-NoDeny` / `-NoSteer`), or accept everything unattended with `--yes` (`-Yes`).

### Registering by hand

If you'd rather skip the installer, build and register the absolute path yourself.

```bash
npm install
npm run build
npx playwright install chromium
claude mcp add --scope user playwright-mcp -- node /ABSOLUTE/PATH/dist/index.js
```

## Verifying

Restart Claude Code, run `/mcp` in any project, and look for the `mcp__playwright-mcp__*` tools. To check the server on its own:

```bash
npm run smoke
```

The full deterministic gate (build, 34 tests, then the smoke test) is one command.

```bash
npm run gate
```

## Configuration

Credentials for `session_login` live outside the repo in `~/.config/playwright-mcp/secrets.env`, mode 600 and gitignored. See `.env.example` for the format, and set `PLAYWRIGHT_MCP_SECRETS` if you want the file somewhere else.

With the deny rules applied, all web and browser work routes through this server. Some networks do block headless traffic at the infrastructure level, so `web_search` can come back with an engine dropped now and then. That's by design. A blocked engine drops out with a note and the others carry the search.

## License

MIT
