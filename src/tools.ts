/**
 * Custom tool registry — tools added on top of the wrapped @playwright/mcp set.
 *
 * Tools: web_fetch (stealth render + citations) and the session helpers.
 * Web search/discovery runs on Claude's native server-side WebSearch, layered
 * with web_fetch as a double-check by the session-side web-search skill — so the
 * scraping web_search/deep_research tools were removed
 * (DEC-2026-06-08-native-websearch-webfetch-doublecheck).
 * Each tool lives in src/tools/<name>.ts and registers itself here.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// Type-only: the trust tiers are DEFINED and documented in src/index.ts, which owns
// the outward surfaces. Nothing is imported at runtime, so the registry stays free
// of a require cycle with the server that imports it.
import type { SurfaceTrust } from './index.js';

/**
 * What a custom tool gets to know about the CALL, as opposed to its arguments.
 *
 * `trust` exists because two tools must behave differently per surface: a human-
 * present capture waits with no deadline on `stdio`, where the person is at this
 * display, and keeps a bounded default on an HTTP surface, where the headed window
 * would open on the server host with nobody in front of it. Arguments cannot carry
 * that — a caller could simply ask for the unbounded wait.
 *
 * `progress` is present ONLY when the incoming request carried an
 * `_meta.progressToken`. A long human wait uses it as a heartbeat so the client's
 * idle timer does not abort the call; sending one for a token the client never
 * issued makes the client complain, which is why absence has to stay visible here
 * rather than being papered over with a no-op default.
 */
export interface ToolContext {
  trust: SurfaceTrust;
  progress?: (message: string) => void;
}

type ToolHandler = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<CallToolResult>;

interface CustomTool {
  definition: Tool;
  handler: ToolHandler;
}

import { webFetch } from './tools/web-fetch.js';
import {
  sessionLoginTool,
  sessionStatusTool,
  sessionSolveChallengeTool,
  sessionAttachTool,
} from './tools/session.js';
import { sessionScaffoldTool } from './tools/scaffold.js';
import { suiteScaffoldTool, suiteAuditTool, suiteMethodologyTool } from './tools/suite.js';

const registry: CustomTool[] = [
  webFetch,
  sessionLoginTool,
  sessionStatusTool,
  sessionSolveChallengeTool,
  sessionAttachTool,
  sessionScaffoldTool,
  suiteScaffoldTool,
  suiteAuditTool,
  suiteMethodologyTool,
];

export const customTools: Tool[] = registry.map((t) => t.definition);

export function isCustomTool(name: string): boolean {
  return registry.some((t) => t.definition.name === name);
}

/**
 * `ctx` is optional so a direct caller (a test, a script) still works — but an
 * OMITTED ctx is an UNKNOWN surface, not the stdio one. Nothing downstream may read
 * "no ctx" as permission for the unbounded human wait; the session handlers treat it
 * as a non-stdio surface and cap the wait. The production call site in src/index.ts
 * always passes the real tier.
 */
export async function callCustomTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<CallToolResult> {
  const tool = registry.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`unknown custom tool: ${name}`);
  return tool.handler(args, ctx);
}
