#!/usr/bin/env node
// T1 regression guard — install.sh's ONE-LINE INSTALL logic, run as shell, offline.
//
// install.sh runs two ways: `./install.sh` inside a clone (build in place), and
// `bash -c "$(curl … install.sh)"` with no clone (download into
// ~/.local/share/playwright-mcp, build in a staging dir, swap). Telling them apart
// wrongly is the dangerous failure: under `bash -c` there is no script file, so a
// naive dirname-of-BASH_SOURCE resolves to the caller's cwd, and the installer
// would npm-install into whatever project the user happened to be standing in.
//
// Method, same as test-install-glibc.mjs: the helpers are EXTRACTED from
// install.sh by name (and the mode block by its first and last lines) and run
// under `set -euo pipefail`. Nothing is downloaded and nothing outside a scratch
// dir is touched. Each predicate also runs against a mutated copy that must
// fail: a guard that cannot fail is not a guard.
//
// NOT covered here, because it is network and npm: the download, the build in
// the staging dir, and the swap. Those were run end to end by hand against a
// throwaway HOME when this landed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');

/** `name() {` through the first line that is exactly `}`; throws when missing. */
function shFunction(text, name) {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => new RegExp(`^${name}\\(\\) \\{`).test(l));
  if (open === -1) throw new Error(`install.sh: no function ${name}()`);
  const close = lines.indexOf('}', open + 1);
  if (close === -1) throw new Error(`install.sh: function ${name}() is not terminated by a bare }`);
  return lines.slice(open, close + 1).join('\n');
}

/** The top-level mode block: `SELF="${BASH_SOURCE[0]:-}"` through the bare `fi` that ends it. */
function modeBlock(text) {
  const lines = text.split('\n');
  const open = lines.indexOf('SELF="${BASH_SOURCE[0]:-}"');
  if (open === -1) throw new Error('install.sh: mode block (SELF=...) not found');
  const end = lines.indexOf('  OLD="$INSTALL_DIR.old"', open);
  if (end === -1 || lines[end + 1] !== 'fi') throw new Error('install.sh: mode block is not closed the expected way');
  return lines.slice(open, end + 2).join('\n');
}

const VERSION_IS_OLDER = shFunction(SH, 'version_is_older');
const IS_OWN_CHECKOUT = shFunction(SH, 'is_own_checkout');
const INSTALL_DIR_IS_OURS = shFunction(SH, 'install_dir_is_ours');
const MODE_BLOCK = modeBlock(SH);

const PRELUDE = `set -euo pipefail
die() { printf 'DIE %s\\n' "$*" >&2; exit 1; }
`;

function bash(script, { cwd, env = {}, args = [] } = {}) {
  const res = spawnSync('bash', ['-c', script, 'harness', ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: env.HOME ?? os.tmpdir(), ...env },
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-install-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A directory that looks like a checkout: package.json with `name`, plus src/. */
function fakeCheckout(dir, name = '@francis/playwright-mcp', { installRecord = false } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.4.0' }, null, 2) + '\n');
  if (installRecord) fs.writeFileSync(path.join(dir, '.install.json'), '{}\n');
  return dir;
}

// ── version_is_older ─────────────────────────────────────────────────────────

const olderHarness = (fn = VERSION_IS_OLDER) =>
  `${PRELUDE}${fn}\nversion_is_older "$1" "$2" && echo OLDER || echo NOT_OLDER`;
const older = (a, b, fn) => bash(olderHarness(fn), { args: [a, b] }).out;

test('version_is_older compares X.Y.Z numerically, field by field', () => {
  assert.equal(older('0.3.2', '0.4.0'), 'OLDER');
  assert.equal(older('0.4.0', '0.3.2'), 'NOT_OLDER');
  assert.equal(older('0.4.0', '0.4.0'), 'NOT_OLDER', 'equal is not older');
  assert.equal(older('0.9.0', '0.10.0'), 'OLDER', '10 is numeric, not text');
  assert.equal(older('0.10.0', '0.9.0'), 'NOT_OLDER');
  assert.equal(older('1.0', '1.0.1'), 'OLDER', 'a missing field counts as 0');
  assert.equal(older('1.0.1', '1.0'), 'NOT_OLDER');
  assert.equal(older('0.4.0-beta.1', '0.4.1'), 'OLDER', 'non-digits in a field are dropped');
  assert.equal(older('08.0.0', '9.0.0'), 'OLDER', 'a leading zero is base 10, not octal');
});

test('negative: drop the "newer field wins" line and a downgrade is misread', () => {
  const mutated = VERSION_IS_OLDER.replace(/^\s*if \[ "\$x" -gt "\$y" \]; then return 1; fi\n/m, '');
  assert.notEqual(mutated, VERSION_IS_OLDER, 'precondition: the line was located');
  assert.equal(older('1.0.0', '0.9.0', mutated), 'OLDER', 'without it 1.0.0 reads as older than 0.9.0');
  assert.equal(older('1.0.0', '0.9.0'), 'NOT_OLDER', 'and the real function gets it right');
});

// ── is_own_checkout / install_dir_is_ours ────────────────────────────────────

const pred = (fn, name, dir) => bash(`${PRELUDE}${fn}\n${name} "$1" && echo YES || echo NO`, { args: [dir] }).out;

test('is_own_checkout: this package with src/, and not an install this script made', (t) => {
  const root = scratch(t);
  assert.equal(pred(IS_OWN_CHECKOUT, 'is_own_checkout', REPO), 'YES', 'the real repo is a checkout');
  assert.equal(pred(IS_OWN_CHECKOUT, 'is_own_checkout', fakeCheckout(path.join(root, 'ours'))), 'YES');
  assert.equal(pred(IS_OWN_CHECKOUT, 'is_own_checkout', fakeCheckout(path.join(root, 'other'), 'some-app')), 'NO',
    'another Node project with package.json and src/ is not ours');
  assert.equal(
    pred(IS_OWN_CHECKOUT, 'is_own_checkout', fakeCheckout(path.join(root, 'inst'), undefined, { installRecord: true })),
    'NO', 'an install carrying .install.json is updated by download, not rebuilt in place');
  const noSrc = path.join(root, 'nosrc');
  fakeCheckout(noSrc);
  fs.rmSync(path.join(noSrc, 'src'), { recursive: true });
  assert.equal(pred(IS_OWN_CHECKOUT, 'is_own_checkout', noSrc), 'NO');
});

test('negative: without the package-name test, any Node project counts as a checkout', (t) => {
  const mutated = IS_OWN_CHECKOUT.replace(/ &&\n\s*grep -q .*$/m, '');
  assert.notEqual(mutated, IS_OWN_CHECKOUT, 'precondition: the grep line was located');
  const other = fakeCheckout(path.join(scratch(t), 'other'), 'some-app');
  assert.equal(pred(mutated, 'is_own_checkout', other), 'YES');
});

test('install_dir_is_ours: absent, empty, or carrying .install.json; nothing else', (t) => {
  const root = scratch(t);
  const ours = (d) => pred(INSTALL_DIR_IS_OURS, 'install_dir_is_ours', d);
  assert.equal(ours(path.join(root, 'absent')), 'YES');
  fs.mkdirSync(path.join(root, 'empty'));
  assert.equal(ours(path.join(root, 'empty')), 'YES');
  fakeCheckout(path.join(root, 'installed'), undefined, { installRecord: true });
  assert.equal(ours(path.join(root, 'installed')), 'YES');
  fs.mkdirSync(path.join(root, 'home'));
  fs.writeFileSync(path.join(root, 'home', '.bashrc'), '');
  assert.equal(ours(path.join(root, 'home')), 'NO', 'a lived-in directory is never moved aside');
  assert.equal(ours(fakeCheckout(path.join(root, 'clone'))), 'NO', 'nor is a clone');
});

// ── the mode block ───────────────────────────────────────────────────────────

const modeHarness = `${PRELUDE}${IS_OWN_CHECKOUT}\n${MODE_BLOCK}\nprintf '%s|%s|%s\\n' "$MODE" "$HERE" "\${INSTALL_DIR:-}"`;

test('bash -c (the one-liner) is bootstrap even when cwd is a checkout', (t) => {
  const home = scratch(t);
  // The worst case: cwd is a perfect copy of this project. With no script file
  // there is nothing to resolve, so it must still not build here.
  const r = bash(modeHarness, { cwd: REPO, env: { HOME: home } });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `bootstrap||${home}/.local/share/playwright-mcp`);
});

test('the install dir follows XDG_DATA_HOME, then PLAYWRIGHT_MCP_HOME', (t) => {
  const home = scratch(t);
  assert.equal(bash(modeHarness, { env: { HOME: home, XDG_DATA_HOME: `${home}/data` } }).out,
    `bootstrap||${home}/data/playwright-mcp`);
  assert.equal(bash(modeHarness, { env: { HOME: home, PLAYWRIGHT_MCP_HOME: `${home}/pw/` } }).out,
    `bootstrap||${home}/pw`, 'a trailing slash is dropped so .new/.old land beside it');
  const rel = bash(modeHarness, { env: { HOME: home, PLAYWRIGHT_MCP_HOME: 'relative/dir' } });
  assert.equal(rel.code, 1);
  assert.match(rel.err, /must be an absolute path/);
});

/** Run the mode block as a real script file placed in `dir`. */
function runAsFile(dir, env) {
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, modeHarness);
  const res = spawnSync('bash', [file], { encoding: 'utf8', cwd: os.tmpdir(), env: { PATH: process.env.PATH, ...env } });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

test('./install.sh inside a checkout is clone mode, rooted at the checkout', (t) => {
  const root = scratch(t);
  const clone = fakeCheckout(path.join(root, 'clone'));
  assert.equal(runAsFile(clone, { HOME: root }).out, `clone|${clone}|`);
});

test('install.sh saved on its own, or inside another project, is bootstrap', (t) => {
  const root = scratch(t);
  const downloads = path.join(root, 'Downloads');
  fs.mkdirSync(downloads);
  assert.equal(runAsFile(downloads, { HOME: root }).out, `bootstrap||${root}/.local/share/playwright-mcp`);
  const other = fakeCheckout(path.join(root, 'other'), 'some-app');
  assert.equal(runAsFile(other, { HOME: root }).out, `bootstrap||${root}/.local/share/playwright-mcp`);
});

test('install.sh re-run from inside an install it made updates that install', (t) => {
  const root = scratch(t);
  const inst = fakeCheckout(path.join(root, 'elsewhere', 'playwright-mcp'), undefined, { installRecord: true });
  assert.equal(runAsFile(inst, { HOME: root }).out, `bootstrap||${inst}`);
});
