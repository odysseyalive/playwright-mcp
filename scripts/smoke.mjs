#!/usr/bin/env node
// Smoke test: start dist/index.js over stdio, list tools, navigate to a data: URL.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

// Discoverability acceptance: the server must publish a non-empty instructions
// capability map. With web_search/web_fetch present it must also carry the
// REPLACES NATIVE TOOLS steering line.
const instructions = client.getInstructions() ?? '';
const instructionsOk =
  instructions.includes('browser_navigate') && instructions.includes('REPLACES NATIVE TOOLS');
console.log(instructionsOk ? 'instructions: capability map present (+ replaces-native steering)' : 'FAIL: instructions missing or incomplete');

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const expectedCustom = ['web_fetch', 'web_search', 'deep_research', 'session_login', 'session_status'];
const missing = expectedCustom.filter((n) => !names.has(n));
const toolsOk = names.has('browser_navigate') && missing.length === 0;
console.log(toolsOk ? `tools: ${tools.length} present (custom: ${expectedCustom.join(', ')})` : `FAIL: missing tools: ${missing.join(', ')}`);
for (const t of tools) console.log(`  - ${t.name}`);

console.log('\nnavigating to a data: URL...');
const result = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'data:text/html,<title>smoke-ok</title><h1>playwright-mcp smoke test</h1>' },
});
const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
console.log(text.includes('smoke-ok') ? '\nPASS: navigation + snapshot working' : `\nFAIL: unexpected result:\n${text}`);

await client.close();
process.exit(text.includes('smoke-ok') && instructionsOk && toolsOk ? 0 : 1);
