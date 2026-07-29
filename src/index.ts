#!/usr/bin/env node
/**
 * playwright-mcp — user-scoped MCP server wrapping @playwright/mcp (headless)
 * and adding custom tools (web_fetch + session helpers). web_fetch replaces
 * Claude Code's native WebFetch; web search/discovery uses the native
 * server-side WebSearch, verified/cited with web_fetch by the session-side
 * web-search skill (DEC-2026-06-08-native-websearch-webfetch-doublecheck).
 *
 * Architecture: proxy composition. The official @playwright/mcp server runs
 * in-process behind an InMemoryTransport; we connect to it as a client and
 * re-expose its full toolset over stdio, merged with our custom tools.
 *
 * IMPORTANT: never write to stdout — it carries the MCP stdio stream.
 * All logging goes to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { pathToFileURL } from 'node:url';

import { customTools, callCustomTool, isCustomTool } from './tools.js';
import { guardOutbound, UNTRUSTED_NOTICE } from './exfil.js';
import { secretInventory } from './secrets.js';
import { closeBrowser } from './browser.js';
import { startRemoteServer, type RemoteHandle } from './remote.js';
import { buildGitHubAuth, type RemoteAuth } from './auth.js';
import { initUpstream, getUpstream, closeUpstream, boundSession } from './upstream.js';

const VERSION = '0.2.0';

const log = (...args: unknown[]) => console.error('[playwright-mcp]', ...args);

/**
 * Render the server `instructions` capability map from the LIVE toolset —
 * never hand-maintained, so it cannot drift. Claude Code injects this into the
 * system prompt even when tool schemas are deferred (see CLAUDE.md Gotchas).
 * Keep the output under ~40 lines.
 */
function buildInstructions(
  upstreamTools: { name: string }[],
  custom: { name: string }[],
): string {
  const names = new Set([...upstreamTools, ...custom].map((t) => t.name));
  const lines = [
    'playwright-mcp provides headless Playwright browsing for web work:',
    'reviewing/debugging local dev servers (localhost) and live sites, screenshots, and page fetch/render.',
    '',
  ];
  if (names.has('web_fetch')) {
    lines.push(
      'REPLACES NATIVE WebFetch: use web_fetch to fetch a URL — it stealth-renders JS pages and PDFs and ' +
        'extracts readable text + author/date/CMS citations. For web SEARCH use the native WebSearch tool, ' +
        'then verify and cite the top results with web_fetch.',
      '',
    );
  }
  lines.push(
    'Browse/debug workflow: browser_navigate → browser_snapshot (accessibility tree; prefer over screenshots) → interact by ref (browser_click, browser_type, …) → verify.',
    'Debugging: browser_console_messages, browser_network_requests. Screenshots: browser_take_screenshot.',
  );
  if (names.has('session_login')) {
    lines.push(
      '',
      'SITE BEHIND A LOGIN: capture it ONCE with session_login({name, loginUrl, headed:true}) — a real window opens ' +
        'for the human to log in (2FA/SSO fine; credentials never pass through the model). Point loginUrl at the app ' +
        'page you want; redirects to the identity provider are followed, and the capture FAILS LOUDLY rather than ' +
        'saving an unauthenticated session. Then read authenticated pages with web_fetch({url, session:"name"}); ' +
        'session_status({name, probeUrl}) checks it first. The capture BINDS the browser automatically: browser_* ' +
        'are then authenticated too, so you can click through the authed UI, not just read it. ' +
        'session_attach({name}) re-binds a session captured in an earlier run; session_attach({name:null}) drops back ' +
        'to anonymous.',
    );
  }
  if (names.has('session_solve_challenge')) {
    lines.push(
      '',
      'BLOCKED BY A CAPTCHA / BOT WALL: session_solve_challenge opens a real Chrome for the human to solve it once, ' +
        'then saves the cleared session AND binds it exactly as session_login does — browser_* and ' +
        'web_fetch({url, session}) both get past the wall afterwards. Short-lived (minutes); re-solve when it lapses.',
    );
  }
  if (names.has('session_scaffold_tests')) {
    lines.push(
      '',
      'AUTHENTICATED E2E TESTS: capture a login once with session_login, then call session_scaffold_tests to ' +
        'generate a deterministic Playwright suite (setup-project + dependencies) that reuses it — no model in the loop.',
    );
  }
  if (names.has('suite_scaffold') || names.has('suite_methodology')) {
    lines.push(
      '',
      'TEST-SUITE WORK (create/edit/audit e2e suites): read suite_methodology FIRST; suite_scaffold builds a full ' +
        'suite + project-local AI test-suite skill into a project; suite_audit runs/parses a suite and returns ' +
        'per-failure dossiers for TEST-DEFECT vs PRODUCT-BUG adjudication (fix scripts only — never paper over product bugs).',
    );
  }
  lines.push(
    '',
    `All tools (${names.size}): ${[...names].sort().join(', ')}`,
  );
  return lines.join('\n');
}

/**
 * Tools that must NOT be reachable over the remote (claude.ai) transport: they
 * run arbitrary code or touch credentials, and the remote surface is driven by a
 * prompt-injectable cloud LLM (ledger DEC-2026-06-26). Filtered from BOTH
 * tools/list and tools/call when remote=true; the local stdio surface is
 * unaffected. Hiding alone is insufficient — a client can still name a hidden
 * tool — so the call handler rejects them too.
 */
const REMOTE_DENYLIST = new Set([
  'browser_run_code_unsafe',
  'session_login',
  'session_status',
  'session_solve_challenge',
  'session_attach',
  'session_scaffold_tests',
  'browser_file_upload',
  'suite_scaffold',
  'suite_audit',
]);

interface OutwardServerOptions {
  /** Apply the REMOTE_DENYLIST to tools/list + tools/call (claude.ai surface). */
  remote?: boolean;
}

/**
 * Disclose the ambient browser binding on every result it affects.
 *
 * session_login / session_solve_challenge / session_attach rebind the shared
 * upstream browser (src/upstream.ts), so every later browser_* call is
 * authenticated without saying so. That is state carried across calls where the
 * model cannot see it — exactly what MCP 2026-07-28 moves away from ("mint an
 * explicit handle… the model can see the handle and thread it between tools";
 * ledger DEC-2026-07-28). The binding stays, because it is what makes "log in
 * once" cover interactive debugging; it just stops being invisible.
 *
 * The remote surface gets a name-free notice: it shares this browser but cannot
 * rebind it (session_* is denylisted), so the name would be disclosure to a
 * prompt-injectable client with nothing actionable attached.
 *
 * Takes the session as an argument rather than reading boundSession() itself, so
 * it stays a pure function the T1 tier can exercise without a live browser.
 */
export function withSessionBanner<T extends object>(
  result: T,
  session: string | null,
  remote: boolean,
): T {
  if (!session) return result;
  const banner = {
    type: 'text' as const,
    text: remote
      ? '[playwright-mcp] this browser is running an authenticated session.'
      : `[playwright-mcp] browser is authenticated as session "${session}" — session_attach({name:null}) returns it to the anonymous profile.`,
  };
  // callTool's compatibility result is a union (modern `content` vs legacy
  // `toolResult`), so read the field defensively and re-widen on the way out.
  const existing = (result as { content?: unknown }).content;
  return {
    ...result,
    content: Array.isArray(existing) ? [...existing, banner] : [banner],
  } as T;
}

/**
 * `browser_*` tools whose results do NOT carry page content, so the untrusted-
 * content notice would be pure noise on them. An allowlist by exclusion rather
 * than by enumeration: upstream adds tools, and a new page-reading tool must
 * default to being marked, not to being trusted.
 */
const NO_PAGE_CONTENT = new Set(['browser_close', 'browser_resize', 'browser_take_screenshot']);

/**
 * Mark upstream page content as untrusted data (ledger DEC-2026-07-29).
 *
 * `browser_*` results are accessibility snapshots consumed structurally, so they
 * get the one-line notice rather than web_fetch's full `<untrusted-content>`
 * wrap — wrapping them would fight the ref-based interaction workflow. Same
 * intercept point and same shape as withSessionBanner; both may append, which
 * is the accepted cost of making invisible state visible.
 *
 * Pure, so the T1 tier exercises it without a live browser.
 */
export function withUntrustedNotice<T extends object>(result: T, toolName: string): T {
  if (!toolName.startsWith('browser_') || NO_PAGE_CONTENT.has(toolName)) return result;
  const notice = { type: 'text' as const, text: UNTRUSTED_NOTICE };
  const existing = (result as { content?: unknown }).content;
  return {
    ...result,
    content: Array.isArray(existing) ? [...existing, notice] : [notice],
  } as T;
}

/**
 * The http(s) URL an upstream tool call is about to navigate to, if any.
 *
 * Reads any string `url` argument rather than special-casing browser_navigate:
 * the guard must cover every upstream tool that can be pointed at a host
 * (browser_navigate, browser_tabs, browser_network_request), including ones
 * upstream has not shipped yet.
 */
function outboundUrlArg(args: Record<string, unknown> | undefined): string | undefined {
  const raw = args?.url;
  if (typeof raw !== 'string') return undefined;
  return /^https?:\/\//i.test(raw) ? raw : undefined;
}

/**
 * Build one outward-facing MCP Server bound to the shared upstream proxy. A
 * Server owns exactly one transport (SDK contract: connect() assumes sole
 * ownership), so each binding — stdio and every HTTP session — gets its own
 * Server from this factory, all delegating to the SAME single @playwright/mcp
 * chromium via `upstream`. The `instructions` capability map is rendered from the
 * (mode-filtered) live toolset so it never drifts and reflects what the surface
 * actually exposes.
 */
export function createOutwardServer(
  /**
   * Resolved PER CALL, not captured: binding a session rebuilds the upstream
   * browser underneath us (see src/upstream.ts), and already-connected callers
   * must follow the swap without reconnecting.
   */
  upstreamOf: () => Client,
  upstreamTools: { name: string }[],
  options: OutwardServerOptions = {},
): Server {
  const remote = options.remote ?? false;
  const allow = (name: string) => !remote || !REMOTE_DENYLIST.has(name);

  const visibleUpstream = upstreamTools.filter((t) => allow(t.name));
  const visibleCustom = customTools.filter((t) => allow(t.name));

  const server = new Server(
    { name: 'playwright-mcp', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(visibleUpstream, visibleCustom),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await upstreamOf().listTools();
    return { tools: [...tools.filter((t) => allow(t.name)), ...visibleCustom] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!allow(name)) {
      return {
        content: [
          { type: 'text', text: `Error: tool "${name}" is not available on the remote surface.` },
        ],
        isError: true,
      };
    }
    try {
      // Custom tools are exempt from the wrappers below: web_fetch already takes
      // an explicit `session` argument and runs the outbound guard + framing
      // itself, and the session_* tools report the binding themselves.
      if (isCustomTool(name)) return await callCustomTool(name, args ?? {});

      // Same outbound guard web_fetch runs, on the same shared ledger — so
      // browser_navigate cannot be used to route around it (DEC-2026-07-29).
      const target = outboundUrlArg(args);
      if (target) {
        const guard = guardOutbound(target, secretInventory());
        if (!guard.ok) {
          return {
            content: [{ type: 'text', text: `Error in ${name}: ${guard.reason}` }],
            isError: true,
          };
        }
      }

      const result = await upstreamOf().callTool({ name, arguments: args ?? {} });
      return withUntrustedNotice(withSessionBanner(result, boundSession(), remote), name);
    } catch (err) {
      return {
        content: [
          { type: 'text', text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/** Read the remote-auth environment (GitHub OAuth app creds + dev opt-out). */
function remoteAuthEnv() {
  return {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    allowedLogin: process.env.GITHUB_ALLOWED_LOGIN,
    allowNoAuth: process.env.PLAYWRIGHT_MCP_ALLOW_NOAUTH === '1',
  };
}

async function main() {
  // 1-2. Spin up the official @playwright/mcp server in-process (headless) and
  //      connect to it over an in-memory transport. It lives behind a mutable
  //      holder so session_login/session_attach can rebind the browser to a
  //      captured login without anything reconnecting — see src/upstream.ts.
  const upstream = await initUpstream();

  // 3. Snapshot the live upstream toolset once for the instructions map; each
  //    outward Server (stdio + every HTTP session) is built from the factory.
  const { tools: upstreamTools } = await upstream.listTools();

  // 3a. Local stdio surface (Claude Code) — full toolset, byte-for-byte unchanged.
  const stdioServer = createOutwardServer(getUpstream, upstreamTools);
  await stdioServer.connect(new StdioServerTransport());
  log(`v${VERSION} ready (stdio, wrapping @playwright/mcp, headless chromium)`);

  // 3b. Remote (claude.ai) surface — ONLY when the public URL is configured.
  //     Remote sessions get the denylisted toolset (remote:true). stdio above is
  //     untouched whether or not this runs.
  let remote: RemoteHandle | undefined;
  const publicUrl = process.env.PLAYWRIGHT_MCP_PUBLIC_URL;
  if (publicUrl) {
    const { clientId, clientSecret, allowedLogin, allowNoAuth } = remoteAuthEnv();
    let auth: RemoteAuth | undefined;
    let start = true;
    if (clientId && clientSecret && allowedLogin) {
      auth = buildGitHubAuth({ publicUrl, clientId, clientSecret, allowedLogin });
      log(`remote auth: GitHub proxy-OAuth (allowed login: ${allowedLogin})`);
    } else if (allowNoAuth) {
      log('WARNING: remote transport starting WITHOUT auth (PLAYWRIGHT_MCP_ALLOW_NOAUTH=1) — localhost/dev only, never expose publicly.');
    } else {
      start = false;
      log('remote requested (PLAYWRIGHT_MCP_PUBLIC_URL set) but GitHub OAuth is not configured — refusing to start the remote transport. Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/GITHUB_ALLOWED_LOGIN, or PLAYWRIGHT_MCP_ALLOW_NOAUTH=1 for localhost dev.');
    }
    if (start) {
      const port = Number(process.env.PLAYWRIGHT_MCP_PORT ?? 8765);
      remote = startRemoteServer({
        makeServer: () => createOutwardServer(getUpstream, upstreamTools, { remote: true }),
        publicUrl,
        port,
        authRouter: auth?.router,
        requireAuth: auth?.requireAuth,
      });
    }
  }

  // Tidy both browsers + the remote host on shutdown (best-effort).
  //
  // ONE handler covers BOTH surfaces: this is a single process that always serves
  // stdio and additionally serves the HTTP port when PLAYWRIGHT_MCP_PUBLIC_URL is
  // set, and every binding — stdio and each HTTP session — resolves the SAME
  // upstream chromium through getUpstream(). There is no port-only teardown to
  // write; closing that one upstream covers the local and served cases alike.
  const shutdown = async () => {
    remote?.close(); // stop accepting before tearing anything down
    // Two independent browsers: the wrapped @playwright/mcp chromium (upstream,
    // rebound by session_login/session_attach) and the stealth context web_fetch
    // uses. Concurrent so a slow close doesn't serialise behind the other;
    // allSettled because shutdown must not be derailed by either one failing.
    await Promise.allSettled([closeUpstream(), closeBrowser()]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Run only when invoked as the entry point — importing this module (e.g. tests
// using createOutwardServer) must not boot the server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('fatal:', err);
    process.exit(1);
  });
}
