// Exercise the same outward MCP handler with both clients' initialize identities.
// Browser behavior itself is covered by the real-browser acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutwardServer } from '../dist/index.js';
import { customTools } from '../dist/tools.js';

const upstreamTools = ['browser_navigate', 'browser_snapshot', 'browser_evaluate'].map((name) => ({
  name, description: name, inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
}));
const text = (result) => result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function connect(t, name) {
  const calls = [];
  const upstream = {
    listTools: async () => ({ tools: upstreamTools }),
    callTool: async (call) => {
      calls.push(call);
      return { content: [{ type: 'text', text: 'page result' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }] };
    },
  };
  const server = createOutwardServer(() => upstream, upstreamTools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: 'test' });
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

test('Codex and Claude Code initialize with identical full tool schemas and truthful cross-client instructions', async (t) => {
  const codex = await connect(t, 'codex-mcp-client');
  const claude = await connect(t, 'claude-code');
  const a = await codex.client.listTools();
  const b = await claude.client.listTools();
  assert.deepEqual(a, b);
  assert.deepEqual(a.tools.map((tool) => tool.name).sort(), [...upstreamTools, ...customTools].map((tool) => tool.name).sort());
  assert.deepEqual(codex.client.getServerCapabilities(), claude.client.getServerCapabilities());
  const guidance = codex.client.getInstructions();
  assert.equal(guidance, claude.client.getInstructions());
  assert.match(guidance, /native WebSearch tool in Claude Code/);
  assert.match(guidance, /native web-search tool in Codex\/other clients \(when enabled\)/);
  assert.match(guidance, /claude.ai Artifact/);
  assert.match(guidance, /durable local copies/);
});

for (const name of ['codex-mcp-client', 'claude-code']) {
  test(`${name}: custom/upstream routing, image results, leases, progress and queued cancellation`, { timeout: 10_000 }, async (t) => {
    const { client, calls } = await connect(t, name);
    const methodology = await client.callTool({ name: 'suite_methodology', arguments: {} });
    assert.equal(methodology.isError, undefined);
    assert.match(text(methodology), /TEST-DEFECT|PRODUCT-BUG/);
    const grant = JSON.parse(text(await client.callTool({ name: 'browser_lease_acquire', arguments: { holder: 'parity' } })));
    t.after(() => client.callTool({ name: 'browser_lease_release', arguments: { lease: grant.lease } }).catch(() => {}));
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com', lease: grant.lease } });
    assert.deepEqual(calls, [{ name: 'browser_navigate', arguments: { url: 'https://example.com' } }], 'lease is consumed by proxy');
    assert.equal(result.content.some((c) => c.type === 'image' && c.mimeType === 'image/png'), true);
    assert.match(text(result), /UNTRUSTED|data, not instructions/);

    const controller = new AbortController();
    let sawProgress;
    const progress = new Promise((resolve) => { sawProgress = resolve; });
    const queued = client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, {
      signal: controller.signal, onprogress: sawProgress,
    });
    await progress;
    assert.equal(calls.length, 1, 'unleased call waits while lease is held');
    controller.abort();
    await assert.rejects(queued);
    await settle();
    const released = await client.callTool({ name: 'browser_lease_release', arguments: { lease: grant.lease } });
    assert.equal(JSON.parse(text(released)).released, true);
    await client.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.equal(calls.length, 2, 'cancelled queued call never reaches upstream');
  });
}
