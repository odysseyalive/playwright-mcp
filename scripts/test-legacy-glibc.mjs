#!/usr/bin/env node
// T1/T2 regression guard — the PRIVATE-GLIBC host gates in src/stealth.ts and
// src/upstream.ts (run org-old-glibc-20260929T195009Z, PLAN C2/C3/C3a/C4 + the
// security review's C7).
//
// Why this file exists at all: every one of those behaviours was demonstrated
// once, by a probe that was deleted, a CentOS 7 container that was removed, and a
// reviewer's one-off measurement. Nothing in the gate could see any of it, so the
// next edit to stealth.ts could undo it with the gate green — the exact shape of
// PAT-2026-09-05-evidence-scope-is-not-conclusion-scope, and it matters more here
// than in a project with CI (DEC-2026-09-05-no-ci-every-green-gate-is-one-workstation).
//
// What is pinned, and where each thing is asserted:
//   * the predicate, both directions, including the C7 conjunct that closed the
//     measured C-4 regression (a leftover glibc/ dir on an UPGRADED host used to
//     read as legacy and silently drop the Chromium sandbox);
//   * C3/C3a — the private glibc and the EL8 sysroot reach the BROWSER and never
//     process.env on a legacy host, while a healthy host still gets the sysroot on
//     process.env exactly as it does today (that control is what proves C6);
//   * C4 — the sandbox gate, both arms, and that src/ still has exactly ONE place
//     that decides it;
//   * the loader filename has exactly one spelling in the tree;
//   * Playwright's _validateHostRequirements no-op, which is load-bearing and
//     which nobody else owns (release-engineer's Observation 3).
//
// Determinism: no network, no sleeps, no container, no download. The two seams
// src/stealth.ts was written with are what make it possible — `legacyGlibc(version)`
// takes the version as a parameter, and `glibcDir()` reads XDG_CACHE_HOME at call
// time. `useSysroot()` runs at MODULE LOAD against the runtime reading, so the
// cases that depend on it run in a child process whose process.report.getReport is
// replaced before the import. The threshold itself is always read from the
// CHROMIUM_MIN_GLIBC export: a retyped 2.25 would pin this file's typing, not the
// product.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHROMIUM_MIN_GLIBC,
  glibcDir,
  glibcOlderThan,
  legacyGlibc,
  privateLoaderPath,
  sysrootDir,
  STEALTH_LAUNCH,
} from '../dist/stealth.js';
import { withPlatformSync } from './fixtures/platform.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [MAJOR, MINOR] = CHROMIUM_MIN_GLIBC;
/** Version strings derived from the exported threshold, never typed out. */
const OLDER = `${MAJOR}.${MINOR - 1}`;
const EXACT = `${MAJOR}.${MINOR}`;
const NEWER = `${MAJOR}.${MINOR + 1}`;

/**
 * A scratch XDG_CACHE_HOME. `loader` writes the private loader as a ZERO-BYTE
 * file, which is exactly what the security reviewer used: the predicate must not
 * be satisfiable by an empty file on a modern host. `sysroot` writes the shape
 * sysrootLibDirs() recognises plus the fontconfig file the library step leaves.
 */
function makeCache({ loader = false, sysroot = false } = {}) {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-glibc-'));
  if (loader) {
    fs.mkdirSync(path.join(cache, 'playwright-mcp', 'glibc'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'playwright-mcp', 'glibc', path.basename(privateLoaderPath())), '');
  }
  if (sysroot) {
    fs.mkdirSync(path.join(cache, 'playwright-mcp', 'sysroot', 'usr', 'lib64'), { recursive: true });
    fs.writeFileSync(path.join(cache, 'playwright-mcp', 'sysroot', 'fonts.conf'), '<fontconfig/>\n');
  }
  return cache;
}

/** Run `fn` with XDG_CACHE_HOME pointed at `cache`, restored however it exits. */
function withCache(cache, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'XDG_CACHE_HOME');
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  try {
    return fn();
  } finally {
    if (had) process.env.XDG_CACHE_HOME = prev;
    else delete process.env.XDG_CACHE_HOME;
  }
}

// ── 1. the predicate, both directions ────────────────────────────────────────

test('glibcOlderThan compares numerically against the exported threshold', () => {
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, OLDER), true);
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, EXACT), false, 'the threshold itself is new enough');
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, NEWER), false);
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, `${MAJOR - 1}.99`), true, 'an older MAJOR is older');
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, `${MAJOR + 1}.0`), false, 'a newer MAJOR is not');
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, '2.17'), true, 'CentOS 7 — the motivating host');
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, '2.44'), false, 'the host this gate was written on');
  // A lexicographic comparison would call 2.9 newer than 2.25. It is not.
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, '2.9'), true);
  assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, `${EXACT}.3`), false, 'a patch component is ignored');
});

test('an unreadable glibc version is NOT older — the safe direction', () => {
  // A false "legacy" verdict strips the sandbox from a browser that was working
  // and puts a foreign libc in front of it, so every unparseable answer must mean
  // HEALTHY. musl hosts and a Node that reports nothing both land here.
  for (const version of [undefined, '', 'musl', 'x.y', '2', 'glibc 2.17', 'unknown'])
    assert.equal(glibcOlderThan(CHROMIUM_MIN_GLIBC, version), false, `version ${JSON.stringify(version)}`);
});

test('the exported threshold is still the GLIBC_2.25 that was MEASURED on the browser binaries', () => {
  // The one place the number is written down in this file, deliberately: every
  // case above derives from the export, so nothing here pins a retyped threshold
  // — but the number itself is a measurement about the pinned Playwright Chromium
  // builds (weak refs to 2.18/2.25; `symbol __cxa_thread_atexit_impl, version
  // GLIBC_2.18 not defined` on CentOS 7, 2026-09-29). Moving it is a claim about
  // those binaries and must be a deliberate edit here too.
  assert.deepEqual([...CHROMIUM_MIN_GLIBC], [2, 25]);
});

test('legacyGlibc: loader present AND an old version ⇒ legacy; either half alone ⇒ not', () => {
  const withLoader = makeCache({ loader: true });
  const without = makeCache({ loader: false });
  try {
    withCache(withLoader, () => {
      assert.equal(legacyGlibc(OLDER), true, 'patched host, still old: the case this exists for');
      assert.equal(legacyGlibc('2.17'), true, 'CentOS 7 with the runtime provisioned');
      assert.equal(legacyGlibc(EXACT), false, 'a host at the threshold needs no private runtime');
      assert.equal(legacyGlibc(NEWER), false);
    });
    withCache(without, () => {
      assert.equal(legacyGlibc(OLDER), false, 'old host, nothing provisioned: browsers are not patched');
      assert.equal(legacyGlibc(NEWER), false);
    });
  } finally {
    fs.rmSync(withLoader, { recursive: true, force: true });
    fs.rmSync(without, { recursive: true, force: true });
  }
});

test('legacyGlibc: an unreadable version never makes a patched host legacy', () => {
  const cache = makeCache({ loader: true });
  try {
    withCache(cache, () => {
      for (const version of [undefined, '', 'musl', 'x.y'])
        assert.equal(legacyGlibc(version), false, `version ${JSON.stringify(version)}`);
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('legacyGlibc is linux-only: the same fixture on darwin/win32 is not legacy', () => {
  const cache = makeCache({ loader: true });
  try {
    withCache(cache, () => {
      assert.equal(legacyGlibc(OLDER), true, 'precondition: this fixture IS legacy on linux');
      for (const platform of ['darwin', 'win32'])
        assert.equal(withPlatformSync(platform, () => legacyGlibc(OLDER)), false, platform);
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('C-4 regression: a leftover glibc/ dir on an UPGRADED host is not legacy', () => {
  // The measurement the security review made (2026-09-29, SEC-18): on a glibc-2.44
  // host, a ZERO-BYTE file named ld-linux-x86-64.so.2 under a scratch
  // XDG_CACHE_HOME gave legacyGlibc()=true, chromiumSandbox=false and that dir on
  // the browser's LD_LIBRARY_PATH. Its real-world form is not an attacker but
  // staleness: a host provisioned once and later OS-upgraded keeps glibc/ forever.
  //
  // The version is passed EXPLICITLY rather than read from the host, which is what
  // makes this deterministic: on the 2.44 workstation the ambient reading happens
  // to agree, and in a CentOS 7 container it would legitimately say legacy.
  const cache = makeCache({ loader: true });
  try {
    withCache(cache, () => {
      assert.equal(fs.existsSync(privateLoaderPath()), true, 'precondition: the leftover loader is there');
      assert.equal(fs.statSync(privateLoaderPath()).size, 0, 'precondition: it is the zero-byte file');
      assert.equal(legacyGlibc(NEWER), false, 'presence alone must no longer be enough');

      // The pre-C7 predicate, reconstructed: this is what src/stealth.ts said
      // before the conjunct landed. It must DISAGREE on this fixture — otherwise
      // the assertion above cannot fail and proves nothing.
      const presenceOnly = () => process.platform === 'linux' && fs.existsSync(privateLoaderPath());
      assert.equal(presenceOnly(), true, 'the old predicate said legacy here — that was the defect');
      assert.notEqual(legacyGlibc(NEWER), presenceOnly(), 'C7 is the difference between the two');
    });
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

// ── 2. the cache layout, and one spelling of the loader filename ──────────────

test('glibcDir() and privateLoaderPath() honour XDG_CACHE_HOME, beside the sysroot', () => {
  const cache = makeCache();
  try {
    withCache(cache, () => {
      assert.equal(glibcDir(), path.join(cache, 'playwright-mcp', 'glibc'));
      assert.equal(privateLoaderPath(), path.join(glibcDir(), path.basename(privateLoaderPath())));
      assert.equal(
        path.dirname(glibcDir()),
        path.dirname(sysrootDir()),
        'the private runtime lives beside the sysroot in the SAME cache root (PLAN C2)',
      );
    });
    // And an explicit root still overrides, which is how provision-libs.mjs
    // addresses a runtime it is building somewhere else.
    assert.equal(privateLoaderPath('/tmp/other'), path.join('/tmp/other', path.basename(privateLoaderPath())));
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('the private loader filename has exactly ONE spelling in the tree', () => {
  // The installer WRITES this name and every launch site TESTS it. If the two ever
  // diverge the product breaks silently on the only hosts it exists for, so the
  // name must come from privateLoaderPath() everywhere. Note the name below is
  // read FROM the export — typing it here would make this file a second spelling.
  const name = path.basename(privateLoaderPath());
  const files = [
    ...fs.readdirSync(path.join(REPO, 'src'), { recursive: true }).map((f) => path.join('src', String(f))),
    ...fs.readdirSync(path.join(REPO, 'scripts')).map((f) => path.join('scripts', String(f))),
    'install.sh',
  ].filter((f) => /\.(ts|mjs|sh)$/.test(f) && !/^scripts[/\\]test-/.test(f));
  const hits = files.filter((f) => {
    const abs = path.join(REPO, f);
    return fs.statSync(abs).isFile() && fs.readFileSync(abs, 'utf8').includes(name);
  });
  assert.deepEqual(hits, ['src/stealth.ts'], `${name} must appear only where privateLoaderPath() defines it`);
  // The writer really does import that export rather than build the path itself.
  const provision = fs.readFileSync(path.join(REPO, 'scripts', 'provision-libs.mjs'), 'utf8');
  assert.match(provision, /privateLoaderPath/, 'scripts/provision-libs.mjs uses the shared spelling');
  assert.match(provision, /from '\.\.\/dist\/stealth\.js'/, 'and imports it from the one module that owns it');
});

test('the Chromium glibc threshold has one definition, and the installer imports it', () => {
  // The installer decides whether to BUILD the private runtime and the launch
  // sites decide whether to USE it. Two copies of the threshold would let those
  // two answers drift — a host provisioned by one number and launched by another.
  const provision = fs.readFileSync(path.join(REPO, 'scripts', 'provision-libs.mjs'), 'utf8');
  assert.match(provision, /\bCHROMIUM_MIN_GLIBC\b/, 'provision-libs.mjs reads the exported threshold');
  assert.match(provision, /\bglibcOlderThan\b/, 'and the exported comparison, not a second implementation');
  // No second copy of the tuple anywhere else in the code we own.
  const literal = new RegExp(`\\[\\s*${MAJOR}\\s*,\\s*${MINOR}\\s*\\]`);
  const files = [
    ...fs.readdirSync(path.join(REPO, 'src'), { recursive: true }).map((f) => path.join('src', String(f))),
    ...fs.readdirSync(path.join(REPO, 'scripts')).map((f) => path.join('scripts', String(f))),
  ].filter((f) => /\.(ts|mjs)$/.test(f) && !/^scripts[/\\]test-/.test(f));
  const copies = files.filter((f) => literal.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
  assert.deepEqual(copies, ['src/stealth.ts'], 'the threshold tuple is written down exactly once');
});

// ── 3. C4 — the sandbox gate has exactly one decision site ───────────────────

test('src/ decides chromiumSandbox in exactly ONE place, and it carries the legacy gate', () => {
  // Every other launch site is unsandboxed already (Playwright's chromiumSandbox
  // default is false, and it pushes --no-sandbox when the option is not true), so
  // a future edit that sandboxes one of them would be a silent behaviour change on
  // a legacy host: the sandbox cannot start under the patched loader there. This
  // asserts the shape of the census server-engineer took, so the census stays true.
  const sites = [];
  for (const rel of fs.readdirSync(path.join(REPO, 'src'), { recursive: true })) {
    const f = path.join('src', String(rel));
    if (!f.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    for (const line of text.split('\n')) if (/^\s*chromiumSandbox\s*:/.test(line)) sites.push([f, line.trim()]);
  }
  assert.equal(sites.length, 1, `expected one chromiumSandbox assignment in src/, found ${sites.length}`);
  assert.equal(sites[0][0], 'src/upstream.ts');
  assert.match(sites[0][1], /!legacyGlibc\(\)/, 'the one decision site must consult the legacy gate');
  assert.match(sites[0][1], /getuid/, 'and keep the root case it already had (commit b98cb63)');
});

test('STEALTH_LAUNCH carries no sandbox opinion, and its env appears exactly when legacy', () => {
  assert.equal('chromiumSandbox' in STEALTH_LAUNCH, false, 'the spread sites are unsandboxed by default');
  // Host-independent: whatever this host is, the env is present iff the gate says
  // legacy. `env` is a GETTER, so this reads the live decision, not a snapshot.
  assert.equal({ ...STEALTH_LAUNCH }.env === undefined, !legacyGlibc());
});

// ── 4. C3/C3a — what reaches the browser, and what must never reach Node ──────
//
// useSysroot() mutates process.env at MODULE LOAD, gated on the runtime reading,
// so these cases need a fresh process with that reading replaced. The child writes
// one JSON line to stdout; stealth.ts's own notice goes to stderr, where the MCP
// contract requires it.

const PROBE = `
// Written by scripts/test-legacy-glibc.mjs; lives and dies with its scratch dir.
const mode = process.env.WF_FAKE_MODE;
if (mode === 'value') process.report.getReport = () => ({ header: { glibcVersionRuntime: process.env.WF_FAKE_GLIBC } });
else if (mode === 'missing') process.report.getReport = () => ({ header: {} });
const s = await import(process.env.WF_STEALTH_URL);
const u = await import(process.env.WF_UPSTREAM_URL);
const launch = u.upstreamLaunch().launchOptions;
const spread = { ...s.STEALTH_LAUNCH };
process.stdout.write(
  JSON.stringify({
    legacy: s.legacyGlibc(),
    sandbox: launch.chromiumSandbox,
    upstreamLD: launch.env?.LD_LIBRARY_PATH ?? null,
    stealthLD: spread.env?.LD_LIBRARY_PATH ?? null,
    launchFonts: launch.env?.FONTCONFIG_FILE ?? null,
    processLD: process.env.LD_LIBRARY_PATH ?? null,
    processFonts: process.env.FONTCONFIG_FILE ?? null,
    glibcDir: s.glibcDir(),
    sysrootDirs: s.sysrootLibDirs(),
    uid: process.getuid(),
  }),
);
`;

/**
 * One probe process against `cache`, with the runtime glibc reading forced to
 * `glibc` ('missing' for a host that reports none, 'ambient' to leave the real
 * reading alone). LD_LIBRARY_PATH and FONTCONFIG_FILE are stripped from the child
 * env first: this test process imported stealth.js too, so on a host that HAS a
 * sysroot it would otherwise hand the child an inherited path and the assertions
 * would read as passing for the wrong reason.
 */
function probe(cache, glibc) {
  const env = { ...process.env, XDG_CACHE_HOME: cache };
  delete env.LD_LIBRARY_PATH;
  delete env.FONTCONFIG_FILE;
  env.WF_FAKE_MODE = glibc === 'ambient' ? 'ambient' : glibc === 'missing' ? 'missing' : 'value';
  if (env.WF_FAKE_MODE === 'value') env.WF_FAKE_GLIBC = glibc;
  env.WF_STEALTH_URL = pathToFileURL(path.join(REPO, 'dist', 'stealth.js')).href;
  env.WF_UPSTREAM_URL = pathToFileURL(path.join(REPO, 'dist', 'upstream.js')).href;
  const file = path.join(cache, 'probe.mjs');
  fs.writeFileSync(file, PROBE);
  const res = spawnSync(process.execPath, [file], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(res.status, 0, `probe failed (rc=${res.status}):\n${res.stderr}`);
  return { ...JSON.parse(res.stdout), stderr: res.stderr };
}

test('C3/C3a: on a legacy host the private glibc leads the BROWSER path and never Node’s', async (t) => {
  const cache = makeCache({ loader: true, sysroot: true });
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const r = probe(cache, '2.17');

  assert.equal(r.legacy, true);
  assert.ok(r.sysrootDirs.length > 0, 'precondition: the fixture sysroot was recognised');
  for (const [label, ld] of [
    ['upstreamLaunch (browser_*)', r.upstreamLD],
    ['STEALTH_LAUNCH (web_fetch, session_*)', r.stealthLD],
  ]) {
    assert.ok(ld, `${label} must carry a library path`);
    const dirs = ld.split(':');
    assert.equal(dirs[0], r.glibcDir, `${label}: the private glibc must LEAD (rpath alone was measured insufficient)`);
    for (const d of r.sysrootDirs) assert.ok(dirs.includes(d), `${label}: the sysroot dir ${d} must be on the path`);
  }
  assert.ok(r.launchFonts?.endsWith('fonts.conf'), 'the browser gets the sysroot fontconfig file');

  // C3a — the half that keeps the server alive on the target host. Nothing EL8
  // may reach process.env: every child of the server inherits it (rpm2cpio, cpio,
  // curl, ldd, sh), and an EL8 libz in front of a CentOS 7 /bin/sh breaks the very
  // tools the installer re-runs with on its second run.
  assert.equal(r.processLD, null, 'the server’s own LD_LIBRARY_PATH must stay untouched');
  assert.equal(r.processFonts, null, 'and so must FONTCONFIG_FILE');
  assert.equal(r.sandbox, false, 'C4: browser_* runs unsandboxed on a patched host');
  // C-2 asks that the exposure be STATED on stderr, not that it be stated in any
  // particular words, so this matches the subject and not server-engineer's
  // phrasing — a docs-driven rewording is not a product regression.
  assert.match(r.stderr, /sandbox/i, 'C-2: the exposure is stated on stderr');
  assert.equal(r.stderr.split('\n').filter((l) => /sandbox/i.test(l)).length, 1, 'and exactly once');
});

test('C-4 regression, end to end: a leftover runtime on an upgraded host keeps the sandbox', async (t) => {
  // The same fixture as the legacy case above — loader present, sysroot present —
  // with only the reported glibc moved forward. Before C7 this produced
  // legacy:true, sandbox:false and the dir on the browser's path.
  const cache = makeCache({ loader: true, sysroot: true });
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const r = probe(cache, NEWER);

  assert.equal(r.legacy, false);
  assert.equal(r.sandbox, process.getuid() !== 0, 'the sandbox is back (and root is still unsandboxed)');
  assert.equal(r.upstreamLD, null, 'no private-glibc env reaches browser_*');
  assert.equal(r.stealthLD, null, 'nor web_fetch/session_*');
  assert.doesNotMatch(r.stderr, /sandbox/i, 'and nothing is announced on a host that is not legacy');
  // It is not legacy, so it takes the HEALTHY branch: the sysroot still reaches
  // process.env, exactly as on any other healthy host.
  assert.equal(r.processLD, r.sysrootDirs.join(':'));
});

test('C6 control: a healthy host still puts the sysroot on process.env, as it does today', async (t) => {
  const cache = makeCache({ loader: false, sysroot: true });
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const r = probe(cache, NEWER);

  assert.equal(r.legacy, false);
  assert.equal(r.processLD, r.sysrootDirs.join(':'), 'useSysroot() still mutates process.env here');
  assert.ok(r.processFonts?.endsWith('fonts.conf'));
  assert.equal(r.upstreamLD, null, 'and no launch carries an env of its own');
  assert.equal(r.stealthLD, null);
  assert.equal(r.sandbox, process.getuid() !== 0);
});

test('an OLD host that was never provisioned behaves exactly like a healthy one', async (t) => {
  // Below the threshold but with no private loader: the browsers were not patched,
  // so nothing may change — least of all the sandbox.
  const cache = makeCache({ loader: false, sysroot: true });
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const r = probe(cache, '2.17');

  assert.equal(r.legacy, false);
  assert.equal(r.sandbox, process.getuid() !== 0);
  assert.equal(r.processLD, r.sysrootDirs.join(':'));
  assert.equal(r.upstreamLD, null);
});

test('a host that reports NO glibc version is treated as healthy at module load too', async (t) => {
  const cache = makeCache({ loader: true, sysroot: true });
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const r = probe(cache, 'missing');

  assert.equal(r.legacy, false, 'no answer means healthy — a false legacy verdict is the dangerous one');
  assert.equal(r.sandbox, process.getuid() !== 0);
  assert.equal(r.upstreamLD, null);
});

// ── 5. release-engineer's Observation 3 — a no-op that is load-bearing ────────

/**
 * The directory names Playwright's `_validateHostRequirements` ldds, per browser
 * registry entry, read out of the pinned playwright-core bundle. Throws when the
 * call shape it looks for is gone: regex rot must fail this test, not pass it.
 */
function validatedDirNames() {
  const src = fs.readFileSync(path.join(REPO, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf8');
  const re = /this\._validateHostRequirements\(sdkLanguage,\s*([A-Za-z0-9_$]+)\.dir,\s*\[([^\]]*)\]/g;
  const out = new Map();
  for (const m of src.matchAll(re))
    out.set(
      m[1],
      m[2]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean),
    );
  if (out.size < 2)
    throw new Error('could not read _validateHostRequirements call sites out of playwright-core; the regex has rotted');
  return out;
}

/** The directory the registry will actually launch a browser out of. */
function executableDirName(name) {
  const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry;
  const exe = registry.findExecutable(name)?.executablePath();
  if (!exe) throw new Error(`playwright registry has no executable path for ${name}`);
  return path.basename(path.dirname(exe));
}

test('Playwright still ldds a directory this build does not ship — the no-op must stay a no-op', () => {
  // Load-bearing, and nobody else owns it. _validateHostRequirements scans
  // <browser>/chrome-linux while the linux-x64 builds unpack into
  // chrome-linux64 / chrome-headless-shell-linux64, so the scan finds nothing and
  // never throws. If a future Playwright lines those names up, a legacy host
  // starts failing at launch with "Host system is missing dependencies" — because
  // after C3a the server's own process.env deliberately carries no sysroot for
  // that ldd to find. The fix would be one legacyGlibc()-gated line in
  // src/stealth.ts; this test is how we hear about it first.
  const validated = validatedDirNames();
  const chromium = validated.get('chromium');
  assert.ok(chromium?.length, 'the chromium registry entry still validates some directory');
  for (const [entry, browser] of [
    ['chromium', 'chromium'],
    ['chromiumHeadlessShell', 'chromium-headless-shell'],
  ]) {
    const scanned = validated.get(entry);
    assert.ok(scanned?.length, `no _validateHostRequirements dirs found for ${entry}`);
    const real = executableDirName(browser);
    assert.equal(
      scanned.includes(real),
      false,
      `Playwright now ldds ${real}, the directory ${browser} really unpacks into. The host-requirements ` +
        'check is no longer a no-op, so a private-glibc host will fail at launch with "Host system is ' +
        'missing dependencies". src/stealth.ts needs a legacyGlibc()-gated fix before this Playwright ships.',
    );
  }
});

test('negative: the collision comparator does fire when the names line up', () => {
  // The test above can only pass for its intended reason if the same comparison
  // fails on a source where the names match. Synthetic bundle, real comparator.
  const synthetic = `
    _validateHostRequirements: (sdkLanguage) => this._validateHostRequirements(sdkLanguage, chromium.dir, ["chrome-linux64"], [], ["chrome-win"]),
    _validateHostRequirements: (sdkLanguage) => this._validateHostRequirements(sdkLanguage, chromiumHeadlessShell.dir, ["chrome-headless-shell-linux64"], [], ["chrome-win"]),
  `;
  const re = /this\._validateHostRequirements\(sdkLanguage,\s*([A-Za-z0-9_$]+)\.dir,\s*\[([^\]]*)\]/g;
  const parsed = new Map(
    [...synthetic.matchAll(re)].map((m) => [m[1], m[2].split(',').map((s) => s.trim().replace(/["']/g, ''))]),
  );
  assert.equal(parsed.get('chromium').includes(executableDirName('chromium')), true);
  assert.equal(
    parsed.get('chromiumHeadlessShell').includes(executableDirName('chromium-headless-shell')),
    true,
    'the comparator recognises a collision, so its false verdict above is a real reading',
  );
});
