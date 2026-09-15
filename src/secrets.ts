/**
 * secrets.ts — shared config-path + secrets handling for the server and the
 * session helpers. Single owner of the secrets.env parser and the
 * platform-correct config/sessions directories (so nothing is duplicated).
 *
 * Layout: ~/.config/playwright-mcp/secrets.env  (Linux/macOS)
 *         %APPDATA%\playwright-mcp\secrets.env   (Windows)
 * Sessions live alongside in a sessions/ subdir; both are secrets, readable by
 * the owning account only (mode 600 on POSIX, an owner-only ACL on Windows —
 * see ownerOnlyFile / ownerOnlyDir below, the one place that is enforced).
 *
 * IMPORTANT: never log to stdout (MCP stdio stream). Use stderr.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TtlCache } from './cache.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:secrets]', ...args);

/** The playwright-mcp config base dir (platform-correct). */
export function configDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'playwright-mcp');
}

export function secretsPath(): string {
  return process.env.PLAYWRIGHT_MCP_SECRETS ?? path.join(configDir(), 'secrets.env');
}

/** Directory for saved storageState session artifacts (owner-only files — see ownerOnlyFile). */
export function sessionsDir(): string {
  return process.env.PLAYWRIGHT_MCP_SESSIONS ?? path.join(configDir(), 'sessions');
}

/**
 * Resolve a named session's storageState artifact path — the owner-only file
 * session_login writes and session_status / web_fetch(session) read. Single
 * owner of the name→path mapping so callers never re-derive the safe-name rule.
 */
export function sessionFilePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(sessionsDir(), `${safe}.json`);
}

// ── owner-only restriction ────────────────────────────────────────────────────
// A storageState artifact is an impersonation-grade credential, so it must be
// readable by the owning account and nobody else. This section is the ONE place
// that is enforced; every write site calls it rather than chmod-ing on its own.
//
// POSIX: the mode bits ARE the access control, so chmod 0o600 on the file and
// mkdir 0o700 on the dir is the whole job — exactly the calls the write sites
// made before this helper existed, and nothing more.
//
// Windows: they are NOT. Node's chmod only toggles the read-only attribute and
// mkdir's `mode` is ignored, so an artifact there silently kept whatever ACL it
// inherited from its folder while the log said "mode 600". The win32 branch
// therefore also rewrites the DACL with icacls so the current account's SID is
// the only grantee. NOT VERIFIED ON WINDOWS: written against the documented
// icacls / whoami behaviour, never executed on win32 in this repository.

/** What a restriction actually did, worded for a stderr log line. Never claims more than happened. */
export type OwnerOnlyDescriptor = 'mode 600' | 'mode 700' | 'existing dir, mode unchanged' | 'owner-only ACL';

/**
 * The win32 ACL step (or the SID lookup it needs) failed. Only the Windows
 * branch throws this; a failing chmod or mkdir surfaces as its own fs error,
 * exactly as it did before, so a caller can tell "the ACL did not apply" apart
 * from "the directory does not exist".
 */
export class OwnerOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerOnlyError';
  }
}

/** A SID in string form. Validated before it is ever placed in an argument. */
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

/**
 * Absolute path to a System32 tool. Never a bare name: on Windows, libuv's
 * command lookup tries the CURRENT DIRECTORY before PATH, and this server's cwd
 * is whatever project Claude Code was launched in — a cloned repo could plant
 * its own icacls.exe there. %SystemRoot% is set by Windows for every process
 * (and is only as settable as the rest of the operator's environment); the
 * literal is the last resort.
 */
function system32Tool(exe: 'icacls.exe' | 'whoami.exe'): string {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', exe);
}

/** First line of a tool's complaint, bounded — enough to act on, never a dump. */
function briefly(text: string | undefined): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, 200) : 'no output';
}

/**
 * Run one System32 tool synchronously with an ARGUMENT ARRAY — no shell, so no
 * metacharacter in a path can be interpreted, and the tool is an .exe, not a
 * .bat/.cmd, so cmd.exe is never involved either. Child stdout/stderr are
 * PIPED into this process and returned or folded into the error; they are never
 * inherited, because this process's stdout is the MCP stdio stream.
 */
function runSystem32(exe: 'icacls.exe' | 'whoami.exe', args: string[]): string {
  const r = spawnSync(system32Tool(exe), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000,
    shell: false,
  });
  if (r.error) throw new OwnerOnlyError(`${exe} could not run (${r.error.message})`);
  if (r.status !== 0)
    throw new OwnerOnlyError(`${exe} exited ${r.status ?? r.signal ?? 'abnormally'} (${briefly(r.stderr || r.stdout)})`);
  return r.stdout;
}

/**
 * The SID out of `whoami /user /fo csv /nh`, whose one line is
 * `"DOMAIN\user","S-1-5-21-…"`. The SID is the last field and is language-
 * invariant, which is why it is the grantee rather than a name: built-in and
 * account names are localized, and `os.userInfo().username` drops the domain.
 * Exported as a deterministic seam for tests; the raw output is never echoed.
 */
export function parseWhoamiSid(csv: string): string {
  const fields = csv.trim().split(',');
  const sid = (fields[fields.length - 1] ?? '').trim().replace(/^"|"$/g, '');
  if (!SID_PATTERN.test(sid)) throw new OwnerOnlyError("could not read the current account's SID from whoami");
  return sid;
}

let cachedSid: string | undefined;

/** The current account's SID, looked up once per process. A failure is not cached. */
function currentUserSid(): string {
  cachedSid ??= parseWhoamiSid(runSystem32('whoami.exe', ['/user', '/fo', 'csv', '/nh']));
  return cachedSid;
}

/**
 * The icacls arguments that leave `target` readable by `sid` alone:
 *   /inheritance:r   drop every inherited ACE (so the parent folder's grants stop applying)
 *   /grant:r         REPLACE any explicit grant for this SID with the one given
 *   *<SID>           a numeric SID must carry the `*` prefix
 *   (OI)(CI)(F)      on the DIR, full control that new files and subfolders inherit,
 *                    so an artifact written into it is owner-only from its first byte
 *   (F)              on a FILE, full control
 * Limit, stated so nobody over-reads it: an EXPLICIT ACE some other principal
 * was granted by hand survives both switches. A file or dir this server created
 * carries only inherited ACEs, so for everything it writes the result is owner-
 * only; SYSTEM and Administrators are dropped too (a backup agent running as
 * SYSTEM loses read access, deliberately).
 * Exported as a deterministic seam: tests assert the exact array on any OS.
 */
export function ownerOnlyAclArgs(target: string, sid: string, kind: 'file' | 'dir'): string[] {
  if (!SID_PATTERN.test(sid)) throw new OwnerOnlyError('refusing to build an ACL for a malformed SID');
  return [target, '/inheritance:r', '/grant:r', `*${sid}:${kind === 'dir' ? '(OI)(CI)(F)' : '(F)'}`];
}

/**
 * The shared icacls core for ownerOnlyFile / ownerOnlyDir (win32 only).
 *
 * The target is resolved to an absolute path first, which on Windows always
 * begins with a drive letter or `\\`, so it can never be read by icacls as a
 * `/switch`. icacls expands `*` and `?` in the name; neither is legal in a
 * Windows path, so one appearing means the path is not what it seems, and the
 * restriction is refused rather than widened to a wildcard match.
 */
function restrictAclToOwner(target: string, kind: 'file' | 'dir'): void {
  const abs = path.resolve(target);
  if (/^[-/]/.test(abs) || /[*?]/.test(abs.replace(/^\\\\\?\\/, '')))
    throw new OwnerOnlyError(`refusing to run icacls on an unexpected path: ${abs}`);
  try {
    runSystem32('icacls.exe', ownerOnlyAclArgs(abs, currentUserSid(), kind));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new OwnerOnlyError(`could not restrict ${abs} to the current account with an owner-only ACL: ${why}`);
  }
}

/**
 * Restrict an artifact FILE to the owning account. POSIX: `chmod 0o600`, nothing
 * else. win32: the same chmod (it only clears the read-only bit there), then an
 * owner-only ACL. Returns what it did, for the caller's log line. Throws on
 * failure — the caller owns the policy (capture fails loud; a rolling
 * write-back warns, via reassertOwnerOnly).
 */
export function ownerOnlyFile(file: string): OwnerOnlyDescriptor {
  fs.chmodSync(file, 0o600);
  if (process.platform !== 'win32') return 'mode 600';
  restrictAclToOwner(file, 'file'); // NOT VERIFIED ON WINDOWS
  return 'owner-only ACL';
}

/**
 * Create (if needed) and restrict the sessions DIRECTORY. POSIX: the same
 * `mkdir -p` at 0o700 as before — which applies the mode only to directories it
 * creates, and never re-chmods an existing one; the descriptor says which
 * happened. win32: the same mkdir (whose mode Windows ignores), then an
 * owner-only inheritable ACL, re-applied on EVERY call so a directory created
 * before this fix is locked down the next time anything writes into it.
 */
export function ownerOnlyDir(dir: string): OwnerOnlyDescriptor {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return created === undefined ? 'existing dir, mode unchanged' : 'mode 700';
  restrictAclToOwner(dir, 'dir'); // NOT VERIFIED ON WINDOWS
  return 'owner-only ACL';
}

/**
 * Re-restrict an artifact after a ROLLING WRITE-BACK (session_status's keepalive,
 * web_fetch({session})). Never throws — the write-back itself is best-effort and
 * must not change the caller's result — but never swallows silently either: a
 * failure is a truthful stderr warning. Running on every write-back is also what
 * locks down an artifact captured before this helper existed.
 */
export function reassertOwnerOnly(file: string): void {
  try {
    ownerOnlyFile(file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(
      `warning: rewrote ${file} but could NOT restrict it to the owning account (${why}). ` +
        'It is not confirmed owner-only: an in-place rewrite keeps whatever permissions the file already had.',
    );
  }
}

/** Minimal dotenv-style parser — KEY=value lines, # comments, optional quotes. */
function parseDotenv(file: string): Record<string, string> | undefined {
  if (!fs.existsSync(file)) return undefined;
  const secrets: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    secrets[key] = value;
  }
  return secrets;
}

/** The user-scoped secrets.env, parsed (undefined if absent). */
export function loadSecrets(): Record<string, string> | undefined {
  return parseDotenv(secretsPath());
}

export interface GetSecretOptions {
  /** Explicit dotenv file to read first (e.g. session_login's envFile). Throws if missing. */
  envFile?: string;
}

/**
 * Read a single secret by key. Precedence — most specific scope wins:
 *   1. the consuming project's .env: opts.envFile if given, else ./.env in the
 *      server's working directory (the project Claude Code was launched in)
 *   2. the user-scoped secrets.env
 *   3. process.env
 * Only the named key is read out; file contents are never logged or returned.
 */
export function getSecret(key: string, opts: GetSecretOptions = {}): string | undefined {
  if (opts.envFile) {
    const explicit = path.resolve(opts.envFile);
    const parsed = parseDotenv(explicit);
    if (!parsed) throw new Error(`envFile not found: ${explicit}`);
    if (parsed[key] !== undefined) return parsed[key];
  } else {
    const projectEnv = parseDotenv(path.join(process.cwd(), '.env'));
    if (projectEnv?.[key] !== undefined) return projectEnv[key];
  }
  return loadSecrets()?.[key] ?? process.env[key];
}

/**
 * Everything this package can positively identify as a secret VALUE, labelled
 * by where it came from — the inventory src/exfil.ts scans outbound URLs
 * against (ledger DEC-2026-07-29).
 *
 * Deliberately scoped to what we own: dotenv values plus cookie values from
 * captured storageState artifacts. It knows nothing of the user's memory
 * directory or connector data, which is exactly why the DEC records
 * single-URL exfiltration as an explicit non-fix.
 *
 * Labels are what surface in a refusal message; values never are. Cached
 * briefly so a per-fetch check does not re-read every session file, but short
 * enough that a freshly captured session is covered within a minute.
 */
const inventoryCache = new TtlCache<Record<string, string>>(60_000);

export function secretInventory(): Record<string, string> {
  const cached = inventoryCache.get('inventory');
  if (cached) return cached;

  const inventory: Record<string, string> = {};

  const projectEnv = parseDotenv(path.join(process.cwd(), '.env'));
  for (const [key, value] of Object.entries(projectEnv ?? {})) inventory[`.env:${key}`] = value;
  for (const [key, value] of Object.entries(loadSecrets() ?? {})) inventory[`secrets.env:${key}`] = value;

  const dir = sessionsDir();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as {
          cookies?: { name?: string; value?: string }[];
        };
        const session = file.replace(/\.json$/, '');
        for (const cookie of state.cookies ?? []) {
          if (cookie.name && cookie.value) inventory[`session:${session}/${cookie.name}`] = cookie.value;
        }
      } catch {
        /* an unreadable or corrupt artifact contributes nothing; never fatal */
      }
    }
  }

  inventoryCache.set('inventory', inventory);
  return inventory;
}
