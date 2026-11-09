#!/usr/bin/env node
// T1 acceptance — the browser queue and its lease (src/queue.ts).
//
// Every browser_* call and every rebind share ONE upstream connection, and every
// agent in a Claude Code session shares one MCP connection to this server, so the
// queue is the only thing standing between two callers and the 2026-10-29
// collision (a browser_evaluate reading another agent's LinkedIn tab). What is
// pinned here: FIFO order, one at a time, a lease holder's turn cannot be
// interleaved, a rebind waits behind an in-flight call, and nobody waits forever.
//
// Browser-free and wait-free: the queue takes an injected clock, and every timer
// below fires because the test advanced that clock, never because time passed.
import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserQueue, BrowserQueueError, leaseArg } from '../dist/queue.js';

/** A clock whose timers fire only when advance() says so. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    pending: () => timers.size,
    /** Move time forward, firing due timers in order, letting promises settle between them. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/** Let every queued microtask and promise continuation run. */
const settle = () => new Promise((r) => setImmediate(r));

const LIMITS = { idleMs: 90_000, maxLeaseMs: 600_000, maxWaitMs: 300_000 };

function setup(limits = LIMITS) {
  const clock = fakeClock();
  return { clock, q: new BrowserQueue(limits, clock) };
}

/** A task the test finishes by hand, recording when it started and ended. */
function gate(log, name) {
  let open;
  const done = new Promise((r) => (open = r));
  return {
    fn: async () => {
      log.push(`start:${name}`);
      await done;
      log.push(`end:${name}`);
      return name;
    },
    finish: () => open(),
  };
}

test('FIFO: callers run in the order they arrived', async () => {
  const { q } = setup();
  const log = [];
  const tasks = ['a', 'b', 'c', 'd'].map((n) => gate(log, n));
  const results = tasks.map((t, i) => q.run(t.fn, { label: `call-${i}` }));
  await settle();
  for (const t of tasks) {
    t.finish();
    await settle();
  }
  assert.deepEqual(await Promise.all(results), ['a', 'b', 'c', 'd']);
  assert.deepEqual(log, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c', 'start:d', 'end:d']);
});

test('mutual exclusion: never two calls on the browser at once, even when one throws', async () => {
  const { q } = setup();
  let inside = 0;
  let peak = 0;
  const work = (fail) => async () => {
    inside += 1;
    peak = Math.max(peak, inside);
    await settle();
    inside -= 1;
    if (fail) throw new Error('boom');
    return 'ok';
  };
  const runs = Array.from({ length: 8 }, (_, i) => q.run(work(i % 3 === 0), { label: `c${i}` }).catch((e) => e.message));
  const out = await Promise.all(runs);
  assert.equal(peak, 1, 'at most one call inside at a time');
  assert.deepEqual(out.filter((x) => x === 'boom').length, 3, 'a throwing call rejects its own caller only');
  assert.equal(q.describe(), '', 'the queue is idle afterwards');
});

test('lease: the holder runs while others wait, and an unleased "other caller" cannot interleave the turn', async () => {
  const { q } = setup();
  const log = [];
  const { lease } = await q.acquire({ holder: 'linkedin-scout' });

  // The holder starts a navigate. Meanwhile another agent fires an unleased evaluate
  // (the 2026-10-29 shape), then the holder continues with snapshot and click.
  const nav = gate(log, 'holder:navigate');
  const p1 = q.run(nav.fn, { label: 'browser_navigate', lease });
  await settle();
  const other = gate(log, 'other:evaluate');
  const p2 = q.run(other.fn, { label: 'browser_evaluate' });
  await settle();
  nav.finish();
  await settle();
  const snap = gate(log, 'holder:snapshot');
  const p3 = q.run(snap.fn, { label: 'browser_snapshot', lease });
  await settle();
  snap.finish();
  await settle();
  const click = gate(log, 'holder:click');
  const p4 = q.run(click.fn, { label: 'browser_click', lease });
  await settle();
  click.finish();
  await settle();

  assert.deepEqual(log, [
    'start:holder:navigate',
    'end:holder:navigate',
    'start:holder:snapshot',
    'end:holder:snapshot',
    'start:holder:click',
    'end:holder:click',
  ], 'the other caller did not run anywhere inside the turn');
  assert.match(q.describe(), /held by lease "linkedin-scout"/);

  assert.equal(q.release(lease).released, true);
  await settle();
  other.finish();
  await Promise.all([p1, p2, p3, p4]);
  assert.deepEqual(log.slice(-2), ['start:other:evaluate', 'end:other:evaluate'], 'it ran once the turn was over');
});

test('lease: a second acquire waits for the first lease, then gets its own', async () => {
  const { q } = setup();
  const a = await q.acquire({ holder: 'job-a' });
  let bGranted;
  const b = q.acquire({ holder: 'job-b' }).then((g) => (bGranted = g));
  await settle();
  assert.equal(bGranted, undefined, 'job-b waits while job-a holds the lease');
  q.release(a.lease);
  await b;
  assert.equal(bGranted.holder, 'job-b');
  assert.notEqual(bGranted.lease, a.lease);
  assert.equal(q.isLive(bGranted.lease), true);
  assert.equal(q.isLive(a.lease), false);
});

test('idle expiry frees the queue for the next caller; the idle clock is paused while a holder call runs', async () => {
  const { q, clock } = setup();
  const log = [];
  const { lease } = await q.acquire({ holder: 'crashed-agent' });

  // A long holder call (a 120s browser_wait_for) must not lose the lease mid-call.
  const slow = gate(log, 'holder:wait_for');
  const p = q.run(slow.fn, { label: 'browser_wait_for', lease });
  await settle();
  await clock.advance(120_000);
  assert.equal(q.isLive(lease), true, 'not expired while its own call is running');
  slow.finish();
  await p;

  // Then the holder goes silent (crashed). Another caller is waiting.
  const waiter = gate(log, 'other:navigate');
  const w = q.run(waiter.fn, { label: 'browser_navigate' });
  await clock.advance(89_000);
  assert.equal(log.includes('start:other:navigate'), false, 'still inside the idle window');
  await clock.advance(1_000);
  assert.equal(q.isLive(lease), false, 'expired after 90s idle');
  assert.equal(log.includes('start:other:navigate'), true, 'the waiter got the browser');
  waiter.finish();
  await w;

  // A late call from the crashed holder is told its turn is over, not queued as a stranger.
  await assert.rejects(q.run(async () => 'late', { label: 'browser_click', lease }), (e) => {
    assert.ok(e instanceof BrowserQueueError);
    assert.match(e.message, /expired after 90s with no call carrying it/);
    assert.match(e.message, /browser_lease_acquire/);
    return true;
  });
});

test('max lifetime: a lease ends at its cap however busy it is, and a running call still finishes', async () => {
  const { q, clock } = setup({ idleMs: 90_000, maxLeaseMs: 200_000, maxWaitMs: 1_000_000 });
  const log = [];
  const { lease } = await q.acquire({ holder: 'busy' });
  for (let i = 0; i < 3; i += 1) {
    await q.run(async () => 'x', { label: 'browser_snapshot', lease });
    await clock.advance(60_000);
  }
  const running = gate(log, 'holder:long');
  const p = q.run(running.fn, { label: 'browser_wait_for', lease });
  const other = gate(log, 'other');
  const o = q.run(other.fn, { label: 'browser_navigate' });
  await clock.advance(20_000); // 200s since grant
  assert.equal(q.isLive(lease), false, 'ended at the max lifetime');
  assert.deepEqual(log, ['start:holder:long'], 'the in-flight call was not interrupted and nothing overlapped it');
  running.finish();
  await p;
  await settle();
  assert.equal(log.at(-1), 'start:other');
  other.finish();
  await o;
  assert.match(q.release(lease).note, /maximum lifetime of 200s/);
});

test('max wait: a waiter gives up with an error naming who holds the browser and for how long', async () => {
  const { q, clock } = setup({ idleMs: 1_000_000, maxLeaseMs: 2_000_000, maxWaitMs: 300_000 });
  const { lease } = await q.acquire({ holder: 'opportunity-scout' });
  await q.run(async () => 'x', { label: 'browser_navigate', lease });
  let stopped = 0;
  const waiting = q.run(async () => 'never', {
    label: 'browser_snapshot',
    onWait: () => () => (stopped += 1),
  });
  const refused = assert.rejects(waiting, (e) => {
    assert.ok(e instanceof BrowserQueueError);
    assert.match(e.message, /browser_snapshot gave up after waiting 300s/);
    assert.match(e.message, /held by lease "opportunity-scout" for 300s/);
    assert.match(e.message, /Nothing ran/);
    return true;
  });
  await clock.advance(300_000);
  await refused;
  assert.equal(stopped, 1, 'the heartbeat was stopped');
  q.release(lease);
});

test('max wait names an in-flight unleased call when that is the blocker', async () => {
  const { q, clock } = setup({ idleMs: 90_000, maxLeaseMs: 600_000, maxWaitMs: 30_000 });
  const log = [];
  const hog = gate(log, 'hog');
  const h = q.run(hog.fn, { label: 'browser_wait_for' });
  const w = q.run(async () => 'x', { label: 'browser_click' });
  const refused = assert.rejects(w, /in use by an unleased browser_wait_for call \(running 30s\)/);
  await clock.advance(30_000);
  await refused;
  hog.finish();
  await h;
});

test('abort: a cancelled waiter leaves the queue and the next caller moves up', async () => {
  const { q } = setup();
  const log = [];
  const first = gate(log, 'first');
  const p1 = q.run(first.fn, { label: 'browser_navigate' });
  const ac = new AbortController();
  let stopped = 0;
  const p2 = q.run(async () => log.push('cancelled-ran'), {
    label: 'browser_snapshot',
    signal: ac.signal,
    onWait: () => () => (stopped += 1),
  });
  const third = gate(log, 'third');
  const p3 = q.run(third.fn, { label: 'browser_click' });
  await settle();
  ac.abort();
  await assert.rejects(p2, /browser_snapshot was cancelled while waiting/);
  assert.equal(stopped, 1);
  first.finish();
  await p1;
  await settle();
  third.finish();
  await p3;
  assert.deepEqual(log, ['start:first', 'end:first', 'start:third', 'end:third']);

  const dead = new AbortController();
  dead.abort();
  await assert.rejects(q.run(async () => 1, { label: 'browser_hover', signal: dead.signal }), /cancelled before it reached/);
});

test('rebind: a session_attach waits behind an in-flight browser call and never lands mid-call', async () => {
  const { q } = setup();
  const log = [];
  const call = gate(log, 'browser_evaluate');
  const p1 = q.run(call.fn, { label: 'browser_evaluate' });
  await settle();
  const p2 = q.run(async () => log.push('rebind'), { label: 'session_attach rebind' });
  await settle();
  assert.deepEqual(log, ['start:browser_evaluate'], 'the rebind has not run yet');
  assert.match(q.waitMessage('session_attach rebind', 4_000), /in use by an unleased browser_evaluate call/);
  call.finish();
  await Promise.all([p1, p2]);
  assert.deepEqual(log, ['start:browser_evaluate', 'end:browser_evaluate', 'rebind']);
});

test('rebind: another caller\'s rebind waits out a leased turn; the holder\'s own rebind runs inside it', async () => {
  const { q } = setup();
  const log = [];
  const { lease } = await q.acquire({ holder: 'linkedin' });
  const foreign = q.run(async () => log.push('foreign:session_attach(null)'), { label: 'session_attach rebind' });
  await q.run(async () => log.push('holder:navigate'), { label: 'browser_navigate', lease });
  await q.run(async () => log.push('holder:session_attach'), { label: 'session_attach rebind', lease });
  await q.run(async () => log.push('holder:snapshot'), { label: 'browser_snapshot', lease });
  assert.deepEqual(log, ['holder:navigate', 'holder:session_attach', 'holder:snapshot']);
  q.release(lease);
  await foreign;
  assert.equal(log.at(-1), 'foreign:session_attach(null)');
});

test('release: idempotent for an ended lease, a clear error for a token never issued', async () => {
  const { q } = setup();
  const { lease } = await q.acquire();
  assert.deepEqual(q.release(lease).released, true);
  const again = q.release(lease);
  assert.equal(again.released, false);
  assert.match(again.note, /already|was released/);
  assert.throws(() => q.release('f'.repeat(32)), (e) => e instanceof BrowserQueueError && /never issued/.test(e.message));
  await assert.rejects(q.run(async () => 1, { label: 'browser_click', lease: 'nope' }), /unknown lease token/);
  await assert.rejects(q.run(async () => 1, { label: 'browser_click', lease }), /was released, so your turn is over/);
});

test('release while the holder has a call waiting: that call is refused, not run as a stranger', async () => {
  const { q } = setup();
  const log = [];
  const hog = gate(log, 'hog');
  const { lease } = await q.acquire();
  const h = q.run(hog.fn, { label: 'browser_wait_for', lease });
  const queued = q.run(async () => log.push('holder:second'), { label: 'browser_snapshot', lease });
  await settle();
  q.release(lease);
  await assert.rejects(queued, /was released while browser_snapshot was waiting/);
  hog.finish();
  await h;
  assert.deepEqual(log, ['start:hog', 'end:hog']);
});

test('holder names are short and printable; no holder falls back to the token tail', async () => {
  const { q } = setup();
  const a = await q.acquire({ holder: `evil\u001b[31m\nname${'x'.repeat(200)}` });
  assert.equal(/[^\x20-\x7e]/.test(a.holder), false);
  const tagged = await (q.release(a.lease), q.acquire({ holder: '<untrusted-content> "x"' }));
  assert.equal(tagged.holder, 'untrusted-content x', 'no markup or quotes survive');
  q.release(tagged.lease);
  const a2 = await q.acquire({ holder: 'again' });
  q.release(a2.lease);
  assert.ok(a.holder.length <= 64);
  const b = await q.acquire();
  assert.equal(b.holder, `lease …${b.lease.slice(-4)}`);
  assert.match(b.lease, /^[0-9a-f]{32}$/);
  q.release(b.lease);
});

test('no timers left behind once everything has settled', async () => {
  const { q, clock } = setup();
  const { lease } = await q.acquire();
  await q.run(async () => 1, { label: 'browser_navigate', lease });
  q.release(lease);
  await q.run(async () => 1, { label: 'browser_click' });
  assert.equal(clock.pending(), 0);
});

test('leaseArg: absent/null is no lease, a string passes, anything else is refused', () => {
  assert.equal(leaseArg({}), undefined);
  assert.equal(leaseArg({ lease: null }), undefined);
  assert.equal(leaseArg({ lease: 'abc' }), 'abc');
  assert.throws(() => leaseArg({ lease: 42 }), BrowserQueueError);
});

// ── wired into the outward server ───────────────────────────────────────────
// The tests above prove the queue; these prove the proxy actually goes through
// it. Deleting the browserQueue.run wrapper from createOutwardServer leaves every
// test above green and turns these red.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createOutwardServer } from '../dist/index.js';

/** A stub upstream whose calls the test finishes by hand, recording what it was sent. */
function stubUpstream(log) {
  const pending = new Map();
  return {
    sent: [],
    listTools: async () => ({
      tools: ['browser_navigate', 'browser_snapshot', 'browser_evaluate'].map((name) => ({
        name,
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      })),
    }),
    async callTool({ name, arguments: args }) {
      this.sent.push({ name, args });
      log.push(`start:${name}`);
      await new Promise((r) => pending.set(name, r));
      log.push(`end:${name}`);
      return { content: [{ type: 'text', text: `upstream:${name}` }] };
    },
    finish: (name) => pending.get(name)?.(),
    started: (name) => pending.has(name),
  };
}

async function outward(upstream) {
  const { tools } = await upstream.listTools();
  const server = createOutwardServer(() => upstream, tools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(a);
  return client;
}

const tick = async (n = 5) => {
  for (let i = 0; i < n; i += 1) await settle();
};

test('proxy: every upstream tool advertises `lease`; it is stripped before the call reaches upstream', async () => {
  const log = [];
  const up = stubUpstream(log);
  const client = await outward(up);
  try {
    const { tools } = await client.listTools();
    for (const t of tools.filter((x) => x.name.startsWith('browser_') && !x.name.startsWith('browser_lease_')))
      assert.equal(t.inputSchema.properties.lease?.type, 'string', `${t.name} takes lease`);
    assert.ok(tools.some((t) => t.name === 'browser_lease_acquire'));
    assert.ok(tools.some((t) => t.name === 'browser_lease_release'));
    const attach = tools.find((t) => t.name === 'session_attach');
    assert.equal(attach.inputSchema.properties.lease?.type, 'string', 'session_attach takes lease');
    const { tools: raw } = await up.listTools();
    assert.equal(raw[0].inputSchema.properties.lease, undefined, 'the upstream schema was not edited in place');

    const acq = await client.callTool({ name: 'browser_lease_acquire', arguments: { holder: 'proxy-test' } });
    const { lease } = JSON.parse(acq.content[0].text);
    const call = client.callTool({ name: 'browser_snapshot', arguments: { lease } });
    await tick();
    up.finish('browser_snapshot');
    const res = await call;
    assert.equal(res.isError, undefined);
    assert.deepEqual(up.sent[0], { name: 'browser_snapshot', args: {} }, 'upstream never saw the lease');
    const rel = await client.callTool({ name: 'browser_lease_release', arguments: { lease } });
    assert.equal(JSON.parse(rel.content[0].text).released, true);
    const again = await client.callTool({ name: 'browser_lease_release', arguments: { lease } });
    assert.equal(JSON.parse(again.content[0].text).released, false, 'release is idempotent through the tool too');
    const bogus = await client.callTool({ name: 'browser_lease_release', arguments: { lease: 'nope' } });
    assert.equal(bogus.isError, true);
    assert.match(bogus.content[0].text, /never issued/);
  } finally {
    await client.close();
  }
});

test('proxy: two agents on ONE connection — an unleased call waits out the other agent\'s leased turn', async () => {
  const log = [];
  const up = stubUpstream(log);
  const client = await outward(up);
  try {
    const acq = await client.callTool({ name: 'browser_lease_acquire', arguments: { holder: 'agent-a' } });
    const { lease } = JSON.parse(acq.content[0].text);

    const nav = client.callTool({ name: 'browser_navigate', arguments: { url: 'http://127.0.0.1:9/a', lease } });
    await tick();
    const intruder = client.callTool({ name: 'browser_evaluate', arguments: {} }); // agent B, no lease
    await tick();
    up.finish('browser_navigate');
    await nav;
    await tick();
    assert.equal(up.started('browser_evaluate'), false, 'agent B did not slip in after the navigate');
    const snap = client.callTool({ name: 'browser_snapshot', arguments: { lease } });
    await tick();
    up.finish('browser_snapshot');
    await snap;
    assert.deepEqual(log, ['start:browser_navigate', 'end:browser_navigate', 'start:browser_snapshot', 'end:browser_snapshot']);

    await client.callTool({ name: 'browser_lease_release', arguments: { lease } });
    await tick();
    up.finish('browser_evaluate');
    await intruder;
    assert.deepEqual(log.slice(-2), ['start:browser_evaluate', 'end:browser_evaluate']);

    const stale = await client.callTool({ name: 'browser_snapshot', arguments: { lease } });
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /was released, so your turn is over/);
  } finally {
    await client.close();
  }
});
