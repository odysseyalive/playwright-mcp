#!/usr/bin/env node
// Installer step (Linux): give Chromium the system libraries it needs, WITHOUT root.
//
// Measured 2026-09-26 on a Debian server: the bundled Chromium downloaded fine and
// then exited 127 on launch, "libnspr4.so: cannot open shared object file". The
// usual fix, `sudo npx playwright install-deps`, needs root, and this installer
// must work on hosts where the user has none. So the missing packages are fetched
// and unpacked as the user:
//
//   1. ldd both Chromium binaries. Nothing missing: done, nothing touched.
//   2. apt, pointed at a PRIVATE state dir (lists, cache, lock), refreshes its
//      package lists as the user. The system's dpkg status stays the source of
//      truth for what is installed.
//   3. Playwright's own `install-deps chromium --dry-run` names the packages this
//      distro is missing (its per-distro list, resolved by apt against what is
//      installed). Not deb.deps: package names differ between releases.
//   4. `apt-get download` + `dpkg-deb -x` unpack them into the sysroot.
//      stealth.ts puts its lib dirs on LD_LIBRARY_PATH for every browser launch.
//   5. ldd again. Anything still missing is a loud failure listing it.
//
// Hosts without apt/dpkg fail loudly with the missing libraries named. No rpm
// branch ships until one has been run.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { chromium } from 'playwright';

import { sysrootDir, sysrootLibDirs } from '../dist/stealth.js';

if (process.platform !== 'linux') process.exit(0);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = sysrootDir();
const APT = path.join(path.dirname(ROOT), 'apt');
/** Never unpacked, whatever a resolver says: shadowing these breaks every process. */
const NEVER = new Set(['libc6', 'libc-bin', 'libgcc-s1', 'libstdc++6']);

function binaries() {
  const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry;
  const shell = registry.findExecutable('chromium-headless-shell')?.executablePath();
  return [chromium.executablePath(), shell].filter((b) => b && fs.existsSync(b));
}

/** Sonames ldd cannot resolve for these binaries, with the sysroot on the path. */
function missingLibs(bins) {
  const libPath = [...sysrootLibDirs(ROOT), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const missing = new Set();
  for (const bin of bins) {
    const r = spawnSync('ldd', [bin], { env: { ...process.env, LD_LIBRARY_PATH: libPath }, encoding: 'utf8' });
    for (const m of (r.stdout ?? '').matchAll(/^\s*(\S+) => not found/gm)) missing.add(m[1]);
  }
  return [...missing].sort();
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

function fail(msg, libs) {
  console.error(msg);
  if (libs?.length) console.error(`Missing libraries: ${libs.join(' ')}`);
  process.exit(1);
}

const bins = binaries();
if (!bins.length) fail('No Chromium binary found to check. Did `npx playwright install chromium` run?');
const before = missingLibs(bins);
if (!before.length) {
  console.log('Chromium system libraries OK.');
  process.exit(0);
}

console.log(`Chromium is missing ${before.length} system libraries; fetching them into ${ROOT} (no root needed)…`);
if (!['apt-get', 'dpkg-deb', 'dpkg-query'].every(has))
  fail('This host has no apt/dpkg, so the libraries cannot be fetched without root.', before);

// A private apt: its own lists, cache, and lock, readable and writable by the user.
for (const d of ['state/lists/partial', 'cache/archives/partial', 'log']) fs.mkdirSync(path.join(APT, d), { recursive: true });
const conf = path.join(APT, 'apt.conf');
fs.writeFileSync(
  conf,
  [
    `Dir::State "${APT}/state";`,
    'Dir::State::status "/var/lib/dpkg/status";',
    `Dir::Cache "${APT}/cache";`,
    `Dir::Log "${APT}/log";`,
    'Debug::NoLocking "true";',
    '',
  ].join('\n'),
);
const aptEnv = { ...process.env, APT_CONFIG: conf };

const update = spawnSync('apt-get', ['-q', 'update'], { env: aptEnv, encoding: 'utf8' });
if (update.status !== 0) fail(`apt-get update (private lists) failed:\n${update.stderr || update.stdout}`, before);

const dry = spawnSync(path.join(REPO, 'node_modules/.bin/playwright'), ['install-deps', 'chromium', '--dry-run'], {
  env: aptEnv,
  encoding: 'utf8',
});
const listed = /Missing system dependencies \(\d+\):\n((?:\s+\S+\n?)+)/.exec(dry.stdout ?? '');
if (!listed) fail(`Could not get the package list from Playwright:\n${dry.stderr || dry.stdout}`, before);
const pkgs = listed[1].split('\n').map((l) => l.trim()).filter((p) => p && !NEVER.has(p));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-debs-'));
try {
  const dl = spawnSync('apt-get', ['-q', 'download', ...pkgs], { cwd: tmp, env: aptEnv, encoding: 'utf8' });
  if (dl.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fail(`apt-get download failed:\n${dl.stderr || dl.stdout}`, before);
  }
  fs.mkdirSync(ROOT, { recursive: true });
  const debs = fs.readdirSync(tmp).filter((f) => f.endsWith('.deb'));
  for (const deb of debs) execFileSync('dpkg-deb', ['-x', path.join(tmp, deb), ROOT]);
  console.log(`Unpacked ${debs.length} packages.`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Fonts from the sysroot are invisible to a host fontconfig that does not know
// the dir, and a host with no fontconfig at all has no config to read. Point
// fontconfig at both the system and sysroot font dirs (stealth.ts sets
// FONTCONFIG_FILE only when this file exists).
if (!fs.existsSync('/etc/fonts/fonts.conf') && fs.existsSync(path.join(ROOT, 'usr/share/fonts'))) {
  fs.writeFileSync(
    path.join(ROOT, 'fonts.conf'),
    [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">',
      '<fontconfig>',
      '  <dir>/usr/share/fonts</dir>',
      `  <dir>${ROOT}/usr/share/fonts</dir>`,
      `  <cachedir>${ROOT}/fontcache</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n'),
  );
}

const after = missingLibs(bins);
if (after.length) fail('Some libraries are still missing after unpacking the packages.', after);
console.log('Chromium system libraries OK.');
