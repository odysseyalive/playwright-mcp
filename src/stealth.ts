/**
 * stealth.ts — the anti-detection DISGUISE primitives, shared by every context
 * that must pass as a real person: the web_fetch scraping context (browser.ts)
 * and the authenticated-capture/probe contexts (tools/session.ts).
 *
 * Isolation note: sharing these primitives is NOT "merging" the contexts. The
 * DEC-2026-06-07-authenticated-session-storagestate-artifact isolation rule is
 * about IDENTITY — separate BrowserContext, profile, and cookie jar so authed
 * cookies never ride along with scraping and the scraping profile's fingerprint
 * never bleeds into an authed capture. The disguise *technique* (UA, launch
 * args, webdriver erasure, locale/viewport) is anti-bot hardening, not an
 * identity; every context is entitled to it. web_fetch keeps its own persistent
 * profile; session.ts uses ephemeral contexts — they never share a cookie jar.
 *
 * Stealth is manual only — NO playwright-extra/stealth plugin (it wraps
 * Playwright and is a dedupe/compat hazard against the exact-pinned playwright
 * version). WebGL/canvas spoofing is escalation-only and intentionally absent.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { chromium, type BrowserContextOptions } from 'playwright';

/**
 * Which browser every Playwright launch starts: the REAL Google Chrome
 * (`'chrome'`) when the host has it, else `undefined` — the bundled Chromium the
 * installer downloads. Decided by Playwright's own registry, the exact lookup
 * `channel:'chrome'` performs at launch, so detection and launch cannot disagree
 * (resolveChromePath below is NOT that check: it also accepts a distro
 * /usr/bin/chromium, which `channel:'chrome'` refuses). Measured 2026-09-26 on
 * two no-sudo hosting accounts with no Google Chrome and no way to install it:
 * a hard-coded `channel:'chrome'` left install.sh reporting success and every
 * browser tool dead, while the bundled Chromium launched fine.
 */
function detectChannel(): 'chrome' | undefined {
  const { registry } = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry;
  return registry.findExecutable('chrome')?.executablePath() ? 'chrome' : undefined;
}

export const BROWSER_CHANNEL = detectChannel();

/**
 * Where install.sh unpacks Chromium's system libraries when the host lacks them
 * and the user has no root to install them (scripts/provision-libs.mjs). Plain
 * distro packages, extracted as the user, never installed system-wide.
 */
export function sysrootDir(): string {
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'playwright-mcp', 'sysroot');
}

/** The library dirs inside the sysroot that exist: multiarch, pre-usrmerge, and NSS's own. */
export function sysrootLibDirs(root = sysrootDir()): string[] {
  const dirs: string[] = [];
  for (const base of ['usr/lib', 'lib']) {
    const abs = path.join(root, base);
    if (!fs.existsSync(abs)) continue;
    for (const e of fs.readdirSync(abs))
      if (/-linux-gnu/.test(e)) dirs.push(path.join(abs, e), path.join(abs, e, 'nss'));
  }
  dirs.push(path.join(root, 'usr/lib64'), path.join(root, 'usr/lib'));
  return dirs.filter((d) => fs.existsSync(d));
}

/**
 * Where install.sh puts a PRIVATE glibc, for a host whose own is too old to run
 * Chromium at all: CentOS 7 ships glibc 2.17, while every Playwright Chromium
 * build needs GLIBC_2.25 and dies with
 * `symbol __cxa_thread_atexit_impl, version GLIBC_2.18 not defined`.
 * scripts/provision-libs.mjs unpacks glibc 2.28 here and patchelfs the browser
 * binaries' interpreter and rpath at it — as the user, in the same cache and the
 * same no-root way as the sysroot above, never system-wide.
 */
export function glibcDir(): string {
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'playwright-mcp', 'glibc');
}

/**
 * The private loader inside `glibcDir()`. One spelling of that filename, shared:
 * the installer WRITES this path, every launch site below TESTS it.
 */
export function privateLoaderPath(root = glibcDir()): string {
  return path.join(root, 'ld-linux-x86-64.so.2');
}

/**
 * The oldest glibc a Playwright Chromium build will start on: GLIBC_2.25.
 * Exported so a test asserts against the real threshold, never a retyped one.
 */
export const CHROMIUM_MIN_GLIBC: readonly [number, number] = [2, 25];

/**
 * The glibc THIS PROCESS is running on, e.g. `'2.44'` — Node's own process report
 * carries it, so there is no `getconf` subprocess and no second idea of the
 * number. `undefined` on a host with no glibc to report (musl), a Node that does
 * not report one, or a host where the report cannot be built at all: a throw here
 * would kill the server at import time, and "no answer" means HEALTHY, which is
 * the safe direction (see legacyGlibc). Read once, like detectChromeMajor below:
 * it cannot change while the process lives, and getReport() is not cheap. Only
 * the one header field is kept — the report object it comes in also carries the
 * environment and the command line, and is dropped here.
 */
function readRuntimeGlibc(): string | undefined {
  try {
    return (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
      ?.glibcVersionRuntime;
  } catch {
    return undefined; // no report to read — treat the host as healthy
  }
}

const RUNTIME_GLIBC: string | undefined = readRuntimeGlibc();

/**
 * True when `version` is older than major.minor. UNPARSEABLE MEANS NOT OLDER: a
 * host we cannot read a version from is treated as healthy, because a false
 * "legacy" verdict would strip the sandbox from a browser that was working. The
 * version is a parameter so tests can drive both answers on any host.
 */
export function glibcOlderThan([major, minor]: readonly [number, number], version = RUNTIME_GLIBC): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!m) return false;
  const [have, haveMinor] = [Number(m[1]), Number(m[2])];
  return have < major || (have === major && haveMinor < minor);
}

/**
 * True iff this host's browsers both NEED the private glibc and were patched onto
 * it: the running glibc is older than Chromium can start on, AND the private
 * loader is there. The file's presence is what the installer records and what
 * makes the positive case cheap; the version is what keeps the verdict HONEST
 * when the host moves on underneath it.
 *
 * File presence alone was not enough (security review C-4, 2026-09-29): a host
 * provisioned once and later OS-upgraded keeps its `glibc/` dir forever, and
 * every browser launch would then go on running unsandboxed with an EL8 libc in
 * front of a modern browser. Un-patching a leftover runtime is the installer's
 * half of that fix; this is the half that stops a stale directory disarming the
 * sandbox on its own.
 */
export function legacyGlibc(version = RUNTIME_GLIBC): boolean {
  return (
    process.platform === 'linux' &&
    glibcOlderThan(CHROMIUM_MIN_GLIBC, version) &&
    fs.existsSync(privateLoaderPath())
  );
}

/**
 * Say ONCE, on stderr, that this host's browsers are not what a healthy host
 * runs: no Chromium sandbox, and a frozen private userland instead of the
 * system's. A working install otherwise never mentions it — the only other place
 * the sandbox appears is a FAILURE branch in the installer's check — and a browser
 * that renders untrusted content unsandboxed must not be discoverable only from
 * the source (security review C-2, 2026-09-29). Called from browserGlibcEnv(), so
 * it fires at the first launch on such a host and cannot fire on any other.
 * stderr, never stdout: stdout is the MCP stream.
 */
let noticed = false;
function noteLegacyRuntime(version: string | undefined): void {
  if (noticed) return;
  noticed = true;
  const release = privateRuntimeRelease();
  console.error(
    `[playwright-mcp:stealth] this host's glibc (${version ?? 'unknown'}) is older than Chromium needs, so the ` +
      `browser runs against a frozen AlmaLinux ${release ?? '8'} userland in ${glibcDir()} — not this host's ` +
      `libraries — and WITHOUT Chromium's sandbox. Pages you open are rendered unsandboxed.`,
  );
}

/**
 * Which EL8 release the private runtime was built from, per the stamp the library
 * step leaves beside it (the installer's own notice reads the same file). The
 * exact release is the INSTALLER's fact, not ours: read it, never hardcode it, and
 * say plain "8" when the stamp is absent rather than guess a point release.
 * Sanitised and capped — it is a file under the cache and its content goes
 * straight to a terminal.
 */
function privateRuntimeRelease(): string | undefined {
  try {
    const stamp = fs.readFileSync(path.join(glibcDir(), '.el8-release'), 'utf8');
    return stamp.split('\n', 1)[0].replace(/[^\w.+-]/g, '').slice(0, 20) || undefined;
  } catch {
    return undefined; // no stamp — the notice stands without a release
  }
}

/** The fontconfig file the library step writes beside the sysroot, when it did. */
function sysrootFontsConf(): string | undefined {
  const file = path.join(sysrootDir(), 'fonts.conf');
  return fs.existsSync(file) ? file : undefined;
}

/**
 * The COMPLETE library environment a BROWSER launch needs on a private-glibc
 * host — and `undefined` on every other host, which Playwright treats exactly as
 * "not given". This process's environment, plus, in front of it: the private
 * glibc dir, then the sysroot's dirs.
 *
 * The private dir must be on the path and not merely in the patched rpath:
 * without it the system's own /lib64/librt.so.1 is still pulled in transitively
 * and fails with `undefined symbol: __clock_nanosleep, version GLIBC_PRIVATE`
 * (measured on CentOS 7, 2026-09-29). The sysroot's dirs are here rather than on
 * process.env because on such a host they are EL8 libraries — see useSysroot().
 *
 * Deliberately NOT applied to this process the way useSysroot() applies the
 * sysroot on a healthy host: the server's own Node keeps the SYSTEM loader and
 * the system libc, because putting a foreign libc.so.6 in front of a Node that
 * was linked against the host's would kill the server on the very host this
 * exists to support. These libraries reach the browser through a launch option
 * only — and since Playwright REPLACES the environment rather than merging it,
 * process.env is copied in here.
 *
 * `version` is the same test seam as legacyGlibc()'s.
 */
export function browserGlibcEnv(version = RUNTIME_GLIBC): Record<string, string> | undefined {
  if (!legacyGlibc(version)) return undefined;
  noteLegacyRuntime(version);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.LD_LIBRARY_PATH = [glibcDir(), ...sysrootLibDirs(), process.env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(':');
  const fontsConf = sysrootFontsConf();
  if (!env.FONTCONFIG_FILE && fontsConf) env.FONTCONFIG_FILE = fontsConf;
  return env;
}

/**
 * Put the sysroot's libraries on the path of every browser this process starts.
 * Playwright hands process.env to the browser, so all three launch sites and the
 * installer's check pick it up from here. Runs before detectChromeMajor below,
 * which runs the browser binary too. Only packages the host was MISSING were
 * unpacked, so nothing installed system-wide is shadowed. A fontconfig file is
 * written alongside only when the host had no fontconfig of its own.
 *
 * NOT on a private-glibc host. There the sysroot holds EL8 libraries, built
 * against the private glibc 2.28 — and process.env is inherited by every CHILD
 * PROCESS, not just the browser: `rpm2cpio`, `cpio`, `curl`, `ldd`, `sh`, a
 * subprocess playwright. An EL8 libz or libpcre in front of a CentOS 7 /bin/sh
 * breaks the very tools the installer re-runs with on its second run. So on such
 * a host nothing from the sysroot reaches this process at all, and
 * browserGlibcEnv() carries the same dirs to the browser alone.
 */
function useSysroot(): void {
  if (process.platform !== 'linux' || legacyGlibc()) return;
  const dirs = sysrootLibDirs();
  if (!dirs.length) return;
  const prev = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = [...dirs, ...(prev ? [prev] : [])].join(':');
  const fontsConf = sysrootFontsConf();
  if (!process.env.FONTCONFIG_FILE && fontsConf) process.env.FONTCONFIG_FILE = fontsConf;
}

useSysroot();

/**
 * Resolve the host's REAL Google Chrome executable — the same binary
 * STEALTH_LAUNCH starts (`channel:'chrome'`) and the attach-mode capture spawns.
 * Override with PLAYWRIGHT_MCP_CHROME_PATH. Shared so the UA below and
 * tools/session.ts resolve Chrome identically.
 */
export function resolveChromePath(): string {
  const env = process.env.PLAYWRIGHT_MCP_CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/opt/google/chrome/chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'chrome.exe' : 'google-chrome-stable';
}

/**
 * The host's default Google Chrome user-data-dir — the REAL profile a person
 * browses with. attach-mode capture can ride this profile so an established
 * browser's earned trust (e.g. a Cloudflare `cf_clearance` cookie, real history)
 * carries the capture past a hard bot wall that hard-challenges a fresh profile.
 * Override with PLAYWRIGHT_MCP_CHROME_USER_DATA_DIR.
 */
export function defaultChromeUserDataDir(): string {
  const env = process.env.PLAYWRIGHT_MCP_CHROME_USER_DATA_DIR;
  if (env) return env;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') return `${home}/Library/Application Support/Google/Chrome`;
  if (process.platform === 'win32')
    return `${process.env.LOCALAPPDATA || `${home}\\AppData\\Local`}\\Google\\Chrome\\User Data`;
  return `${home}/.config/google-chrome`;
}

/** OS platform token the real Chrome reports in its UA, keyed off this host. */
const PLATFORM_TOKEN =
  process.platform === 'darwin'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : 'X11; Linux x86_64';

/**
 * Detect the host's installed Chrome MAJOR at startup so the UA can never drift
 * out of lockstep with the browser we actually launch. Chrome's own reduced UA
 * is `<major>.0.0.0`, so the major is all we need for a self-consistent string.
 * A UA that lies about the version (vs `navigator.userAgentData` Client Hints)
 * is a Cloudflare/Turnstile tell — this reads the truth instead of hardcoding it.
 * Runs once at module load (~1 subprocess); falls back to a recent major if the
 * binary can't be queried. NOTE: attach-mode capture uses the plain real Chrome's
 * NATIVE UA and never touches this — this only masks the Playwright-driven path.
 *
 * This RUNS the browser binary, so it is a launch site like any other and takes
 * the private glibc env too: on a patched host without it the binary cannot start
 * at all, the fallback below would take over, and the UA would then lie about the
 * major on precisely the host this supports.
 */
function detectChromeMajor(): number {
  const FALLBACK = 150;
  try {
    // Query the binary we will actually launch: Chrome, or the bundled Chromium.
    const bin = BROWSER_CHANNEL ? resolveChromePath() : chromium.executablePath();
    const out = execFileSync(bin, ['--version'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: browserGlibcEnv(), // undefined ⇒ Node passes process.env, as before
    }).toString();
    const m = out.match(/\b(\d+)\.\d+\.\d+/);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* Chrome not queryable — use the fallback below */
  }
  return FALLBACK;
}

export const CHROME_MAJOR = detectChromeMajor();
export const STEALTH_UA = `Mozilla/5.0 (${PLATFORM_TOKEN}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

export const LOCALE = 'en-US';
export const TIMEZONE = 'America/New_York';
export const VIEWPORT = { width: 1366, height: 768 };

/** Launch args that strip the automation tell. Reused by every launch. */
export const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled'];

/**
 * Launch options for a stealth browser: the REAL installed Google Chrome
 * (`channel:'chrome'`) plus the automation-tell strip. Bundled Chromium is a
 * distinct fingerprint that aggressive bot walls (DataDome, PerimeterX) flag on
 * sight, and a session captured under one engine is re-challenged when replayed
 * under another — so capture (session_login), probe (session_status), and authed
 * read (web_fetch) all launch the same browser the shared scraping context uses.
 * On a host without Google Chrome that browser is the bundled Chromium
 * (BROWSER_CHANNEL): every tool works, and the hardest walls are more likely to
 * challenge it. Spread into chromium.launch().
 */
export const STEALTH_LAUNCH = {
  channel: BROWSER_CHANNEL,
  args: STEALTH_ARGS,
  /**
   * A GETTER, not a value: it is read when this object is SPREAD into a launch,
   * so no snapshot of the environment is ever frozen at module load, and a
   * healthy host spreads `env: undefined` — which Playwright handles as "not
   * given" (`env: options.env ? … : undefined`, coreBundle), so nothing about
   * those launches changes. Every site that spreads STEALTH_LAUNCH (web_fetch,
   * session_login, session_status, the installer's check-browser) therefore picks
   * a patched host's private glibc up from here without knowing about it.
   */
  get env(): Record<string, string> | undefined {
    return browserGlibcEnv();
  },
};

/** addInitScript payload: erase the headless tells before any page script runs. */
export const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5].map((i) => ({ name: 'Plugin ' + i })),
  });
  window.chrome = window.chrome || { runtime: {} };
`;

/**
 * Context options that make a headless context look like a real desktop browser.
 * Spread into newContext()/launchPersistentContext(); merge caller-specific keys
 * (storageState, ignoreHTTPSErrors) alongside.
 */
export const stealthContextOptions: BrowserContextOptions = {
  userAgent: STEALTH_UA,
  locale: LOCALE,
  timezoneId: TIMEZONE,
  viewport: VIEWPORT,
  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
};
