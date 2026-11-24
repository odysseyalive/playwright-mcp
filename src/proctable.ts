/**
 * proctable.ts — the process table browser lifetime needs (src/lifetime.ts), on
 * Linux, macOS and Windows, behind one shape.
 *
 * Why per platform: the first cut of lifetime.ts read /proc only, so off Linux it
 * found no pid, killed nothing by pid and reaped nothing. playwright-mcp ships a
 * Windows installer and macOS steps (README), so the 2026-11-24 leak had to be
 * closed there too (user requirement, same day).
 *
 *   - Linux: /proc, read directly. No child process.
 *   - macOS: ONE `ps -A -o pid= -o ppid= -o pgid= -o uid= -o rss= -o lstart=
 *     -o command=` per snapshot, under LC_ALL=C so lstart is the fixed English
 *     ctime form.
 *   - Windows: ONE PowerShell `Get-CimInstance Win32_Process` per snapshot (wmic
 *     is deprecated and absent on new Windows 11). The creation time is turned
 *     into epoch milliseconds inside PowerShell, so the JSON carries a number and
 *     not one of the DateTime shapes ConvertTo-Json produces across versions.
 *     A process of another user comes back with a null CommandLine for a
 *     non-admin caller, which is exactly the "not ours" it should read as.
 *
 * Every snapshot has a timeout. A snapshot that fails returns ok:false, and the
 * reaper then kills nothing (src/lifetime.ts). The parsers are pure and exported,
 * so macOS and Windows are covered by fixture output on any host
 * (scripts/test-browser-ownership.mjs). ONLY LINUX IS VERIFIED ON A REAL MACHINE.
 * macOS and Windows are tested against fixtures written by hand to the documented
 * ps and CIM formats, not captured on those systems; the ps argv and parsePs are
 * also run against Linux's own ps, which speaks the same format.
 *
 * A snapshot that does not contain this process is not a snapshot of this
 * machine (a misparse, a wrong format): it is reported ok:false, so it can never
 * make every other server look dead.
 *
 * `start` is only ever compared with itself: clock ticks since boot on Linux,
 * epoch milliseconds elsewhere (seconds resolution on macOS). It exists so a
 * reused pid is never taken for the process that had it before.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

export type Platform = 'linux' | 'darwin' | 'win32' | 'other';

export const PLATFORM: Platform =
  process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32'
    ? process.platform
    : 'other';

/** What the reaper and the status view need to know about one process. */
export interface ProcInfo {
  pid: number;
  ppid: number;
  /** The process group. Windows has none: there it is the pid itself. */
  pgid: number;
  start: number;
  uid?: number;
  comm: string;
  /** NUL-split argv (Linux). */
  argv?: string[];
  /** The whole command line as one string (macOS, Windows). */
  command?: string;
  /** Resident memory in bytes when the snapshot carries it (macOS, Windows). */
  rss?: number;
}

export interface ProcSnapshot {
  ok: boolean;
  table: Map<number, ProcInfo>;
  error?: string;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;

// ── Linux ───────────────────────────────────────────────────────────────────

/** Parse /proc/<pid>/stat. comm may hold spaces and parentheses: fields start after the LAST ')'. */
export function parseProcStat(pid: number, stat: string): Omit<ProcInfo, 'argv' | 'uid'> {
  const close = stat.lastIndexOf(')');
  const f = stat.slice(close + 2).split(' ');
  return {
    pid,
    ppid: Number(f[1]),
    pgid: Number(f[2]),
    start: Number(f[19]),
    comm: stat.slice(stat.indexOf('(') + 1, close),
  };
}

function readLinuxProc(pid: number): ProcInfo | undefined {
  try {
    const info: ProcInfo = parseProcStat(pid, fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      info.argv = argv;
    } catch {
      /* unreadable */
    }
    try {
      info.uid = fs.statSync(`/proc/${pid}`).uid;
    } catch {
      /* gone */
    }
    return info;
  } catch {
    return undefined;
  }
}

function linuxTable(): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const p = readLinuxProc(Number(name));
    if (p) table.set(p.pid, p);
  }
  return table;
}

// ── macOS ───────────────────────────────────────────────────────────────────

// One -o per keyword: BSD ps (macOS) reads everything after the first '=' of an
// -o argument as that column's header, so a single 'pid=,ppid=,…' would print one
// column. Separate flags mean the same thing to BSD ps and procps alike.
export const PS_ARGS = ['-A', ...['pid', 'ppid', 'pgid', 'uid', 'rss', 'lstart', 'command'].flatMap((k) => ['-o', `${k}=`])];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/;

/** Parse `ps -A -o pid=,ppid=,pgid=,uid=,rss=,lstart=,command=` (LC_ALL=C). rss is in KiB there. */
export function parsePs(out: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of out.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const month = MONTHS.indexOf(m[6]);
    const start = new Date(Number(m[11]), month, Number(m[7]), Number(m[8]), Number(m[9]), Number(m[10])).getTime();
    const command = m[12].trimEnd();
    const pid = Number(m[1]);
    table.set(pid, {
      pid,
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      uid: Number(m[4]),
      rss: Number(m[5]) * 1024,
      start,
      comm: command.split(' ')[0].split('/').pop() ?? '',
      command,
    });
  }
  return table;
}

// ── Windows ─────────────────────────────────────────────────────────────────

export const CIM_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,' +
  "@{n='Created';e={[int64](($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds)}} " +
  '| ConvertTo-Json -Compress';

/** A CIM creation time in any of the shapes it can arrive in: epoch ms, "/Date(ms)/", or an ISO string. */
function cimTime(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = /Date\((\d+)/.exec(v);
    if (m) return Number(m[1]);
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** Parse CIM_SCRIPT's JSON. One process comes back as an object, not an array. */
export function parseCim(json: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  const raw = JSON.parse(json || '[]') as unknown;
  for (const r of (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[]) {
    const pid = Number(r?.ProcessId);
    if (!Number.isInteger(pid)) continue;
    const command = typeof r.CommandLine === 'string' ? r.CommandLine : undefined;
    table.set(pid, {
      pid,
      ppid: Number(r.ParentProcessId) || 0,
      pgid: pid,
      start: cimTime(r.Created ?? r.CreationDate),
      rss: Number(r.WorkingSetSize) || undefined,
      comm: (command?.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? '').split(/[\\/]/).pop() ?? '',
      command,
    });
  }
  return table;
}

// ── snapshots ───────────────────────────────────────────────────────────────

const psEnv = () => ({ ...process.env, LC_ALL: 'C' });
const powershell = () => (process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe');
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-Command'];

/** A table that does not list this very process cannot be trusted with a kill. */
function checked(table: Map<number, ProcInfo>): ProcSnapshot {
  return table.has(process.pid)
    ? { ok: true, table }
    : { ok: false, table: new Map(), error: `the process table does not list this process (${table.size} rows parsed)` };
}

/** Every process on the machine, synchronously. For the 'exit' hook and the shutdown kill only. */
export function snapshotSync(platform: Platform = PLATFORM): ProcSnapshot {
  try {
    if (platform === 'linux') return { ok: true, table: linuxTable() };
    if (platform === 'darwin')
      return checked(parsePs(execFileSync('ps', PS_ARGS, { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, env: psEnv(), maxBuffer: 64 << 20 })));
    if (platform === 'win32')
      return checked(
        parseCim(execFileSync(powershell(), [...PS_FLAGS, CIM_SCRIPT], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 << 20 })),
      );
    return { ok: false, table: new Map(), error: `no process table on ${process.platform}` };
  } catch (err) {
    return { ok: false, table: new Map(), error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every process on the machine, without blocking the event loop on a child process. */
export function snapshot(platform: Platform = PLATFORM): Promise<ProcSnapshot> {
  if (platform === 'linux' || platform === 'other') return Promise.resolve(snapshotSync(platform));
  const [file, args, parse] =
    platform === 'darwin' ? ['ps', PS_ARGS, parsePs] as const : [powershell(), [...PS_FLAGS, CIM_SCRIPT], parseCim] as const;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true, env: psEnv(), maxBuffer: 64 << 20 },
      (err, out) => {
        if (err) return resolve({ ok: false, table: new Map(), error: err.message });
        try {
          resolve(checked(parse(out)));
        } catch (e) {
          resolve({ ok: false, table: new Map(), error: e instanceof Error ? e.message : String(e) });
        }
      },
    );
  });
}

/** One process, cheaply where that is possible (Linux); elsewhere from a full snapshot. */
export function readProc(pid: number): ProcInfo | undefined {
  if (PLATFORM === 'linux') return readLinuxProc(pid);
  return undefined;
}

/** Resident memory of one process in bytes, from the snapshot or (Linux) /proc. */
export function rssOf(p: ProcInfo): number {
  if (p.rss !== undefined) return p.rss;
  try {
    const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** Kill a whole tree on Windows, where there are no process groups. */
export function taskkillTree(pid: number, sync = false): void {
  const args = ['/PID', String(pid), '/T', '/F'];
  try {
    if (sync) execFileSync('taskkill', args, { stdio: 'ignore', timeout: 5_000, windowsHide: true });
    else execFile('taskkill', args, { timeout: 5_000, windowsHide: true }, () => {});
  } catch {
    /* already gone */
  }
}
