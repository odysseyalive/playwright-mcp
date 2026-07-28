/**
 * The wrapped @playwright/mcp connection, and the ability to REBIND it to a
 * captured login session.
 *
 * Why this module exists
 * ----------------------
 * A session_login capture used to be usable only by web_fetch({session}) and by
 * generated Playwright suites. The browser_* tools kept their own persistent
 * profile and knew nothing about it, so "log in once" did not make the
 * interactive tools authenticated — you had to log in a second time, by hand, in
 * the profile they happen to use. That contradicted both the advertised
 * behaviour and CLAUDE.md, which states that interactive debugging and generated
 * suites BOTH load the artifact.
 *
 * A login session must support everything you can do with the session. So the
 * upstream connection is no longer created once and captured: it lives behind a
 * mutable holder, and binding a session tears it down and brings it back up with
 * `contextOptions.storageState` pointing at that capture. Every outward Server
 * resolves the client per call, so a rebind is transparent to callers already
 * connected — no MCP restart, no reconnect.
 *
 * Isolated only when bound: with no session we keep the default persistent
 * profile (unchanged behaviour). Once a session IS bound, the artifact is the
 * single source of session truth, and a persistent profile alongside it could
 * only drift out of sync — so that mode runs isolated.
 */

import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import fs from 'node:fs';

import { loadSecrets, sessionFilePath } from './secrets.js';
import { egressRestricted, BLOCKED_ORIGIN_PATTERNS } from './egress.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp]', ...args);

type PwServer = Awaited<ReturnType<typeof createConnection>>;

interface Bound {
  server: PwServer;
  client: Client;
  /** Session name whose storageState this browser was launched with, if any. */
  session: string | null;
}

let current: Bound | undefined;

/** Build the @playwright/mcp config, optionally seeded with a captured session. */
function upstreamConfig(storageState?: string) {
  return {
    browser: {
      browserName: 'chromium' as const,
      launchOptions: { headless: true, channel: 'chrome' },
      // Only when a session is bound: the artifact is the source of truth, so
      // run without a persistent profile that could disagree with it.
      ...(storageState ? { isolated: true, contextOptions: { storageState } } : {}),
    },
    secrets: loadSecrets(),
    // Remote instance: block the wrapped browser_* tools from the metadata
    // endpoint, localhost, and private nets (SSRF backstop; OS-level is primary).
    ...(egressRestricted() ? { network: { blockedOrigins: BLOCKED_ORIGIN_PATTERNS } } : {}),
  };
}

async function connect(session: string | null, storageState?: string): Promise<Bound> {
  const server = await createConnection(upstreamConfig(storageState));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'playwright-mcp-proxy', version: '0.2.0' });
  await client.connect(clientTransport);
  return { server, client, session };
}

/** Start the upstream browser. Call once at boot. */
export async function initUpstream(): Promise<Client> {
  current = await connect(null);
  return current.client;
}

/**
 * The live upstream client. Resolved PER CALL by the outward servers so a
 * rebind swaps the browser underneath them without reconnecting anything.
 */
export function getUpstream(): Client {
  if (!current) throw new Error('upstream not initialised');
  return current.client;
}

/** Which session the browser_* tools are currently authenticated as, if any. */
export function boundSession(): string | null {
  return current?.session ?? null;
}

/**
 * Point the browser_* tools at a captured login (or, with null, back at the
 * default anonymous profile). Tears the old browser down first: two chromiums
 * holding the same artifact is a leak, not a feature.
 */
export async function bindSession(name: string | null): Promise<{ session: string | null }> {
  let storageState: string | undefined;
  if (name) {
    const file = sessionFilePath(name);
    if (!fs.existsSync(file))
      throw new Error(
        `no saved session named "${name}" — capture one first with session_login({name:"${name}", loginUrl, headed:true})`,
      );
    storageState = file;
  }

  const previous = current;
  current = await connect(name, storageState);
  // Close the old one only after the new one is up, so a failed rebind leaves a
  // working browser rather than none.
  if (previous) {
    await previous.client.close().catch(() => {});
    await previous.server.close?.().catch(() => {});
  }
  log(name ? `browser bound to session "${name}"` : 'browser unbound (anonymous profile)');
  return { session: name };
}

/** Shut the upstream browser down (process exit). */
export async function closeUpstream(): Promise<void> {
  const c = current;
  current = undefined;
  if (!c) return;
  await c.client.close().catch(() => {});
  await c.server.close?.().catch(() => {});
}
