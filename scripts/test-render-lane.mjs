#!/usr/bin/env node
// T1 acceptance — the machine-wide RENDER lane (src/render-lane.ts): every
// browser_* call and web_fetch render, from every playwright-mcp server, takes one
// of a few render slots; fewer while a suite holds the suite lane, round-robin
// across sessions, bounded so a page check is never failed by it.
//
// Fake servers are child processes that take a render slot, mark start and end,
// and hold it for a while. No browser. Every test has its own slot directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LANE = path.join(ROOT, 'dist', 'render-lane.js');
const SLOT_BIN = path.join(ROOT, 'dist', 'slot-bin.js');
const POSIX = process.platform !== 'win32';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-render-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR = path.join(work, 'default');

// A fake server: takes `n` render slots at once (n calls in flight), each held `ms`.
const FAKE = path.join(work, 'fake-server.mjs');
fs.writeFileSync(
  FAKE,
  `import fs from 'node:fs';
const { takeRender } = await import(${JSON.stringify(new URL(`file://${LANE}`).href)});
const [name, ms, log, n = '1'] = process.argv.slice(2);
const mark = (s, i) => fs.appendFileSync(log, s + ' ' + name + i + ' ' + Date.now() + '\\n');
await Promise.all([...Array(Number(n)).keys()].map(async (i) => {
  const turn = await takeRender('browser_navigate');
  mark(turn.unslotted ? 'unslotted' : 'enter', i);
  // "until:<file>" holds until the test creates the file, not for a time a loaded machine may outrun.
  // A 60 s ceiling, so a failed test never leaves one behind.
  if (ms.startsWith('until:')) await new Promise((r) => { const t = setInterval(() => fs.existsSync(ms.slice(6)) && (clearInterval(t), r()), 20); setTimeout(r, 60_000).unref(); });
  else await new Promise((r) => setTimeout(r, Number(ms)));
  mark('exit', i);
  turn.release();
}));
`,
);

let gateN = 0;
function gate(dir) {
  const file = path.join(dir, `release-${++gateN}`);
  return [`until:${file}`, () => fs.writeFileSync(file, '')];
}

let laneN = 0;
function lane(extra = {}) {
  const dir = path.join(work, `lane-${++laneN}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    log: path.join(dir, 'markers.log'),
    env: { ...process.env, PLAYWRIGHT_MCP_E2E_SLOT_DIR: dir, PLAYWRIGHT_MCP_RENDER_POLL_MS: '20', PLAYWRIGHT_MCP_RENDER_SLOTS: '2', ...extra },
  };
}

const children = new Set();
process.on('exit', () => children.forEach((c) => c.kill('SIGKILL')));
function server(name, ms, { env, log }, { session = name, n = 1 } = {}) {
  const child = spawn(process.execPath, [FAKE, name, String(ms), log, String(n)], {
    env: { ...env, CLAUDE_CODE_SESSION_ID: session },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.done = new Promise((r) => child.on('close', (code) => (children.delete(child), r({ code, stderr }))));
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const marks = (log) =>
  fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => {
        const [kind, name, t] = l.split(' ');
        return { kind, name, t: Number(t) };
      })
    : [];
/** The most renders in flight at once, read off the markers in file order. */
function peak(log) {
  let now = 0;
  let max = 0;
  for (const m of marks(log)) {
    if (m.kind === 'enter') max = Math.max(max, ++now);
    if (m.kind === 'exit') now--;
  }
  return max;
}
const waiters = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, 'render', 'tickets')).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
};

test('N renders run at once across fake servers; the N+1th waits for one to end', async () => {
  const l = lane();
  const [held, release] = gate(l.dir);
  const runs = [server('a', held, l), server('b', held, l), server('c', held, l)];
  await until(() => marks(l.log).filter((m) => m.kind === 'enter').length === 2, 10_000, 'two renders');
  await until(() => waiters(l.dir) === 1, 10_000, 'the third to queue');
  await sleep(200);
  assert.equal(marks(l.log).filter((m) => m.kind === 'enter').length, 2, 'the third still waits');
  release();
  await Promise.all(runs.map((r) => r.done));
  assert.equal(peak(l.log), 2);
  const m = marks(l.log);
  const third = m.filter((x) => x.kind === 'enter')[2];
  const firstExit = m.find((x) => x.kind === 'exit');
  assert.ok(third.t >= firstExit.t, 'the third started only once one had ended');
});

test('while a suite holds the suite lane the limit drops to 1, and renders still flow', async () => {
  const l = lane({ PLAYWRIGHT_MCP_E2E_POLL_MS: '50' });
  // A suite holding the slot: the real wrapper around a sleeping command.
  const [, release] = gate(l.dir);
  const stop = path.join(l.dir, `release-${gateN}`);
  const suite = spawn(
    process.execPath,
    [SLOT_BIN, '--', process.execPath, '-e', `setInterval(() => require('fs').existsSync(${JSON.stringify(stop)}) && process.exit(0), 20); setTimeout(() => process.exit(0), 60000)`],
    { env: l.env, stdio: 'ignore' },
  );
  children.add(suite);
  await until(() => fs.existsSync(path.join(l.dir, 'slots', '0')), 10_000, 'the suite to hold the slot');
  await Promise.all([server('a', 200, l), server('b', 200, l), server('c', 200, l)].map((r) => r.done));
  assert.equal(peak(l.log), 1, 'one render at a time during the suite');
  assert.ok(fs.existsSync(path.join(l.dir, 'slots', '0')), 'every render finished while the suite still held its slot');
  release();
  await new Promise((r) => suite.on('close', r));
});

test('round-robin: a second session is served before the first session\'s backlog', async () => {
  const l = lane({ PLAYWRIGHT_MCP_RENDER_SLOTS: '1' });
  const [held, release] = gate(l.dir);
  const holder = server('h', held, l, { session: 'session-hold' });
  await until(() => marks(l.log).some((m) => m.name === 'h0'), 10_000, 'the holder');
  const busy = server('A', 50, l, { session: 'session-AAAA', n: 3 });
  await until(() => waiters(l.dir) === 3, 10_000, 'A to queue three');
  const other = server('B', 50, l, { session: 'session-BBBB' });
  await until(() => waiters(l.dir) === 4, 10_000, 'B to queue');
  release();
  await Promise.all([holder.done, busy.done, other.done]);
  const order = marks(l.log).filter((m) => m.kind === 'enter' && m.name !== 'h0').map((m) => m.name[0]);
  assert.deepEqual(order, ['A', 'B', 'A', 'A'], 'B went second, not last');
});

test('a dead render holder is freed by the next waiter', { skip: !POSIX && 'POSIX signals' }, async () => {
  const l = lane({ PLAYWRIGHT_MCP_RENDER_SLOTS: '1' });
  const dead = server('d', 60_000, l);
  await until(() => marks(l.log).some((m) => m.name === 'd0'), 10_000, 'the holder');
  dead.kill('SIGKILL');
  const t0 = Date.now();
  await server('n', 10, l).done;
  assert.ok(marks(l.log).some((m) => m.kind === 'enter' && m.name === 'n0'));
  assert.ok(Date.now() - t0 < 5_000);
});

test('a wait past the bound goes ahead without a slot and says so', async () => {
  const l = lane({ PLAYWRIGHT_MCP_RENDER_SLOTS: '1', PLAYWRIGHT_MCP_RENDER_MAX_WAIT_MS: '200' });
  const [held, release] = gate(l.dir);
  const holder = server('h', held, l, { session: 'session-hold' });
  await until(() => marks(l.log).some((m) => m.name === 'h0'), 10_000, 'the holder');
  Object.assign(process.env, { PLAYWRIGHT_MCP_E2E_SLOT_DIR: l.dir, PLAYWRIGHT_MCP_RENDER_SLOTS: '1', PLAYWRIGHT_MCP_RENDER_MAX_WAIT_MS: '200', PLAYWRIGHT_MCP_RENDER_POLL_MS: '20' });
  const { takeRender, renderNote } = await import('../dist/render-lane.js');
  const turn = await takeRender('browser_snapshot');
  turn.release();
  assert.equal(turn.unslotted, true);
  assert.match(renderNote(turn), /none free after 0s behind session session-; ran anyway/);
  release();
  await holder.done;
});

test('a waited render reports how long and behind whom; a short one says nothing', async () => {
  const { renderNote } = await import('../dist/render-lane.js');
  assert.equal(renderNote({ waitedMs: 300, behind: ['session ab'], unslotted: false }), undefined);
  assert.equal(renderNote({ waitedMs: 4200, behind: ['session abcd1234'], unslotted: false }), '[render slot: waited 4s behind session abcd1234]');
});

test('round-robin order is pure: served-longest-ago session first, FIFO within one', async () => {
  const { roundRobin } = await import('../dist/render-lane.js');
  const w = (id, session) => ({ id, session });
  const served = (k) => ({ X: 100, Y: 50 })[k] ?? 0;
  const order = roundRobin([w('1', 'X'), w('2', 'X'), w('3', 'Y'), w('4', 'Z'), w('5', 'Y')], served).map((t) => t.id);
  assert.deepEqual(order, ['4', '3', '1', '5', '2']);
});

test('uncontended overhead: taking and releasing a render slot costs a few ms', async () => {
  const l = lane();
  Object.assign(process.env, { PLAYWRIGHT_MCP_E2E_SLOT_DIR: l.dir, PLAYWRIGHT_MCP_RENDER_SLOTS: '2' });
  const { takeRender } = await import('../dist/render-lane.js');
  (await takeRender('warm-up')).release();
  const N = 200;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) (await takeRender('browser_snapshot')).release();
  const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`# render lane, uncontended take+release: ${perCallMs.toFixed(3)} ms per call (${N} calls)`);
  assert.ok(perCallMs < 10, `${perCallMs} ms per call`);
});

test('the status shows render holders and waiters by session', async () => {
  const l = lane({ PLAYWRIGHT_MCP_RENDER_SLOTS: '1' });
  const [held, release] = gate(l.dir);
  const holder = server('h', held, l, { session: 'session-hold' });
  await until(() => marks(l.log).some((m) => m.name === 'h0'), 10_000, 'the holder');
  const w = server('w', 10, l, { session: 'session-wait', n: 2 });
  await until(() => waiters(l.dir) === 2, 10_000, 'the waiters');
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, [SLOT_BIN, '--status'], { env: l.env });
    let s = '';
    c.stdout.on('data', (d) => (s += d));
    c.on('close', () => resolve(s));
  });
  assert.match(out, /Render lane .*1\/1 in use/);
  assert.match(out, /RENDER {2}session session- browser_navigate/);
  assert.match(out, /WAIT {4}session session-: 2 calls \(browser_navigate\)/);
  release();
  await Promise.all([holder.done, w.done]);
});

test('a lane that cannot be written never fails the page check', async () => {
  const blocked = path.join(work, 'not-a-dir');
  fs.writeFileSync(blocked, 'a file where the slot directory should be');
  Object.assign(process.env, { PLAYWRIGHT_MCP_E2E_SLOT_DIR: blocked });
  const { takeRender, renderNote } = await import('../dist/render-lane.js');
  const turn = await takeRender('browser_navigate');
  turn.release();
  assert.equal(turn.unslotted, true);
  assert.ok(turn.unavailable);
  assert.equal(renderNote(turn), undefined, 'no "waited" note for a wait that never happened');
});
