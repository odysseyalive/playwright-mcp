// T1 acceptance for the E2E scaffold generator. Deterministic: generates into a
// temp dir and asserts the contract — files written, placeholder substituted,
// portable path resolution (no baked home path, CI hatch), no secret/session
// data leaked into the target, overwrite protection, and lockstep with
// src/secrets.ts. No browser, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addE2eScripts, E2E_SCRIPTS, scaffold } from '../dist/scaffold.js';
import { sessionScaffoldTool } from '../dist/tools/scaffold.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXPECTED = [
  'playwright.config.ts',
  path.join('tests', 'auth.setup.ts'),
  path.join('tests', 'example.spec.ts'),
  path.join('tests', 'e2e-slot.mjs'),
  'README.md',
];

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-scaffold-'));
}
function withTmp(fn) {
  const out = mkTmp();
  try {
    fn(out);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

test('writes the expected files with the session substituted', () => {
  withTmp((out) => {
    const written = scaffold({ session: 'acme', out });
    assert.deepEqual(written.slice().sort(), EXPECTED.slice().sort());
    for (const rel of EXPECTED) assert.ok(fs.existsSync(path.join(out, rel)), `missing ${rel}`);

    // Placeholder substituted everywhere, session name baked into the config.
    for (const rel of written) {
      const body = fs.readFileSync(path.join(out, rel), 'utf8');
      assert.ok(!body.includes('__SESSION_NAME__'), `placeholder left in ${rel}`);
    }
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    assert.ok(config.includes("?? 'acme'"), 'session name not baked in');
  });
});

test('config resolves storageState portably (no baked home path, CI hatch)', () => {
  withTmp((out) => {
    scaffold({ session: 'default', out });
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    for (const tok of ['PLAYWRIGHT_MCP_SESSIONS', 'XDG_CONFIG_HOME', 'APPDATA', 'STORAGE_STATE']) {
      assert.ok(config.includes(tok), `config missing ${tok}`);
    }
    assert.ok(!/\/home\/|\/Users\//.test(config), 'config hard-codes a home path');
  });
});

test('path precedence stays in lockstep with src/secrets.ts', () => {
  withTmp((out) => {
    scaffold({ session: 'default', out });
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    const secrets = fs.readFileSync(path.join(REPO, 'src', 'secrets.ts'), 'utf8');
    for (const tok of ['PLAYWRIGHT_MCP_SESSIONS', 'XDG_CONFIG_HOME', 'APPDATA']) {
      assert.ok(config.includes(tok) && secrets.includes(tok), `precedence drift on ${tok}`);
    }
  });
});

test('writes no session/secret data into the target project', () => {
  withTmp((out) => {
    const written = scaffold({ session: 'acme', out });
    assert.ok(
      written.every((rel) => !rel.endsWith('.json')),
      'a .json file was written into the project',
    );
    for (const rel of written) {
      const body = fs.readFileSync(path.join(out, rel), 'utf8');
      assert.ok(!/"cookies"\s*:/.test(body), `${rel} contains cookie data`);
    }
  });
});

test('refuses to overwrite without --force, rewrites with it', () => {
  withTmp((out) => {
    scaffold({ session: 'a', out });
    assert.throws(() => scaffold({ session: 'b', out }), /refusing to overwrite/);
    const written = scaffold({ session: 'b', out, force: true });
    assert.ok(written.length > 0);
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    assert.ok(config.includes("?? 'b'"), 'force did not rewrite the config');
  });
});

// ── session_scaffold_tests tool (shares the same core) ──────────────────────────

test('tool writes the suite, bakes the session, echoes the resolved outDir', async () => {
  const out = mkTmp();
  try {
    const res = await sessionScaffoldTool.handler({ session: 'toolsess', outDir: out });
    assert.ok(!res.isError, 'tool returned isError');
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    assert.ok(text.includes(out), 'result does not echo the resolved outDir');
    for (const rel of EXPECTED) assert.ok(fs.existsSync(path.join(out, rel)), `tool missing ${rel}`);
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    assert.ok(config.includes("?? 'toolsess'"), 'tool did not bake the session name');
    for (const rel of EXPECTED) {
      const body = fs.readFileSync(path.join(out, rel), 'utf8');
      assert.ok(!/"cookies"\s*:/.test(body), `${rel} contains cookie data`);
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('tool documents force as rewriting the whole template set', () => {
  const force = sessionScaffoldTool.definition.inputSchema.properties.force;
  assert.match(force.description, /whole template set/i);
  assert.match(force.description, /customized/i);
});

test('tool reports collisions as an error result, never throws', async () => {
  const out = mkTmp();
  try {
    await sessionScaffoldTool.handler({ session: 'a', outDir: out });
    const res = await sessionScaffoldTool.handler({ session: 'b', outDir: out });
    assert.ok(res.isError, 'expected isError on collision');
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    assert.match(text, /refusing to overwrite/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ── the e2e slot (2026-11-25) ───────────────────────────────────────────────────

test('the npm scripts go through the slot runner; only absent keys are added', () => {
  withTmp((out) => {
    fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'x', scripts: { 'test:e2e': 'my own' } }, null, 4) + '\n');
    const note = addE2eScripts(out);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['test:e2e'], 'my own', "the project's own script is left as it is");
    assert.equal(pkg.scripts['test:e2e:direct'], E2E_SCRIPTS['test:e2e:direct']);
    assert.match(note, /added "test:e2e:direct"/);
    assert.match(note, /Left your own "test:e2e"/);
    assert.match(fs.readFileSync(path.join(out, 'package.json'), 'utf8'), /^\{\n {4}"/, 'the file keeps its indent');
    assert.equal(E2E_SCRIPTS['test:e2e'], 'node tests/e2e-slot.mjs');
  });
  withTmp((out) => {
    assert.match(addE2eScripts(out), /No package\.json/);
    assert.ok(!fs.existsSync(path.join(out, 'package.json')), 'none is created');
  });
});

test('the tool adds the scripts and tells the caller how to run through the slot', async () => {
  const out = mkTmp();
  try {
    fs.writeFileSync(path.join(out, 'package.json'), '{"name":"x"}\n');
    const res = await sessionScaffoldTool.handler({ session: 's', outDir: out });
    const text = res.content[0].text;
    assert.match(text, /npm run test:e2e/);
    assert.match(text, /--detach/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).scripts['test:e2e'], 'node tests/e2e-slot.mjs');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('the generated slot runner finds the state directory exactly as src/e2e-slot.ts does', () => {
  withTmp((out) => {
    scaffold({ session: 'default', out });
    const runner = fs.readFileSync(path.join(out, 'tests', 'e2e-slot.mjs'), 'utf8');
    const source = fs.readFileSync(path.join(REPO, 'src', 'e2e-slot.ts'), 'utf8');
    const body = (text) => /function slotDir\(\)[^{]*\{([\s\S]*?)\n\}/.exec(text)?.[1].replace(/\s+/g, ' ');
    assert.ok(body(runner), 'runner has slotDir()');
    assert.equal(body(runner), body(source), 'slotDir() drifted between the runner and src/e2e-slot.ts');
  });
});

test('the generated runner falls back to a direct run where there is no playwright-mcp', () => {
  withTmp((out) => {
    scaffold({ session: 'default', out });
    const runner = fs.readFileSync(path.join(out, 'tests', 'e2e-slot.mjs'), 'utf8');
    assert.match(runner, /process\.env\.CI \? undefined : wrapper\(\)/);
    assert.match(runner, /running without the slot/);
  });
});
