/**
 * loopback-wait.ts — browser_navigate waits for a local server that is still
 * starting.
 *
 * Reported 2026-11-25 (i19 item 4): a session started a dev server and called
 * browser_navigate on it at once; the port was not listening yet, the call
 * failed with net::ERR_CONNECTION_REFUSED, and the same call a moment later
 * worked. Every agent that starts a server and then looks at it runs that race,
 * so the wait is automatic rather than an option someone has to know to pass.
 *
 * Loopback only (localhost, *.localhost, 127.0.0.0/8, ::1). A refused
 * connection there almost always means "not up yet"; on any other host it means
 * the host said no, and retrying a remote host is just hammering it. Only
 * ERR_CONNECTION_REFUSED retries: a timeout, a DNS failure or an HTTP error is
 * an answer, not a server still binding its port.
 *
 * Budget: LOOPBACK_WAIT_MS, 10 s by default, PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS to
 * tune it, 0 to turn it off. Well under the 30 s a silent tool call survives in
 * Claude Code (see callContext in src/index.ts). The retries run inside the
 * caller's one turn in the browser queue, so nobody else's call lands between
 * them, and they stop at once if the caller gives up.
 */

import net from 'node:net';

const DEFAULT_WAIT_MS = 10_000;

export function loopbackWaitMs(): number {
  const raw = process.env.PLAYWRIGHT_MCP_LOOPBACK_WAIT_MS;
  const n = raw === undefined || raw === '' ? DEFAULT_WAIT_MS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

/**
 * Is this navigate target a loopback host? Reads the URL the way upstream will
 * open it: a bare `localhost:3000` gets `http://` (checkUrlAndNavigate in
 * playwright-core's coreBundle.js), anything else unparseable gets `https://`.
 */
export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    try {
      u = new URL((raw.startsWith('localhost') ? 'http://' : 'https://') + raw);
    } catch {
      return false;
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // URL keeps the brackets on an IPv6 hostname: `[::1]`.
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (net.isIPv4(host)) return host.startsWith('127.');
  return host === '::1';
}

/** Did this upstream result fail because nothing was listening? Upstream reports it as text, it does not throw. */
export function refusedConnection(result: object): boolean {
  // callTool's result is a union (modern `content` vs legacy `toolResult`), so read defensively.
  const { content, isError } = result as { content?: unknown; isError?: unknown };
  if (!isError || !Array.isArray(content)) return false;
  return content.some(
    (b) => typeof b?.text === 'string' && b.text.includes('net::ERR_CONNECTION_REFUSED'),
  );
}

/**
 * Run `call`; while it is refused and budget remains, wait and run it again.
 * Backoff 250 ms doubling to 1 s, so a server that comes up in a second is seen
 * within a quarter second of it. Returns the last result, with a line saying the
 * wait happened, since a navigate that took 4 s for no visible reason would
 * otherwise read as a slow page.
 */
export async function withLoopbackWait<T extends object>(
  call: () => Promise<T>,
  { budgetMs = loopbackWaitMs(), signal }: { budgetMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const start = Date.now();
  let result = await call();
  if (budgetMs <= 0 || !refusedConnection(result)) return result;
  let delay = 250;
  let tries = 1;
  while (refusedConnection(result) && !signal?.aborted) {
    const left = budgetMs - (Date.now() - start);
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(delay, left)));
    delay = Math.min(delay * 2, 1000);
    if (signal?.aborted) break;
    result = await call();
    tries += 1;
  }
  const secs = ((Date.now() - start) / 1000).toFixed(1);
  const note = refusedConnection(result)
    ? `[playwright-mcp] the local server refused the connection; retried ${tries} times over ${secs}s and it never started listening. Is it running, and on this port?`
    : `[playwright-mcp] the local server was not listening yet; waited ${secs}s (${tries} tries) for it to start.`;
  const existing = (result as { content?: unknown }).content;
  const content = Array.isArray(existing) ? existing : [];
  return { ...result, content: [...content, { type: 'text', text: note }] } as T;
}
