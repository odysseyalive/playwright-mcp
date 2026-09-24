# deploy/jstack — run this connector as a claude.ai custom connector via jstack

Template files to deploy the playwright-mcp remote connector as a [jstack](https://jstack.cx)
site (Docker + nginx + Let's Encrypt). **Every server-specific / identifiable value
lives only in `.env`** (see `.env.example`); the compose file and nginx script read
from it and hardcode nothing. Copy these into a jstack site directory and fill `.env`.

## Files
| File | Purpose |
|---|---|
| `.env.example` | Template for `.env` — the single place for your domain, port, container name, public URL, and GitHub OAuth creds. Copy to `.env`, fill in, `chmod 600`. The real `.env` is gitignored; never commit it. |
| `docker-compose.yml` | jstack site service. Container name comes from `${CONTAINER}`; no host port published; Chromium sandbox kept on via `cap_drop: ALL` + relaxed seccomp. |
| `patch-nginx-sse.sh` | Rewrites the nginx vhost with SSE-friendly proxy settings (unbuffered, long read timeout) + Cloudflare real-IP. Reads `DOMAIN`/`PORT`/`CONTAINER` from `.env`. Re-run after every `jstack.sh --install-site`. |

The connector image is built from this repo (`../../Dockerfile`).

## Deploy

On the jstack host, from the jstack root. Set `SITE` to your domain's site directory, e.g. `sites/mcp.example.com`.

```sh
SITE=sites/<your-domain>
```

```sh
mkdir -p "$SITE"
```

```sh
cp /path/to/playwright-mcp/deploy/jstack/{docker-compose.yml,patch-nginx-sse.sh,.env.example} "$SITE/"
```

```sh
cp "$SITE/.env.example" "$SITE/.env"
```

```sh
chmod 600 "$SITE/.env"
```

Edit `"$SITE/.env"` and set `DOMAIN`, `PORT`, `CONTAINER`, `PLAYWRIGHT_MCP_PUBLIC_URL`, and the `GITHUB_*` values.

This builds the image, starts the container, and provisions nginx + the TLS cert.

```sh
DBUSER=unused DBPASS=unused ./jstack.sh --install-site "$SITE"
```

Apply the SSE-tuned vhost config.

```sh
./"$SITE"/patch-nginx-sse.sh
```

Prerequisites and the full walk-through (GitHub OAuth app, DNS, Cloudflare grey→orange,
adding the connector in Claude) are in [`../../docs/REMOTE-CONNECTOR.md`](../../docs/REMOTE-CONNECTOR.md).

> `docker-compose.yml`'s build context is `../../../playwright-mcp`, i.e. it assumes the
> site dir sits at `jstack/sites/<domain>/` next to a sibling `playwright-mcp` checkout.

## Notes
- **No host port** is published — only the jstack nginx container reaches the connector
  over the docker network, by `${CONTAINER}` name.
- **TLS renews automatically** through Cloudflare's proxy (the ACME challenge path is
  passed to the origin), so no Cloudflare Origin Cert is required. `patch-nginx-sse.sh`
  supports `ORIGIN_CERT=1` if you ever want one anyway.
- The connector's own security model (GitHub-OAuth gate, remote tool denylist, SSRF
  egress block) is documented in `../../docs/REMOTE-CONNECTOR.md`.
