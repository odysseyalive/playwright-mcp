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

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface CustomTool {
  definition: Tool;
  handler: ToolHandler;
}

import { webFetch } from './tools/web-fetch.js';
import { sessionLoginTool, sessionStatusTool } from './tools/session.js';

const registry: CustomTool[] = [webFetch, sessionLoginTool, sessionStatusTool];

export const customTools: Tool[] = registry.map((t) => t.definition);

export function isCustomTool(name: string): boolean {
  return registry.some((t) => t.definition.name === name);
}

export async function callCustomTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = registry.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`unknown custom tool: ${name}`);
  return tool.handler(args);
}
