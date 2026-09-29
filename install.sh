#!/usr/bin/env bash
#
# install.sh — Linux/macOS installer for playwright-mcp.
#
# Builds the server, downloads headless Chromium, registers the server at USER
# scope with Claude Code (so every project gets it), routes Claude's page
# fetching and browser work to it, and appends a steering note to
# ~/.claude/CLAUDE.md (once — guarded by a marker). Idempotent + non-interactive:
# safe to re-run, never prompts.
#
# The routing is two entries in ~/.claude/settings.json permissions.deny:
# WebFetch and mcp__claude-in-chrome. They take the built-in fetcher and the
# Chrome extension out of the way so Claude uses web_fetch and browser_*
# instead. They never block a playwright-mcp tool, and native WebSearch stays.
#
# Flags:
#   --yes        accepted but no longer needed (back-compat no-op; nothing prompts)
#
# No flag switches off any part of the install; the routing and the steering
# directive are always applied. Anything else on the line — including the retired --no-deny and
# --no-steer — is warned about on stderr and ignored rather than rejected, so an
# old script that still passes one keeps working.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for arg in "$@"; do
  case "$arg" in
    --yes) ;;  # back-compat no-op: the installer no longer prompts
    *) echo "ignoring unknown flag: $arg" >&2 ;;
  esac
done

# Colour only on a terminal, and never when NO_COLOR is set (no-color.org): a
# piped or captured log (Claude Code's `!` runner, `| tee`) otherwise shows the
# raw escapes as literal "[1;36m==>[0m". stdout and stderr are checked apart,
# since die writes to stderr and either one can be redirected alone.
SAY_C=; WARN_C=; OUT_R=; ERR_C=; ERR_R=
if [ -z "${NO_COLOR:-}" ] && [ -t 1 ]; then SAY_C='\033[1;36m'; WARN_C='\033[1;33m'; OUT_R='\033[0m'; fi
if [ -z "${NO_COLOR:-}" ] && [ -t 2 ]; then ERR_C='\033[1;31m'; ERR_R='\033[0m'; fi
say()  { printf "${SAY_C}==>${OUT_R} %s\n" "$*"; }
warn() { printf "${WARN_C}!  ${OUT_R} %s\n" "$*"; }
die()  { printf "${ERR_C}ERR${ERR_R} %s\n" "$*" >&2; exit 1; }

# ── 1. Node ≥ 22.13 ───────────────────────────────────────────────────────────
# jsdom 29 (^20.19.0 || ^22.13.0 || >=24.0.0) and pdfjs-dist 6 (>=22.13.0 || >=24)
# intersect at 22.13.0, and npm only WARNS on an engines mismatch — so this guard
# is what turns a confusing runtime failure inside a PDF or DOM parse into a clear
# install-time one. MAJOR.MINOR compare: 22.12 is rejected, 22.13 and later pass.
# Pure function of a version string — it never reads process.versions itself.
node_ok() {
  local rest major minor
  major="${1%%.*}"
  rest="${1#*.}"
  minor="${rest%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }
}

# Too old or missing: fetch the current LTS from nodejs.org into the user's cache,
# checksum-verified, and use it for everything below. No root, no version manager,
# and the system Node is left alone. The server is then registered with this
# Node's absolute path, so Claude Code never starts it on the system's old one.
# Measured 2026-09-26: a host with Node 18.17.1 stopped here with only a pointer
# to the README; this fetch is what that README section told a person to do.
PRIVATE_NODE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/playwright-mcp/node"
NODE_CMD=node

fetch() { # url -> stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  elif command -v node >/dev/null 2>&1; then # an old Node (18+) still has fetch()
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) process.exit(1); process.stdout.write(Buffer.from(await r.arrayBuffer())); }, () => process.exit(1))' "$1"
  else die "Need curl, wget, or any Node.js 18+ to download Node.js."; fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_node() {
  local os arch ver name tmp want got
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "No automatic Node.js download for $(uname -s). Install Node >=22.13.0 and re-run." ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "No automatic Node.js download for $(uname -m). Install Node >=22.13.0 and re-run." ;; esac
  # index.tab is newest first; column 10 is the LTS codename, "-" when not LTS.
  # awk reads to the end (no early exit): closing the pipe early breaks the
  # download with SIGPIPE, and pipefail turns that into a failed install.
  ver="$(fetch https://nodejs.org/dist/index.tab | awk -F'\t' '!v && NR > 1 && $10 != "-" { v = $1 } END { print v }')"
  [ -n "$ver" ] || die "Could not read the current Node.js LTS version from nodejs.org."
  name="node-$ver-$os-$arch"
  say "Downloading Node.js $ver (LTS) into $PRIVATE_NODE_DIR (no root needed)…"
  tmp="$(mktemp -d)"
  fetch "https://nodejs.org/dist/$ver/$name.tar.gz" > "$tmp/$name.tar.gz" || { rm -rf "$tmp"; die "Node.js download failed."; }
  want="$(fetch "https://nodejs.org/dist/$ver/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')"
  got="$(sha256_of "$tmp/$name.tar.gz")"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then rm -rf "$tmp"; die "Node.js download failed its checksum; nothing was installed."; fi
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$PRIVATE_NODE_DIR"
  mkdir -p "$(dirname "$PRIVATE_NODE_DIR")"
  mv "$tmp/$name" "$PRIVATE_NODE_DIR"
  rm -rf "$tmp"
}

system_node_ok() { command -v node >/dev/null 2>&1 && node_ok "$(node -p 'process.versions.node' 2>/dev/null)"; }

if ! system_node_ok; then
  if command -v node >/dev/null 2>&1; then warn "System Node $(node -v) is older than 22.13.0; using a private one instead."
  else warn "No Node.js on PATH; using a private one."; fi
  if ! { [ -x "$PRIVATE_NODE_DIR/bin/node" ] && node_ok "$("$PRIVATE_NODE_DIR/bin/node" -p 'process.versions.node' 2>/dev/null)"; }; then
    fetch_node
  fi
  "$PRIVATE_NODE_DIR/bin/node" -v >/dev/null 2>&1 || die "The downloaded Node.js does not run on this host (its C library may be too old). Install Node >=22.13.0 and re-run."
  export PATH="$PRIVATE_NODE_DIR/bin:$PATH"
  NODE_CMD="$PRIVATE_NODE_DIR/bin/node"
fi
NODE_VER="$(node -p 'process.versions.node')"
node_ok "$NODE_VER" || die "Node >=22.13.0 required; found $(node -v)."
command -v claude >/dev/null 2>&1 || warn "Claude Code CLI 'claude' not found on PATH — the registration step will be skipped."
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
# wherever the libs are present (every desktop, macOS, Windows). A bare Linux box
# (minimal container, server, WSL) with no desktop libs is handled next, without
# root: the step after the download fetches the missing packages into the user's
# cache. The installer never installs anything system-wide.
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

# Linux: if Chromium's system libraries are missing (a bare server), fetch the
# distro's own packages and unpack them into ~/.cache/playwright-mcp/sysroot as
# the user. No root. A host where that is impossible fails here, naming the libs.
say "Checking Chromium's system libraries…"
( cd "$HERE" && node scripts/provision-libs.mjs ) || die "Chromium's system libraries could not be provided. See the error above."

# Prove it launches. The server starts the real Google Chrome when the host has
# one, else this bundled Chromium; check-browser.mjs launches exactly that, so a
# host where no browser can start fails HERE instead of printing "Done" and
# leaving every browser tool dead (measured 2026-09-26 on no-sudo hosting).
say "Checking that the browser launches…"
( cd "$HERE" && node scripts/check-browser.mjs ) || die "No working browser. See the error above, fix it, and re-run this installer."

# ── 4. Register at user scope (idempotent) ────────────────────────────────────
if command -v claude >/dev/null 2>&1; then
  say "Registering playwright-mcp at user scope with Claude Code…"
  claude mcp remove --scope user playwright-mcp >/dev/null 2>&1 || true
  claude mcp add --scope user playwright-mcp -- "$NODE_CMD" "$HERE/dist/index.js"
  say "Registered with Claude Code. Check with: claude mcp list"
else
  warn "Skipped Claude Code registration. Run manually once 'claude' is installed:"
  echo "    claude mcp add --scope user playwright-mcp -- \"$NODE_CMD\" \"$HERE/dist/index.js\""
fi

if command -v codex >/dev/null 2>&1; then
  say "Registering playwright-mcp with Codex…"
  codex mcp remove playwright-mcp >/dev/null 2>&1 || true
  codex mcp add playwright-mcp -- "$NODE_CMD" "$HERE/dist/index.js"
  say "Registered with Codex. Check with: codex mcp list"
else
  warn "Skipped Codex registration. Run manually once 'codex' is installed:"
  echo "    codex mcp add playwright-mcp -- \"$NODE_CMD\" \"$HERE/dist/index.js\""
fi

# ── 5. Route fetching + browser work to playwright-mcp ────────────────────────
# Always applied. Adds only WebFetch and mcp__claude-in-chrome to
# permissions.deny (and drops a stale WebSearch deny from older installs);
# every other setting is left as it is. A re-run finds both and changes nothing.
SETTINGS="$HOME/.claude/settings.json"
say "Routing page fetches and browser work to playwright-mcp in $SETTINGS"
mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
PREVIEW="$(node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --print)" || die "could not read $SETTINGS"
if [ -z "$PREVIEW" ]; then
  say "Routing already in place — nothing to change."
else
  echo "----- change to settings.json (your other settings untouched) -----"
  echo "$PREVIEW"
  echo "-------------------------------------------------------------------"
  node "$HERE/scripts/merge-deny.mjs" "$SETTINGS" --write
  say "Done. Claude now fetches pages with web_fetch and drives browsers with"
  say "playwright-mcp's browser_* tools instead of built-in WebFetch and the"
  say "Chrome extension. No playwright-mcp tool is blocked; WebSearch stays on."
fi

# ── 6. Steering directive ─────────────────────────────────────────────────────
# Always applied, with no opt-out: it is what points Claude at the tools this
# script just installed. Idempotence comes from the marker, not from a flag —
# a re-run finds STEER_MARK and appends nothing.
USER_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
STEER_MARK="playwright-mcp steering"
steer() {
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
}
steer

say "Done. Restart Claude Code, then run /mcp in any project to see mcp__playwright-mcp__* tools."
