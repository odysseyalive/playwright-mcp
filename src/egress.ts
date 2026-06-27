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

/** Abort sub-resource requests to blocked hosts on a web_fetch page. */
export async function installEgressGuard(page: Page): Promise<void> {
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
}
