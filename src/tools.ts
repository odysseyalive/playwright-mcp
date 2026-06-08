/**
 * Custom tool registry — tools added on top of the wrapped @playwright/mcp set.
 *
 * Phase 2 adds: web_search (Google), web_fetch, deep_research.
 * Each tool lives in src/tools/<name>.ts and registers itself here.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface CustomTool {
  definition: Tool;
  handler: ToolHandler;
}

import { webFetch } from './tools/web-fetch.js';
import { webSearch } from './tools/web-search.js';
import { deepResearch } from './tools/deep-research.js';
import { sessionLoginTool, sessionStatusTool } from './tools/session.js';

// Built bottom-up: web_fetch → web_search → deep_research → session. The upper
// layers call fetchUrl()/runSearch() in-process so the shared budget stays honest.
const registry: CustomTool[] = [webFetch, webSearch, deepResearch, sessionLoginTool, sessionStatusTool];

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
