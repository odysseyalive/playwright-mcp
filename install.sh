#!/usr/bin/env bash
#
# install.sh — Linux/macOS installer for playwright-mcp.
#
# Builds the server, downloads headless Chromium, registers the server at USER
# scope with Claude Code (so every project gets it), and applies the
# WebFetch/claude-in-chrome override automatically, printing a diff of what it
# changes. Native WebFetch stays enabled. Idempotent + non-interactive: safe to
# re-run, never prompts. Opt out of the global-config edits with --no-deny/--no-steer.
#
# Flags:
#   --no-deny    skip the settings.json deny override entirely
#   --no-steer   skip the ~/.claude/CLAUDE.md steering directive
#   --yes        accepted but no longer needed (back-compat no-op; nothing prompts)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DO_DENY=1
DO_STEER=1
for arg in "$@"; do
  case "$arg" in
    --no-deny) DO_DENY=0 ;;
    --no-steer) DO_STEER=0 ;;
    --yes) ;;  # back-compat no-op: the installer no longer prompts
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Node ≥ 18 ──────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required (>=18). Install it and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >=18 required; found $(node -v)."
command -v claude >/dev/null 2>&1 || warn "Claude Code CLI 'claude' not found on PATH — the registration step will be skipped."
command -v codex >/dev/null 2>&1 || warn "Codex CLI 'codex' not found on PATH — the registration step will be skipped."
say "Node $(node -v) OK"

# ── 2. Install deps + build ───────────────────────────────────────────────────
say "Installing dependencies…"
( cd "$HERE" && { npm ci 2>/dev/null || npm install; } )
say "Building (tsc → dist/)…"
( cd "$HERE" && npm run build )

# ── 3. Download Chromium ──────────────────────────────────────────────────────
# Just the browser binary — Playwright fetches it from Microsoft's CDN into the
# per-OS cache (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on
# macOS, %LOCALAPPDATA%\ms-playwright on Windows). No OS package manager, no sudo,
# the same one command on macOS / Linux / Windows alike.
#
# We deliberately do NOT pass --with-deps. That flag only auto-installs Chromium's
# native system libraries (libnss3, libgbm1, …) via apt — Debian/Ubuntu only — so
# it breaks on apt-less distros (Arch, Fedora) and is unnecessary on a desktop,
# where those libs already exist from the graphics stack. Those libraries are a
# runtime requirement of the Chromium BINARY regardless of headless vs headed, so
# dropping --with-deps does not affect headless operation: headless still works
# wherever the libs are present (every desktop, macOS, Windows). The lone
# exception is a bare/headless Linux box (minimal container, server, WSL) with no
# desktop libs — there, run `npx playwright install-deps` or use the official
# Playwright Docker image. The installer never invokes a system package manager.
#
# pw_install filters Playwright's "BEWARE: your OS is not officially supported…"
# lines (printed on distros it has no native build for, e.g. Arch — the Ubuntu
# fallback build it downloads runs fine). Real exit status comes from PIPESTATUS.
pw_install() {
  set +e
  ( cd "$HERE" && "$@" ) 2>&1 | grep -vE '^BEWARE: your OS is not officially supported'
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

say "Downloading Chromium…"
pw_install npx playwright install chromium

# ── 4. Register at user scope (idempotent) ────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  say "Registering playwright-mcp at user scope with Claude Code…"
  claude mcp remove --scope user playwright-mcp >/dev/null 2>&1 || true
  claude mcp add --scope user playwright-mcp -- node "$HERE/dist/index.js"
  say "Registered with Claude Code. Check with: claude mcp list"
else
  warn "Skipped Claude Code registration. Run manually once 'claude' is installed:"
  echo "    claude mcp add --scope user playwright-mcp -- node \"$HERE/dist/index.js\""
fi

if command -v codex >/dev/null 2>&1; then
  say "Registering playwright-mcp with Codex…"
  codex mcp remove playwright-mcp >/dev/null 2>&1 || true
  codex mcp add playwright-mcp -- node "$HERE/dist/index.js"
  say "Registered with Codex. Check with: codex mcp list"
else
  warn "Skipped Codex registration. Run manually once 'codex' is installed:"
  echo "    codex mcp add playwright-mcp -- node \"$HERE/dist/index.js\""
fi

# ── 5. Override native WebFetch + claude-in-chrome ────────────────────────────
SETTINGS="$HOME/.claude/settings.json"
if [ "$DO_DENY" = "1" ]; then
  say "Applying WebFetch/claude-in-chrome override for $SETTINGS"
  mkdir -p "$HOME/.claude"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  # Compute the merged result and a diff with Node (guaranteed present).
  PREVIEW="$(node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --print)" || die "could not read $SETTINGS"
  if [ -z "$PREVIEW" ]; then
    say "Deny rules already present — nothing to change."
  else
    echo "----- applying this change to settings.json (your other settings untouched) -----"
    echo "$PREVIEW"
    echo "---------------------------------------------------------------------------------"
    node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --write
    say "Applied. WebFetch + claude-in-chrome are now denied; native WebSearch stays enabled."
  fi
fi

# ── 6. Steering directive (optional) ──────────────────────────────────────────
USER_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
STEER_MARK="playwright-mcp steering"
if [ "$DO_STEER" = "1" ]; then
  if [ -f "$USER_CLAUDE_MD" ] && grep -q "$STEER_MARK" "$USER_CLAUDE_MD" 2>/dev/null; then
    say "Steering directive already present in $USER_CLAUDE_MD"
  else
    mkdir -p "$HOME/.claude"
    say "Adding the playwright-mcp steering directive to $USER_CLAUDE_MD"
    cat >> "$USER_CLAUDE_MD" <<'EOF'

<!-- playwright-mcp steering -->
Use playwright-mcp for browser work: reviewing and debugging local dev servers
(localhost/127.0.0.1) and live sites, screenshots, and fetching/rendering pages.
For web SEARCH, use the native WebSearch tool for discovery, then verify and cite
the top results with playwright-mcp's web_fetch — or just run the /web-search
skill, which does that discover→verify pass for you. Use web_fetch instead of the
built-in WebFetch, and playwright-mcp's browser_* tools instead of the
claude-in-chrome extension. Do NOT scrape search engines. Clean up temporary
screenshots and files at the end of every debug session.
EOF
    say "Added steering directive."
  fi
fi

say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
echo
echo "To temporarily re-enable the Chrome extension for a session, remove"
echo "\"mcp__claude-in-chrome\" from the deny array in $SETTINGS."
