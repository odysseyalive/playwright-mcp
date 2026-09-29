#!/usr/bin/env node
// T1 regression guard — install.sh's OLD-GLIBC HOST logic, run as shell, offline.
//
// The behaviour this pins landed 2026-09-29 (run org-old-glibc-20260929T195009Z,
// PLAN C1): a host whose glibc is older than 2.28 cannot run any official Node
// build, so install.sh fetches the `linux-x64-glibc-217` build from
// unofficial-builds.nodejs.org instead — and on arm64, where no such build
// exists, stops with the real cause instead of "its C library may be too old".
// Nothing in the gate saw any of that: it was proved once in a CentOS 7 container
// that no longer exists (PAT-2026-09-05-evidence-scope-is-not-conclusion-scope).
//
// Method: the four shell functions are EXTRACTED from install.sh by name and run
// under `set -euo pipefail` (the `|| v=` in host_glibc exists because of pipefail,
// so a harness without it would not see that regression) with a PATH holding
// nothing but stubs and symlinks to the coreutils the functions call. `fetch` and
// the network are stubbed to print the URL they were handed and exit, so the
// variant/base/filename decision is asserted as one string and NOTHING is
// downloaded. The two index.tab fixtures under scripts/fixtures/node-index/ are
// what the version selection reads.
//
// NOT covered, deliberately, because it is a network fact and cannot be made one:
// whether unofficial-builds.nodejs.org actually publishes a `.tar.gz` (not only
// `.tar.xz`) for the current LTS. install.sh requests `.tar.gz`; this file proves
// which URL it requests, never that the URL resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = fs.readFileSync(path.join(REPO, 'install.sh'), 'utf8');
const FIXTURES = path.join(REPO, 'scripts', 'fixtures', 'node-index');

/**
 * Absolute paths, resolved from THIS process's PATH, for the few commands the
 * harness needs: the child's PATH holds only the stubs, so nothing in it —
 * including bash itself — may be looked up by name.
 */
function whichOrThrow(tool) {
  const res = spawnSync('/usr/bin/env', ['sh', '-c', `command -v ${tool}`], { encoding: 'utf8' });
  const found = String(res.stdout ?? '').trim();
  if (!found) throw new Error(`this host has no ${tool} on PATH; the installer harness cannot run`);
  return found;
}

const BASH = whichOrThrow('bash');

/**
 * The body of a POSIX-shell function in install.sh, `name() {` through the first
 * line that is exactly `}` (install.sh indents every nested brace, including the
 * awk programs inside node_lts_version). Throws when the function is missing or
 * unterminated: a renamed function must fail loudly, not silently compose an
 * empty harness that passes.
 */
function shFunction(text, name) {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => new RegExp(`^${name}\\(\\) \\{`).test(l));
  if (open === -1) throw new Error(`install.sh: no function ${name}()`);
  const close = lines.indexOf('}', open + 1);
  if (close === -1) throw new Error(`install.sh: function ${name}() is not terminated by a bare }`);
  return lines.slice(open, close + 1).join('\n');
}

/** A top-level `NAME=value` assignment, read from install.sh rather than retyped. */
function shAssignment(text, name) {
  const m = new RegExp(`^${name}=(\\S+)$`, 'm').exec(text);
  if (!m) throw new Error(`install.sh: no top-level assignment ${name}=`);
  return m[0];
}

const HOST_GLIBC = shFunction(SH, 'host_glibc');
const GLIBC_OLDER_THAN = shFunction(SH, 'glibc_older_than');
const NODE_LTS_VERSION = shFunction(SH, 'node_lts_version');
const FETCH_NODE = shFunction(SH, 'fetch_node');
const UNOFFICIAL_BASE = shAssignment(SH, 'UNOFFICIAL_NODE_BASE');

/**
 * Compose the harness: install.sh's own functions, plus stubs for everything they
 * call that would reach the network, the filesystem outside the scratch dir, or a
 * colour variable this harness does not define. `die`/`warn`/`say` keep install.sh
 * shapes (die exits 1 after writing to stderr) so the assertions read the same
 * text a user would.
 *
 * `mutate` lets a test run the SAME harness with one line of install.sh removed,
 * which is how the arm64 guard is proved to be the thing doing the work.
 */
function harness({ mutate = (s) => s } = {}) {
  return mutate(`set -euo pipefail
${UNOFFICIAL_BASE}
PRIVATE_NODE_DIR="$WF_SCRATCH/node"
say()  { printf 'SAY %s\\n' "$*" >&2; }
warn() { printf 'WARN %s\\n' "$*" >&2; }
die()  { printf 'DIE %s\\n' "$*" >&2; exit 1; }
sha256_of() { printf 'deadbeef'; }
fetch() {
  case "\${1:-}" in
    *//nodejs.org/dist/index.tab) cat "$WF_FIX_OFFICIAL" ;;
    *unofficial-builds.nodejs.org*/index.tab) cat "$WF_FIX_UNOFFICIAL" ;;
    *) printf 'FETCH %s\\n' "\${1:-}" >&2; exit 97 ;;
  esac
}
${HOST_GLIBC}
${GLIBC_OLDER_THAN}
${NODE_LTS_VERSION}
${FETCH_NODE}
case "$1" in
  host_glibc) host_glibc; printf '\\n' ;;
  older) glibc_older_than "$2" "$3" && printf 'OLDER\\n' || printf 'NOT_OLDER\\n' ;;
  lts) node_lts_version "$2" ;;
  fetch_node) fetch_node ;;
  *) printf 'unknown case %s\\n' "$1" >&2; exit 98 ;;
esac
`);
}

/**
 * Run one harness case in a scratch dir whose PATH holds ONLY the stub commands
 * and symlinks to the coreutils install.sh's functions actually invoke. A fake
 * `getconf`/`ldd` is created only when the case wants one, so "this host has no
 * getconf" is a real absence rather than a command that exits nonzero.
 */
function runCase(args, { glibc, ldd, unameS = 'Linux', unameM = 'x86_64', mutate } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-install-glibc-'));
  try {
    const bin = path.join(scratch, 'bin');
    fs.mkdirSync(bin);
    // Only what the extracted functions call: awk (host_glibc, node_lts_version),
    // cat (the fetch stub), mktemp + rm (fetch_node, before its first fetch).
    for (const tool of ['awk', 'cat', 'mktemp', 'rm']) fs.symlinkSync(whichOrThrow(tool), path.join(bin, tool));
    const stub = (name, body) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    stub('uname', `case "\${1:-}" in -s) echo '${unameS}' ;; -m) echo '${unameM}' ;; *) echo '${unameS}' ;; esac`);
    if (glibc !== undefined) stub('getconf', `[ "\${1:-}" = GNU_LIBC_VERSION ] || exit 1\nprintf '%s\\n' '${glibc}'`);
    if (ldd !== undefined) stub('ldd', `printf '%s\\n' '${ldd}'`);
    const script = path.join(scratch, 'harness.sh');
    fs.writeFileSync(script, harness({ mutate }));
    const res = spawnSync(BASH, [script, ...args], {
      env: {
        PATH: bin,
        HOME: scratch,
        WF_SCRATCH: scratch,
        TMPDIR: scratch,
        WF_FIX_OFFICIAL: path.join(FIXTURES, 'nodejs-org-index.tab'),
        WF_FIX_UNOFFICIAL: path.join(FIXTURES, 'unofficial-builds-index.tab'),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) throw res.error;
    return { rc: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ── host_glibc: the reading, and "unreadable means HEALTHY" ───────────────────

test('host_glibc reads getconf GNU_LIBC_VERSION, then falls back to ldd', () => {
  assert.equal(runCase(['host_glibc'], { glibc: 'glibc 2.17' }).stdout.trim(), '2.17');
  // No getconf on this host at all: the ldd reading is what answers.
  assert.equal(runCase(['host_glibc'], { ldd: 'ldd (GNU libc) 2.17' }).stdout.trim(), '2.17');
  // getconf present but answering something else — the ldd reading still wins.
  assert.equal(
    runCase(['host_glibc'], { glibc: 'musl libc x86_64', ldd: 'ldd (GNU libc) 2.28' }).stdout.trim(),
    '2.28',
  );
});

test('host_glibc reports NOTHING rather than a guess when no version can be read', () => {
  // musl, a getconf that answers something else, and no readable ldd line: an
  // empty answer is what every comparison below treats as new enough. Guessing
  // "too old" would swap a working Node for an unofficial build.
  assert.equal(runCase(['host_glibc'], { glibc: 'musl libc x86_64' }).stdout.trim(), '');
  assert.equal(runCase(['host_glibc'], { ldd: 'musl libc (x86_64)' }).stdout.trim(), '');
  assert.equal(runCase(['host_glibc'], {}).stdout.trim(), '', 'neither getconf nor ldd present');
});

test('glibc_older_than compares numerically, and an unreadable version is NOT older', () => {
  const older = (v, maj, min) => runCase(['older', String(maj), String(min)], { glibc: `glibc ${v}` }).stdout.trim();
  assert.equal(older('2.17', 2, 28), 'OLDER', 'CentOS 7 — the motivating host');
  assert.equal(older('2.17', 2, 25), 'OLDER');
  // Lexicographic comparison would call 2.9 newer than 2.28. It is not.
  assert.equal(older('2.9', 2, 28), 'OLDER');
  assert.equal(older('2.28', 2, 28), 'NOT_OLDER', 'the threshold itself is new enough');
  assert.equal(older('2.44', 2, 28), 'NOT_OLDER');
  assert.equal(older('3.0', 2, 28), 'NOT_OLDER');
  assert.equal(older('2.28.1', 2, 28), 'NOT_OLDER', 'a patch component does not confuse the minor');
  assert.equal(runCase(['older', '2', '28'], {}).stdout.trim(), 'NOT_OLDER', 'unreadable ⇒ healthy');
});

// ── node_lts_version: which release actually HAS the glibc-217 build ──────────

test('node_lts_version picks the newest LTS that ships the requested variant', () => {
  // The fixtures encode the real trap: nodejs.org marks LTS (column 10) and
  // unofficial-builds does not, while unofficial-builds' own `files` column says
  // which versions have the build. Newest LTS is v24.21.0, which has NO
  // glibc-217 build; v25.0.0 HAS one but is not LTS. The answer is v24.20.0.
  assert.equal(runCase(['lts', 'linux-x64-glibc-217'], {}).stdout.trim(), 'v24.20.0');
  // The official variant takes the newest LTS unconditionally, off nodejs.org.
  assert.equal(runCase(['lts', 'linux-x64'], {}).stdout.trim(), 'v24.21.0');
  assert.equal(runCase(['lts', 'darwin-arm64'], {}).stdout.trim(), 'v24.21.0');
});

// ── fetch_node: which BASE and which VARIANT, captured as the URL ─────────────
//
// The `FETCH <url>` line is the first fetch fetch_node performs (the tarball), so
// one string carries the base URL, the variant, and the filename it asks for.

const fetchedUrl = (res) => (/^FETCH (\S+)$/m.exec(res.stderr) ?? [])[1] ?? null;

test('an old-glibc x86_64 host is sent to unofficial-builds for the glibc-217 build', () => {
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17' });
  assert.equal(
    fetchedUrl(res),
    'https://unofficial-builds.nodejs.org/download/release/v24.20.0/node-v24.20.0-linux-x64-glibc-217.tar.gz',
  );
  assert.match(res.stderr, /^WARN .*glibc is 2\.17.*linux-x64-glibc-217.*unofficial-builds\.nodejs\.org/m);
});

test('a healthy host is unchanged: nodejs.org, the plain variant, no glibc warning', () => {
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.44' });
  assert.equal(fetchedUrl(res), 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz');
  assert.doesNotMatch(res.stderr, /WARN/, 'nothing about glibc is printed on a healthy host');
});

test('a host whose glibc cannot be read is treated as healthy, not as old', () => {
  const res = runCase(['fetch_node'], {});
  assert.equal(fetchedUrl(res), 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz');
});

test('arm64 below the line STOPS, naming the cause and the remedy, and downloads nothing', () => {
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17', unameM: 'aarch64' });
  assert.equal(res.rc, 1);
  assert.equal(fetchedUrl(res), null, 'no download may be attempted on a host with no build to fetch');
  assert.match(res.stderr, /^DIE /m);
  assert.match(res.stderr, /glibc is 2\.17/, 'the real cause, not "its C library may be too old"');
  assert.match(res.stderr, /x86_64 only/);
  assert.match(res.stderr, /aarch64/, 'and the architecture that has nothing to download');
});

test('the old-glibc gate is linux-only: macOS arm64 still gets its own official build', () => {
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17', unameS: 'Darwin', unameM: 'arm64' });
  assert.equal(fetchedUrl(res), 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz');
});

test('an architecture with no Node build at all is refused before any fetch', () => {
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17', unameM: 'i686' });
  assert.equal(res.rc, 1);
  assert.equal(fetchedUrl(res), null);
  assert.match(res.stderr, /No automatic Node\.js download for i686/);
});

// ── negatives: the guards above are the things doing the work ─────────────────

test('negative: removing the arm64 guard makes the arm64 case download instead of stopping', () => {
  // Proof that the assertion above fails for its intended reason. With the one
  // `[ "$arch" = x64 ] || die …` line deleted, the same arm64 host walks on into
  // the unofficial base with an arm64 variant that does not exist there.
  const mutate = (s) => {
    const out = s.replace(/^\s*\[ "\$arch" = x64 \] \|\| die .*$/m, '    :');
    assert.notEqual(out, s, 'precondition: the arm64 guard line was located in install.sh');
    return out;
  };
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17', unameM: 'aarch64', mutate });
  assert.notEqual(fetchedUrl(res), null, 'without the guard, an arm64 host reaches a download');
  assert.match(String(fetchedUrl(res)), /unofficial-builds\.nodejs\.org/);
});

test('negative: removing the glibc gate sends an old host to a Node it cannot run', () => {
  const mutate = (s) => {
    const out = s.replace(/^  if \[ "\$os" = linux \] && glibc_older_than 2 28; then$/m, '  if false; then');
    assert.notEqual(out, s, 'precondition: the glibc gate was located in install.sh');
    return out;
  };
  const res = runCase(['fetch_node'], { glibc: 'glibc 2.17', mutate });
  assert.equal(fetchedUrl(res), 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz');
});

test('negative: the extractor throws on a renamed function rather than composing an empty harness', () => {
  assert.throws(() => shFunction(SH, 'no_such_function'), /no function no_such_function/);
  assert.throws(() => shFunction('host_glibc() {\n  local v=\n', 'host_glibc'), /not terminated/);
  assert.throws(() => shAssignment(SH, 'NO_SUCH_VAR'), /no top-level assignment/);
});
