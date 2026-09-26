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
 * Isolated only when bound: with no session the browser runs on a persistent
 * profile. Once a session IS bound, the artifact is the single source of session
 * truth, and a persistent profile alongside it could only drift out of sync — so
 * that mode runs isolated.
 *
 * We launch that browser, not @playwright/mcp (DEF-Q-17)
 * ------------------------------------------------------
 * Left to itself, @playwright/mcp launched every browser_* chrome on ONE default
 * profile (`ms-playwright/mcp-chrome-<hash>`) and never closed it: browser_close
 * only discards its tool state, and closing the connection does the same. The
 * chrome kept running under this process with the profile locked, so the next
 * browser_* call, even a second browser_close, launched again on that profile
 * and failed with "Browser is already in use for …mcp-chrome-<hash>". Reproduced
 * with navigate, close, navigate on 0.0.75.
 *
 * So each connection hands upstream a context getter (createConnection's second
 * argument) and owns what it returns. The profile comes from BROWSER_POOL, drawn
 * by browser.ts's pool mechanism (first free slot, pid-keyed temp fallback, one
 * retry when a slot is taken mid-launch), and the previous browser is closed
 * before the next one launches and when the connection is torn down.
 *
 * The pool keeps what the single profile gave: slot 1 IS the dir upstream used
 * for this workspace, so an existing browser_* login carries over, and every
 * other slot and the temp fallback carry the same workspace hash, so projects
 * never share a browser_* profile (DEC-2026-08-28 Path B).
 */

import { createConnection } from '@playwright/mcp';
import { chromium, type BrowserContext, type LaunchOptions } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { dropTempProfile, launchOnPool, type ProfilePool } from './browser.js';
import { loadSecrets, sessionFilePath } from './secrets.js';
import { BROWSER_CHANNEL, STEALTH_ARGS, STEALTH_INIT, stealthContextOptions } from './stealth.js';
import { egressRestricted, installContextEgressGuard, BLOCKED_ORIGIN_PATTERNS } from './egress.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp]', ...args);

type PwServer = Awaited<ReturnType<typeof createConnection>>;

interface Bound {
  server: PwServer;
  client: Client;
  /** Session name whose storageState this browser was launched with, if any. */
  session: string | null;
  /** Close the browser this connection launched. Upstream never does. */
  closeBrowser: () => Promise<void>;
}

let current: Bound | undefined;

/**
 * @playwright/mcp takes init scripts as FILE PATHS, not source, so the shared
 * STEALTH_INIT is written once to the cache root beside web_fetch's profiles.
 * Rewritten on every launch so it can never lag the source string.
 */
function stealthInitFile(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  const file = path.join(base, 'playwright-mcp', 'stealth-init.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, STEALTH_INIT);
  return file;
}

/**
 * How the browser_* browser is launched: the same disguise as web_fetch and the
 * capture contexts (stealth.ts). Without it, a session captured by attach mode was
 * replayed by a headless browser announcing `HeadlessChrome` with
 * navigator.webdriver=true, so a Cloudflare-fronted site (dash.cloudflare.com,
 * 2026-09-14) re-challenged it immediately: the clearance was earned by a
 * different-looking client. Headless + CDP remains detectable by a determined
 * wall; this removes the obvious mismatch.
 *
 * `chromiumSandbox` and the kept `--disable-extensions` default are what
 * @playwright/mcp's own launch set for Chrome, kept so taking the launch over
 * changes nothing about the browser itself.
 */
export function upstreamLaunch(storageState?: string) {
  const launchOptions: LaunchOptions = {
    headless: true,
    channel: BROWSER_CHANNEL,
    args: STEALTH_ARGS,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
  };
  const contextOptions = storageState ? { ...stealthContextOptions, storageState } : { ...stealthContextOptions };
  return { launchOptions, contextOptions };
}

/**
 * The 7-hex workspace hash @playwright/mcp names its profile with. Upstream hashes
 * the MCP client's first root, falling back to process.cwd() when there is none;
 * our in-memory proxy client declares no roots, so it is always the cwd — the
 * project Claude Code started this server in.
 */
function workspaceHash(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 7);
}

/**
 * The exact dir @playwright/mcp launched browser_* on for this workspace before we
 * took the launch over. Mirrors `createUserDataDir` in playwright-core's
 * tools/mcp/browserFactory.ts (bundled in lib/coreBundle.js):
 * `<PWMCP_PROFILES_DIR_FOR_TEST ?? registryDirectory>/mcp-<channel ?? browserName>-<hash>`. The
 * registry dir is read from upstream's own export, so PLAYWRIGHT_BROWSERS_PATH
 * and the platform cache root resolve exactly as they do there.
 * scripts/test-upstream-browser.mjs pins this against upstream's own launch.
 */
export function upstreamProfileDir(): string {
  const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle');
  const root: string = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? registry.registryDirectory;
  // Upstream names it by channel, else browserName: `mcp-chrome-…` or `mcp-chromium-…`.
  return path.join(root, `mcp-${upstreamLaunch().launchOptions.channel ?? 'chromium'}-${workspaceHash()}`);
}

/**
 * browser_*'s profile pool. Slot 1 is upstream's own dir for this workspace, so
 * a login made there survives the switch; slots 2..N (`mcp-chrome-<hash>-2` …, or `mcp-chromium-…`)
 * and the temp fallback (`pwmcp-browser-<hash>-<pid>`) carry the same hash, so
 * two projects never land on one profile. No override: pinning browser_* to one
 * dir would bring back the lockout this pool exists to end.
 */
export const BROWSER_POOL: ProfilePool = {
  slot1: upstreamProfileDir,
  tempMark: 'pwmcp-browser-',
  tempKey: () => `${workspaceHash()}-`,
};

/**
 * Build the @playwright/mcp config. Only what upstream applies to a context it is
 * handed: the stealth init script, secrets, and the egress block. The launch
 * itself is ours (see `launchBrowser`), so there is no `isolated`/`userDataDir`
 * here: upstream would reject `isolated` alongside a context getter.
 */
export function upstreamConfig() {
  return {
    browser: {
      browserName: 'chromium' as const,
      initScript: [stealthInitFile()],
    },
    secrets: loadSecrets(),
    // Remote instance: upstream's own host block, a coarse second layer under the
    // context guard `launchBrowser` installs (SSRF backstop; OS-level is primary).
    ...(egressRestricted() ? { network: { blockedOrigins: BLOCKED_ORIGIN_PATTERNS } } : {}),
  };
}

/**
 * Launch one browser_* browser. Unbound: a persistent profile from BROWSER_POOL.
 * Bound: an in-memory context seeded with the capture, on a browser of its own
 * that goes down with the context. On the remote instance the context gets the
 * in-process egress guard before upstream ever sees it; if the guard cannot be
 * installed, the browser is closed and the launch fails rather than running
 * unguarded.
 */
export async function launchBrowser(storageState?: string): Promise<BrowserContext> {
  const context = await openBrowser(storageState);
  if (egressRestricted()) {
    try {
      await installContextEgressGuard(context);
    } catch (err) {
      await context.close().catch(() => {});
      await context.browser()?.close().catch(() => {});
      throw err;
    }
  }
  return context;
}

async function openBrowser(storageState?: string): Promise<BrowserContext> {
  const { launchOptions, contextOptions } = upstreamLaunch(storageState);
  if (!storageState) {
    const { context, dir } = await launchOnPool(BROWSER_POOL, (d) =>
      chromium.launchPersistentContext(d, { ...launchOptions, ...contextOptions }),
    );
    log(`browser_* browser up (profile=${dir})`);
    return context;
  }
  const browser = await chromium.launch(launchOptions);
  try {
    const context = await browser.newContext(contextOptions);
    context.once('close', () => void browser.close().catch(() => {}));
    return context;
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * The context getter one connection hands upstream, plus the close for what it
 * launched. Upstream calls the getter whenever it builds its tool state: on the
 * first browser_* call, and again after browser_close or a crash discarded the
 * last one. Nothing uses the previous browser at that point, and upstream never
 * closed it, so it is closed here BEFORE the launch. That releases its profile
 * lock, and the pool hands the same slot back, keeping the profile's continuity.
 */
export function browserOwner(storageState?: string, launch = launchBrowser) {
  let live: BrowserContext | undefined;
  const closeBrowser = async (): Promise<void> => {
    const context = live;
    live = undefined;
    if (!context) return;
    await context.close().catch(() => {});
    await context.browser()?.close().catch(() => {});
  };
  const getContext = async (): Promise<BrowserContext> => {
    await closeBrowser();
    live = await launch(storageState);
    return live;
  };
  return { getContext, closeBrowser };
}

async function connect(session: string | null, storageState?: string): Promise<Bound> {
  const { getContext, closeBrowser } = browserOwner(storageState);
  const server = await createConnection(upstreamConfig(), getContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'playwright-mcp-proxy', version: '0.3.0' });
  await client.connect(clientTransport);
  return { server, client, session, closeBrowser };
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
  if (previous) await disconnect(previous);
  log(name ? `browser bound to session "${name}"` : 'browser unbound (anonymous profile)');
  return { session: name };
}

/**
 * browser_close leaves upstream with no tool state and the chrome still running
 * (see the header). Close it now rather than at the next browser_* call, so the
 * idle browser does not hold its profile slot in the meantime.
 */
export async function releaseBrowser(): Promise<void> {
  await current?.closeBrowser();
}

/** Shut the upstream browser down (process exit). */
export async function closeUpstream(): Promise<void> {
  const c = current;
  current = undefined;
  if (!c) return;
  await disconnect(c);
  dropTempProfile(BROWSER_POOL);
}

/** Tear one connection down, browser included: closing upstream leaves it running. */
async function disconnect(b: Bound): Promise<void> {
  await b.client.close().catch(() => {});
  await b.server.close?.().catch(() => {});
  await b.closeBrowser();
}
