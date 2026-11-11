// T1 tests for scripts/merge-crush.mjs — registering playwright-mcp with Crush.
// Every case runs the script as the installers do, against a temp config home
// (XDG_CONFIG_HOME / CRUSH_GLOBAL_CONFIG), never the real ~/.config/crush.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'merge-crush.mjs');

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-crush-'));
  try {
    fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function run(home, entry, mode, extraEnv = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: home, ...extraEnv };
  if (!('CRUSH_GLOBAL_CONFIG' in extraEnv)) delete env.CRUSH_GLOBAL_CONFIG;
  return spawnSync(process.execPath, [SCRIPT, 'node', entry, mode], { env, encoding: 'utf8' });
}

const rcPath = (home) => path.join(home, 'crush', 'crushrc');
const jsonPath = (home) => path.join(home, 'crush', 'crush.json');

test('no config: appends one marked block to crushrc, and a re-run changes nothing', () => {
  withHome((home) => {
    assert.equal(run(home, '/opt/pw/dist/index.js', '--write').status, 0);
    const rc = fs.readFileSync(rcPath(home), 'utf8');
    assert.match(rc, /^mcp add playwright-mcp --type stdio --command 'node' --args '\/opt\/pw\/dist\/index.js' --timeout 300$/m);
    const again = run(home, '/opt/pw/dist/index.js', '--print');
    assert.equal(again.status, 0);
    assert.equal(again.stdout, '', 'a second run must report no change');
  });
});

test('moved install: the block is replaced, not duplicated, and user lines stay', () => {
  withHome((home) => {
    fs.mkdirSync(path.dirname(rcPath(home)), { recursive: true });
    fs.writeFileSync(rcPath(home), 'option progress false\n');
    run(home, '/old/dist/index.js', '--write');
    fs.appendFileSync(rcPath(home), 'permissions allow view\n');
    run(home, '/new/dist/index.js', '--write');
    const rc = fs.readFileSync(rcPath(home), 'utf8');
    assert.equal(rc.match(/mcp add playwright-mcp/g).length, 1);
    assert.ok(rc.includes("'/new/dist/index.js'") && !rc.includes('/old/'));
    assert.ok(rc.startsWith('option progress false\n'));
    assert.ok(rc.includes('permissions allow view'));
  });
});

test('existing crush.json entry: updated in place, other keys kept, no crushrc block added', () => {
  withHome((home) => {
    fs.mkdirSync(path.dirname(jsonPath(home)), { recursive: true });
    const before = {
      providers: { openrouter: { api_key: '$OPENROUTER_API_KEY' } },
      mcp: { 'playwright-mcp': { type: 'stdio', command: 'node', args: ['/old/dist/index.js'], timeout: 120, env: { A: '1' } } },
    };
    fs.writeFileSync(jsonPath(home), JSON.stringify(before));
    assert.equal(run(home, '/new/dist/index.js', '--write').status, 0);
    const after = JSON.parse(fs.readFileSync(jsonPath(home), 'utf8'));
    assert.deepEqual(after.providers, before.providers);
    assert.deepEqual(after.mcp['playwright-mcp'], {
      type: 'stdio', command: 'node', args: ['/new/dist/index.js'], timeout: 120, env: { A: '1' },
    });
    assert.equal(fs.existsSync(rcPath(home)), false, 'crush.json already registers it; no crushrc block');
  });
});

test('CRUSH_GLOBAL_CONFIG decides where crush.json is read', () => {
  withHome((home) => {
    const alt = path.join(home, 'alt');
    fs.mkdirSync(alt);
    fs.writeFileSync(path.join(alt, 'crush.json'), JSON.stringify({ mcp: { 'playwright-mcp': { type: 'stdio', command: 'node', args: ['/x'] } } }));
    run(home, '/y/dist/index.js', '--write', { CRUSH_GLOBAL_CONFIG: alt });
    const cfg = JSON.parse(fs.readFileSync(path.join(alt, 'crush.json'), 'utf8'));
    assert.deepEqual(cfg.mcp['playwright-mcp'].args, ['/y/dist/index.js']);
    assert.equal(cfg.mcp['playwright-mcp'].timeout, 300, 'a missing timeout gets the installer default');
  });
});

test('CRUSH_GLOBAL_CONFIG also decides where crushrc is written (Crush reads it there)', () => {
  withHome((home) => {
    const alt = path.join(home, 'alt');
    run(home, '/y/dist/index.js', '--write', { CRUSH_GLOBAL_CONFIG: alt });
    assert.match(fs.readFileSync(path.join(alt, 'crushrc'), 'utf8'), /mcp add playwright-mcp/);
    assert.equal(fs.existsSync(rcPath(home)), false, 'nothing under XDG_CONFIG_HOME when the override is set');
  });
});

test('unparseable crush.json that names the server: refuses, writes nothing', () => {
  withHome((home) => {
    fs.mkdirSync(path.dirname(jsonPath(home)), { recursive: true });
    const raw = '{ "mcp": { "playwright-mcp": { "command": "node", }, }, }';
    fs.writeFileSync(jsonPath(home), raw);
    const r = run(home, '/z/dist/index.js', '--write');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /could not be parsed/);
    assert.equal(fs.readFileSync(jsonPath(home), 'utf8'), raw);
    assert.equal(fs.existsSync(rcPath(home)), false);
  });
});

test('awkward paths survive bash quoting byte-for-byte', () => {
  withHome((home) => {
    const entry = "/home/o'brien/My Apps/$HOME/`x`/dist/index.js";
    run(home, entry, '--write');
    // Source the crushrc under a stub `mcp` that prints its arguments.
    const out = execFileSync('bash', ['-c', `mcp() { printf '%s\\n' "$@"; }; source "$1"`, '_', rcPath(home)], {
      encoding: 'utf8',
    });
    const argv = out.trimEnd().split('\n');
    assert.equal(argv[argv.indexOf('--args') + 1], entry);
  });
});
