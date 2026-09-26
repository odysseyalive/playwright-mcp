# install.ps1 — Windows installer for playwright-mcp (PowerShell 5.1+).
#
# Builds the server, downloads Chromium, registers it at USER scope with Claude
# Code and Codex, routes Claude's page fetching and browser work to it, and
# appends a steering note to ~\.claude\CLAUDE.md (once — guarded by a marker).
# Idempotent + non-interactive: safe to re-run, never prompts.
#
# The routing is two entries in ~\.claude\settings.json permissions.deny:
# WebFetch and mcp__claude-in-chrome. They take the built-in fetcher and the
# Chrome extension out of the way so Claude uses web_fetch and browser_*
# instead. They never block a playwright-mcp tool, and native WebSearch stays.
#
#   .\install.ps1            run (non-interactive)
#   .\install.ps1 -Yes       accepted but no longer needed (back-compat no-op)
#
# No flag switches off any part of the install; the routing and the steering
# directive are always applied. Anything else on the line — including the retired -NoDeny and
# -NoSteer — lands in $Rest, is warned about on stderr and ignored rather than
# rejected, so an old script that still passes one keeps working.
# ValueFromRemainingArguments is what collects it: a [Parameter()] attribute
# makes this an advanced script, which would otherwise refuse an unknown
# parameter before the body runs.
#
param(
  [switch]$Yes,     # back-compat no-op: the installer no longer prompts
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot

# One line per leftover, on stderr, then carry on — the install.sh twin of this
# is the `*) echo "ignoring unknown flag: $arg" >&2 ;;` arm. [Console]::Error is
# the 5.1-safe stderr write: Write-Error would throw under 'Stop', and
# Write-Warning goes to the warning stream, not stderr.
if ($Rest) { foreach ($arg in $Rest) { [Console]::Error.WriteLine("ignoring unknown flag: $arg") } }

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "ERR $m" -ForegroundColor Red; exit 1 }

# ── 1. Node >= 22.13 ──────────────────────────────────────────────────────────
# jsdom 29 (^20.19.0 || ^22.13.0 || >=24.0.0) and pdfjs-dist 6 (>=22.13.0 || >=24)
# intersect at 22.13.0, and npm only WARNS on an engines mismatch — so this guard
# is what turns a confusing runtime failure inside a PDF or DOM parse into a clear
# install-time one. MAJOR.MINOR compare: 22.12 is rejected, 22.13 and later pass.
# Pure function of a version string — it never reads process.versions itself.
# [version] is the 5.1-safe comparison; strip any 'v' prefix and prerelease tag
# first, since [version] parses digits and dots only.
function Test-NodeVersion ($v) {
  $core = ($v -replace '^v', '') -replace '-.*$', ''
  return ([version]$core -ge [version]'22.13.0')
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is required (>=22.13.0). See `"Getting a current Node.js`" in README.md." }
$nodeVersion = (node -p "process.versions.node")
if (-not (Test-NodeVersion $nodeVersion)) { Die "Node >=22.13.0 required; found $(node -v). See `"Getting a current Node.js`" in README.md." }
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if (-not $hasClaude) { Warn "Claude Code CLI 'claude' not found — registration step will be skipped." }
$hasCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
if (-not $hasCodex) { Warn "Codex CLI 'codex' not found — registration step will be skipped." }
Say "Node $(node -v) OK"

# ── 2. Install deps + build ───────────────────────────────────────────────────
Push-Location $Here
try {
  Say "Installing dependencies…"
  npm ci
  if ($LASTEXITCODE -ne 0) { npm install }
  Say "Building (tsc -> dist/)…"
  npm run build
  if ($LASTEXITCODE -ne 0) { Die "build failed" }

  # ── 3. Download Chromium ────────────────────────────────────────────────────
  # Browser binary only, from Playwright's CDN into %LOCALAPPDATA%\ms-playwright.
  # No OS package manager, no admin — Windows needs no system-dep step at all
  # (the apt-only --with-deps flag is a Linux-CI concern and never applies here).
  Say "Downloading Chromium…"
  npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { Die "Chromium download failed" }

  # Prove it launches: the real Google Chrome when the host has one, else this
  # bundled Chromium. A host where no browser can start fails here, not later.
  Say "Checking that the browser launches…"
  node scripts/check-browser.mjs
  if ($LASTEXITCODE -ne 0) { Die "No working browser. See the error above, fix it, and re-run this installer." }
} finally {
  Pop-Location
}

# ── 4. Register at user scope (idempotent) ────────────────────────────────────
$entry = Join-Path $Here "dist\index.js"
if ($hasClaude) {
  Say "Registering playwright-mcp at user scope with Claude Code…"
  claude mcp remove --scope user playwright-mcp 2>$null
  claude mcp add --scope user playwright-mcp -- node "$entry"
  Say "Registered with Claude Code. Check with: claude mcp list"
} else {
  Warn "Skipped Claude Code registration. Run manually once 'claude' is installed:"
  Write-Host "    claude mcp add --scope user playwright-mcp -- node `"$entry`""
}

if ($hasCodex) {
  Say "Registering playwright-mcp with Codex…"
  codex mcp remove playwright-mcp 2>$null
  codex mcp add playwright-mcp -- node "$entry"
  Say "Registered with Codex. Check with: codex mcp list"
} else {
  Warn "Skipped Codex registration. Run manually once 'codex' is installed:"
  Write-Host "    codex mcp add playwright-mcp -- node `"$entry`""
}

# ── 5. Route fetching + browser work to playwright-mcp ────────────────────────
# Always applied. Adds only WebFetch and mcp__claude-in-chrome to
# permissions.deny (and drops a stale WebSearch deny from older installs);
# every other setting is left as it is. A re-run finds both and changes nothing.
$settings = Join-Path $env:USERPROFILE ".claude\settings.json"
Say "Routing page fetches and browser work to playwright-mcp in $settings"
New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
if (-not (Test-Path $settings)) { '{}' | Set-Content -Encoding utf8 $settings }
$preview = node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --print
if ($LASTEXITCODE -ne 0) { Die "could not read $settings" }
if (-not $preview) {
  Say "Routing already in place — nothing to change."
} else {
  Write-Host "----- change to settings.json (your other settings untouched) -----"
  Write-Host $preview
  Write-Host "-------------------------------------------------------------------"
  node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --write
  Say "Done. Claude now fetches pages with web_fetch and drives browsers with"
  Say "playwright-mcp's browser_* tools instead of built-in WebFetch and the"
  Say "Chrome extension. No playwright-mcp tool is blocked; WebSearch stays on."
}

# ── 6. Steering directive ─────────────────────────────────────────────────────
# Always applied, with no opt-out: it is what points Claude at the tools this
# script just installed. Idempotence comes from the marker, not from a flag —
# a re-run finds it and appends nothing.
$userClaudeMd = Join-Path $env:USERPROFILE ".claude\CLAUDE.md"
function Add-Steering {
  $hasMark = (Test-Path $userClaudeMd) -and (Select-String -Quiet -Path $userClaudeMd -Pattern "playwright-mcp steering")
  if ($hasMark) {
    Say "Steering directive already present in $userClaudeMd"
  } else {
    New-Item -ItemType Directory -Force -Path (Split-Path $userClaudeMd) | Out-Null
    Say "Adding the playwright-mcp steering directive to $userClaudeMd"
    $steer = @'

<!-- playwright-mcp steering -->
Use playwright-mcp for browser work: reviewing and debugging local dev servers
(localhost/127.0.0.1) and live sites, screenshots, and fetching/rendering pages.
For web SEARCH, use the native WebSearch tool for discovery, then verify and cite
the top results with playwright-mcp's web_fetch — or just run the /web-search
skill, which does that discover→verify pass for you. Use web_fetch instead of the
built-in WebFetch, and playwright-mcp's browser_* tools instead of the
claude-in-chrome extension. Do NOT scrape search engines. Clean up temporary
screenshots and files at the end of every debug session.
'@
    # Append as UTF-8 without a BOM, LF-only, newline-terminated: byte-identical to
    # install.sh's heredoc. Not Add-Content: under 5.1 it writes the ANSI code page
    # to a new or BOM-less file, and -Encoding UTF8 there would add a BOM.
    $block = ($steer -replace "`r`n", "`n") + "`n"
    [System.IO.File]::AppendAllText($userClaudeMd, $block, (New-Object System.Text.UTF8Encoding $false))
    Say "Added steering directive."
  }
}
Add-Steering

Say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
