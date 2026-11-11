# install.ps1 — Windows installer for playwright-mcp (PowerShell 5.1+).
#
# Builds the server, downloads Chromium, registers it at USER scope with Claude
# Code, Codex and Crush, routes Claude's page fetching and browser work to it, and
# appends a steering note to ~\.claude\CLAUDE.md (once — guarded by a marker).
# Idempotent + non-interactive: safe to re-run, never prompts.
#
# The routing is two entries in ~\.claude\settings.json permissions.deny:
# WebFetch and mcp__claude-in-chrome. They take the built-in fetcher and the
# Chrome extension out of the way so Claude uses web_fetch and browser_*
# instead. They never block a playwright-mcp tool, and native WebSearch stays.
#
#   .\install.ps1            from a clone: build and register that checkout in place
#   irm https://raw.githubusercontent.com/odysseyalive/playwright-mcp/main/install.ps1 | iex
#                            one line, no clone: download into
#                            $env:PLAYWRIGHT_MCP_HOME or %LOCALAPPDATA%\playwright-mcp,
#                            build in a staging folder beside it, then swap it in.
#                            A failure before the swap leaves the existing install
#                            as it was. The same line updates; what got installed
#                            is recorded in .install.json there.
#   .\install.ps1 -Force     let the one-line install replace a newer version with
#                            an older one ($env:PLAYWRIGHT_MCP_FORCE='1' for irm | iex,
#                            which cannot take parameters)
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
  [switch]$Force,   # one-line install only: allow replacing a newer version with an older one
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)
# Empty under `irm | iex`: there is no script file, so there is no clone to build.
$SelfDir = $PSScriptRoot

# Everything below runs in its own scope. Under `irm | iex` the script runs in
# the user's own console, and without this the 'Stop' preference and every
# variable here would stay behind in their session after the install.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # 5.1's progress bar slows downloads many times over
$RepoSlug = 'odysseyalive/playwright-mcp'
$ForceDowngrade = $Force -or ($env:PLAYWRIGHT_MCP_FORCE -and @('0', 'no', 'false') -notcontains $env:PLAYWRIGHT_MCP_FORCE)

# One line per leftover, on stderr, then carry on — the install.sh twin of this
# is the `*) echo "ignoring unknown flag: $arg" >&2 ;;` arm. [Console]::Error is
# the 5.1-safe stderr write: Write-Error would throw under 'Stop', and
# Write-Warning goes to the warning stream, not stderr.
if ($Rest) { foreach ($arg in $Rest) { [Console]::Error.WriteLine("ignoring unknown flag: $arg") } }

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "!   $m" -ForegroundColor Yellow }
# Run as a file, exit 1 as before. Under `irm | iex` `exit` would close the
# user's whole console, so it throws instead, which stops the install and
# leaves the console open.
function Die  ($m) {
  Write-Host "ERR $m" -ForegroundColor Red
  Remove-Stage
  if ($SelfDir) { exit 1 } else { throw "playwright-mcp install stopped: $m" }
}

# ── 0. Clone or one-line install ──────────────────────────────────────────────
# A checkout of this project, and not an install this script made (those carry
# .install.json and are updated by download). The package name is part of the
# test so a copy of this script saved inside some other Node project never
# builds there. Twin of install.sh's is_own_checkout.
function Test-OwnCheckout ($dir) {
  if (-not $dir) { return $false }
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pkg -PathType Leaf)) { return $false }
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'src') -PathType Container)) { return $false }
  if (Test-Path -LiteralPath (Join-Path $dir '.install.json')) { return $false }
  return [bool](Select-String -Quiet -LiteralPath $pkg -Pattern '"name": *"@francis/playwright-mcp"')
}

# Is dotted version $a strictly OLDER than $b? X.Y.Z numerically, a missing or
# non-numeric field is 0, equal is not older. Twin of install.sh's version_is_older.
function Test-VersionOlder ($a, $b) {
  $pa = @("$a" -split '\.'); $pb = @("$b" -split '\.')
  for ($i = 0; $i -lt 3; $i++) {
    $x = ''; $y = ''
    if ($i -lt $pa.Count) { $x = $pa[$i] -replace '[^0-9]', '' }
    if ($i -lt $pb.Count) { $y = $pb[$i] -replace '[^0-9]', '' }
    $x = if ($x) { [int64]$x } else { 0 }
    $y = if ($y) { [int64]$y } else { 0 }
    if ($x -lt $y) { return $true }
    if ($x -gt $y) { return $false }
  }
  return $false
}

function Read-Version ($pkg) {
  try { return [string](Get-Content -Raw -LiteralPath $pkg | ConvertFrom-Json).version } catch { return '' }
}

# Put the previous install back if the run dies between the two renames, and
# never leave a half-built staging folder behind. A no-op in clone mode.
function Remove-Stage {
  if ($Mode -ne 'bootstrap' -or -not $Stage) { return }
  if ((Test-Path -LiteralPath $Old) -and -not (Test-Path -LiteralPath $InstallDir)) {
    Move-Item -LiteralPath $Old -Destination $InstallDir -ErrorAction SilentlyContinue
  }
  # A build step that failed left us standing inside $Stage, and Windows will not
  # delete the current folder. Step out first; the caller's finally restores it.
  if ((Get-Location).Path -like "$Stage*") { Set-Location (Split-Path $Stage) }
  foreach ($p in @($Stage, "$Stage.zip", "$Stage.unpack")) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

if ($SelfDir -and (Test-OwnCheckout $SelfDir)) {
  $Mode = 'clone'
  $Here = $SelfDir
} else {
  $Mode = 'bootstrap'
  $Here = $null
  # An install this script made, re-run from inside itself, updates itself.
  if ($SelfDir -and (Test-Path -LiteralPath (Join-Path $SelfDir '.install.json'))) {
    $defaultDir = $SelfDir
  } else {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
    $defaultDir = Join-Path $localAppData 'playwright-mcp'
  }
  $InstallDir = if ($env:PLAYWRIGHT_MCP_HOME) { $env:PLAYWRIGHT_MCP_HOME } else { $defaultDir }
  if (-not [System.IO.Path]::IsPathRooted($InstallDir)) { Die "PLAYWRIGHT_MCP_HOME must be an absolute path; got $InstallDir" }
  $InstallDir = $InstallDir.TrimEnd('\', '/')
  $Stage = "$InstallDir.new"
  $Old = "$InstallDir.old"
}


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
$hasCrush = [bool](Get-Command crush -ErrorAction SilentlyContinue)
if (-not $hasCrush) { Warn "Crush CLI 'crush' not found — registration step will be skipped." }
Say "Node $(node -v) OK"

# ── 1b. One-line install: fetch the source into a staging folder ──────────────
# Everything from here to the swap in step 3b happens in $Stage; the live install
# is not touched until the new one has built and its browser has launched.
# Runtime state (sessions, browser profile, caches) lives under %APPDATA% and
# %LOCALAPPDATA%\ms-playwright, never in the install folder, so replacing the
# folder loses nothing. Twin of install.sh's step 1b.

# The commit main points at right now, for .install.json. Optional: when
# GitHub's API says no, the branch zip is fetched and the commit is unknown.
function Resolve-Commit {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Headers @{ Accept = 'application/vnd.github.sha' } -Uri "https://api.github.com/repos/$RepoSlug/commits/main"
    $sha = $r.Content
    if ($sha -is [byte[]]) { $sha = [System.Text.Encoding]::ASCII.GetString($sha) }
    $sha = "$sha".Trim()
    if ($sha -match '^[0-9a-f]{40}$') { return $sha }
  } catch { }
  return $null
}

# The install folder is replaced wholesale, so it has to be one this script
# owns: absent, empty, or carrying .install.json. Anything else is refused,
# never moved aside. Twin of install.sh's install_dir_is_ours.
function Test-InstallDirOurs ($dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return $true }
  if (Test-Path -LiteralPath (Join-Path $dir '.install.json')) { return $true }
  return (Test-Path -LiteralPath $dir -PathType Container) -and -not (Get-ChildItem -LiteralPath $dir -Force | Select-Object -First 1)
}

if ($Mode -eq 'bootstrap') {
  if (-not (Test-InstallDirOurs $InstallDir)) {
    Die "$InstallDir exists and was not made by this installer (no .install.json). Move it, or set `$env:PLAYWRIGHT_MCP_HOME to another folder, and re-run. To build a clone in place, run .\install.ps1 inside it."
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $InstallDir) | Out-Null
  foreach ($p in @($Stage, "$Stage.zip", "$Stage.unpack", $Old)) {
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
  }

  $Commit = Resolve-Commit
  $ref = if ($Commit) { $Commit } else { 'refs/heads/main' }
  $SourceUrl = "https://codeload.github.com/$RepoSlug/zip/$ref"
  $label = if ($Commit) { "main at $($Commit.Substring(0, 12))" } else { 'main' }
  Say "Downloading playwright-mcp ($label) into $Stage…"
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $SourceUrl -OutFile "$Stage.zip"
    Expand-Archive -LiteralPath "$Stage.zip" -DestinationPath "$Stage.unpack" -Force
    # The zip holds one top folder, playwright-mcp-main or playwright-mcp-<sha>.
    $top = Get-ChildItem -LiteralPath "$Stage.unpack" -Directory | Select-Object -First 1
    if (-not $top) { throw 'the zip is empty' }
    Move-Item -LiteralPath $top.FullName -Destination $Stage
    Remove-Item -LiteralPath "$Stage.zip", "$Stage.unpack" -Recurse -Force
  } catch {
    Die "Download or unpack failed ($($_.Exception.Message)): $SourceUrl. Nothing was changed."
  }
  if (-not (Test-OwnCheckout $Stage)) { Die "The download does not look like playwright-mcp. Nothing was changed." }

  $IncomingVersion = Read-Version (Join-Path $Stage 'package.json')
  $InstalledVersion = ''
  if (Test-Path -LiteralPath (Join-Path $InstallDir 'package.json')) { $InstalledVersion = Read-Version (Join-Path $InstallDir 'package.json') }
  if (-not $InstalledVersion) {
    Say "fresh install: $(if ($IncomingVersion) { $IncomingVersion } else { 'unknown' })"
  } elseif ($IncomingVersion -and (Test-VersionOlder $IncomingVersion $InstalledVersion)) {
    if (-not $ForceDowngrade) {
      Die "Refusing to downgrade: $InstallDir has $InstalledVersion and the download is $IncomingVersion. Nothing was changed. Re-run with -Force (or `$env:PLAYWRIGHT_MCP_FORCE='1') to install the older one anyway."
    }
    Warn "installed: $InstalledVersion -> $IncomingVersion (downgrade, forced)"
  } elseif ($IncomingVersion -eq $InstalledVersion) {
    Say "installed: $InstalledVersion -> $IncomingVersion (already at this version; rebuilding it)"
  } else {
    Say "installed: $InstalledVersion -> $IncomingVersion"
  }
  $Here = $Stage
}

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

# ── 3b. One-line install: record it, then swap it into place ──────────────────
# Two renames: the old install steps aside, the new one takes its name, and only
# then is the old one deleted. If the second rename fails the first is undone.
# Windows refuses to rename a folder something has open, so a running Claude
# Code or Codex session using the old install is the likely cause of a failure.
if ($Mode -eq 'bootstrap') {
  $record = [ordered]@{
    version     = $(if ($IncomingVersion) { $IncomingVersion } else { 'unknown' })
    commit      = $Commit
    source      = $SourceUrl
    installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  [System.IO.File]::WriteAllText((Join-Path $Stage '.install.json'), (($record | ConvertTo-Json) + "`n"), (New-Object System.Text.UTF8Encoding $false))
  if (Test-Path -LiteralPath $InstallDir) {
    try { Move-Item -LiteralPath $InstallDir -Destination $Old }
    catch { Die "Could not move the previous install aside ($($_.Exception.Message)). Close Claude Code and Codex, then re-run. Nothing was changed." }
  }
  try { Move-Item -LiteralPath $Stage -Destination $InstallDir }
  catch {
    if (Test-Path -LiteralPath $Old) { Move-Item -LiteralPath $Old -Destination $InstallDir -ErrorAction SilentlyContinue }
    Die "Could not move the new build into $InstallDir ($($_.Exception.Message)). The previous install was put back."
  }
  if (Test-Path -LiteralPath $Old) {
    Remove-Item -LiteralPath $Old -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $Old) { Warn "Could not delete the previous install at $Old; remove it once nothing is using it." }
  }
  $Here = $InstallDir
  Say "Installed playwright-mcp $($record.version) at $Here (recorded in $(Join-Path $Here '.install.json'))"
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

# Crush has no `mcp add` subcommand, so merge-crush.mjs edits its global config:
# an existing crush.json entry is updated in place, otherwise a marked block is
# written to crushrc. A re-run changes nothing unless the install path moved.
if ($hasCrush) {
  Say "Registering playwright-mcp with Crush…"
  $mergeCrush = Join-Path $Here "scripts\merge-crush.mjs"
  $crushPreview = node $mergeCrush node "$entry" --print
  if ($LASTEXITCODE -ne 0) {
    Warn "Skipped Crush registration (see the message above)."
  } elseif (-not $crushPreview) {
    Say "Already registered with Crush — nothing to change."
  } else {
    $crushPreview | ForEach-Object { Write-Host $_ }
    node $mergeCrush node "$entry" --write
    if ($LASTEXITCODE -eq 0) { Say "Registered with Crush. Restart Crush to load it." }
    else { Warn "Could not write the Crush config shown above; Crush registration skipped." }
  }
} else {
  Warn "Skipped Crush registration. Once 'crush' is installed, add this line to ~\.config\crush\crushrc:"
  Write-Host "    mcp add playwright-mcp --type stdio --command node --args '$entry' --timeout 300"
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

Say "Done. playwright-mcp $(Read-Version (Join-Path $Here 'package.json')) is installed at $Here."
Say "Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
}
