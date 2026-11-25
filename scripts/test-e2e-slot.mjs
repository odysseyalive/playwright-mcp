#!/usr/bin/env node
// T1 acceptance — the machine-wide e2e slot's SUITE lane (src/e2e-slot.ts,
// src/slot-cli.ts) and suite_audit's use of it (src/tools/suite.ts).
//
// 2026-11-25: several e2e suites from different sessions ran at once and locked up
// a 4-core laptop. These tests hold the slot with child processes that only sleep
// and write markers, so they need no browser and no Playwright. Every one runs
// against its own slot directory (PLAYWRIGHT_MCP_E2E_SLOT_DIR), never the live one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BIN = path.join(ROOT, 'dist', 'slot-bin.js');
const POSIX = process.platform !== 'win32';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-slot-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
// Set before the module is imported, and per test below, so nothing reads the live slot.
process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR = path.join(work, 'default');

const { capWorkers, resolveWorkers, parseDuration, playwrightTestIndex } = await import('../dist/e2e-slot.js');
const { parseSlotArgs } = await import('../dist/slot-cli.js');

// A command that marks its start and end, holds for `ms`, and exits `code`
// (7 on SIGTERM, having said so). Plain node: no shell, the same on every OS.
const HOLD = path.join(work, 'hold.mjs');
fs.writeFileSync(
  HOLD,
  `import fs from 'node:fs';
const [name, ms, log, code = '0'] = process.argv.slice(2);
const mark = (s) => fs.appendFileSync(log, s + ' ' + name + ' ' + Date.now() + ' ' + process.pid + '\\n');
const done = () => { mark('exit'); process.exit(Number(code)); };
process.on('SIGTERM', () => { mark('term'); process.exit(7); });
mark('enter');
// "until:<file>" holds until the test creates the file: no race against a timer on a loaded machine.
// A 60 s ceiling, so a failed test never leaves one behind waiting for a file that will not come.
if (ms.startsWith('until:')) { setInterval(() => fs.existsSync(ms.slice(6)) && done(), 20); setTimeout(done, 60_000); }
else setTimeout(done, Number(ms));
`,
);

let dirN = 0;
/** A fresh slot directory and the env that points the wrapper at it. */
function lane(extra = {}) {
  const dir = path.join(work, `lane-${++dirN}`);
  const env = {
    ...process.env,
    PLAYWRIGHT_MCP_E2E_SLOT_DIR: dir,
    PLAYWRIGHT_MCP_E2E_POLL_MS: '50',
    PLAYWRIGHT_MCP_E2E_PROGRESS_MS: '200',
    PLAYWRIGHT_MCP_E2E_WORKERS: '2',
    ...extra,
  };
  delete env.PLAYWRIGHT_MCP_E2E_SLOT_HELD;
  const log = path.join(dir, 'markers.log');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, env, log };
}

const children = new Set();
process.on('exit', () => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** Start the wrapper; resolves {code, stdout, stderr} when it exits. */
function wrap(args, env, opts = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd: opts.cwd ?? work, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.err = () => stderr;
  // 'exit', not 'close': a killed wrapper's command still holds the inherited pipes open.
  child.exited = new Promise((resolve) => child.on('exit', resolve));
  child.done = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    }),
  );
  return child;
}

let gateN = 0;
/** A release file for an `until:` hold: [the ms argument, open()]. */
function gate(dir) {
  const file = path.join(dir, `release-${++gateN}`);
  return [`until:${file}`, () => fs.writeFileSync(file, '')];
}
const hold = (name, ms, log, code = 0) => ['--', process.execPath, HOLD, name, String(ms), log, String(code)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}
const tickets = (dir) => {
  try {
    return fs.readdirSync(path.join(dir, 'tickets')).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
};
const markers = (log) =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          const [kind, name, t, pid] = l.split(' ');
          return { kind, name, t: Number(t), pid: Number(pid) };
        })
    : [];
const status = (env) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, '--status', '--json'], { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(JSON.parse(out)));
  });

// ── pure parts ──────────────────────────────────────────────────────────────

test('workers: only `playwright test` is touched; an explicit value at or under the cap is kept', () => {
  assert.equal(playwrightTestIndex(['npx', 'playwright', 'test', 'a.spec.ts']), 2);
  assert.equal(playwrightTestIndex(['node_modules/.bin/playwright.cmd', 'test']), 1);
  assert.equal(playwrightTestIndex(['npx', 'playwright', 'show-report']), -1);
  assert.equal(playwrightTestIndex(['npm', 'test', '--', '--workers=8']), -1);

  const kept = capWorkers(['npx', 'playwright', 'test', '--workers=1', '--retries=0'], 2, 4);
  assert.deepEqual(kept.argv, ['npx', 'playwright', 'test', '--workers=1', '--retries=0'], '--workers=1 stays 1');
  assert.match(kept.note, /kept/);

  const none = capWorkers(['npx', 'playwright', 'test', 'a.spec.ts'], 2, 4);
  assert.deepEqual(none.argv, ['npx', 'playwright', 'test', 'a.spec.ts'], 'nothing is added: a config asking for fewer must not be raised');

  const other = capWorkers(['npm', 'run', 'e2e', '--', '--workers=8'], 2, 4);
  assert.deepEqual(other.argv, ['npm', 'run', 'e2e', '--', '--workers=8']);
  assert.match(other.note, /not a `playwright test` command/);
});

test('workers: above the cap is lowered, in every spelling, percent resolved against the cores', () => {
  assert.deepEqual(capWorkers(['npx', 'playwright', 'test', '--workers=8'], 2, 4).argv, ['npx', 'playwright', 'test', '--workers=2']);
  assert.match(capWorkers(['npx', 'playwright', 'test', '--workers=8'], 2, 4).note, /lowered 8 to the cap 2/);
  assert.deepEqual(capWorkers(['playwright', 'test', '--workers', '6'], 2, 4).argv, ['playwright', 'test', '--workers', '2']);
  assert.deepEqual(capWorkers(['playwright', 'test', '-j', '6'], 2, 4).argv, ['playwright', 'test', '-j', '2']);
  assert.deepEqual(capWorkers(['playwright', 'test', '-j6'], 2, 4).argv, ['playwright', 'test', '-j2']);
  // 100% of 8 cores = 8 > 2: lowered. 25% of 8 = 2: kept as written.
  assert.deepEqual(capWorkers(['playwright', 'test', '--workers=100%'], 2, 8).argv, ['playwright', 'test', '--workers=2']);
  assert.deepEqual(capWorkers(['playwright', 'test', '--workers=25%'], 2, 8).argv, ['playwright', 'test', '--workers=25%']);
  // Playwright's own rounding: floor(cores * pct), at least 1.
  assert.equal(resolveWorkers('50%', 5), 2);
  assert.equal(resolveWorkers('10%', 4), 1);
});

test('durations and flags parse; a bad one is an error, not a silent default', () => {
  assert.equal(parseDuration('5h'), 5 * 3_600_000);
  assert.equal(parseDuration('90'), 90 * 60_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('soon'), undefined);
  const o = parseSlotArgs(['--max-wait', '2h', '--max-hold=6h', '--detach', '--log', 'x.log', '--', 'npx', 'playwright', 'test']);
  assert.equal(o.maxWaitMs, 2 * 3_600_000);
  assert.equal(o.maxHoldMs, 6 * 3_600_000);
  assert.equal(o.detach, true);
  assert.deepEqual(o.command, ['npx', 'playwright', 'test']);
  assert.throws(() => parseSlotArgs(['--max-wait', 'later', '--', 'x']), /not a duration/);
});

// ── ordering and exclusion ──────────────────────────────────────────────────

test('FIFO: three processes run in the order they queued, never overlapping', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const b = wrap(hold('B', 50, log), env);
  await until(() => tickets(dir).length === 2, 10_000, 'B to queue');
  const c = wrap(hold('C', 50, log), env);
  await until(() => tickets(dir).length === 3, 10_000, 'C to queue');
  await until(() => /position 2/.test(c.err()), 10_000, 'C to report its place');
  release();
  const results = await Promise.all([a.done, b.done, c.done]);
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0]);
  const enters = markers(log).filter((m) => m.kind === 'enter').map((m) => m.name);
  assert.deepEqual(enters, ['A', 'B', 'C']);
  assert.match(results[2].stderr, /waiting: position 2 behind .* running .*hold\.mjs A/);
  assert.equal(tickets(dir).length, 0, 'every ticket released');
});

test('exclusion under contention: six processes started at once never overlap', async () => {
  const { dir, env, log } = lane();
  const runs = ['1', '2', '3', '4', '5', '6'].map((n) => wrap(hold(n, 60, log), env));
  const results = await Promise.all(runs.map((r) => r.done));
  assert.deepEqual(results.map((r) => r.code), [0, 0, 0, 0, 0, 0]);
  const m = markers(log);
  assert.equal(m.length, 12);
  // Read in file order: every enter is followed by the same run's exit.
  for (let i = 0; i < m.length; i += 2) {
    assert.equal(m[i].kind, 'enter');
    assert.equal(m[i + 1].kind, 'exit');
    assert.equal(m[i].name, m[i + 1].name, `overlap at ${i}: ${JSON.stringify(m.slice(i, i + 2))}`);
  }
  assert.equal(tickets(dir).length, 0);
});

// ── stale holders ───────────────────────────────────────────────────────────

test('a SIGKILLed holder is skipped once its command is gone too, never while the command still runs', { skip: !POSIX && 'POSIX signals' }, async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  await until(() => fs.readFileSync(path.join(dir, 'tickets', tickets(dir)[0]), 'utf8').includes('childPid'), 5_000, 'the command pid in the ticket');
  const b = wrap(hold('B', 50, log), env);
  await until(() => tickets(dir).length === 2, 10_000, 'B to queue');
  // The wrapper dies without a word; its command, in its own process group, runs on.
  a.kill('SIGKILL');
  await a.exited;
  await sleep(600);
  assert.ok(!markers(log).some((m) => m.name === 'B'), 'B does not start beside a suite that is still running');
  release(); // A's command ends: now nothing of A is left
  const r = await b.done;
  assert.equal(r.code, 0);
  const m = markers(log);
  assert.ok(m.findIndex((x) => x.kind === 'exit' && x.name === 'A') < m.findIndex((x) => x.name === 'B'));
});

test('pid reuse: a ticket whose pid now belongs to a newer process is dropped', async () => {
  const { dir, env, log } = lane();
  // A holder ticket and claim for THIS test process's pid, with a start time that
  // is not this process's: what a reused pid looks like.
  const { ownStart } = await import('../dist/e2e-slot.js');
  const start = await ownStart();
  const id = `00000000000001-${process.pid}-abcdef`;
  fs.mkdirSync(path.join(dir, 'tickets'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'slots', '0'), { recursive: true });
  const ticket = { id, pid: process.pid, start: (start ?? 0) + 12345, cwd: '/old', command: 'stale run', via: 'cli', enqueuedAt: new Date(1).toISOString(), acquiredAt: new Date(1).toISOString(), maxHoldMs: 1 };
  fs.writeFileSync(path.join(dir, 'tickets', `${id}.json`), JSON.stringify(ticket));
  fs.writeFileSync(path.join(dir, 'slots', '0', id), '');
  const before = await status(env);
  assert.equal(before.holders.length, 0, 'the status already leaves it out');
  const r = await wrap(hold('B', 20, log), env).done;
  assert.equal(r.code, 0);
  assert.ok(!r.stderr.includes('waiting'), r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'tickets', `${id}.json`)), 'the stale ticket was removed');
});

test('overdue: past its max hold the holder is reported, not killed', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(['--max-hold', '300ms', ...hold('A', held, log)], env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  await sleep(500);
  const s = await status(env);
  assert.equal(s.holders.length, 1);
  assert.equal(s.holders[0].overdue, true);
  const text = await new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, '--status'], { env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', () => resolve(out));
  });
  assert.match(text, /HOLDER .*hold\.mjs A .*OVERDUE/);
  const b = wrap(hold('B', 10, log), env);
  await until(() => /OVERDUE/.test(b.err()), 10_000, 'the waiter to be told');
  release();
  await b.done;
  const ra = await a.done;
  assert.equal(ra.code, 0, 'the overdue holder ran to its end');
  assert.ok(markers(log).some((m) => m.kind === 'exit' && m.name === 'A'));
});

test('a waiter that runs out of time fails with exit 124, naming the holder; nothing ran', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const r = await wrap(['--max-wait', '300ms', ...hold('B', 10, log)], env).done;
  assert.equal(r.code, 124);
  assert.match(r.stderr, /gave up .* held by .*hold\.mjs A/);
  assert.ok(!markers(log).some((m) => m.name === 'B'));
  release();
  await a.done;
  assert.equal(tickets(dir).length, 0);
});

test('the status lists the holder and the queue, with positions', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const b = wrap(hold('B', 10, log), env);
  await until(() => tickets(dir).length === 2, 10_000, 'B to queue');
  const s = await status(env);
  assert.equal(s.slots, 1);
  assert.equal(s.holders[0].command.includes('hold.mjs A'), true);
  assert.equal(s.waiting[0].position, 1);
  assert.equal(s.waiting[0].command.includes('hold.mjs B'), true);
  assert.equal(typeof s.render?.limit, 'number', 'the render lane is in the same status');
  release();
  await Promise.all([a.done, b.done]);
});

// ── the wrapper ─────────────────────────────────────────────────────────────

test('exit codes pass through', async () => {
  const { env, log } = lane();
  assert.equal((await wrap(hold('A', 10, log, 5), env).done).code, 5);
  assert.equal((await wrap(['--', 'definitely-not-a-command-pwmcp'], env).done).code, 127);
});

test('SIGTERM is forwarded to the command, which exits its own way; the slot is released', { skip: !POSIX && 'POSIX signals' }, async () => {
  const { dir, env, log } = lane();
  const a = wrap(hold('A', 20_000, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  a.kill('SIGTERM');
  const r = await a.done;
  assert.equal(r.code, 7, 'the wrapper exits with the command\'s own code');
  assert.ok(markers(log).some((m) => m.kind === 'term'), 'the command got SIGTERM');
  assert.equal(tickets(dir).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'slots')).filter((n) => !n.startsWith('.')).length, 0);
});

test('`npx playwright test` runs through the wrapper, with --workers lowered and the slot marker set', { skip: !POSIX && 'a POSIX .bin shim' }, async () => {
  const { env } = lane();
  // A project whose local playwright bin only records what it was given, so npx
  // resolves it from node_modules/.bin and fetches nothing.
  const project = path.join(work, 'npx-project');
  const bin = path.join(project, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"npx-project","version":"0.0.0"}');
  fs.writeFileSync(
    path.join(bin, 'playwright'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(project)}, 'ran.json'), JSON.stringify({ argv: process.argv.slice(2), held: process.env.PLAYWRIGHT_MCP_E2E_SLOT_HELD, cap: process.env.PLAYWRIGHT_MCP_E2E_WORKERS }));\n`,
    { mode: 0o755 },
  );
  const r = await wrap(['--', 'npx', '--no-install', 'playwright', 'test', 'a.spec.ts', '--workers=8', '--retries=0'], env, { cwd: project }).done;
  assert.equal(r.code, 0, r.stderr);
  const ran = JSON.parse(fs.readFileSync(path.join(project, 'ran.json'), 'utf8'));
  assert.deepEqual(ran.argv, ['test', 'a.spec.ts', '--workers=2', '--retries=0']);
  assert.ok(ran.held, 'the command knows it is inside the slot');
  assert.equal(ran.cap, '2');
  assert.match(r.stderr, /lowered 8 to the cap 2/);
});

test('re-entrant: a wrapper inside a command that holds the slot runs at once', async () => {
  const { env, log } = lane();
  const inner = [process.execPath, BIN, ...hold('inner', 10, log)];
  const r = await wrap(['--max-wait', '3s', '--', ...inner], env).done;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /running at once, not queueing/);
  assert.ok(markers(log).some((m) => m.name === 'inner'));
});

// ── detached ────────────────────────────────────────────────────────────────

const lastLine = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').pop() : '');

test('detached: returns at once with the position and log; the runner owns the ticket; the log ends "done 0"', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const runLog = path.join(dir, 'run.log');
  const launcher = wrap(['--detach', '--log', runLog, ...hold('D', 10, log)], env);
  const r = await launcher.done; // returns while A still holds the slot: it did not wait for it
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!markers(log).some((m) => m.kind === 'exit' && m.name === 'A'), 'A was still holding');
  assert.match(r.stdout, /queued at position 1/);
  assert.ok(r.stdout.includes(runLog));
  const s = await status(env);
  const w = s.waiting.find((x) => x.command.includes('hold.mjs D'));
  assert.ok(w, 'the detached run is queued');
  assert.notEqual(w.pid, launcher.pid, 'the ticket belongs to the runner, not the launcher');
  assert.equal(w.log, runLog, 'the status shows its log');
  await until(() => /waiting: position 1/.test(fs.readFileSync(runLog, 'utf8')), 10_000, 'a position line in the log');
  release();
  await until(() => lastLine(runLog).startsWith('done'), 15_000, 'the detached run to finish');
  const body = fs.readFileSync(runLog, 'utf8');
  assert.equal(lastLine(runLog), 'done 0');
  assert.match(body, /waiting: position 1 behind .*hold\.mjs A/);
  assert.match(body, /\nacquired \d{4}-/);
  await a.done;
  await until(() => tickets(dir).length === 0, 5_000, 'the runner to release');
});

test('detached: a max wait that runs out ends the log with "done timeout"', async () => {
  const { dir, env, log } = lane();
  const [held, release] = gate(dir);
  const a = wrap(hold('A', held, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const runLog = path.join(dir, 'timeout.log');
  const r = await wrap(['--detach', '--max-wait', '300ms', '--log', runLog, ...hold('T', 10, log)], env).done;
  assert.equal(r.code, 0);
  await until(() => lastLine(runLog).startsWith('done'), 10_000, 'the runner to give up');
  assert.equal(lastLine(runLog), 'done timeout');
  assert.ok(!markers(log).some((m) => m.name === 'T'));
  release();
  await a.done;
});

test('detached with no --log writes under the slot directory and says where', async () => {
  const { dir, env, log } = lane();
  const r = await wrap(['--detach', ...hold('L', 10, log)], env).done;
  assert.equal(r.code, 0, r.stderr);
  const file = /log: (.+)/.exec(r.stdout)?.[1];
  assert.ok(file?.startsWith(path.join(dir, 'logs')), r.stdout);
  await until(() => lastLine(file).startsWith('done'), 10_000, 'the run to finish');
  assert.equal(lastLine(file), 'done 0');
});

// ── suite_audit ─────────────────────────────────────────────────────────────

test('suite_audit takes the slot around its run, waits behind a holder, and says so', async () => {
  const { dir, env, log } = lane();
  // The tool runs in THIS process: point it at the same lane.
  Object.assign(process.env, { PLAYWRIGHT_MCP_E2E_SLOT_DIR: dir, PLAYWRIGHT_MCP_E2E_POLL_MS: '50', PLAYWRIGHT_MCP_E2E_WORKERS: '2' });
  const project = path.join(work, 'audit-project');
  const pkg = path.join(project, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(project, 'playwright.config.ts'), 'export default {};\n');
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@playwright/test', version: '0.0.0-fake', bin: { playwright: 'cli.js' }, exports: { './package.json': './package.json' } }),
  );
  // The fake suite records whether a claim on the slot existed while it ran.
  fs.writeFileSync(
    path.join(pkg, 'cli.js'),
    `const fs = require('node:fs'); const path = require('node:path');
const slots = path.join(process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR, 'slots');
const claims = fs.readdirSync(slots).filter((n) => !n.startsWith('.')).flatMap((n) => fs.readdirSync(path.join(slots, n)));
fs.writeFileSync(path.join(process.cwd(), 'ran.json'), JSON.stringify({ claims, held: process.env.PLAYWRIGHT_MCP_E2E_SLOT_HELD, argv: process.argv.slice(2) }));
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({ suites: [] }));
`,
  );
  const { suiteAuditTool } = await import('../dist/tools/suite.js');
  const [heldA, releaseA] = gate(dir);
  const a = wrap(hold('A', heldA, log), env);
  await until(() => markers(log).some((m) => m.name === 'A'), 10_000, 'A to start');
  const pending = suiteAuditTool.handler({ cwd: project, run: true, specs: ['--workers=9'] });
  await until(() => tickets(dir).length === 2, 10_000, 'suite_audit to queue');
  await sleep(1_100); // long enough to be reported as a wait
  releaseA();
  const res = await pending;
  assert.ok(!res.isError, res.content[0].text);
  const ran = JSON.parse(fs.readFileSync(path.join(project, 'ran.json'), 'utf8'));
  assert.ok(markers(log).some((m) => m.kind === 'exit' && m.name === 'A'), 'the suite ran only after the holder finished');
  assert.deepEqual(ran.claims, [ran.held], 'the suite ran holding the one claim');
  assert.deepEqual(ran.argv, ['test', '--workers=2', '--reporter=json'], 'an explicit --workers above the cap is lowered');
  assert.match(res.content[0].text, /E2E slot: waited \d+s/);
  assert.equal(tickets(dir).length, 0, 'released after the run');

  // Held by someone else for longer than the tool will wait: an error naming them, nothing run.
  fs.rmSync(path.join(project, 'ran.json'));
  const [heldB, releaseB] = gate(dir);
  const b = wrap(hold('B', heldB, log), env);
  await until(() => markers(log).some((m) => m.name === 'B'), 10_000, 'B to start');
  const late = await suiteAuditTool.handler({ cwd: project, run: true, slotWaitMs: 200 });
  assert.equal(late.isError, true);
  assert.match(late.content[0].text, /held by .*hold\.mjs B.*suite_audit ran nothing/s);
  assert.ok(!fs.existsSync(path.join(project, 'ran.json')));
  releaseB();
  await b.done;
  await a.done;
});
