#!/usr/bin/env node
// Register the local server without `codex mcp add` replacing user options.
// TOML is parsed, never matched with regex. A changed file is reserialized
// (comments/formatting are lost); its exact original is backed up first.
// Usage: node merge-codex.mjs <node> <dist/index.js> [--print|--write]
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'smol-toml';

const [nodeCmd, entry, mode = '--print'] = process.argv.slice(2);
if (!nodeCmd || !entry || !['--print', '--write'].includes(mode)) {
  console.error('usage: merge-codex.mjs <node> <dist/index.js> [--print|--write]');
  process.exit(2);
}

const configured = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const file = existsSync(configured) ? realpathSync(configured) : configured;
const table = (v) => v !== null && typeof v === 'object' &&
  [null, Object.prototype].includes(Object.getPrototypeOf(v));
const parseConfig = (raw) => parse(raw, { integersAsBigInt: 'asNeeded' });

try {
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let config;
  try { config = parseConfig(raw); } catch {
    throw new Error(`Cannot parse ${file}; left unchanged. Repair its TOML before registering.`);
  }
  if (config.mcp_servers !== undefined && !table(config.mcp_servers))
    throw new Error(`${file}: mcp_servers must be a table; left unchanged.`);
  const servers = config.mcp_servers ?? Object.create(null);
  const current = servers['playwright-mcp'];
  if (current !== undefined && !table(current))
    throw new Error(`${file}: playwright-mcp must be a table; left unchanged.`);
  if (current?.url !== undefined)
    throw new Error(`${file}: playwright-mcp uses HTTP; left unchanged. Use a separate name for the local server.`);
  const next = Object.assign(Object.create(null), current, { command: nodeCmd, args: [entry] });
  // suite_audit supports a 30-minute run; allow one minute for setup/reporting.
  // An explicit user timeout is a preference and survives every reinstall.
  if (next.tool_timeout_sec === undefined) next.tool_timeout_sec = 1860;
  if (isDeepStrictEqual(current, next)) process.exit(0);

  servers['playwright-mcp'] = next;
  config.mcp_servers = servers;
  const body = stringify(config);
  if (!isDeepStrictEqual(parseConfig(body), config))
    throw new Error(`${file}: TOML round-trip changed values; left unchanged.`);
  if (mode === '--print') {
    console.log(`${file}\n  Update playwright-mcp command/args; tool_timeout_sec=${next.tool_timeout_sec}.`);
    if (raw) console.log(`  Existing options retained. TOML comments/formatting will be reset; original saved beside config.toml as a unique playwright-mcp-*.bak file.`);
    process.exit(0);
  }

  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (raw) {
    const backup = `${file}.playwright-mcp-${randomUUID()}.bak`;
    writeFileSync(backup, raw, { mode: 0o600, flag: 'wx' });
    console.log(`Original Codex config saved to ${backup}`);
  }
  const temp = `${file}.playwright-mcp-${process.pid}.tmp`;
  try {
    writeFileSync(temp, body, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
