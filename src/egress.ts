/**
 * egress.ts — in-process SSRF backstop for the REMOTE (claude.ai) instance.
 *
 * The remote surface is driven by a prompt-injectable cloud LLM (ledger
 * DEC-2026-06-26): a malicious page could steer browser_navigate / web_fetch at
 * cloud metadata (169.254.169.254), localhost, or the VPS's internal network.
 * PRIMARY enforcement is OS/container-level egress firewalling on the VPS (see
 * the deploy docs); this module is the in-process backstop.
 *
 * Active ONLY when the process runs as a remote instance (PLAYWRIGHT_MCP_PUBLIC_URL
 * set) — a local stdio instance is unrestricted, so debugging localhost dev
 * servers keeps working. Covers web_fetch's page (installEgressGuard) and the
 * browser_* browser, whose context this server launches (installContextEgressGuard,
 * called from src/upstream.ts), plus @playwright/mcp's own network.blockedOrigins
 * as a second, coarser layer. The OS-level block stays primary.
 *
 * Never log to stdout (MCP stdio stream).
 */

import net from 'node:net';
import dns from 'node:dns/promises';
import type { BrowserContext, Page, Route } from 'playwright';

export class EgressBlockedError extends Error {}

/** True when running as a public remote instance — gates all egress restriction. */
export function egressRestricted(): boolean {
  return !!process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
}

const range = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).join(',');

/**
 * Host globs for @playwright/mcp's network.blockedOrigins (wrapped browser_*
 * tools): a coarse second layer under installContextEgressGuard. The OS-level
 * egress block is the complete control.
 *
 * The FORMAT is upstream's, not a URL pattern. Its `originOrHostGlob`
 * (playwright-core tools/backend/context.ts) turns an entry into a route glob:
 *   - `http(s)://host:*`           → `http(s)://host:*` + `/**`
 *   - anything `new URL()` gives a real origin → `<origin>/**`
 *   - everything else (a bare host) → `*://<entry>/**`
 * The glob's `*` is `[^/]*` and `{a,b}` is alternation. So an entry is a BARE
 * host glob. The previous list was written as `*://127.0.0.1`, which is not an
 * origin, so it became `*://*://127.0.0.1/**` and matched no URL at all (DEC-2026-
 * 09-16-remote-egress-block-matched-nothing). A host glob ends at the `/` after
 * the host, so an exact host needs a `:*` twin to also match a URL with a port;
 * a glob that already ends in `*` covers the port by itself.
 * scripts/test-browser-egress.mjs checks this list through upstream's own code.
 */
export const BLOCKED_ORIGIN_PATTERNS: string[] = [
  // exact hosts, with and without a port
  ...['localhost', '[::1]', '[::]'].flatMap((h) => [h, `${h}:*`]),
  // suffixes: *.localhost, *.local, *.internal (incl. metadata.google.internal)
  ...['*.localhost', '*.local', '*.internal'].flatMap((h) => [h, `${h}:*`]),
  // IPv4: 0/8, 10/8, 127/8, 169.254/16 (link-local + metadata), 172.16/12, 192.168/16, 100.64/10
  '0.*',
  '10.*',
  '127.*',
  '169.254.*',
  `172.{${range(16, 31)}}.*`,
  '192.168.*',
  `100.{${range(64, 127)}}.*`,
  // IPv6: ULA fc00::/7 (incl. fd00:ec2::254), link-local fe80::/10, IPv4-mapped
  '[fc*',
  '[fd*',
  '[fe8*',
  '[fe9*',
  '[fea*',
  '[feb*',
  '[::ffff:*',
];

const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local'];

function normalizeHost(host: string): string {
  // A trailing dot is the same name to DNS (`localhost.`), so it must not slip past.
  return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

/** Block a literal IP in a private/loopback/link-local/metadata range. */
export function isBlockedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (incl. unspecified)
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4.
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // The same, as a URL parser writes it: `[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`.
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isBlockedIpv4([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  const head = v.split(':')[0] ?? '';
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true; // fe80::/10
  if (head.startsWith('fc') || head.startsWith('fd')) return true; // fc00::/7 ULA
  return false;
}

/** Synchronous host check (no DNS) — for the per-request route guard. */
export function isBlockedHostSync(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return net.isIP(h) ? isBlockedIp(h) : false;
}

/**
 * Full check for a navigation URL — resolves DNS names and rejects if ANY
 * resolved address is private (catches internal names + DNS-rebinding). Throws
 * EgressBlockedError when blocked; resolves quietly when allowed.
 */
export async function assertEgressAllowed(urlString: string): Promise<void> {
  let host: string;
  try {
    host = new URL(urlString).hostname;
  } catch {
    throw new EgressBlockedError(`invalid URL: ${urlString}`);
  }
  const h = normalizeHost(host);
  if (h === 'localhost' || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) {
    throw new EgressBlockedError(`blocked host: ${host}`);
  }
  if (net.isIP(h)) {
    if (isBlockedIp(h)) throw new EgressBlockedError(`blocked IP: ${host}`);
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(h, { all: true });
  } catch {
    return; // unresolvable → let the fetch fail naturally, nothing to leak
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new EgressBlockedError(`blocked: ${host} resolves to private address ${a.address}`);
    }
  }
}

export interface EgressGuardOptions {
  /**
   * Per-hop validator for document navigations. Defaults to the DNS-aware
   * assertEgressAllowed. Injectable so the test tier can assert per-hop
   * behaviour against an ordinary loopback chain, with no real private address
   * hidden behind a redirect.
   */
  validate?: (url: string) => Promise<void>;
}

export interface EgressGuardHandle {
  /**
   * The reason a navigation hop was refused, if one was. A failed CDP request
   * surfaces to the caller as `net::ERR_ACCESS_DENIED`, which says neither
   * which hop nor why — fetchUrl reads this instead so the model gets the real
   * reason rather than a chromium error code.
   */
  blocked(): string | null;
}

/**
 * Guard a web_fetch page's outbound requests. Two layers, because one mechanism
 * cannot see both kinds of traffic:
 *
 * 1. `page.route` aborts SUB-RESOURCE requests to blocked hosts (sync host check,
 *    no DNS — it runs on every image and script on the page).
 * 2. A CDP `Fetch` interception re-validates EVERY DOCUMENT request, which is
 *    what closes the redirect gap (catalog SEC-8). Playwright's own route layer
 *    follows 30x responses internally and never re-enters the handler — measured:
 *    a 302 chain A/a → B/b → B/c fires `page.route` once, for A/a — so a redirect
 *    into a private address was previously followed without re-entering any
 *    check. CDP pauses each hop as a fresh request at the REQUEST stage, so a
 *    refused hop is failed before its packet is sent, not reported after.
 *
 * The document check is DNS-aware on purpose. `isBlockedHostSync` resolves
 * nothing, so a hop to a *hostname* pointing at a private or metadata address
 * would pass a sync check that the same hostname fails as an initial URL — the
 * DNS-TOCTOU asymmetry the catalog names.
 *
 * SCOPE, stated so it is not overread: this covers web_fetch's OWN page. The
 * browser_* browser gets the same layers context-wide from
 * `installContextEgressGuard` below. Both are defence in depth; the OS-level
 * nftables egress block (docs/REMOTE-CONNECTOR.md §6) is the primary control.
 *
 * Called only under `egressRestricted()` (see fetchUrl), so a local stdio
 * instance never installs it and localhost dev-server debugging is untouched.
 */
export async function installEgressGuard(
  page: Page,
  opts: EgressGuardOptions = {},
): Promise<EgressGuardHandle> {
  const validate = opts.validate ?? assertEgressAllowed;
  let blocked: string | null = null;
  const onBlocked = (reason: string) => {
    blocked ??= reason;
  };

  await page.route('**/*', (route) => subResourceGuard(route));
  await installDocumentGuard(page, validate, onBlocked);

  return { blocked: () => blocked };
}

/**
 * The egress guard for a whole browser context: the browser_* browser, which
 * src/upstream.ts launches and hands to @playwright/mcp. Holding the context is
 * what makes this possible at all; before that, upstream launched the browser and
 * this server had no handle on its pages.
 *
 * 1. A BROWSER-level CDP `Fetch` session pauses EVERY request, of every type, at
 *    the request stage, redirect hops included, and runs the DNS-aware
 *    validator on it (a hostname that resolves to a private address is refused).
 *    Measured on real chrome, both narrower shapes leaked:
 *    - per-page sessions attach after the page exists, and a `newPage()` +
 *      `goto` raced ahead: a 302 from a public host into 127.0.0.1 was served;
 *    - documents-only let a page's own `fetch('/redir')` follow a 302 into
 *      127.0.0.1 and read the response.
 *    The browser session is in place before any page is. This browser serves
 *    only this context (src/upstream.ts launches one per context), so it guards
 *    nothing else. Verdicts are cached per host for a short time so a page with
 *    many sub-resources does not resolve the same name each time.
 * 2. `context.route` repeats the sync host check on every request (no DNS), so a
 *    literal private address is refused even before CDP sees it.
 * 3. WebSockets, which neither layer sees, are routed and validated DNS-aware
 *    before being connected to the server.
 *
 * FAIL-CLOSED, unlike web_fetch's page guard: without a browser handle or a
 * browser CDP session this throws, and launchBrowser closes the browser rather
 * than hand upstream an unguarded one. Refusals are logged to stderr. Called only
 * under `egressRestricted()`.
 */
export async function installContextEgressGuard(
  context: BrowserContext,
  opts: EgressGuardOptions = {},
): Promise<EgressGuardHandle> {
  const validate = cachedByHost(opts.validate ?? assertEgressAllowed);
  let blocked: string | null = null;
  const onBlocked = (reason: string) => {
    blocked ??= reason;
    console.error('[playwright-mcp] egress: refused', reason);
  };

  const browser = context.browser();
  if (!browser) throw new Error('egress guard: no browser handle for this context; refusing to run unguarded');
  const cdp = await browser.newBrowserCDPSession();
  cdp.on('Fetch.requestPaused', (event: unknown) => {
    void handlePausedRequest(cdp, event as FetchRequestPaused, validate, onBlocked, { allTypes: true });
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  await context.route('**/*', (route) => subResourceGuard(route, onBlocked));

  await context.routeWebSocket(/.*/, async (ws) => {
    try {
      await validate(ws.url());
    } catch (err) {
      onBlocked(`WebSocket ${err instanceof Error ? err.message : String(err)}`);
      await ws.close({ code: 1008, reason: 'blocked by egress policy' }).catch(() => {});
      return;
    }
    ws.connectToServer();
  });

  return { blocked: () => blocked };
}

/** How long a host's verdict is reused (see installContextEgressGuard). */
const VERDICT_TTL_MS = 30_000;

/**
 * Reuse a validator's verdict for the same host for VERDICT_TTL_MS. Keyed on the
 * hostname because that is all assertEgressAllowed looks at; an unparseable URL
 * is never cached and goes straight to the validator, which refuses it.
 */
function cachedByHost(validate: (url: string) => Promise<void>): (url: string) => Promise<void> {
  const verdicts = new Map<string, { at: number; verdict: Promise<void> }>();
  return (url) => {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return validate(url);
    }
    const hit = verdicts.get(host);
    if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.verdict;
    const verdict = validate(url);
    verdict.catch(() => {}); // observed by every caller; never an unhandled rejection
    verdicts.set(host, { at: Date.now(), verdict });
    return verdict;
  };
}

/** Sync route check for a non-document request: abort a blocked host, continue the rest. */
function subResourceGuard(route: Route, onBlocked?: (reason: string) => void): void {
  let host = '';
  try {
    host = new URL(route.request().url()).hostname;
  } catch {
    /* fall through to continue */
  }
  if (host && isBlockedHostSync(host)) {
    onBlocked?.(`blocked host: ${host}`);
    void route.abort('blockedbyclient').catch(() => {});
    return;
  }
  void route.continue().catch(() => {});
}

/** CDP per-hop validation of one page's DOCUMENT requests (see installEgressGuard). */
async function installDocumentGuard(
  page: Page,
  validate: (url: string) => Promise<void>,
  onBlocked: (reason: string) => void,
): Promise<void> {
  try {
    await attachDocumentGuard(await page.context().newCDPSession(page), validate, onBlocked);
  } catch (err) {
    // A browser that will not give up a CDP session still gets the sub-resource
    // route above; degrade to the previous coverage rather than failing the
    // fetch. FAIL-OPEN is deliberate — the OS-level nftables block is the
    // primary control — but a security layer that degrades SILENTLY is
    // indistinguishable from one that was never wired, so say so on stderr
    // (never stdout: it carries the MCP stdio stream).
    console.error(
      '[playwright-mcp] egress: per-hop redirect guard unavailable, sub-resource route guard only —',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Pause and validate every DOCUMENT request seen by one CDP session (page- or browser-level). */
async function attachDocumentGuard(
  cdp: CdpLike & { on(event: string, fn: (e: unknown) => void): unknown },
  validate: (url: string) => Promise<void>,
  onBlocked: (reason: string) => void,
): Promise<void> {
  cdp.on('Fetch.requestPaused', (event: unknown) => {
    void handlePausedRequest(cdp, event as FetchRequestPaused, validate, onBlocked);
  });
  // Documents only: sub-resources are already covered by the route layer, and
  // pausing every image through CDP would tax each request for nothing.
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
  });
}

/** The slice of CDP's Fetch.requestPaused payload this guard reads. */
interface FetchRequestPaused {
  requestId: string;
  request?: { url?: string };
  resourceType?: string;
}

/** Minimal CDP surface used above — Playwright types `send`/`on` loosely. */
interface CdpLike {
  send(method: string, params?: object): Promise<unknown>;
}

/**
 * Validate one paused request and let it through, or fail it before it leaves.
 * By default only documents are validated (web_fetch's page guard pauses only
 * documents; a stray non-document is continued rather than silently dropped).
 * `allTypes` validates everything, for the browser_* context guard.
 */
async function handlePausedRequest(
  cdp: CdpLike,
  e: FetchRequestPaused,
  validate: (url: string) => Promise<void>,
  onBlocked: (reason: string) => void,
  { allTypes = false }: { allTypes?: boolean } = {},
): Promise<void> {
  const url = e.request?.url ?? '';
  if ((allTypes || e.resourceType === 'Document') && url) {
    try {
      await validate(url);
    } catch (err) {
      onBlocked(err instanceof Error ? err.message : String(err));
      await cdp
        .send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'AccessDenied' })
        .catch(() => {});
      return;
    }
  }
  await cdp.send('Fetch.continueRequest', { requestId: e.requestId }).catch(() => {});
}
