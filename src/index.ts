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

import { customTools, callCustomTool, isCustomTool } from './tools.js';
import { loadSecrets } from './secrets.js';
import { closeBrowser } from './browser.js';

const VERSION = '0.1.0';

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
    '',
    `All tools (${names.size}): ${[...names].sort().join(', ')}`,
  );
  return lines.join('\n');
}

async function main() {
  // 1. Spin up the official @playwright/mcp server in-process, headless.
  const playwrightServer = await createConnection({
    browser: {
      browserName: 'chromium',
      launchOptions: { headless: true },
    },
    secrets: loadSecrets(),
  });

  // 2. Connect to it as a client over an in-memory transport.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await playwrightServer.connect(serverTransport);
  const upstream = new Client({ name: 'playwright-mcp-proxy', version: VERSION });
  await upstream.connect(clientTransport);

  // 3. Our outward-facing server: upstream tools + custom tools, over stdio.
  //    `instructions` is the always-visible capability map (AI discoverability —
  //    see Architecture); generated from the live toolset so it never drifts.
  const { tools: upstreamTools } = await upstream.listTools();
  const server = new Server(
    { name: 'playwright-mcp', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(upstreamTools, customTools),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await upstream.listTools();
    return { tools: [...tools, ...customTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (isCustomTool(name)) return await callCustomTool(name, args ?? {});
      return await upstream.callTool({ name, arguments: args ?? {} });
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready (wrapping @playwright/mcp, headless chromium)`);

  // Tidy the shared stealth context on shutdown (best-effort).
  const shutdown = async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log('fatal:', err);
  process.exit(1);
});
