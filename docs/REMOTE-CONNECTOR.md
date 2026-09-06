# Remote connector (claude.ai) — deployment runbook

This server is normally **stdio-only** (Claude Code, local). Setting one env var —
`PLAYWRIGHT_MCP_PUBLIC_URL` — additionally stands up a **remote Streamable-HTTP
transport** so **claude.ai** can use it as a custom connector. The local stdio
surface is unchanged whether or not the remote transport runs.

> Decision record: `DEC-2026-06-26-remote-streamable-http-transport-claude-ai`
> (`.claude/skills/awareness-ledger/ledger/decisions/`).

This runbook is the **VPS deploy + claude.ai connect** procedure. Run it on the
host you intend to serve from (jstack/Debian assumed).

---

## What you get, and the security model

The remote surface deliberately differs from the local one:

- **Exposed remotely:** `web_fetch` + the browser tools not denylisted below
  (`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`,
  `browser_take_screenshot`, and the rest). An earlier version of this runbook
  included `browser_evaluate` here and described it as "the 'render JS +
  interact with the page' capability that motivated the connector." That
  conflated three things. Rendering JS-heavy pages is what headless Chromium
  does unaided. It is why the connector runs Playwright at all, and `web_fetch`
  stealth-renders without `browser_evaluate`. Interaction is `browser_click`,
  `browser_type`, `browser_fill_form`, `browser_select_option`,
  `browser_press_key`, `browser_snapshot`, all still exposed.
  `browser_evaluate` injects script into page context. It does neither, and the
  connector keeps its stated purpose without it.
- **Denylisted remotely** (filtered from `tools/list` **and** rejected by
  `tools/call`), in two tiers. Six are denied on every non-stdio surface,
  including the local no-auth option: `browser_run_code_unsafe`,
  `browser_evaluate`, `browser_file_upload`, `session_scaffold_tests`,
  `suite_scaffold`, `suite_audit`. Four more are denied on the cloud (OAuth)
  surface only: `session_login`, `session_status`, `session_solve_challenge`,
  `session_attach`. The cloud surface drops all ten. The no-auth surface keeps
  the second group because none of them act autonomously. Three open a headed
  window for the human; `session_status` only reports whether a saved session
  exists. None of this touches the local stdio surface. Claude Code on your own
  machine still has every tool, `browser_evaluate` included.
- **Authenticated** with GitHub-backed OAuth, locked to **one** GitHub login.
- **Hardened** three ways, because the driving LLM is prompt-injectable by any
  page it visits: (1) GitHub OAuth, (2) an OS-level **egress block** to cloud
  metadata / localhost / private networks (primary SSRF control), (3) a
  **secrets-free** deployment (no `secrets.env`, no sessions dir on this host).

None of these replaces the others, and none of them solves prompt injection.
The full posture, including the non-fixes, is in the main
[README](../README.md#untrusted-content-and-prompt-injection). Ship all three.

---

## Prerequisites

- Node ≥ 18 and this repo built (`npm ci && npm run build`) on the host.
- Chromium for Playwright installed for the service user (`npx playwright install chromium`).
- A DNS name for the connector, e.g. `mcp.example.com`, pointed at the host.
- nginx + certbot (jstack provides these).
- A GitHub account (for the OAuth app).

---

## 1. Create the GitHub OAuth app

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

| Field | Value |
|---|---|
| Application name | anything, e.g. `playwright-mcp connector` |
| Homepage URL | `https://mcp.example.com` |
| **Authorization callback URL** | `https://mcp.example.com/oauth/github/callback` |

Generate a client secret. You now have `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`.

> The callback above is **GitHub → this server**. claude.ai's own callback
> (`https://claude.ai/api/mcp/auth_callback`) is registered automatically via
> Dynamic Client Registration — you do not configure it anywhere.

---

## 2. Service environment

Put the remote config in a root-owned, mode-600 env file — **not** in the unit
file, and **not** in `secrets.env` (which this host must not have):

`/etc/playwright-mcp/remote.env` (`chmod 600`, `chown root:pwmcp`):

```sh
PLAYWRIGHT_MCP_PUBLIC_URL=https://mcp.example.com
PLAYWRIGHT_MCP_PORT=8765
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_ALLOWED_LOGIN=your-github-login
```

If the `GITHUB_*` trio is absent (and you have not set
`PLAYWRIGHT_MCP_ALLOW_NOAUTH=1`), the server **refuses to start the remote
transport** — it fails closed rather than exposing an unauthenticated browser.

`PLAYWRIGHT_MCP_ALLOW_NOAUTH=1` exists for **localhost dev only**. Never set it on
a public host.

---

## 3. systemd service (dedicated, unprivileged, secrets-free)

```sh
useradd --system --home /opt/playwright-mcp --shell /usr/sbin/nologin pwmcp
```

`/etc/systemd/system/playwright-mcp-remote.service`:

```ini
[Unit]
Description=playwright-mcp remote connector (claude.ai)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pwmcp
WorkingDirectory=/opt/playwright-mcp
EnvironmentFile=/etc/playwright-mcp/remote.env
ExecStart=/usr/bin/node /opt/playwright-mcp/dist/index.js
Restart=on-failure
RestartSec=2

# Secrets-free + least privilege. Do NOT mount secrets.env or the sessions dir.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/playwright-mcp
# Chromium needs a cache dir; keep it under the service home (XDG_CACHE_HOME).
Environment=XDG_CACHE_HOME=/opt/playwright-mcp/.cache

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now playwright-mcp-remote
journalctl -u playwright-mcp-remote -f   # expect: "remote ... ready ... auth: on"
```

The service binds **127.0.0.1:8765 only** — it is never directly reachable from
the internet. nginx is the sole public listener.

---

## 4. nginx TLS vhost (SSE-friendly + Anthropic IP allowlist)

claude.ai connects from **Anthropic's published IP ranges**, not your device, so
lock inbound to those ranges. See the "Anthropic IP addresses" page linked from
the [custom-connectors docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

`/etc/nginx/sites-available/mcp.example.com`:

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;
    server_tokens off;
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Inbound allowlist — only Anthropic's egress can reach the connector.
    include /etc/nginx/anthropic-allowlist.conf;   # generated in §5
    deny all;

    # Streamable HTTP + SSE: no buffering, long-lived GET stream.
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600s;
    }
}
server {
    listen 80;
    server_name mcp.example.com;
    return 301 https://$host$request_uri;
}
```

```sh
ln -s ../sites-available/mcp.example.com /etc/nginx/sites-enabled/
certbot --nginx -d mcp.example.com        # or certonly, if you manage vhosts by hand
nginx -t && systemctl reload nginx
```

The whole vhost (not just `/mcp`) proxies to the app, because the OAuth router
serves `/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke`, and
`/oauth/github/callback` at the root.

---

## 5. Anthropic IP allowlist auto-refresh

Anthropic's ranges change; regenerate `anthropic-allowlist.conf` on a schedule.
Point `SRC` at the current published ranges (JSON or text list of CIDRs) from the
"Anthropic IP addresses" page, then:

`/usr/local/sbin/refresh-anthropic-allowlist.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
SRC="https://<anthropic-published-ip-ranges-url>"   # from the Anthropic IP addresses page
OUT=/etc/nginx/anthropic-allowlist.conf
TMP="$(mktemp)"
# Adapt the parse to the published format (this assumes one CIDR per line):
curl -fsS "$SRC" | grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}' | sort -u \
  | sed 's/^/allow /; s/$/;/' > "$TMP"
[ -s "$TMP" ] || { echo "empty allowlist, refusing to apply" >&2; exit 1; }
mv "$TMP" "$OUT"
nginx -t && systemctl reload nginx
```

```sh
chmod 755 /usr/local/sbin/refresh-anthropic-allowlist.sh
# run once now, then daily via cron/timer:
echo '17 4 * * * root /usr/local/sbin/refresh-anthropic-allowlist.sh' > /etc/cron.d/anthropic-allowlist
```

The `[ -s "$TMP" ]` guard means a fetch failure leaves the last good list in
place instead of locking claude.ai out (or worse, emptying `deny all`'s partner).

---

## 6. OS-level egress block (primary SSRF control)

The in-process guard (`src/egress.ts`) is a backstop; the **real** control is an
outbound firewall on the service user. nftables example:

```nft
table inet pwmcp_egress {
    chain output {
        type filter hook output priority 0; policy accept;
        # Restrict ONLY the connector's user.
        meta skuid "pwmcp" ip  daddr { 169.254.0.0/16, 127.0.0.0/8, 10.0.0.0/8, \
            172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } drop
        meta skuid "pwmcp" ip6 daddr { ::1, fc00::/7, fe80::/10 } drop
    }
}
```

This blocks the browser (a child of the service process, same uid) from reaching
cloud metadata (`169.254.169.254`), localhost services, and private networks,
while still allowing it to fetch public sites and reach GitHub over TLS.

> Containerized (jstack docker) alternative: run the connector in its own network
> namespace with an egress policy denying RFC1918 + `169.254.0.0/16`, and do not
> mount `secrets.env` or the sessions volume.

---

## 7. Add the connector in claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://mcp.example.com/mcp`.
3. claude.ai discovers OAuth (401 → protected-resource metadata), registers via
   DCR, and sends you through **GitHub login**.
4. Log in as the allowed GitHub user. Any other GitHub user is rejected
   (`access_denied`) at the callback.
5. The connector's tools appear; enable it per-conversation via the **+** menu.

---

## 8. Verification checklist

- `journalctl -u playwright-mcp-remote` shows `auth: on` and `ready`.
- `curl https://mcp.example.com/.well-known/oauth-authorization-server` returns
  JSON with `issuer` = your public URL (from an allowlisted IP), and
  `authorization_response_iss_parameter_supported: true` — the RFC 9207 flag from
  MCP spec 2026-07-28. If that field is missing, an old build is running.
- `curl -X POST https://mcp.example.com/mcp` (no token) → `401` with a
  `WWW-Authenticate: Bearer …` header.
- In claude.ai, the connector lists `web_fetch` + browser tools but **not**
  `browser_run_code_unsafe` / `session_login`.
- A page fetch of `http://169.254.169.254/` or a localhost URL fails (egress
  block) — confirm the firewall is doing its job.

The deterministic half of all this is covered by `npm test`
(`scripts/test-remote.mjs`): denylist, OAuth metadata/DCR/redirect/401, the RFC
9207 `iss` parameter on both the success and denial redirects, the session-binding
banner, and the egress classifier. The **live** GitHub login + claude.ai handshake
is what you verify here, on the server.

---

## Dependency advisories (assessed)

`npm audit` reports highs in transitive deps that predate this feature and are
**not introduced by it**: `hono` (via `@modelcontextprotocol/sdk`), `undici` (via
`jsdom`), `esbuild` (via `tsx`, dev-only). Their advisories are Windows-,
AWS-Lambda-, or SOCKS5-proxy-specific and do **not** apply to this Linux,
nginx-fronted, non-Lambda deployment. They are locked by their parents, so
`npm audit fix --force` would bump the exact-pinned SDK/jsdom/tsx and risk the
build for non-applicable issues — don't. Re-check when the SDK ships a patched
`@hono/node-server`.
