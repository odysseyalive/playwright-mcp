#!/usr/bin/env bash
# Re-apply the SSE-tuned nginx vhost for this connector site AFTER jstack has
# obtained the TLS cert. jstack's generated vhost uses default 60s proxy timeouts
# and response buffering, which break the connector's long-lived Streamable-HTTP
# (SSE) stream. This overwrites the vhost with an unbuffered, 1h-timeout version,
# plus Cloudflare real-IP restoration for when the record is proxied (orange).
#
# All site-specific values (domain, port, container) are read from ./.env — this
# script hardcodes nothing identifiable.
#
# Run AFTER `./jstack.sh --install-site sites/<domain>` reports HTTPS enabled.
# Re-run it any time you re-run --install-site. Needs write access to nginx/conf.d
# (use sudo if it errors).
#
# TLS: by default points at the Let's Encrypt cert. To use a Cloudflare Origin
# Certificate instead, set ORIGIN_CERT=1 and place the cert/key at
#   nginx/certbot/conf/cloudflare-origin/<domain>.pem   (cert)
#   nginx/certbot/conf/cloudflare-origin/<domain>.key   (private key)
set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSTACK_ROOT="$(cd "$SITE_DIR/../.." && pwd)"
ENV_FILE="$SITE_DIR/.env"
ORIGIN_CERT="${ORIGIN_CERT:-0}"

# Site-specific config comes entirely from .env (same contract jstack itself reads).
DOMAIN="$(grep -m1 '^DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
PORT="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d= -f2-)"
CONTAINER="$(grep -m1 '^CONTAINER=' "$ENV_FILE" | cut -d= -f2-)"
if [ -z "$DOMAIN" ] || [ -z "$PORT" ] || [ -z "$CONTAINER" ]; then
  echo "ERROR: DOMAIN/PORT/CONTAINER must be set in $ENV_FILE" >&2; exit 2
fi
CONF="$JSTACK_ROOT/nginx/conf.d/${DOMAIN}.conf"

if [ "$ORIGIN_CERT" = "1" ]; then
  CERT_LINE="ssl_certificate     /etc/letsencrypt/cloudflare-origin/${DOMAIN}.pem;"
  KEY_LINE="ssl_certificate_key /etc/letsencrypt/cloudflare-origin/${DOMAIN}.key;"
else
  CERT_LINE="ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;"
  KEY_LINE="ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;"
fi

cat > "$CONF" <<EOF
# ${DOMAIN} — playwright-mcp remote connector (claude.ai). SSE-tuned.
# NOTE: re-running \`jstack.sh --install-site\` overwrites this with the generic
# template — re-run patch-nginx-sse.sh afterwards to restore these settings.
server {
    listen 80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ {
        alias /var/www/certbot/.well-known/acme-challenge/;
    }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};

    ${CERT_LINE}
    ${KEY_LINE}

    server_tokens off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy "no-referrer" always;

    # Cloudflare real-IP restoration — effective when this record is PROXIED (orange),
    # harmless when DNS-only (grey). Makes nginx log + allowlist the TRUE client IP
    # instead of a Cloudflare edge IP. Refresh from https://www.cloudflare.com/ips-v4|v6.
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;
    set_real_ip_from 2400:cb00::/32;
    set_real_ip_from 2606:4700::/32;
    set_real_ip_from 2803:f800::/32;
    set_real_ip_from 2405:b500::/32;
    set_real_ip_from 2405:8100::/32;
    set_real_ip_from 2a06:98c0::/29;
    set_real_ip_from 2c0f:f248::/32;
    real_ip_header CF-Connecting-IP;

    # OPTIONAL defense-in-depth — restrict inbound to Anthropic's published ranges.
    # Works on BOTH grey (direct source IP) and orange (restored via real_ip above).
    # Verify current ranges at https://platform.claude.com/docs/en/api/ip-addresses.
    #allow 160.79.104.0/21;
    #allow 2607:6bc0::/48;
    #deny all;

    # Streamable HTTP + SSE: unbuffered, long-lived GET stream.
    location / {
        proxy_pass http://${CONTAINER}:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

echo "Wrote $CONF (domain=$DOMAIN container=$CONTAINER port=$PORT origin_cert=$ORIGIN_CERT)"
docker compose -f "$JSTACK_ROOT/docker-compose.yml" exec -T nginx nginx -t
docker compose -f "$JSTACK_ROOT/docker-compose.yml" exec -T nginx nginx -s reload
echo "nginx reloaded — vhost active for $DOMAIN"
