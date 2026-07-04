// Tests for the suite_scaffold template tree + generalized scaffold core.
// Mirrors scripts/test-scaffold.mjs: run with `node --test scripts/`.

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scaffold, SUITE_TEMPLATE_DIR } from '../dist/scaffold.js';
import { suiteMethodologyTool } from '../dist/tools/suite.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const KEY_FILES = [
  'playwright.config.ts',
  'e2e-suite.config.json',
  'README.md',
  path.join('tests', 'auth.setup.ts'),
  path.join('tests', 'fixture.ts'),
  path.join('tests', 'global-setup.ts'),
  path.join('tests', 'global-teardown.ts'),
  path.join('tests', 'example.spec.ts'),
  path.join('tests', 'helpers', 'page-integrity.ts'),
  path.join('tests', 'helpers', 'error-capture.ts'),
  path.join('tests', 'helpers', 'session-state.ts'),
  path.join('tests', 'helpers', 'suite-config.ts'),
  path.join('.claude', 'skills', 'test-suite', 'SKILL.md'),
  path.join('.claude', 'skills', 'test-suite', 'references', 'methodology.md'),
  path.join('.claude', 'skills', 'test-suite', 'references', 'authoring-workflow.md'),
  path.join('.claude', 'skills', 'test-suite', 'references', 'audit-workflow.md'),
];

function withTmp(fn) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-suite-'));
  try {
    fn(out);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const suiteScaffold = (opts) => scaffold({ templateDir: SUITE_TEMPLATE_DIR, ...opts });

test('suite template writes the full pack with both placeholders substituted', () => {
  withTmp((out) => {
    const written = suiteScaffold({ session: 'acme', project: 'shopfront', out });
    for (const rel of KEY_FILES) {
      assert.ok(written.includes(rel), `not written: ${rel}`);
      assert.ok(fs.existsSync(path.join(out, rel)), `missing on disk: ${rel}`);
    }
    for (const rel of written) {
      const body = fs.readFileSync(path.join(out, rel), 'utf8');
      assert.ok(!body.includes('__SESSION_NAME__'), `session placeholder left in ${rel}`);
      assert.ok(!body.includes('__PROJECT_NAME__'), `project placeholder left in ${rel}`);
    }
    // The substituted config JSON must stay parseable.
    const cfg = JSON.parse(fs.readFileSync(path.join(out, 'e2e-suite.config.json'), 'utf8'));
    assert.equal(cfg.project, 'shopfront');
    assert.equal(cfg.session, 'acme');
  });
});

test('names that would break a string literal or JSON are rejected', () => {
  withTmp((out) => {
    assert.throws(() => suiteScaffold({ session: 'a"b', out }), /invalid session name/);
    assert.throws(() => suiteScaffold({ project: 'x\\y', out }), /invalid project name/);
    assert.equal(fs.readdirSync(out).length, 0, 'rejected scaffold must write nothing');
  });
});

test('suite config path precedence stays in lockstep with src/secrets.ts', () => {
  withTmp((out) => {
    suiteScaffold({ out });
    const config = fs.readFileSync(path.join(out, 'playwright.config.ts'), 'utf8');
    const secrets = fs.readFileSync(path.join(REPO, 'src', 'secrets.ts'), 'utf8');
    for (const tok of ['PLAYWRIGHT_MCP_SESSIONS', 'XDG_CONFIG_HOME', 'APPDATA', 'STORAGE_STATE']) {
      assert.ok(config.includes(tok), `suite config missing ${tok}`);
    }
    for (const tok of ['PLAYWRIGHT_MCP_SESSIONS', 'XDG_CONFIG_HOME', 'APPDATA']) {
      assert.ok(secrets.includes(tok), `precedence drift on ${tok}`);
    }
    assert.ok(!/\/home\/|\/Users\//.test(config), 'suite config hard-codes a home path');
  });
});

test('refuses to overwrite an existing scaffold without force', () => {
  withTmp((out) => {
    suiteScaffold({ out });
    assert.throws(() => suiteScaffold({ out }), /refusing to overwrite/);
  });
});

test('suite_methodology serves the shipped references (single source, placeholders neutralized)', async () => {
  for (const topic of ['overview', 'methodology', 'authoring', 'audit', 'all']) {
    const res = await suiteMethodologyTool.handler({ topic });
    assert.ok(!res.isError, `topic ${topic} errored`);
    const text = res.content[0].text;
    assert.ok(text.length > 500, `topic ${topic} suspiciously short`);
    assert.ok(!text.includes('__PROJECT_NAME__'), `placeholder leaked for ${topic}`);
  }
  const audit = await suiteMethodologyTool.handler({ topic: 'audit' });
  assert.ok(/TEST-DEFECT/.test(audit.content[0].text), 'audit topic missing adjudication');
});
