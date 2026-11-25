/**
 * slot-cli.ts — the command-line taker of the machine-wide e2e slot
 * (src/e2e-slot.ts): `playwright-mcp-slot …` and `node dist/index.js --slot …`.
 *
 *   playwright-mcp-slot [--max-wait 4h] [--max-hold 5h] -- npx playwright test …
 *       Blocking. Queues, runs the command with stdio inherited once the slot is
 *       held, forwards SIGINT/SIGTERM/SIGHUP to the command's process group,
 *       releases on any exit, and exits with the command's code.
 *
 *   playwright-mcp-slot --detach [--log FILE] -- npx playwright test …
 *       Returns at once with the queue position and the log path. A runner in
 *       its own process group (so a Bash tool timeout does not take it down)
 *       owns the ticket, waits, runs the command into the log, and ends the log
 *       with `done <code>`, `done timeout` or `done error <msg>`. Required by the
 *       usage data of 2026-11-25: suites of up to ~3.8 h started from Bash, whose
 *       tool calls time out long before that.
 *
 *   playwright-mcp-slot --status [--json]
 *
 * Exit codes of a blocking run: the command's own; 128+n when it died of signal
 * n; 124 when the max wait passed (nothing ran); 127 when it could not start.
 */

import { spawn, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HELD_ENV,
  SlotError,
  WORKERS_ENV,
  acquireSlot,
  capWorkers,
  formatSlotStatus,
  heldByAncestor,
  logsDir,
  newTicketId,
  parseDuration,
  positionOf,
  pruneLogs,
  slotStatus,
  ticketExists,
  whoOf,
  workersCap,
  type SlotHandle,
} from './e2e-slot.js';
import { taskkillTree } from './proctable.js';
import { formatRenderStatus, renderStatus } from './render-lane.js';

/** The lightweight entry a detached launcher starts its runner with. */
const SLOT_BIN = fileURLToPath(new URL('./slot-bin.js', import.meta.url));
/** How long a detached launcher waits for its runner's ticket before reporting. */
const HANDSHAKE_MS = 15_000;

const USAGE = `usage:
  playwright-mcp-slot [options] -- <command...>     run <command> holding the machine-wide e2e slot
  playwright-mcp-slot --status [--json]             show the holder and the queue
  (or: node dist/index.js --slot [options] -- <command...>, node dist/index.js --slot-status)

options:
  --max-wait <dur>   give up waiting after this long (default 4h, PLAYWRIGHT_MCP_E2E_MAX_WAIT)
  --max-hold <dur>   report this run as overdue past this (default 5h, PLAYWRIGHT_MCP_E2E_MAX_HOLD); never killed
  --detach           return at once; a background runner waits, runs and logs, ending with "done <code>"
  --log <file>       the detached run's log (default under the slot's state directory)
durations: 90s, 30m, 5h, or a bare number of minutes.
`;

interface Options {
  maxWaitMs?: number;
  maxHoldMs?: number;
  detach: boolean;
  log?: string;
  runner: boolean;
  ticketId?: string;
  status: boolean;
  json: boolean;
  help: boolean;
  command: string[];
}

export function parseSlotArgs(argv: string[]): Options {
  const o: Options = { detach: false, runner: false, status: false, json: false, help: false, command: [] };
  let i = 0;
  const value = (flag: string, inline?: string): string => {
    if (inline !== undefined) return inline;
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[++i];
  };
  const duration = (flag: string, raw: string): number => {
    const ms = parseDuration(raw);
    if (ms === undefined) throw new Error(`${flag}: not a duration: ${raw} (try 90s, 30m, 5h)`);
    return ms;
  };
  for (; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      i++;
      break;
    }
    if (!tok.startsWith('-')) break;
    const [flag, inline] = tok.includes('=') ? [tok.slice(0, tok.indexOf('=')), tok.slice(tok.indexOf('=') + 1)] : [tok, undefined];
    if (flag === '--max-wait') o.maxWaitMs = duration(flag, value(flag, inline));
    else if (flag === '--max-hold') o.maxHoldMs = duration(flag, value(flag, inline));
    else if (flag === '--detach') o.detach = true;
    else if (flag === '--log') o.log = value(flag, inline);
    else if (flag === '--runner') o.runner = true;
    else if (flag === '--ticket-id') o.ticketId = value(flag, inline);
    else if (flag === '--status' || flag === '--slot-status') o.status = true;
    else if (flag === '--json') o.json = true;
    else if (flag === '-h' || flag === '--help') o.help = true;
    else throw new Error(`unknown option ${tok}; put the command after --`);
  }
  o.command = argv.slice(i);
  return o;
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalCode = (sig: NodeJS.Signals | null) => (sig ? 128 + (os.constants.signals[sig] ?? 0) : 1);

/** cmd.exe quoting for the Windows shell launch below. */
const winQuote = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

/**
 * Run the command, forwarding signals to its process group, and resolve with its
 * exit code. POSIX: spawned as a group leader (detached), so a forwarded SIGINT
 * reaches npx, Playwright and its workers together. Windows: through the shell,
 * because `npx` there is npx.cmd, which Node will not launch without one
 * (CVE-2024-27980); the command is the caller's own, typed in their own shell,
 * so the shell adds no reach. A forwarded signal there is taskkill /T. UNVERIFIED
 * ON WINDOWS, like src/proctable.ts's Windows side.
 */
function runChild(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stdio: StdioOptions,
  onSpawn?: (pid: number) => void,
): Promise<{ code: number; error?: string }> {
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn(argv.map(winQuote).join(' '), { shell: true, stdio, env, windowsHide: true })
        : spawn(argv[0], argv.slice(1), { stdio, env, detached: true });
    const forward = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform === 'win32') taskkillTree(child.pid);
      else {
        try {
          process.kill(-child.pid, sig);
        } catch {
          /* the group is gone */
        }
      }
    };
    for (const sig of SIGNALS) process.on(sig, forward);
    let settled = false;
    const finish = (r: { code: number; error?: string }) => {
      if (settled) return;
      settled = true;
      for (const sig of SIGNALS) process.removeListener(sig, forward);
      resolve(r);
    };
    child.once('spawn', () => child.pid && onSpawn?.(child.pid));
    child.once('error', (err) => finish({ code: 127, error: err.message }));
    child.once('close', (code, sig) => finish({ code: code ?? signalCode(sig) }));
  });
}

/** Leave the queue on a signal that arrives while still waiting. */
function abortOnSignals(): { signal: AbortSignal; received: () => NodeJS.Signals | undefined; stop: () => void } {
  const ac = new AbortController();
  let got: NodeJS.Signals | undefined;
  const on = (sig: NodeJS.Signals) => {
    got = sig;
    ac.abort();
  };
  for (const sig of SIGNALS) process.on(sig, on);
  return { signal: ac.signal, received: () => got, stop: () => SIGNALS.forEach((s) => process.removeListener(s, on)) };
}

const childEnv = (ticketId: string): NodeJS.ProcessEnv => ({ ...process.env, [HELD_ENV]: ticketId, [WORKERS_ENV]: String(workersCap()) });
const minutes = (ms: number) => `${Math.round(ms / 60_000)}m`;

async function runBlocking(o: Options): Promise<number> {
  const say = (s: string) => process.stderr.write(`playwright-mcp-slot: ${s}\n`);
  const capped = capWorkers(o.command);
  const parent = await heldByAncestor();
  let handle: SlotHandle | undefined;
  if (parent) say(`inside the slot this run's parent already holds (${whoOf(parent)}); running at once, not queueing`);
  else {
    const sigs = abortOnSignals();
    try {
      handle = await acquireSlot({
        command: o.command.join(' '),
        via: 'cli',
        maxWaitMs: o.maxWaitMs,
        maxHoldMs: o.maxHoldMs,
        signal: sigs.signal,
        onProgress: say,
      });
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
      const sig = sigs.received();
      return err instanceof SlotError && err.kind === 'timeout' ? 124 : sig ? signalCode(sig) : 1;
    } finally {
      sigs.stop();
    }
    say(`acquired ${handle.ticket.acquiredAt}${handle.waitedMs > 1000 ? ` after waiting ${minutes(handle.waitedMs)}` : ''}`);
  }
  say(capped.note);
  const r = await runChild(capped.argv, childEnv(handle?.ticket.id ?? parent!.id), 'inherit', (pid) => void handle?.attachChild(pid));
  if (r.error) say(`could not start ${o.command[0]}: ${r.error}`);
  handle?.release();
  return r.code;
}

/** The detached runner: stdout and stderr are the log. Every path ends the log with one `done …` line. */
async function runRunner(o: Options): Promise<number> {
  const out = (s: string) => fs.writeSync(1, `${s}\n`);
  let finished = false;
  const done = (s: string) => {
    if (finished) return;
    finished = true;
    out(`done ${s}`);
  };
  process.on('uncaughtException', (err) => {
    done(`error ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
  out(`runner pid ${process.pid} started ${new Date().toISOString()}: ${o.command.join(' ')}`);
  const capped = capWorkers(o.command);
  const parent = await heldByAncestor();
  let handle: SlotHandle | undefined;
  if (parent) out(`inside the slot this run's parent already holds (${whoOf(parent)}); running at once`);
  else {
    const sigs = abortOnSignals();
    try {
      handle = await acquireSlot({
        id: o.ticketId,
        command: o.command.join(' '),
        via: 'detached',
        log: o.log,
        maxWaitMs: o.maxWaitMs,
        maxHoldMs: o.maxHoldMs,
        signal: sigs.signal,
        onProgress: out,
      });
    } catch (err) {
      if (err instanceof SlotError && err.kind === 'timeout') {
        out(err.message);
        done('timeout');
        return 124;
      }
      const sig = sigs.received();
      done(`error ${sig ? `${sig} while waiting; left the queue` : err instanceof Error ? err.message : String(err)}`);
      return sig ? signalCode(sig) : 1;
    } finally {
      sigs.stop();
    }
    out(`acquired ${handle.ticket.acquiredAt}`);
  }
  out(capped.note);
  const r = await runChild(capped.argv, childEnv(handle?.ticket.id ?? parent!.id), ['ignore', 'inherit', 'inherit'], (pid) =>
    void handle?.attachChild(pid),
  );
  handle?.release();
  done(r.error ? `error could not start ${o.command[0]}: ${r.error}` : String(r.code));
  return r.code;
}

/** Start the runner in its own process group, wait for its ticket, report, return. */
async function launchDetached(o: Options): Promise<number> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const log = path.resolve(o.log ?? path.join(logsDir(), `${stamp}-${process.pid}.log`));
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  pruneLogs();
  const id = newTicketId();
  const parent = await heldByAncestor();
  const fd = fs.openSync(log, 'a', 0o600);
  const args = [SLOT_BIN, '--runner', '--ticket-id', id, '--log', log];
  if (o.maxWaitMs) args.push('--max-wait', `${o.maxWaitMs}ms`);
  if (o.maxHoldMs) args.push('--max-hold', `${o.maxHoldMs}ms`);
  // The runner, not this short-lived launcher, writes and owns the ticket, so the
  // dead-pid rule judges the process that actually holds the slot.
  const child = spawn(process.execPath, [...args, '--', ...o.command], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: process.env,
  });
  fs.closeSync(fd);
  let exited = false;
  child.once('exit', () => (exited = true));
  child.unref();

  const print = (s: string) => process.stdout.write(`${s}\n`);
  const tail = () => print(`poll: tail -n 3 ${log}   (finished when the last line starts with "done")`);
  if (parent) {
    print(`detached run started inside the slot its parent already holds (${whoOf(parent)}); it runs at once.`);
    print(`log: ${log}`);
    tail();
    return 0;
  }
  const until = Date.now() + HANDSHAKE_MS;
  while (!ticketExists(id) && !exited && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  if (!ticketExists(id)) {
    let last = '';
    try {
      last = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-3).join('\n');
    } catch {
      /* nothing written */
    }
    print(`the detached runner (pid ${child.pid}) ${exited ? 'exited' : 'did not queue'} within ${HANDSHAKE_MS / 1000}s. log: ${log}`);
    if (last) print(last);
    return 1;
  }
  const pos = await positionOf(id);
  print(
    pos?.holding
      ? `detached run holds the e2e slot now (runner pid ${child.pid}).`
      : `detached run queued at position ${pos?.position ?? '?'} (runner pid ${child.pid}).`,
  );
  print(`log: ${log}`);
  tail();
  return 0;
}

/** The whole CLI. Resolves with the exit code; never calls process.exit itself. */
export async function slotMain(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parseSlotArgs(argv);
  } catch (err) {
    process.stderr.write(`playwright-mcp-slot: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (o.status) {
    const [s, render] = await Promise.all([slotStatus(), renderStatus()]);
    process.stdout.write(o.json ? `${JSON.stringify({ ...s, render }, null, 1)}\n` : `${formatSlotStatus(s)}${formatRenderStatus(render)}`);
    return 0;
  }
  if (!o.command.length) {
    process.stderr.write(`playwright-mcp-slot: no command given\n${USAGE}`);
    return 2;
  }
  if (o.runner) return runRunner(o);
  if (o.detach) return launchDetached(o);
  return runBlocking(o);
}
