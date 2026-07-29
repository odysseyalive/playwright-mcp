/**
 * secrets.ts — shared config-path + secrets handling for the server and the
 * session helpers. Single owner of the secrets.env parser and the
 * platform-correct config/sessions directories (so nothing is duplicated).
 *
 * Layout: ~/.config/playwright-mcp/secrets.env  (Linux/macOS)
 *         %APPDATA%\playwright-mcp\secrets.env   (Windows)
 * Sessions live alongside in a sessions/ subdir; both are secrets (mode 600).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TtlCache } from './cache.js';

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

/** Directory for saved storageState session artifacts (mode-600 files). */
export function sessionsDir(): string {
  return process.env.PLAYWRIGHT_MCP_SESSIONS ?? path.join(configDir(), 'sessions');
}

/**
 * Resolve a named session's storageState artifact path — the mode-600 file
 * session_login writes and session_status / web_fetch(session) read. Single
 * owner of the name→path mapping so callers never re-derive the safe-name rule.
 */
export function sessionFilePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(sessionsDir(), `${safe}.json`);
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
