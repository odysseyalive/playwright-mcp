/**
 * file-roots.ts — where browser_* may read and write files, and which file://
 * pages it may open.
 *
 * Why this module exists (i19, reported 2026-11-25 from a pythom-space session)
 * ---------------------------------------------------------------------------
 * @playwright/mcp has ONE switch for both questions, `allowUnrestrictedFileAccess`,
 * read at exactly two places in the pinned 0.0.75 bundle
 * (playwright-core/lib/coreBundle.js): `checkFile` (:58248), which refuses any
 * `filename`/`paths` argument outside `<cwd>/.playwright-mcp` and the cwd, and
 * `checkUrlAllowed` (:58485), which refuses every `file:` URL handed to
 * browser_navigate or browser_tabs. Off, it cost two things:
 *   - a local HTML file could not be previewed without starting
 *     `python3 -m http.server` first, every time;
 *   - a screenshot could not go to the Claude session scratchpad, so throwaway
 *     PNGs landed in the project and were cleaned out by hand.
 * On, it allows every path on the disk, including /etc/passwd. And upstream's
 * root test is a string prefix on path.resolve(), so a symlink inside the
 * project that points out of it passes even today.
 *
 * So upstream runs with the switch ON (src/upstream.ts), and the check moved
 * here, into the wrapper every surface calls through (src/index.ts). It is by
 * ARGUMENT NAME, not tool name, as outboundUrlArg is: a string `filename`, every
 * entry of `paths`, and any `url` that is a file: URL, on any upstream tool.
 * That covers what screenshot, snapshot, evaluate, console and network save,
 * what file upload and file drop read, and browser_run_code_unsafe's code file,
 * including tools upstream adds later under the same argument names. scripts/test-file-roots.mjs fails when an upstream tool grows a path-like
 * argument under a NEW name, because nothing here would check it.
 *
 * Every path is realpath'd before the test, roots included, so `..` and symlinks
 * are judged by where they land. A file that does not exist yet (a screenshot
 * target) is judged by its deepest existing ancestor; a dangling symlink is
 * refused outright, since writing through it lands wherever it points.
 *
 * What stays: between this check and upstream's own open there is a window in
 * which a path could be swapped for a symlink. This is a guardrail against a
 * model wandering out of its workspace, the same claim upstream makes for its
 * own check, not a sandbox against a hostile local user.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SurfaceTrust } from './index.js';

/** Who and where, injectable so a test can stand in for another uid or tmp dir. */
export interface RootEnv {
  cwd: string;
  uid: number | undefined;
  tmpBases: string[];
  extra: string[];
}

export function currentRootEnv(): RootEnv {
  const extra = (process.env.PLAYWRIGHT_MCP_FILE_ROOTS ?? '')
    .split(path.delimiter)
    .filter((p) => path.isAbsolute(p));
  const tmpBases = [process.env.CLAUDE_CODE_TMPDIR, os.tmpdir(), '/tmp'].filter(
    (p): p is string => !!p && path.isAbsolute(p),
  );
  // cwd is read per call: it is upstream's workspace root (our proxy client
  // declares no MCP roots, so upstream falls back to process.cwd()), and tests chdir.
  return { cwd: process.cwd(), uid: process.getuid?.(), tmpBases: [...new Set(tmpBases)], extra };
}

/**
 * Where a path really lands: realpath of the deepest part that exists, plus the
 * rest. Null when it cannot be judged: a dangling symlink anywhere on the way.
 */
export function realLanding(p: string): string | null {
  let probe = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...rest);
    } catch {
      // A dangling symlink exists (lstat succeeds) yet has no realpath.
      try {
        fs.lstatSync(probe);
        return null;
      } catch {
        /* does not exist: step up */
      }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** @playwright/mcp's own output dir for this cwd (`outputDir` in coreBundle.js :58233), when no outputDir is configured. */
function upstreamOutputDir(cwd: string): string {
  let writable = true;
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  return writable && cwd !== path.parse(cwd).root
    ? path.join(cwd, '.playwright-mcp')
    : path.join(os.tmpdir(), '.playwright-mcp');
}

/**
 * The Claude Code scratchpad parent, `<tmp>/claude-<uid>`, if it is safe to
 * trust: a real directory (not a symlink), owned by this uid, writable by nobody
 * else. Claude Code makes it 0700. Anything else means another user could have
 * planted it, and then nothing under it is ours to write into.
 */
function claudeTmpRoots(env: RootEnv): string[] {
  if (env.uid === undefined) return [];
  const out: string[] = [];
  for (const base of env.tmpBases) {
    const dir = path.join(base, `claude-${env.uid}`);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.uid !== env.uid || (st.mode & 0o022) !== 0) continue;
      out.push(fs.realpathSync(dir));
    } catch {
      /* absent */
    }
  }
  return [...new Set(out)];
}

/**
 * Is `real` inside a session scratchpad: `<claude-uid>/<project-slug>/<session>/scratchpad[/…]`?
 *
 * By SHAPE, not by rebuilding this session's path. The server is spawned with
 * CLAUDE_CODE_SESSION_ID, and on 2026-11-24 it matched the session's scratchpad
 * id. Whether a /clear or a resume moves the session to a new id while this
 * server keeps running was NOT measured; if it does, a pinned id would refuse
 * the very scratchpad the session is told to use, so the rule does not pin it. Nor is the slug rebuilt from the
 * project path: Claude Code turns every non-alphanumeric into `-`
 * (`/home/francis/www/amishwbf.com` → `-home-francis-www-amishwbf-com`), and a
 * rule that guessed it would break on the next path that differs. The shape
 * admits only scratchpads, not the rest of `claude-<uid>`, and that dir is this
 * user's alone (claudeTmpRoots).
 */
function inScratchpad(real: string, env: RootEnv): boolean {
  for (const root of claudeTmpRoots(env)) {
    if (!inside(root, real)) continue;
    const parts = path.relative(root, real).split(path.sep);
    if (parts.length >= 3 && parts[0] && parts[1] && parts[2] === 'scratchpad') return true;
  }
  return false;
}

/** The roots a surface may use, realpath'd. Scratchpad and extra roots are stdio-only. */
export function allowedRoots(trust: SurfaceTrust, env: RootEnv = currentRootEnv()): string[] {
  const roots = [env.cwd, upstreamOutputDir(env.cwd), ...(trust === 'stdio' ? env.extra : [])];
  return [...new Set(roots.map((r) => realLanding(r)).filter((r): r is string => !!r))];
}

/** Why `p` (resolved against the cwd, as upstream resolves it) may not be used, or null if it may. */
export function pathRefusal(p: string, trust: SurfaceTrust, env: RootEnv = currentRootEnv()): string | null {
  const real = realLanding(path.resolve(env.cwd, p));
  const roots = allowedRoots(trust, env);
  const where =
    `Allowed: the project (${roots.join(', ')})` +
    (trust === 'stdio' ? ' and the Claude session scratchpad (<tmp>/claude-<uid>/<project>/<session>/scratchpad).' : '.');
  if (!real) return `File access denied: ${p} is a dangling symlink or cannot be resolved. ${where}`;
  if (roots.some((r) => inside(r, real))) return null;
  if (trust === 'stdio' && inScratchpad(real, env)) return null;
  return `File access denied: ${p} resolves to ${real}, outside the allowed roots. ${where}`;
}

/** The local path a file: URL names, or `view-source:file:` names; undefined for any other URL. */
export function fileUrlPath(url: string): string | null | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  // view-source: wraps any URL, and Chrome renders view-source:file:///etc/passwd
  // happily; upstream's check only looked at the outer scheme, so it never caught it.
  // The inner URL is read off the PARSED form: the parser drops leading spaces and
  // embedded tabs, so slicing the raw string would miss ' view-source:file:…'.
  if (u.protocol === 'view-source:') return fileUrlPath(u.href.slice(u.protocol.length));
  if (u.protocol !== 'file:') return undefined;
  if (u.host && u.host !== 'localhost') return null; // file://server/share: not a local path
  try {
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

/**
 * Why a `url` argument may not be opened, or null. Only file: URLs are judged
 * here; every other URL is the egress and exfil guards' business. file: is
 * stdio-only: on an HTTP surface the client is remote, and a file: page would
 * hand it the host's files, so it stays as blocked there as upstream had it.
 */
export function urlRefusal(url: string, trust: SurfaceTrust, env: RootEnv = currentRootEnv()): string | null {
  const p = fileUrlPath(url);
  if (p === undefined) return null;
  if (trust !== 'stdio') return `Access to "file:" URLs is blocked on the ${trust} surface. Attempted URL: "${url}"`;
  if (p === null) return `Access to "file:" URL refused: "${url}" is not a local path.`;
  const why = pathRefusal(p, trust, env);
  return why && `Access to "file:" URL refused: ${why}`;
}

/** For the page-side guard (src/upstream.ts): may the browser load this file: URL at all? */
export function fileUrlAllowed(url: string): boolean {
  return urlRefusal(url, 'stdio') === null;
}

/** Argument names this module checks on every upstream tool. */
export const PATH_ARGS = ['filename', 'paths'] as const;

/** The first refusal among a call's path and url arguments, or null. */
export function argsRefusal(
  args: Record<string, unknown> | undefined,
  trust: SurfaceTrust,
  env: RootEnv = currentRootEnv(),
): string | null {
  if (!args) return null;
  const paths: unknown[] = [];
  if (typeof args.filename === 'string' && args.filename) paths.push(args.filename);
  if (Array.isArray(args.paths)) paths.push(...args.paths);
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const why = pathRefusal(p, trust, env);
    if (why) return why;
  }
  return typeof args.url === 'string' ? urlRefusal(args.url, trust, env) : null;
}
