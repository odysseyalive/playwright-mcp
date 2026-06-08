# install.ps1 — Windows installer for playwright-mcp (PowerShell 5.1+).
#
# Builds the server, downloads headless Chromium, registers it at USER scope with
# Claude Code, and offers the WebSearch/WebFetch/claude-in-chrome override
# (prompted, with a diff — never silent). Idempotent: safe to re-run.
#
#   .\install.ps1            interactive
#   .\install.ps1 -Yes       accept settings + steering changes
#   .\install.ps1 -NoDeny    skip the settings.json deny override
#   .\install.ps1 -NoSteer   skip the CLAUDE.md steering directive
#
param(
  [switch]$Yes,
  [switch]$NoDeny,
  [switch]$NoSteer
)
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!   $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "ERR $m" -ForegroundColor Red; exit 1 }
function Confirm ($q) {
  if ($Yes) { return $true }
  $r = Read-Host "$q [y/N]"
  return ($r -match '^(y|yes)$')
}

# ── 1. Node >= 18 ─────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die "Node.js is required (>=18)." }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 18) { Die "Node >=18 required; found $(node -v)." }
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if (-not $hasClaude) { Warn "Claude Code CLI 'claude' not found — registration step will be skipped." }
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

  # ── 3. Download headless Chromium ───────────────────────────────────────────
  Say "Downloading Chromium…"
  npx playwright install chromium
} finally {
  Pop-Location
}

# ── 4. Register at user scope (idempotent) ────────────────────────────────────
$entry = Join-Path $Here "dist\index.js"
if ($hasClaude) {
  Say "Registering playwright-mcp at user scope…"
  claude mcp remove --scope user playwright-mcp 2>$null
  claude mcp add --scope user playwright-mcp -- node "$entry"
  Say "Registered. Check with: claude mcp list"
} else {
  Warn "Skipped registration. Run manually once 'claude' is installed:"
  Write-Host "    claude mcp add --scope user playwright-mcp -- node `"$entry`""
}

# ── 5. Override native WebSearch/WebFetch + claude-in-chrome ──────────────────
$settings = Join-Path $env:USERPROFILE ".claude\settings.json"
if (-not $NoDeny) {
  Say "Preparing WebSearch/WebFetch/claude-in-chrome override for $settings"
  New-Item -ItemType Directory -Force -Path (Split-Path $settings) | Out-Null
  if (-not (Test-Path $settings)) { '{}' | Set-Content -Encoding utf8 $settings }
  $preview = node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --print
  if (-not $preview) {
    Say "Deny rules already present — nothing to change."
  } else {
    Write-Host "----- proposed change to settings.json -----"
    Write-Host $preview
    Write-Host "--------------------------------------------"
    if (Confirm "Apply these deny rules (merge, your other settings untouched)?") {
      node (Join-Path $Here "scripts\merge-deny.mjs") "$settings" --write
      Say "Applied. Native WebSearch/WebFetch + claude-in-chrome are now denied."
    } else {
      Warn "Skipped. Web access will NOT route through playwright-mcp until you add:"
      Write-Host '    "permissions": { "deny": ["WebSearch","WebFetch","mcp__claude-in-chrome"] }'
    }
  }
}

# ── 6. Steering directive (optional) ──────────────────────────────────────────
$userClaudeMd = Join-Path $env:USERPROFILE ".claude\CLAUDE.md"
if (-not $NoSteer) {
  $hasMark = (Test-Path $userClaudeMd) -and (Select-String -Quiet -Path $userClaudeMd -Pattern "playwright-mcp steering")
  if ($hasMark) {
    Say "Steering directive already present in $userClaudeMd"
  } elseif (Confirm "Add the playwright-mcp steering directive to $userClaudeMd?") {
    $steer = @'

<!-- playwright-mcp steering -->
Use playwright-mcp for ALL browser work: reviewing and debugging local dev
servers (localhost/127.0.0.1) and live sites, screenshots, and web search/fetch.
Use its web_search/web_fetch instead of the built-in WebSearch/WebFetch, and its
browser_* tools instead of the claude-in-chrome extension. Clean up temporary
screenshots and files at the end of every debug session.
'@
    Add-Content -Path $userClaudeMd -Value $steer
    Say "Added steering directive."
  } else {
    Warn "Skipped steering directive."
  }
}

Say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
Write-Host ""
Write-Host "To temporarily re-enable the Chrome extension for a session, remove"
Write-Host "`"mcp__claude-in-chrome`" from the deny array in $settings."
