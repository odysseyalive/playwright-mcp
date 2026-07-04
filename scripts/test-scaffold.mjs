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

import { scaffold } from '../dist/scaffold.js';
import { sessionScaffoldTool } from '../dist/tools/scaffold.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const EXPECTED = [
  'playwright.config.ts',
  path.join('tests', 'auth.setup.ts'),
  path.join('tests', 'example.spec.ts'),
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
