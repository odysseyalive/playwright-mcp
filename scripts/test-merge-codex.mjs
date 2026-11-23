import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const script = new URL('./merge-codex.mjs', import.meta.url);
function setup(t, raw) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config.toml');
  if (raw !== undefined) fs.writeFileSync(file, raw);
  const run = (mode = '--write', entry = '/opt/playwright/dist/index.js') => spawnSync(process.execPath,
    [fileURLToPath(script), process.execPath, entry, mode], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 10_000 });
  const backups = () => fs.readdirSync(home).filter((n) => n.endsWith('.bak'));
  return { home, file, run, backups, read: () => structuredClone(parse(fs.readFileSync(file, 'utf8'))) };
}

test('Codex registration: CODEX_HOME, long-tool budget, private file, repeat is a byte-identical no-op', (t) => {
  const s = setup(t);
  assert.equal(s.run('--print').status, 0);
  assert.equal(fs.existsSync(s.file), false, 'preview never writes');
  assert.equal(s.run().status, 0);
  assert.deepEqual(s.read().mcp_servers['playwright-mcp'], {
    command: process.execPath, args: ['/opt/playwright/dist/index.js'], tool_timeout_sec: 1860,
  });
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  const raw = fs.readFileSync(s.file, 'utf8');
  assert.equal(s.run('--print').stdout, '');
  assert.equal(s.run().status, 0);
  assert.equal(fs.readFileSync(s.file, 'utf8'), raw);
  assert.deepEqual(s.backups(), []);
});

test('Codex registration preserves user options, other servers and quoted/dotted TOML values', (t) => {
  const raw = `# user comment\nmodel = "gpt-6"\n[mcp_servers."playwright-mcp"]\ncommand = 'old-node'\nargs = [\n  '/old/server.js',\n]\ntool_timeout_sec = 42\nenabled = false\ndisabled_tools = ['browser_evaluate']\nstartup_timeout_sec = 27\n[mcp_servers."playwright-mcp".env]\nTOKEN = 'secret-value'\n[mcp_servers.other]\nurl = 'https://example.com/mcp'\n[projects."/home/a.b"]\ntrust_level = 'trusted'\n`;
  const s = setup(t, raw);
  const preview = s.run('--print');
  assert.equal(preview.status, 0, preview.stderr);
  assert.doesNotMatch(preview.stdout, /secret-value/);
  assert.deepEqual(s.backups(), []);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  const expected = structuredClone(parse(raw));
  expected.mcp_servers['playwright-mcp'].command = process.execPath;
  expected.mcp_servers['playwright-mcp'].args = ['/opt/playwright/dist/index.js'];
  assert.deepEqual(s.read(), expected);
  assert.equal(s.backups().length, 1);
  const backup = path.join(s.home, s.backups()[0]);
  assert.equal(fs.readFileSync(backup, 'utf8'), raw);
  if (process.platform !== 'win32') assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(s.run('--write', '/new/server.js').status, 0);
  assert.equal(s.backups().length, 2, 'later updates never overwrite an earlier backup');
  assert.equal(fs.readFileSync(backup, 'utf8'), raw);
});

test('Codex registration accepts inline TOML and Windows paths without shell expansion', (t) => {
  const s = setup(t, `mcp_servers = { "playwright-mcp" = {command = "old", args = ["x"], env = { SAFE = "yes" }} }\n`);
  const entry = "C:\\My Apps\\o'brien\\$HOME\\`literal`\\dist\\index.js";
  const result = s.run('--write', entry);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(s.read().mcp_servers['playwright-mcp'].args[0], entry);
  assert.deepEqual(s.read().mcp_servers['playwright-mcp'].env, { SAFE: 'yes' });
});

for (const [label, raw] of [
  ['malformed TOML', '[mcp_servers.'],
  ['wrong table type', 'mcp_servers = 1\n'],
  ['wrong server type', '[mcp_servers]\nplaywright-mcp = 1\n'],
  ['existing HTTP transport', '[mcp_servers.playwright-mcp]\nurl = "https://example.com/mcp"\n'],
]) test(`Codex registration refuses ${label} without changing any file`, (t) => {
  const s = setup(t, raw);
  assert.equal(s.run().status, 1);
  assert.equal(fs.readFileSync(s.file, 'utf8'), raw);
  assert.deepEqual(s.backups(), []);
});
