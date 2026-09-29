#!/usr/bin/env node
// Installer step (Linux): give Chromium the system libraries it needs, WITHOUT root.
//
// Measured 2026-09-26 on a Debian server: the bundled Chromium downloaded fine and
// then exited 127 on launch, "libnspr4.so: cannot open shared object file". The
// usual fix, `sudo npx playwright install-deps`, needs root, and this installer
// must work on hosts where the user has none. So the missing packages are fetched
// and unpacked as the user — on an apt host, from apt:
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
// A host whose own C library is older than Chromium needs cannot be fixed that way
// at all. Measured 2026-09-29 on CentOS 7 (glibc 2.17): every Playwright Chromium
// build wants GLIBC_2.25, and dies with `symbol __cxa_thread_atexit_impl, version
// GLIBC_2.18 not defined` even once every X/GTK/NSS library is present. Below the
// 2.25 line this takes a different path, and does not touch apt:
//
//   1. An EL8 glibc 2.28 (plus its libstdc++ and libgcc, because EL8 libraries
//      want a newer GLIBCXX than gcc-4.8's 3.4.19) becomes a PRIVATE runtime in
//      ~/.cache/playwright-mcp/glibc — only ever on a browser's library path,
//      never on this process's, so the server's own Node keeps the system libc.
//   2. patchelf — a pinned static release binary, which runs on glibc 2.17 itself —
//      repoints every Chromium executable's ELF interpreter and rpath at it.
//   3. The missing system libraries come from the SAME EL8 repositories, so they
//      are ABI-consistent with the private glibc they will run against, and land
//      in the same sysroot the apt path uses.
//   4. The check is `<private loader> --list`, never `ldd`: the system ldd traces
//      with this host's own 2.17 loader and reports nonsense for a patched binary.
//
// Everything fetched is sha256-verified before it is used, and everything lands
// under the user's cache: no sudo, no root, nothing system-wide, on either path.
// A host that is neither an apt host nor an old-glibc one still fails loudly with
// the missing libraries named.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { chromium } from 'playwright';

import {
  CHROMIUM_MIN_GLIBC,
  glibcDir,
  glibcOlderThan,
  privateLoaderPath,
  sysrootDir,
  sysrootLibDirs,
} from '../dist/stealth.js';

if (process.platform !== 'linux') process.exit(0);

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = sysrootDir();
const CACHE = path.dirname(ROOT);
const APT = path.join(CACHE, 'apt');
const GLIBC = glibcDir();
/**
 * Never unpacked into the SYSROOT, whatever a resolver says — apt names and their
 * EL8 equivalents: shadowing the C library or the C++ runtime of every process
 * that inherits this environment breaks the tools the installer itself re-runs
 * with. On an old-glibc host the EL8 three go into the private runtime below
 * instead, which only a browser launch ever sees.
 */
const NEVER = new Set(['libc6', 'libc-bin', 'libgcc-s1', 'libstdc++6', 'glibc', 'glibc-common', 'libgcc', 'libstdc++']);

/**
 * One pinned, frozen source family for everything the old-glibc path fetches.
 * AlmaLinux's vault holds released minors unchanged, so repomd.xml's sha256 never
 * moves — and that one hash is where trust starts: repomd.xml names primary.xml's
 * sha256, and primary.xml carries a pkgid sha256 for every RPM in the repository.
 * So pinning two hashes covers every package this ever downloads. A mirror that
 * changes under us fails the comparison and stops the install; it never falls back
 * to unverified content.
 */
const EL8 = {
  release: '8.9',
  repos: [
    {
      id: 'BaseOS',
      base: 'https://vault.almalinux.org/8.9/BaseOS/x86_64/os',
      repomd: 'dbc5a30997eae8efd5571cd10721874edc51e08a9b201dc5a2a93c214aabca7b',
    },
    {
      id: 'AppStream',
      base: 'https://vault.almalinux.org/8.9/AppStream/x86_64/os',
      repomd: 'ce390a8baea499174fe1338be9d2af589a71989222c1a31eacc1dcc64e125f24',
    },
  ],
};

/** The EL8 packages that make up the private runtime, in the order they unpack. */
const RUNTIME_PACKAGES = ['glibc', 'libstdc++', 'libgcc'];

/**
 * Which EL8 release an existing private runtime was built from. `glibcDir()` has no
 * release in its path, so without this a bump of EL8.release would leave an old
 * runtime in place forever: the loader is there, so nothing would rebuild it. This
 * answers "which release is this runtime", which is a different question from
 * stealth.ts's "is this host still old" — both exist, neither replaces the other.
 */
const RELEASE_STAMP = '.el8-release';

/**
 * patchelf as a pinned static release binary. Verified 2026-09-29 to run on
 * CentOS 7's own glibc 2.17, so it needs no private runtime to do its job — which
 * is what makes the chicken-and-egg go away. `uvx --from patchelf` works on a
 * developer box but assumes uv; the target host has none.
 */
const PATCHELF = {
  url: 'https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0-x86_64.tar.gz',
  sha256: 'ce84f2447fb7a8679e58bc54a20dc2b01b37b5802e12c57eece772a6f14bf3f0',
  member: 'bin/patchelf',
};

function binaries() {
  const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry;
  const shell = registry.findExecutable('chromium-headless-shell')?.executablePath();
  return [chromium.executablePath(), shell].filter((b) => b && fs.existsSync(b));
}

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

function fail(msg, libs) {
  console.error(msg);
  if (libs?.length) console.error(`Missing libraries: ${libs.join(' ')}`);
  process.exit(1);
}

/**
 * The glibc this process is running against, e.g. `'2.17'`, for the MESSAGES below.
 * The threshold and the comparison are not restated here — `CHROMIUM_MIN_GLIBC` and
 * `glibcOlderThan` are imported from stealth.ts, so the installer and the launch
 * path can never disagree about the number. Same source as theirs: Node's own
 * process report. `undefined` where there is none to read (musl), which the
 * imported predicate treats as new enough.
 */
function runtimeGlibc() {
  try {
    return process.report?.getReport()?.header?.glibcVersionRuntime;
  } catch {
    return undefined;
  }
}

// ── The apt path (unchanged: this is what a healthy host has always done) ──────

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

function provisionWithApt(bins, before) {
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

  writeFontsConf();

  const after = missingLibs(bins);
  if (after.length) fail('Some libraries are still missing after unpacking the packages.', after);
}

/**
 * Fonts from the sysroot are invisible to a host fontconfig that does not know
 * the dir, and a host with no fontconfig at all has no config to read. Point
 * fontconfig at both the system and sysroot font dirs (stealth.ts sets
 * FONTCONFIG_FILE only when this file exists).
 */
function writeFontsConf() {
  if (fs.existsSync('/etc/fonts/fonts.conf') || !fs.existsSync(path.join(ROOT, 'usr/share/fonts'))) return;
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

// ── Pinned downloads ──────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchPinned(url, want) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`checksum mismatch for ${url}\n  expected ${want}\n  got      ${got}`);
  return buf;
}

/** fetchPinned, but a file already in the cache that still hashes right is reused. */
async function pinnedFile(url, want, cachePath) {
  if (fs.existsSync(cachePath)) {
    const have = fs.readFileSync(cachePath);
    if (sha256(have) === want) return have;
  }
  const buf = await fetchPinned(url, want);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, buf);
  return buf;
}

// ── EL8 package metadata: soname → RPM, with a sha256 for every RPM ────────────

/** rpm's own version ordering: numeric runs compare as numbers, digits beat letters. */
function vercmp(a, b) {
  const left = a.match(/\d+|[A-Za-z]+/g) ?? [];
  const right = b.match(/\d+|[A-Za-z]+/g) ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = BigInt(x) - BigInt(y);
      if (d !== 0n) return d < 0n ? -1 : 1;
    } else if (nx !== ny) return nx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Index one repository's primary.xml by 64-bit soname and by `pkg:<name>`, keeping
 * the newest version of each. Only x86_64 and noarch packages, and only provides
 * entries carrying the `()(64bit)` marker — the i686 half of the repository
 * advertises the very same sonames without it, and unpacking a 32-bit library
 * would look resolved to a parser and be useless to a 64-bit browser.
 */
function addPackages(index, xml, repo) {
  for (const block of xml.split('</package>')) {
    if (!/<arch>(?:x86_64|noarch)<\/arch>/.test(block)) continue;
    const name = /<name>([^<]+)<\/name>/.exec(block)?.[1];
    const href = /<location href="([^"]+)"/.exec(block)?.[1];
    const sum = /<checksum type="sha256" pkgid="YES">([0-9a-f]{64})</.exec(block)?.[1];
    const v = /<version epoch="(\d+)" ver="([^"]*)" rel="([^"]*)"/.exec(block);
    if (!name || !href || !sum || !v) continue;
    const entry = { name, href, sum, repo: repo.id, base: repo.base, evr: `${v[1]}:${v[2]}-${v[3]}` };
    const keys = [`pkg:${name}`];
    const provides = /<rpm:provides>([\s\S]*?)<\/rpm:provides>/.exec(block)?.[1] ?? '';
    for (const m of provides.matchAll(/<rpm:entry name="([^"]*\.so[^"]*)\(\)\(64bit\)"/g)) keys.push(m[1]);
    for (const key of keys) {
      const cur = index.get(key);
      if (!cur || vercmp(cur.evr, entry.evr) < 0) index.set(key, entry);
    }
  }
}

async function el8Index() {
  const cache = path.join(CACHE, 'el8', EL8.release);
  const index = new Map();
  for (const repo of EL8.repos) {
    const repomd = (
      await pinnedFile(`${repo.base}/repodata/repomd.xml`, repo.repomd, path.join(cache, `${repo.id}-repomd.xml`))
    ).toString('utf8');
    const primary = /<data type="primary">([\s\S]*?)<\/data>/.exec(repomd)?.[1];
    const sum = primary && /<checksum type="sha256">([0-9a-f]{64})</.exec(primary)?.[1];
    const href = primary && /<location href="([^"]+)"/.exec(primary)?.[1];
    if (!sum || !href) throw new Error(`AlmaLinux ${EL8.release} ${repo.id} repomd.xml names no primary metadata.`);
    const gz = await pinnedFile(`${repo.base}/${href}`, sum, path.join(cache, `${sum}-primary.xml.gz`));
    addPackages(index, zlib.gunzipSync(gz).toString('utf8'), repo);
    console.log(`EL8 ${EL8.release} ${repo.id} metadata verified (repomd sha256 ${repo.repomd.slice(0, 16)}…).`);
  }
  return index;
}

/** Download one RPM against the sha256 its repository's metadata declares, and unpack it under `dest`. */
async function unpackRpm(entry, dest) {
  const buf = await fetchPinned(`${entry.base}/${entry.href}`, entry.sum);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-rpm-'));
  try {
    const rpm = path.join(tmp, path.basename(entry.href));
    fs.writeFileSync(rpm, buf);
    fs.mkdirSync(dest, { recursive: true });
    // rpm2cpio and cpio are both base CentOS 7; neither needs root to unpack into
    // a directory the user owns, and neither consults the rpm database.
    const r = spawnSync('sh', ['-c', 'rpm2cpio "$1" | cpio -idmu --quiet', 'sh', rpm], { cwd: dest, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not unpack ${path.basename(entry.href)}:\n${r.stderr || r.stdout}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── The private glibc runtime ──────────────────────────────────────────────────

/** An ELF64 file's PT_INTERP, or undefined when it has none (a library, or not ELF). */
function readInterp(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 64) return undefined;
    if (head.readUInt32BE(0) !== 0x7f454c46 || head[4] !== 2 || head[5] !== 1) return undefined; // ELF64, little-endian
    const phoff = Number(head.readBigUInt64LE(32));
    const phentsize = head.readUInt16LE(54);
    const phnum = head.readUInt16LE(56);
    if (!phentsize || !phnum) return undefined;
    const table = Buffer.alloc(phentsize * phnum);
    fs.readSync(fd, table, 0, table.length, phoff);
    for (let i = 0; i < phnum; i++) {
      const at = i * phentsize;
      if (table.readUInt32LE(at) !== 3) continue; // PT_INTERP
      const offset = Number(table.readBigUInt64LE(at + 8));
      const size = Number(table.readBigUInt64LE(at + 32));
      if (!size) return undefined;
      const interp = Buffer.alloc(size);
      fs.readSync(fd, interp, 0, size, offset);
      return interp.toString('latin1').replace(/\0[\s\S]*$/, '');
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function ensurePatchelf() {
  const bin = path.join(CACHE, 'patchelf', 'patchelf');
  if (fs.existsSync(bin) && spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return bin;
  const tgz = await pinnedFile(PATCHELF.url, PATCHELF.sha256, path.join(CACHE, 'patchelf', path.basename(PATCHELF.url)));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwmcp-patchelf-'));
  try {
    const archive = path.join(tmp, 'patchelf.tar.gz');
    fs.writeFileSync(archive, tgz);
    // The whole archive, not just the one member: its entries are named "./bin/…",
    // so asking tar for "bin/patchelf" by name finds nothing.
    execFileSync('tar', ['-xzf', archive, '-C', tmp]);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.copyFileSync(path.join(tmp, PATCHELF.member), bin);
    fs.chmodSync(bin, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`the pinned patchelf does not run on this host:\n${version.stderr}`);
  console.log(`${(version.stdout ?? '').trim()} verified (sha256 ${PATCHELF.sha256.slice(0, 16)}…) and cached in ${path.dirname(bin)}.`);
  return bin;
}

/** Copy one library entry — file or symlink — into the flat private runtime dir. */
function copyInto(dir, from, name) {
  const to = path.join(dir, name);
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
  } else if (st.isFile()) {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, st.mode & 0o777);
  }
}

/**
 * Build the private runtime and put its loader in place LAST.
 *
 * The loader's existence is HALF the runtime rule (stealth.ts legacyGlibc(): that
 * file present, AND the running glibc still older than CHROMIUM_MIN_GLIBC) — and it
 * is the half this script writes, so a cache that is half provisioned must never
 * read as provisioned on a host where the other half holds. Everything is
 * staged in a sibling directory and renamed in, with the loader held under a
 * temporary name; the caller renames that one file once the browsers are patched
 * and verified, and gets the temporary name back until then.
 */
async function stagePrivateRuntime(index) {
  const staging = `${GLIBC}.staging-${process.pid}`;
  const unpacked = path.join(staging, 'rpm');
  // Any staging dir at all is debris from a run that died mid-build — this one's
  // included, on a pid that got reused. Leaving them would grow the cache silently.
  const base = path.basename(GLIBC);
  for (const e of fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : [])
    if (e.startsWith(`${base}.staging-`)) fs.rmSync(path.join(CACHE, e), { recursive: true, force: true });
  fs.mkdirSync(unpacked, { recursive: true });
  const names = [];
  for (const pkg of RUNTIME_PACKAGES) {
    const entry = index.get(`pkg:${pkg}`);
    if (!entry) throw new Error(`AlmaLinux ${EL8.release} has no package named ${pkg}.`);
    await unpackRpm(entry, unpacked);
    names.push(path.basename(entry.href).replace(/\.rpm$/, ''));
  }
  // EL8 puts the loader and libc in /lib64 and the C++ runtime in /usr/lib64;
  // flatten both, symlinks included, since every one of them points at a sibling.
  for (const dir of ['lib64', 'usr/lib64']) {
    const from = path.join(unpacked, dir);
    if (!fs.existsSync(from)) continue;
    for (const e of fs.readdirSync(from, { withFileTypes: true }))
      if (!e.isDirectory()) copyInto(staging, path.join(from, e.name), e.name);
  }
  fs.rmSync(unpacked, { recursive: true, force: true });

  fs.writeFileSync(path.join(staging, RELEASE_STAMP), `${EL8.release}\n`);

  const loaderName = path.basename(privateLoaderPath());
  const staged = path.join(staging, loaderName);
  if (!fs.existsSync(staged)) throw new Error(`the EL8 glibc package carried no ${loaderName}.`);
  const incoming = path.join(GLIBC, `.incoming-${loaderName}`);
  fs.renameSync(staged, path.join(staging, path.basename(incoming)));
  fs.rmSync(GLIBC, { recursive: true, force: true });
  fs.renameSync(staging, GLIBC);
  console.log(`Private glibc runtime in ${GLIBC}: ${names.join(', ')} (each sha256-verified).`);
  return incoming;
}

/**
 * Repoint every Chromium executable at the private loader. Which files those are
 * is read off the binaries themselves — anything in a browser directory carrying a
 * PT_INTERP — rather than assumed: `chrome` is not the only one (`chrome_sandbox`
 * and `chrome_crashpad_handler` are executables too), and a future build that adds
 * another gets patched without this list being edited.
 *
 * The rpath keeps whatever the build already had and gains the private dir in
 * front. The dir must ALSO be on LD_LIBRARY_PATH at launch, which is
 * browserGlibcEnv()'s job: rpath alone leaves the system's own librt.so.1 to be
 * pulled in transitively, which fails with `undefined symbol: __clock_nanosleep,
 * version GLIBC_PRIVATE` (measured on CentOS 7, 2026-09-29).
 */
function patchBrowsers(patchelf, bins) {
  const want = privateLoaderPath();
  const targets = [];
  for (const bin of bins) {
    const dir = path.dirname(bin);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const file = path.join(dir, e.name);
      // Already pointing at the private loader: a re-run has nothing to do. An
      // unpatched binary beside an existing private runtime is the case that
      // matters — `npx playwright install chromium` runs BEFORE this step on every
      // install, so a Playwright bump re-downloads pristine binaries into a cache
      // whose loader is still there.
      const interp = readInterp(file);
      if (interp && interp !== want) targets.push(file);
    }
  }
  if (!targets.length) {
    console.log('Chromium executables already run on the private glibc.');
    return;
  }
  for (const file of targets) {
    const rpath = (spawnSync(patchelf, ['--print-rpath', file], { encoding: 'utf8' }).stdout ?? '').trim();
    const dirs = [GLIBC, ...rpath.split(':').filter(Boolean)];
    if (!dirs.includes('$ORIGIN')) dirs.push('$ORIGIN');
    execFileSync(patchelf, ['--set-interpreter', want, '--set-rpath', dirs.join(':'), file]);
  }
  const plural = targets.length === 1 ? 'executable' : 'executables';
  console.log(`Patched ${targets.length} Chromium ${plural} onto ${want}: ${targets.map((f) => path.basename(f)).join(', ')}.`);
}

// ── The old-glibc path ────────────────────────────────────────────────────────

/**
 * What the patched binaries still cannot load, asked of the PRIVATE loader.
 *
 * `ldd` is the wrong tool here twice over: it traces with this host's own 2.17
 * loader, which reports nonsense for a binary whose interpreter is a 2.28 one, and
 * its "=> not found" lines are blind to the other half of the problem — a library
 * that IS present and too old. That half is the majority of the work on an EL7
 * host: EL8's libpng16 wants ZLIB_1.2.9 and CentOS 7's libz is 1.2.7, so the
 * loader finds /lib64/libz.so.1, loads it, and fails on a symbol version. The
 * remedy is the same fetch as a missing soname — the EL8 build of libz.so.1, in
 * front of the system one — so both kinds of line become `wanted` here. Only a
 * complaint about a file THIS script already provided is unfixable, because there
 * is nothing newer left to get; those are `fatal`.
 *
 * The loader is asked for its trace mode the way ldd asks its own — through
 * LD_TRACE_LOADED_OBJECTS and LD_WARN — and not with `--list`, which stops at the
 * FIRST library it cannot resolve (measured: rc=127 and one line about
 * libatk-1.0.so.0, where trace mode named all thirteen). Trace mode never runs the
 * program; the loader reports what it would load and exits.
 */
function unmetLibraries(loader, bins) {
  const libPath = [GLIBC, ...sysrootLibDirs(ROOT)].join(':');
  const trace = { ...process.env, LD_LIBRARY_PATH: libPath, LD_TRACE_LOADED_OBJECTS: '1', LD_WARN: 'yes' };
  const wanted = new Set();
  const fatal = new Set();
  for (const bin of bins) {
    const r = spawnSync(loader, [bin], { env: trace, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    for (const m of out.matchAll(/^\s*(\S+) => not found/gm)) wanted.add(m[1]);
    for (const line of out.split('\n')) {
      // "weak version `GLIBC_2.25' not found" lines do not match, and are benign:
      // a weak reference the private glibc 2.28 satisfies anyway.
      const m = /^\S+: (\/\S+): version `[^']+' not found/.exec(line.trim());
      if (!m) continue;
      if (m[1].startsWith(`${GLIBC}/`) || m[1].startsWith(`${ROOT}/`)) fatal.add(line.trim());
      else wanted.add(path.basename(m[1]));
    }
  }
  return { wanted: [...wanted].sort(), fatal: [...fatal] };
}

/**
 * EL8 ships a few libraries in /lib64 rather than /usr/lib64, and the launch path
 * (sysrootLibDirs, in dist/stealth.js) looks at usr/lib64 and usr/lib. Move them
 * where the launch path looks instead of teaching two modules the same layout.
 */
function normalizeSysroot() {
  const stray = path.join(ROOT, 'lib64');
  if (!fs.existsSync(stray)) return;
  const into = path.join(ROOT, 'usr/lib64');
  fs.mkdirSync(into, { recursive: true });
  for (const e of fs.readdirSync(stray, { withFileTypes: true })) {
    const from = path.join(stray, e.name);
    const to = path.join(into, e.name);
    if (!fs.existsSync(to)) fs.renameSync(from, to);
    else fs.rmSync(from, { recursive: true, force: true });
  }
  fs.rmSync(stray, { recursive: true, force: true });
}

async function provisionOldGlibc(bins) {
  const version = runtimeGlibc() ?? 'unreadable';
  if (process.arch !== 'x64')
    fail(
      `This host's glibc is ${version}, older than the GLIBC_${CHROMIUM_MIN_GLIBC.join('.')} every Playwright ` +
        `Chromium build needs, and the private runtime that works around that is built from EL8 x86_64 packages — ` +
        `there is none for ${process.arch}. Chromium cannot run on this host.`,
    );
  for (const tool of ['rpm2cpio', 'cpio', 'tar']) if (!has(tool)) fail(`This host has no ${tool}, which unpacking the private runtime needs.`);

  console.log(
    `This host's glibc is ${version}; Chromium needs GLIBC_${CHROMIUM_MIN_GLIBC.join('.')}. ` +
      `Building a private runtime in ${GLIBC} from AlmaLinux ${EL8.release} packages (no root needed)…`,
  );
  const index = await el8Index();
  const patchelf = await ensurePatchelf();

  // A runtime already in place is left alone — unless it was built from a different
  // EL8 release than this file now pins, in which case the sysroot's libraries go
  // too, so the browser never mixes a 8.9 libc with 8.10 libraries. Only the loader's
  // NAME differs between the two cases; patchBrowsers and the checks below are
  // identical either way.
  const stamp = path.join(GLIBC, RELEASE_STAMP);
  const built = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : undefined;
  let loader = privateLoaderPath();
  let incoming;
  if (fs.existsSync(loader) && built === EL8.release) {
    console.log(`Private glibc runtime already in ${GLIBC} (AlmaLinux ${built}).`);
  } else {
    if (fs.existsSync(loader)) {
      console.log(
        `The private runtime in ${GLIBC} was built from AlmaLinux ${built ?? 'an unrecorded release'}, ` +
          `not ${EL8.release}; rebuilding it and re-fetching its libraries.`,
      );
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
    loader = incoming = await stagePrivateRuntime(index);
  }

  patchBrowsers(patchelf, bins);

  // Each unpack can reveal the next layer of the dependency closure (Chromium wants
  // libpango, which wants libthai, which wants libdatrie), so this iterates until
  // the loader is satisfied rather than resolving a hand-kept list of packages.
  for (let round = 1; ; round++) {
    const { wanted, fatal } = unmetLibraries(loader, bins);
    if (fatal.length)
      fail(`The private runtime in ${GLIBC} cannot satisfy the browser:\n  ${fatal.join('\n  ')}`);
    if (!wanted.length) break;
    if (round > 10) fail(`Still short of libraries after ${round - 1} rounds of unpacking EL8 packages.`, wanted);
    const packages = new Map();
    const unresolved = [];
    for (const soname of wanted) {
      const entry = index.get(soname);
      if (!entry || NEVER.has(entry.name)) unresolved.push(soname);
      else packages.set(entry.href, entry);
    }
    if (!packages.size)
      fail(`No AlmaLinux ${EL8.release} package provides what Chromium is still missing.`, unresolved);
    console.log(
      `Fetching ${packages.size} EL8 packages for ${wanted.length - unresolved.length} libraries into ${ROOT}…`,
    );
    for (const entry of packages.values()) await unpackRpm(entry, ROOT);
    normalizeSysroot();
    console.log(`Unpacked ${packages.size} packages: ${[...packages.values()].map((e) => e.name).join(' ')}.`);
  }

  writeFontsConf();
  // The loader appears only now, with every executable patched and every library
  // resolved: this rename is what makes legacyGlibc() answer true on a host whose
  // glibc is still below CHROMIUM_MIN_GLIBC — which is every host that reaches here —
  // and it now answers true of a cache that actually works.
  if (incoming) fs.renameSync(incoming, privateLoaderPath());
}

/**
 * The host that WAS old and is not any more: someone upgraded the OS, the C1 gates
 * now read healthy, and `~/.cache/playwright-mcp/glibc` is still sitting there with
 * the browser executables still pointing their PT_INTERP into it. That is not inert.
 * stealth.ts's runtime predicate keys on the private loader's presence, so a stale
 * directory would keep every `browser_*` launch unsandboxed and keep an EL8.9 libc in
 * front of a modern browser — on a host that needs neither. And simply deleting the
 * directory is worse: the executables' rpath alone does not carry them (measured on
 * CentOS 7 — the system librt is still pulled in transitively), so they would stop
 * running at all. Both halves have to be undone together.
 *
 * The system loader is read off the Node running this script rather than hardcoded,
 * so this cannot invent a path that does not exist on the host.
 */
async function repairUpgradedHost(bins) {
  const patched = [];
  for (const bin of bins) {
    const dir = path.dirname(bin);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const file = path.join(dir, e.name);
      if (readInterp(file)?.startsWith(`${GLIBC}/`)) patched.push(file);
    }
  }
  if (!patched.length && !fs.existsSync(GLIBC)) return;

  const version = runtimeGlibc() ?? 'new enough';
  console.log(
    `A private glibc runtime from an earlier install is in ${GLIBC}, but this host's glibc is ${version} ` +
      `and does not need it. Removing it and putting ${patched.length} Chromium ` +
      `${patched.length === 1 ? 'executable' : 'executables'} back on the system loader…`,
  );
  if (patched.length) {
    const system = readInterp(process.execPath);
    if (!system) fail(`Cannot tell what this host's ELF interpreter is (${process.execPath} has none), so the browser executables cannot be put back. Delete ${GLIBC} and re-run \`npx playwright install --force chromium\`.`);
    const patchelf = await ensurePatchelf();
    for (const file of patched) {
      const rpath = (spawnSync(patchelf, ['--print-rpath', file], { encoding: 'utf8' }).stdout ?? '').trim();
      const dirs = rpath.split(':').filter((d) => d && d !== GLIBC);
      execFileSync(patchelf, ['--set-interpreter', system, '--set-rpath', dirs.join(':'), file]);
    }
    console.log(`Restored: ${patched.map((f) => path.basename(f)).join(', ')} → ${system}.`);
  }
  fs.rmSync(GLIBC, { recursive: true, force: true });
}

// ── Which path this host takes ────────────────────────────────────────────────

const bins = binaries();
if (!bins.length) fail('No Chromium binary found to check. Did `npx playwright install chromium` run?');

if (glibcOlderThan(CHROMIUM_MIN_GLIBC)) {
  // Below the floor, ldd cannot even tell us what is missing, so there is no
  // "nothing to do" shortcut here — the private runtime is the only way Chromium
  // runs at all, and provisioning is idempotent. A download, a checksum or an
  // unpack that goes wrong is an installer failure with a sentence, not a stack
  // trace: everything it could say is already in the message.
  await provisionOldGlibc(bins).catch((err) => fail(err instanceof Error ? err.message : String(err)));
} else {
  // Healthy: nothing new happens here unless an EARLIER install left a private
  // runtime behind, which is the one thing this branch must not ignore.
  await repairUpgradedHost(bins).catch((err) => fail(err instanceof Error ? err.message : String(err)));
  const before = missingLibs(bins);
  if (before.length) provisionWithApt(bins, before);
}
console.log('Chromium system libraries OK.');
