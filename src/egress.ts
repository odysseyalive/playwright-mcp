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
 * servers keeps working. Covers web_fetch (which we fully control); the wrapped
 * @playwright/mcp browser_* tools are covered via network.blockedOrigins in
 * index.ts plus the OS-level block.
 *
 * Never log to stdout (MCP stdio stream).
 */

import net from 'node:net';
import dns from 'node:dns/promises';
import type { Page } from 'playwright';

export class EgressBlockedError extends Error {}

/** True when running as a public remote instance — gates all egress restriction. */
export function egressRestricted(): boolean {
  return !!process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
}

/**
 * Origin patterns for @playwright/mcp's network.blockedOrigins (wrapped browser_*
 * tools). Host-pattern based — a coarse backstop; literal private IPs + the
 * metadata endpoint + localhost. RFC1918 is enumerated as far as patterns allow;
 * the OS-level egress block is the complete control.
 */
export const BLOCKED_ORIGIN_PATTERNS: string[] = [
  '*://169.254.169.254',
  '*://metadata.google.internal',
  '*://localhost',
  '*://127.0.0.1',
  '*://[::1]',
  '*://10.*',
  '*://192.168.*',
  '*://172.16.*', '*://172.17.*', '*://172.18.*', '*://172.19.*',
  '*://172.20.*', '*://172.21.*', '*://172.22.*', '*://172.23.*',
  '*://172.24.*', '*://172.25.*', '*://172.26.*', '*://172.27.*',
  '*://172.28.*', '*://172.29.*', '*://172.30.*', '*://172.31.*',
];

const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local'];

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
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
 * SCOPE, stated so it is not overread: this covers web_fetch's OWN page only.
 * The upstream `browser_*` tools drive a page this server holds no handle to;
 * their coverage is `network.blockedOrigins` plus, primarily, the OS-level
 * nftables egress block (docs/REMOTE-CONNECTOR.md §6). This is defence in depth
 * on the in-process backstop.
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

  await page.route('**/*', (route) => {
    let host = '';
    try {
      host = new URL(route.request().url()).hostname;
    } catch {
      /* fall through to continue */
    }
    if (host && isBlockedHostSync(host)) {
      void route.abort('blockedbyclient');
      return;
    }
    void route.continue();
  });

  try {
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Fetch.requestPaused', (event: unknown) => {
      const e = event as FetchRequestPaused;
      void handlePausedRequest(cdp, e, validate, (reason) => {
        blocked ??= reason;
      });
    });
    // Documents only: sub-resources are already covered by the route above, and
    // pausing every image through CDP would tax each fetch for nothing.
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
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

  return { blocked: () => blocked };
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
 * Only documents are validated; a paused non-document (there should be none,
 * given the pattern) is continued rather than silently dropped.
 */
async function handlePausedRequest(
  cdp: CdpLike,
  e: FetchRequestPaused,
  validate: (url: string) => Promise<void>,
  onBlocked: (reason: string) => void,
): Promise<void> {
  const url = e.request?.url ?? '';
  if (e.resourceType === 'Document' && url) {
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
