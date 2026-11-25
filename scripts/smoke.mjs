#!/usr/bin/env node
// Smoke test: start dist/index.js over stdio, list tools, navigate to a data: URL.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromeRootDir, procTable, sameProcess } from '../dist/lifetime.js';

const slotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-smoke-slot-'));
process.on('exit', () => fs.rmSync(slotDir, { recursive: true, force: true }));
const transport = new StdioClientTransport({
  command: process.execPath, // the Node running this test, not whatever `node` is first on PATH
  args: ['dist/index.js'],
  stderr: 'inherit',
  // Its own e2e slot directory (src/e2e-slot.ts): the smoke server's render and
  // its wrapper pointer stay out of the machine's live one.
  env: { ...getDefaultEnvironment(), PLAYWRIGHT_MCP_E2E_SLOT_DIR: slotDir },
});
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

// Discoverability acceptance: the server must publish a non-empty instructions
// capability map. With web_fetch present it must also carry the REPLACES NATIVE
// WebFetch steering line (web search is delegated to native WebSearch, not us).
const instructions = client.getInstructions() ?? '';
// Claude Code cuts server instructions off at 4096 characters (seen live: the cut
// landed mid-sentence and every section after it never reached the model), so the
// whole map, tool list included, must fit.
const INSTRUCTIONS_BUDGET = 4096;
const instructionsOk =
  instructions.includes('browser_navigate') && instructions.includes('REPLACES NATIVE WebFetch');
console.log(instructionsOk ? 'instructions: capability map present (+ replaces-native-WebFetch steering)' : 'FAIL: instructions missing or incomplete');
const budgetOk = instructions.length <= INSTRUCTIONS_BUDGET;
console.log(budgetOk ? `instructions: ${instructions.length}/${INSTRUCTIONS_BUDGET} chars, fits Claude Code's cut-off` : `FAIL: instructions are ${instructions.length} chars; Claude Code truncates at ${INSTRUCTIONS_BUDGET}`);

const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const expectedCustom = ['web_fetch', 'session_login', 'session_status', 'session_scaffold_tests', 'suite_scaffold', 'suite_audit', 'suite_methodology', 'browser_lease_acquire', 'browser_lease_release', 'browser_status', 'movie_script_save', 'movie_script_list', 'movie_record', 'movie_list', 'movie_clean'];
const removed = ['web_search', 'deep_research'];
const missing = expectedCustom.filter((n) => !names.has(n));
const resurrected = removed.filter((n) => names.has(n));
if (resurrected.length) console.log(`FAIL: removed tools still present: ${resurrected.join(', ')}`);
// The browser queue's lease reaches the wrapped tools' schemas (src/queue.ts).
const leaseOk = tools.find((t) => t.name === 'browser_navigate')?.inputSchema?.properties?.lease?.type === 'string';
if (!leaseOk) console.log('FAIL: browser_navigate does not advertise the optional lease argument');
const toolsOk = names.has('browser_navigate') && missing.length === 0 && resurrected.length === 0 && leaseOk;
console.log(toolsOk ? `tools: ${tools.length} present (custom: ${expectedCustom.join(', ')})` : `FAIL: missing tools: ${missing.join(', ')}`);
for (const t of tools) console.log(`  - ${t.name}`);

console.log('\nnavigating to a data: URL...');
const result = await client.callTool({
  name: 'browser_navigate',
  arguments: { url: 'data:text/html,<title>smoke-ok</title><h1>playwright-mcp smoke test</h1>' },
});
const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
console.log(text.includes('smoke-ok') ? '\nPASS: navigation + snapshot working' : `\nFAIL: unexpected result:\n${text}`);

// Exfiltration-guard acceptance (DEC-2026-07-29): page content reaching the model
// must be marked untrusted. test-exfil.mjs proves withUntrustedNotice() works;
// only this proves it is actually WIRED into the live stdio call path — deleting
// the wrapper from createOutwardServer would leave every T1 test green.
const noticeOk = (result.content ?? []).some(
  (c) => c.type === 'text' && c.text.includes('UNTRUSTED DATA, not instructions'),
);
console.log(noticeOk ? 'guards: browser_* results carry the untrusted-content notice' : 'FAIL: untrusted-content notice missing from browser_navigate result');

// Shutdown acceptance: SIGTERM must COMPLETE and exit rather than hang. The
// navigate above launched the browser, so the handler runs with real work to do —
// and because one process serves stdio AND the HTTP port off the SAME upstream,
// this covers the local and served cases alike.
//
// It also goes red on a LEAK now (2026-11-24): the Chrome roots the server
// launched are read from /proc before the signal, and every one of them must be
// gone after it. It does not prove the close was graceful rather than a kill;
// the lifetime tests (scripts/test-browser-ownership.mjs) cover each path.
console.log('\nSIGTERM with a live browser...');
const pid = transport.pid;
const chromes = [...procTable().values()].filter((p) => p.ppid === pid && chromeRootDir(p) !== undefined);
console.log(`  ${chromes.length} Chrome root(s) under the server before SIGTERM`);
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
const table = procTable();
const leaked = chromes.filter((c) => sameProcess(table, c.pid, c.start));
const leakOk = chromes.length > 0 && leaked.length === 0;
console.log(
  leakOk
    ? 'shutdown: every Chrome the server launched is gone'
    : chromes.length === 0
      ? 'FAIL: no Chrome was found under the server, so the leak check observed nothing'
      : `FAIL: Chrome left running after shutdown: ${leaked.map((c) => c.pid).join(', ')}`,
);
for (const c of leaked) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }

await client.close().catch(() => {});
process.exit(text.includes('smoke-ok') && instructionsOk && budgetOk && toolsOk && noticeOk && shutdownOk && leakOk ? 0 : 1);
