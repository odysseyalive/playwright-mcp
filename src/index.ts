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

import { createConnection } from '@playwright/mcp';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { pathToFileURL } from 'node:url';

import { customTools, callCustomTool, isCustomTool } from './tools.js';
import { loadSecrets } from './secrets.js';
import { closeBrowser } from './browser.js';
import { startRemoteServer, type RemoteHandle } from './remote.js';
import { buildGitHubAuth, type RemoteAuth } from './auth.js';
import { egressRestricted, BLOCKED_ORIGIN_PATTERNS } from './egress.js';

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
 * Build one outward-facing MCP Server bound to the shared upstream proxy. A
 * Server owns exactly one transport (SDK contract: connect() assumes sole
 * ownership), so each binding — stdio and every HTTP session — gets its own
 * Server from this factory, all delegating to the SAME single @playwright/mcp
 * chromium via `upstream`. The `instructions` capability map is rendered from the
 * (mode-filtered) live toolset so it never drifts and reflects what the surface
 * actually exposes.
 */
export function createOutwardServer(
  upstream: Client,
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
    const { tools } = await upstream.listTools();
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
      if (isCustomTool(name)) return await callCustomTool(name, args ?? {});
      return await upstream.callTool({ name, arguments: args ?? {} });
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
  // 1. Spin up the official @playwright/mcp server in-process, headless.
  const playwrightServer = await createConnection({
    browser: {
      browserName: 'chromium',
      launchOptions: { headless: true },
    },
    secrets: loadSecrets(),
    // Remote instance: block the wrapped browser_* tools from the metadata
    // endpoint, localhost, and private nets (SSRF backstop; OS-level is primary).
    ...(egressRestricted() ? { network: { blockedOrigins: BLOCKED_ORIGIN_PATTERNS } } : {}),
  });

  // 2. Connect to it as a client over an in-memory transport.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playwrightServer.connect(serverTransport);
  const upstream = new Client({ name: 'playwright-mcp-proxy', version: VERSION });
  await upstream.connect(clientTransport);

  // 3. Snapshot the live upstream toolset once for the instructions map; each
  //    outward Server (stdio + every HTTP session) is built from the factory.
  const { tools: upstreamTools } = await upstream.listTools();

  // 3a. Local stdio surface (Claude Code) — full toolset, byte-for-byte unchanged.
  const stdioServer = createOutwardServer(upstream, upstreamTools);
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
        makeServer: () => createOutwardServer(upstream, upstreamTools, { remote: true }),
        publicUrl,
        port,
        authRouter: auth?.router,
        requireAuth: auth?.requireAuth,
      });
    }
  }

  // Tidy the shared stealth context + remote host on shutdown (best-effort).
  const shutdown = async () => {
    remote?.close();
    await closeBrowser().catch(() => {});
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
