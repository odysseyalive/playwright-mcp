# playwright-mcp remote connector image (claude.ai custom connector).
#
# Built for jstack's Docker model: the public jstack_nginx container proxies to
# THIS container by name over the jstack_default network. The app therefore binds
# 0.0.0.0 *inside the container* (PLAYWRIGHT_MCP_BIND, set in compose) — the port
# is NOT published to any host interface, so the container network + nginx + the
# GitHub-OAuth gate are the access controls.
#
# Playwright is pinned to an alpha (see package.json), so there is no matching
# mcr.microsoft.com/playwright tag — install Chromium + OS deps onto a Node base.
FROM node:22-bookworm

# Shared, world-readable browser path so the non-root runtime user can read the
# Chromium that we install here as root.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    XDG_CACHE_HOME=/home/pwmcp/.cache

WORKDIR /app

# 1) JS deps (full tree incl. devDeps — tsc is needed for the build below).
COPY package.json package-lock.json ./
RUN npm ci

# 2) Google Chrome + its system libraries (apt via --with-deps needs root; we are
#    root at build time). The runtime launches with channel:'chrome' (real Chrome,
#    not bundled Chromium — src/stealth.ts, src/upstream.ts: bundled Chromium is an
#    anti-bot tell), so the `chrome` channel MUST be installed, not `chromium`.
#    Chrome lands in /opt/google/chrome (world-readable from the .deb, so the
#    unprivileged runtime user can exec it). Make /ms-playwright writable too —
#    Playwright still creates lock/registry dirs there at launch. Same RUN layer.
RUN npx playwright install --with-deps chrome \
 && mkdir -p /ms-playwright \
 && chmod -R a+rwX /ms-playwright

# 3) Build the TypeScript (.dockerignore keeps host node_modules/dist out, so this
#    compiles against the clean tree from step 1).
COPY . .
RUN npm run build

# 4) Drop privileges — a prompt-injectable cloud LLM drives this browser.
RUN useradd --system --create-home --home-dir /home/pwmcp --shell /usr/sbin/nologin pwmcp \
 && mkdir -p /home/pwmcp/.cache \
 && chown -R pwmcp:pwmcp /app /home/pwmcp
USER pwmcp

ENV NODE_ENV=production

# The remote Streamable-HTTP transport turns on when PLAYWRIGHT_MCP_PUBLIC_URL is
# set (done in compose). Without the GITHUB_* trio the server fails closed.
CMD ["node", "dist/index.js"]
