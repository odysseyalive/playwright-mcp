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
// capability map. With web_fetch present it must also carry the REPLACES NATIVE
// WebFetch steering line (web search is delegated to native WebSearch, not us).
const instructions = client.getInstructions() ?? '';
const instructionsOk =
  instructions.includes('browser_navigate') && instructions.includes('REPLACES NATIVE WebFetch');
console.log(instructionsOk ? 'instructions: capability map present (+ replaces-native-WebFetch steering)' : 'FAIL: instructions missing or incomplete');

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const expectedCustom = ['web_fetch', 'session_login', 'session_status', 'session_scaffold_tests', 'suite_scaffold', 'suite_audit', 'suite_methodology'];
const removed = ['web_search', 'deep_research'];
const missing = expectedCustom.filter((n) => !names.has(n));
const resurrected = removed.filter((n) => names.has(n));
if (resurrected.length) console.log(`FAIL: removed tools still present: ${resurrected.join(', ')}`);
const toolsOk = names.has('browser_navigate') && missing.length === 0 && resurrected.length === 0;
console.log(toolsOk ? `tools: ${tools.length} present (custom: ${expectedCustom.join(', ')})` : `FAIL: missing tools: ${missing.join(', ')}`);
for (const t of tools) console.log(`  - ${t.name}`);

console.log('\nnavigating to a data: URL...');
const result = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'data:text/html,<title>smoke-ok</title><h1>playwright-mcp smoke test</h1>' },
});
const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
console.log(text.includes('smoke-ok') ? '\nPASS: navigation + snapshot working' : `\nFAIL: unexpected result:\n${text}`);

// Shutdown acceptance: SIGTERM must COMPLETE and exit rather than hang. The
// navigate above launched the browser, so the handler runs with real work to do —
// and because one process serves stdio AND the HTTP port off the SAME upstream,
// this covers the local and served cases alike.
//
// What this does NOT prove: that chromium was closed *gracefully*. The
// process.exit(0) after the awaits takes the browser down either way, so deleting
// closeUpstream() would leave this green. It goes red on a shutdown that hangs or
// throws — verified by stubbing closeUpstream() to never resolve. A real
// leak test would have to observe the browser's own pid, which we don't own.
console.log('\nSIGTERM with a live browser...');
const pid = transport.pid;
let shutdownOk = false;
if (pid) {
  process.kill(pid, 'SIGTERM');
  // transport.pid goes null once the child is reaped — reap-race-free, unlike
  // polling kill(pid, 0), which still succeeds against a zombie.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (transport.pid === null) { shutdownOk = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
}
console.log(shutdownOk ? 'shutdown: SIGTERM exits cleanly' : 'FAIL: server still running 10s after SIGTERM');

await client.close().catch(() => {});
process.exit(text.includes('smoke-ok') && instructionsOk && toolsOk && shutdownOk ? 0 : 1);
