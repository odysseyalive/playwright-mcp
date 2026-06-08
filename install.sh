#!/usr/bin/env bash
#
# install.sh — Linux/macOS installer for playwright-mcp.
#
# Builds the server, downloads headless Chromium, registers the server at USER
# scope with Claude Code (so every project gets it), and offers the
# WebSearch/WebFetch/claude-in-chrome override (prompted, with a diff — never
# silent). Idempotent: safe to re-run.
#
# Flags:
#   --yes        non-interactive: accept the settings + steering changes
#   --no-deny    skip the settings.json deny override entirely
#   --no-steer   skip the ~/.claude/CLAUDE.md steering directive
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSUME_YES=0
DO_DENY=1
DO_STEER=1
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --no-deny) DO_DENY=0 ;;
    --no-steer) DO_STEER=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERR\033[0m %s\n' "$*" >&2; exit 1; }

confirm() {
  # confirm "question" -> 0 if yes
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r reply </dev/tty || return 1
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# ── 1. Node ≥ 18 ──────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required (>=18). Install it and re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >=18 required; found $(node -v)."
command -v claude >/dev/null 2>&1 || warn "Claude Code CLI 'claude' not found on PATH — the registration step will be skipped."
say "Node $(node -v) OK"

# ── 2. Install deps + build ───────────────────────────────────────────────────
say "Installing dependencies…"
( cd "$HERE" && { npm ci 2>/dev/null || npm install; } )
say "Building (tsc → dist/)…"
( cd "$HERE" && npm run build )

# ── 3. Download headless Chromium ─────────────────────────────────────────────
# --with-deps installs the system libraries Chromium needs on Linux.
OS="$(uname -s)"
if [ "$OS" = "Linux" ]; then
  say "Downloading Chromium (+ system deps; may prompt for sudo)…"
  ( cd "$HERE" && npx playwright install --with-deps chromium ) || \
    { warn "--with-deps failed (no sudo?); retrying without system deps"; ( cd "$HERE" && npx playwright install chromium ); }
else
  say "Downloading Chromium…"
  ( cd "$HERE" && npx playwright install chromium )
fi

# ── 4. Register at user scope (idempotent) ────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  say "Registering playwright-mcp at user scope…"
  claude mcp remove --scope user playwright-mcp >/dev/null 2>&1 || true
  claude mcp add --scope user playwright-mcp -- node "$HERE/dist/index.js"
  say "Registered. Check with: claude mcp list"
else
  warn "Skipped registration. Run manually once 'claude' is installed:"
  echo "    claude mcp add --scope user playwright-mcp -- node \"$HERE/dist/index.js\""
fi

# ── 5. Override native WebSearch/WebFetch + claude-in-chrome ──────────────────
SETTINGS="$HOME/.claude/settings.json"
if [ "$DO_DENY" = "1" ]; then
  say "Preparing WebSearch/WebFetch/claude-in-chrome override for $SETTINGS"
  mkdir -p "$HOME/.claude"
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  # Compute the merged result and a diff with Node (guaranteed present).
  PREVIEW="$(node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --print)" || die "could not read $SETTINGS"
  if [ -z "$PREVIEW" ]; then
    say "Deny rules already present — nothing to change."
  else
    echo "----- proposed change to settings.json -----"
    echo "$PREVIEW"
    echo "--------------------------------------------"
    if confirm "Apply these deny rules (merge, your other settings untouched)?"; then
      node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --write
      say "Applied. Native WebSearch/WebFetch + claude-in-chrome are now denied."
    else
      warn "Skipped. Web access will NOT route through playwright-mcp until you add:"
      echo '    "permissions": { "deny": ["WebSearch","WebFetch","mcp__claude-in-chrome"] }'
    fi
  fi
fi

# ── 6. Steering directive (optional) ──────────────────────────────────────────
USER_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
STEER_MARK="playwright-mcp steering"
if [ "$DO_STEER" = "1" ]; then
  if [ -f "$USER_CLAUDE_MD" ] && grep -q "$STEER_MARK" "$USER_CLAUDE_MD" 2>/dev/null; then
    say "Steering directive already present in $USER_CLAUDE_MD"
  elif confirm "Add the playwright-mcp steering directive to $USER_CLAUDE_MD?"; then
    mkdir -p "$HOME/.claude"
    cat >> "$USER_CLAUDE_MD" <<'EOF'

<!-- playwright-mcp steering -->
Use playwright-mcp for ALL browser work: reviewing and debugging local dev
servers (localhost/127.0.0.1) and live sites, screenshots, and web search/fetch.
Use its web_search/web_fetch instead of the built-in WebSearch/WebFetch, and its
browser_* tools instead of the claude-in-chrome extension. Clean up temporary
screenshots and files at the end of every debug session.
EOF
    say "Added steering directive."
  else
    warn "Skipped steering directive."
  fi
fi

say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
echo
echo "To temporarily re-enable the Chrome extension for a session, remove"
echo "\"mcp__claude-in-chrome\" from the deny array in $SETTINGS."
