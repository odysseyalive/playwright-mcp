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

/** Minimal dotenv-style parser — KEY=value lines, # comments, optional quotes. */
export function loadSecrets(): Record<string, string> | undefined {
  const file = secretsPath();
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

/** Read a single secret by key (from secrets.env, falling back to process.env). */
export function getSecret(key: string): string | undefined {
  return loadSecrets()?.[key] ?? process.env[key];
}
