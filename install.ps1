# install.ps1 — Windows installer for playwright-mcp (PowerShell 5.1+).
#
# Builds the server, downloads Chromium, registers it at USER scope with Claude
# Code and Codex, and appends a steering note to ~\.claude\CLAUDE.md (once —
# guarded by a marker). It never changes ~\.claude\settings.json. Idempotent +
# non-interactive: safe to re-run, never prompts. Opt out of the global-config
# edit with -NoSteer.
#
#   .\install.ps1            run (non-interactive)
#   .\install.ps1 -NoSteer   skip the CLAUDE.md steering directive
#   .\install.ps1 -Yes       accepted but no longer needed (back-compat no-op)
#
param(
  [switch]$Yes,     # back-compat no-op: the installer no longer prompts
  [switch]$NoSteer
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot

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

# ── 5. Steering directive (optional) ──────────────────────────────────────────
$userClaudeMd = Join-Path $env:USERPROFILE ".claude\CLAUDE.md"
if (-not $NoSteer) {
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

Say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
