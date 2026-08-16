# install.ps1 — Windows installer for playwright-mcp (PowerShell 5.1+).
#
# Builds the server, downloads Chromium, registers it at USER scope with Claude
# Code and Codex, and applies the WebFetch/claude-in-chrome override automatically,
# printing a diff of what it changes. Native WebSearch stays enabled. Idempotent +
# non-interactive: safe to re-run, never prompts. Opt out of the global-config
# edits with -NoDeny / -NoSteer.
#
#   .\install.ps1            run (non-interactive)
#   .\install.ps1 -NoDeny    skip the settings.json deny override
#   .\install.ps1 -NoSteer   skip the CLAUDE.md steering directive
#   .\install.ps1 -Yes       accepted but no longer needed (back-compat no-op)
#
param(
  [switch]$Yes,     # back-compat no-op: the installer no longer prompts
  [switch]$NoDeny,
  [switch]$NoSteer
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "ERR $m" -ForegroundColor Red; exit 1 }

# ── 1. Node >= 18 ─────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is required (>=18)." }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) { Die "Node >=18 required; found $(node -v)." }
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

# ── 5. Override native WebFetch + claude-in-chrome ────────────────────────────
$settings = Join-Path $env:USERPROFILE ".claude\settings.json"
if (-not $NoDeny) {
  Say "Applying WebFetch/claude-in-chrome override for $settings"
  New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
  if (-not (Test-Path $settings)) { '{}' | Set-Content -Encoding utf8 $settings }
  $preview = node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --print
  if (-not $preview) {
    Say "Deny rules already present — nothing to change."
  } else {
    Write-Host "----- applying this change to settings.json (your other settings untouched) -----"
    Write-Host $preview
    Write-Host "---------------------------------------------------------------------------------"
    node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --write
    Say "Applied. WebFetch + claude-in-chrome are now denied; native WebSearch stays enabled."
  }
}

# ── 6. Steering directive (optional) ──────────────────────────────────────────
$userClaudeMd = Join-Path $env:USERPROFILE ".claude\CLAUDE.md"
if (-not $NoSteer) {
  $hasMark = (Test-Path $userClaudeMd) -and (Select-String -Quiet -Path $userClaudeMd -Pattern "playwright-mcp steering")
  if ($hasMark) {
    Say "Steering directive already present in $userClaudeMd"
  } else {
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
    Add-Content -Path $userClaudeMd -Value $steer
    Say "Added steering directive."
  }
}

Say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
Write-Host ""
Write-Host "To temporarily re-enable the Chrome extension for a session, remove"
Write-Host "`"mcp__claude-in-chrome`" from the deny array in $settings."
