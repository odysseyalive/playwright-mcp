/**
 * movie.ts — the engine behind the movie_* tools: record a scripted walk-through
 * of a GUI (a mock-up or a live local page) as a short captioned video, so a
 * session can show a proposed interface change in motion instead of describing
 * it or pasting one static screenshot.
 *
 * What lives here, and why it is one module:
 *   - the per-job output folder and the saved-script store, under ONE root
 *     (moviesRoot) so a host that only lets screenshots land in one dir can
 *     point PLAYWRIGHT_MCP_MOVIES at it; every path is validated before use;
 *   - a loopback static server, owned by the call, that serves a mock-up from
 *     its own directory (file:// is blocked on some hosts, and nobody should
 *     have to hand-run `python -m http.server`);
 *   - the DOM overlay layer (cursor, click ripple, caption bar, highlight box,
 *     target badge) injected into the page, so captions need no ffmpeg;
 *   - the step runner, which drives a closed vocabulary of actions (no eval, no
 *     upload) against a context created with Playwright's recordVideo;
 *   - the optional ffmpeg/ffprobe pass (mp4, gif, side-by-side, duration).
 *
 * The recorder launches its OWN browser per movie_record call, like web_fetch's
 * authenticated path does, so it never waits on or disturbs the shared browser_*
 * queue (src/queue.ts). recordVideo is fixed when a context is created, which is
 * exactly what a scripted run wants: one context per clip.
 *
 * IMPORTANT: never write to stdout (MCP stdio stream). Log to stderr; child
 * processes get piped stdio, never inherited.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { configDir, ownerOnlyDir, sessionFilePath, secretInventory } from './secrets.js';
import { guardOutbound, sessionAllowsUrl } from './exfil.js';
import { STEALTH_LAUNCH, stealthContextOptions } from './stealth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:movie]', ...args);

// ── limits ────────────────────────────────────────────────────────────────────

/** A clip or encode bigger than this is flagged; it is the claude.ai artifact embed ceiling. */
export const MAX_OUTPUT_BYTES = 15 * 1024 * 1024;
const MAX_STEPS = 60;
const MAX_CLIPS_PER_CALL = 24;
const MAX_TEXT = 400;
const MAX_WAIT_MS = 10_000;
const MAX_HOLD_MS = 5_000;
const DEFAULT_HOLD_MS = 900;
const ACTION_TIMEOUT_MS = 5_000;
const OPTIONAL_PROBE_MS = 1_500;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// ── where things live ─────────────────────────────────────────────────────────

/**
 * Root of everything the movie tools write. Same config base as the sessions and
 * secrets (src/secrets.ts configDir), so one place holds this server's state; the
 * environment override exists because some hosts allow output under one dir only.
 * Operator-only, never a tool argument.
 */
export function moviesRoot(): string {
  return process.env.PLAYWRIGHT_MCP_MOVIES ?? path.join(configDir(), 'movies');
}
const jobsRoot = () => path.join(moviesRoot(), 'jobs');
const scriptsRoot = () => path.join(moviesRoot(), 'scripts');

/** Job ids, script names, labels: a slug, no dots at all, so no `..` and no hidden names. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkSlug(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !SLUG.test(value))
    throw new Error(
      `${kind} must be 1-64 characters of letters, digits, "_" and "-", starting with a letter or digit ` +
        `(got ${JSON.stringify(value)?.slice(0, 80)})`,
    );
  return value;
}

/**
 * Create (if needed) a directory directly under `parent` and prove it is a real
 * directory there: not a symlink, and resolving to a child of the resolved parent.
 * A symlink planted at a job path would otherwise redirect every write (and a
 * later movie_clean) somewhere else.
 */
function realChildDir(parent: string, name: string, create: boolean): string {
  if (create) ownerOnlyDir(parent);
  const dir = path.join(parent, name);
  if (create) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const st = fs.lstatSync(dir); // throws ENOENT for a missing job, which callers turn into a message
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`refusing ${dir}: not a plain directory`);
  if (path.dirname(fs.realpathSync(dir)) !== fs.realpathSync(parent))
    throw new Error(`refusing ${dir}: it resolves outside ${parent}`);
  return dir;
}

export function jobDir(job: string, create = false): string {
  return realChildDir(jobsRoot(), checkSlug('job', job), create);
}

// ── scripts: the closed step vocabulary ───────────────────────────────────────

export const STEP_ACTIONS = ['navigate', 'click', 'type', 'hover', 'press', 'wait', 'scroll'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export interface Step {
  action: StepAction;
  /** Playwright selector (CSS, `text=…`, `role=button[name="…"]`, `[data-testid=…]`). */
  target?: string;
  /** navigate: absolute http(s) URL, or a path resolved against the clip's target. */
  url?: string;
  /** type: the text to type. */
  text?: string;
  /** press: a key name such as Enter, Escape, ArrowDown. */
  key?: string;
  /** wait: milliseconds (when no target). scroll: pixels (when no target). */
  ms?: number;
  dy?: number;
  /** Caption shown from this step on; "" clears it; absent keeps the previous one. */
  caption?: string;
  /** true highlights `target`; a string highlights that selector instead. */
  highlight?: boolean | string;
  highlightStyle?: 'box' | 'spotlight';
  /** Pause after the step so a viewer can read it. */
  holdMs?: number;
  /** Skip the step (with a note) when its target is absent, e.g. in a "before" page. */
  optional?: boolean;
}

const STEP_KEYS = new Set([
  'action', 'target', 'url', 'text', 'key', 'ms', 'dy', 'caption', 'highlight', 'highlightStyle', 'holdMs', 'optional',
]);
const NEEDS_TARGET: ReadonlySet<StepAction> = new Set(['click', 'type', 'hover']);

function str(v: unknown, field: string, i: number, max = MAX_TEXT): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max)
    throw new Error(`step ${i + 1}: ${field} must be a non-empty string of at most ${max} characters`);
  return v;
}
function num(v: unknown, field: string, i: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new Error(`step ${i + 1}: ${field} must be a number from ${min} to ${max}`);
  return v;
}

/** Validate and normalise a step list. Unknown actions or keys are errors, not ignored. */
export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('script must be a non-empty array of steps');
  if (raw.length > MAX_STEPS) throw new Error(`script has ${raw.length} steps; the limit is ${MAX_STEPS}`);
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`step ${i + 1}: must be an object`);
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!STEP_KEYS.has(k)) throw new Error(`step ${i + 1}: unknown field "${k}"`);
    if (!STEP_ACTIONS.includes(o.action as StepAction))
      throw new Error(`step ${i + 1}: action must be one of ${STEP_ACTIONS.join(', ')}`);
    const s: Step = { action: o.action as StepAction };
    if (o.target !== undefined) s.target = str(o.target, 'target', i);
    if (NEEDS_TARGET.has(s.action) && !s.target) throw new Error(`step ${i + 1}: ${s.action} needs a target selector`);
    if (s.action === 'navigate') s.url = str(o.url, 'url', i, 2048);
    if (s.action === 'type') s.text = typeof o.text === 'string' && o.text.length <= MAX_TEXT ? o.text : str(o.text, 'text', i);
    if (s.action === 'press') s.key = str(o.key, 'key', i, 40);
    if (o.ms !== undefined) s.ms = num(o.ms, 'ms', i, 0, MAX_WAIT_MS);
    if (o.dy !== undefined) s.dy = num(o.dy, 'dy', i, -20_000, 20_000);
    if (s.action === 'wait' && s.ms === undefined && !s.target) throw new Error(`step ${i + 1}: wait needs ms or a target`);
    if (s.action === 'scroll' && s.dy === undefined && !s.target) throw new Error(`step ${i + 1}: scroll needs dy or a target`);
    if (o.caption !== undefined) {
      if (typeof o.caption !== 'string' || o.caption.length > MAX_TEXT)
        throw new Error(`step ${i + 1}: caption must be a string of at most ${MAX_TEXT} characters`);
      s.caption = o.caption;
    }
    if (o.highlight !== undefined) {
      if (typeof o.highlight === 'string') s.highlight = str(o.highlight, 'highlight', i);
      else if (typeof o.highlight === 'boolean') s.highlight = o.highlight;
      else throw new Error(`step ${i + 1}: highlight must be true/false or a selector string`);
      if (s.highlight === true && !s.target) throw new Error(`step ${i + 1}: highlight:true needs a target`);
    }
    if (o.highlightStyle !== undefined) {
      if (o.highlightStyle !== 'box' && o.highlightStyle !== 'spotlight')
        throw new Error(`step ${i + 1}: highlightStyle must be "box" or "spotlight"`);
      s.highlightStyle = o.highlightStyle;
    }
    if (o.holdMs !== undefined) s.holdMs = num(o.holdMs, 'holdMs', i, 0, MAX_HOLD_MS);
    if (o.optional !== undefined) {
      if (typeof o.optional !== 'boolean') throw new Error(`step ${i + 1}: optional must be a boolean`);
      s.optional = o.optional;
    }
    return s;
  });
}

export interface SavedScript {
  name: string;
  description?: string;
  steps: Step[];
  savedAt: string;
}

export function saveScript(name: string, steps: unknown, description?: unknown): SavedScript {
  checkSlug('name', name);
  const script: SavedScript = { name, steps: parseSteps(steps), savedAt: new Date().toISOString() };
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > MAX_TEXT)
      throw new Error(`description must be a string of at most ${MAX_TEXT} characters`);
    script.description = description;
  }
  ownerOnlyDir(moviesRoot());
  ownerOnlyDir(scriptsRoot());
  writeFileNoFollow(path.join(scriptsRoot(), `${name}.json`), JSON.stringify(script, null, 2));
  return script;
}

export function loadScript(name: string): SavedScript {
  const file = path.join(scriptsRoot(), `${checkSlug('scriptName', name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`no saved script "${name}" — save it with movie_script_save first`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedScript;
  return { ...parsed, name, steps: parseSteps(parsed.steps) };
}

export function listScripts(): { name: string; description?: string; steps: number; savedAt?: string }[] {
  if (!fs.existsSync(scriptsRoot())) return [];
  const out = [];
  for (const f of fs.readdirSync(scriptsRoot()).sort()) {
    const name = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !SLUG.test(name)) continue;
    try {
      const s = loadScript(name);
      out.push({ name, description: s.description, steps: s.steps.length, savedAt: s.savedAt });
    } catch {
      /* a corrupt file lists as nothing rather than failing the whole listing */
    }
  }
  return out;
}

/** Write a file, refusing to follow a symlink planted at its path. */
function writeFileNoFollow(file: string, data: string | Buffer): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`refusing to write ${file}: it is a symlink`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.writeFileSync(file, data, { mode: 0o600 });
}

// ── viewports and schemes ─────────────────────────────────────────────────────

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile?: boolean;
}

export const VIEWPORT_PRESETS: Record<string, Viewport> = {
  desktop: { name: 'desktop', width: 1280, height: 800 },
  laptop: { name: 'laptop', width: 1024, height: 700 },
  tablet: { name: 'tablet', width: 820, height: 1180, mobile: true },
  phone: { name: 'phone', width: 390, height: 844, mobile: true },
};

export function parseViewports(raw: unknown): Viewport[] {
  if (raw === undefined) return [VIEWPORT_PRESETS.desktop];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('viewports must be a non-empty array');
  return raw.map((v) => {
    if (typeof v === 'string') {
      const preset = VIEWPORT_PRESETS[v];
      if (!preset) throw new Error(`unknown viewport "${v}"; presets: ${Object.keys(VIEWPORT_PRESETS).join(', ')}`);
      return preset;
    }
    const o = (v ?? {}) as Record<string, unknown>;
    const ok = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 240 && n <= 1920;
    if (!ok(o.width) || !ok(o.height)) throw new Error('a custom viewport needs integer width and height from 240 to 1920');
    return {
      name: checkSlug('viewport name', o.name),
      width: o.width as number,
      height: o.height as number,
      mobile: o.mobile === true,
    };
  });
}

export type Scheme = 'light' | 'dark';
export function parseSchemes(raw: unknown): Scheme[] {
  if (raw === undefined) return ['light'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((s) => s !== 'light' && s !== 'dark'))
    throw new Error('schemes must be a non-empty array of "light" and/or "dark"');
  return [...new Set(raw as Scheme[])];
}

// ── targets ───────────────────────────────────────────────────────────────────

export interface TargetSpec {
  label: string;
  url?: string;
  file?: string;
  html?: string;
}

export function parseTargets(raw: unknown): TargetSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('targets must be a non-empty array');
  if (raw.length > 4) throw new Error('at most 4 targets per call');
  const labels = new Set<string>();
  return raw.map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    const label = checkSlug('target label', o.label);
    if (labels.has(label)) throw new Error(`duplicate target label "${label}"`);
    labels.add(label);
    const given = ['url', 'file', 'html'].filter((k) => o[k] !== undefined);
    if (given.length !== 1) throw new Error(`target "${label}" needs exactly one of url, file, html`);
    if (o.url !== undefined) {
      if (typeof o.url !== 'string' || !/^https?:\/\//i.test(o.url)) throw new Error(`target "${label}": url must be http(s)`);
      return { label, url: o.url };
    }
    if (o.file !== undefined) {
      if (typeof o.file !== 'string' || !/\.html?$/i.test(o.file))
        throw new Error(`target "${label}": file must be a path to an .html file`);
      return { label, file: o.file };
    }
    if (typeof o.html !== 'string' || Buffer.byteLength(o.html) > MAX_HTML_BYTES)
      throw new Error(`target "${label}": html must be a string of at most ${MAX_HTML_BYTES} bytes`);
    return { label, html: o.html };
  });
}

// ── loopback static server ────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Map a request path onto a file under `realRoot`, or null. Pure apart from the
 * filesystem reads, so the confinement rules are testable without a browser:
 * no dot-segments or dot-names at all (no `..`, no `.env`, no `.git`), only
 * extensions in MIME, and the RESOLVED file must sit inside the resolved root,
 * so a symlink inside the mock-up dir cannot point the server at another tree.
 */
export function resolveServed(realRoot: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return null;
  if (parts.length === 0) return null;
  const candidate = path.join(realRoot, ...parts);
  if (!MIME[path.extname(candidate).toLowerCase()]) return null;
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + path.sep)) return null;
  // The name checks above saw the REQUESTED path; a symlink inside the root can still
  // resolve to a hidden or unlisted file there (x.png -> .env). Re-check the resolved one.
  if (path.relative(realRoot, real).split(path.sep).some((p) => p.startsWith('.'))) return null;
  if (!MIME[path.extname(real).toLowerCase()]) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}

export interface Served {
  origin: string;
  close: () => Promise<void>;
}

/**
 * Serve one directory on 127.0.0.1 at an ephemeral port for the life of a call.
 * GET/HEAD only, no directory listings, no caching. The root may not be the
 * filesystem root or the home directory itself: a mock-up dropped in ~ would
 * otherwise hand the whole home tree to whatever script the mock-up runs.
 */
export async function serveDir(root: string): Promise<Served> {
  const realRoot = fs.realpathSync(root);
  if (realRoot === path.parse(realRoot).root || realRoot === fs.realpathSync(os.homedir()))
    throw new Error(`refusing to serve ${realRoot}: put the mock-up in its own folder`);
  const server = http.createServer((req, res) => {
    const file = req.method === 'GET' || req.method === 'HEAD' ? resolveServed(realRoot, req.url ?? '/') : null;
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ── the DOM overlay ───────────────────────────────────────────────────────────

/**
 * Injected with addInitScript into every recorded page. Draws, in a closed
 * shadow root on a pointer-events:none layer, the things a viewer needs and a
 * raw recording lacks: a cursor that follows the real mouse, a ripple on each
 * mousedown, a caption bar, a highlight box or spotlight, and a corner badge
 * naming the target ("before", "after"). State is re-applied after every step by
 * the runner, so a navigation that rebuilds the page loses nothing.
 */
const OVERLAY_SCRIPT = `(() => {
  if (window.__pwMovie) return;
  let host, root, cursor, caption, badge, box;
  let state = { x: -100, y: -100, caption: '', badge: '', box: null };
  function build() {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement('pwmovie-overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = \`<style>
      .cur{position:fixed;width:22px;height:22px;margin:-3px 0 0 -3px;transition:transform .05s;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}
      .rip{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #ff3b30;animation:r .55s ease-out forwards}
      @keyframes r{to{transform:scale(3.4);opacity:0}}
      .cap{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:min(92vw,900px);padding:10px 16px;border-radius:10px;
        background:rgba(15,18,25,.88);color:#fff;font:600 17px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;
        box-shadow:0 4px 18px rgba(0,0,0,.35)}
      .bdg{position:fixed;top:10px;right:10px;padding:4px 10px;border-radius:6px;background:#ffcc00;color:#111;
        font:700 13px/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase}
      .box{position:fixed;border:3px solid #ff3b30;border-radius:8px;transition:all .2s}
      .box.spot{border-color:#ffcc00;box-shadow:0 0 0 9999px rgba(0,0,0,.45)}
      [hidden]{display:none}
    </style>
    <div class="box" hidden></div>
    <svg class="cur" viewBox="0 0 24 24"><path d="M3 2l7 19 2.6-7.4L20 11z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>
    <div class="cap" hidden></div><div class="bdg" hidden></div>\`;
    cursor = root.querySelector('.cur'); caption = root.querySelector('.cap');
    badge = root.querySelector('.bdg'); box = root.querySelector('.box');
    document.documentElement.appendChild(host);
    paint();
    return true;
  }
  function paint() {
    if (!build()) return;
    cursor.style.left = state.x + 'px'; cursor.style.top = state.y + 'px';
    caption.textContent = state.caption; caption.hidden = !state.caption;
    badge.textContent = state.badge; badge.hidden = !state.badge;
    const b = state.box;
    box.hidden = !b;
    if (b) {
      const pad = 6;
      box.className = 'box' + (b.style === 'spotlight' ? ' spot' : '');
      box.style.left = (b.x - pad) + 'px'; box.style.top = (b.y - pad) + 'px';
      box.style.width = (b.w + pad * 2) + 'px'; box.style.height = (b.h + pad * 2) + 'px';
    }
  }
  addEventListener('mousemove', (e) => { state.x = e.clientX; state.y = e.clientY; paint(); }, true);
  addEventListener('mousedown', (e) => {
    if (!build()) return;
    const r = document.createElement('div');
    r.className = 'rip'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    root.appendChild(r); setTimeout(() => r.remove(), 700);
  }, true);
  document.addEventListener('DOMContentLoaded', paint);
  window.__pwMovie = { set(s) { state = Object.assign(state, s); paint(); } };
  paint();
})();`;

// ── ffmpeg / ffprobe ──────────────────────────────────────────────────────────

export interface FfmpegCaps {
  ffmpeg?: string;
  ffprobe?: string;
  h264: boolean;
  /** The h264 encoder found: libx264 preferred, else libopenh264 (common where x264 is not shipped). */
  h264Encoder?: string;
  gif: boolean;
  hstack: boolean;
  vp8: boolean;
  /** Why mp4/gif/side-by-side are unavailable, in one sentence, when they are. */
  missing?: string;
}

/**
 * Find a binary on PATH ourselves rather than handing a bare name to execFile:
 * on Windows libuv tries the CURRENT directory first, and this server's cwd is
 * whatever project it was launched in (the same reason src/secrets.ts pins
 * System32 tools to absolute paths).
 */
export function whichSync(name: string, envPath = process.env.PATH ?? ''): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

function run(bin: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${path.basename(bin)} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
        else resolve({ stdout, stderr });
      },
    );
  });
}

/** Parse `ffmpeg -encoders` / `-filters` output into the capabilities the tools use. */
export function parseCaps(encoders: string, filters: string): Pick<FfmpegCaps, 'h264' | 'h264Encoder' | 'gif' | 'hstack' | 'vp8'> {
  const enc = (n: RegExp) => encoders.split('\n').some((l) => n.test(l));
  const h264Encoder = enc(/^\s*V\S*\s+libx264\s/) ? 'libx264' : enc(/^\s*V\S*\s+libopenh264\s/) ? 'libopenh264' : undefined;
  return {
    h264: h264Encoder !== undefined,
    h264Encoder,
    gif: enc(/^\s*V\S*\s+gif\s/),
    vp8: enc(/^\s*V\S*\s+libvpx\s/),
    hstack: filters.split('\n').some((l) => /^\s*\S+\s+hstack\s/.test(l)),
  };
}

let capsMemo: Promise<FfmpegCaps> | undefined;

/**
 * What the local ffmpeg can do. PLAYWRIGHT_MCP_FFMPEG / PLAYWRIGHT_MCP_FFPROBE
 * override the PATH lookup (operator-only). Playwright's bundled ffmpeg is not
 * used: it is built with VP8 and PNG only (no h264, gif or hstack — probed on
 * ffmpeg-1011), so it adds nothing a recording does not already have.
 */
export function ffmpegCaps(): Promise<FfmpegCaps> {
  return (capsMemo ??= (async () => {
    const ffmpeg = process.env.PLAYWRIGHT_MCP_FFMPEG || whichSync('ffmpeg');
    const ffprobe =
      process.env.PLAYWRIGHT_MCP_FFPROBE ||
      (ffmpeg && whichSync('ffprobe', path.dirname(ffmpeg))) ||
      whichSync('ffprobe');
    const none = { h264: false, gif: false, hstack: false, vp8: false };
    if (!ffmpeg) return { ...none, ffprobe, missing: 'no ffmpeg found on PATH (or PLAYWRIGHT_MCP_FFMPEG)' };
    try {
      const [e, f] = await Promise.all([
        run(ffmpeg, ['-hide_banner', '-encoders'], 15_000),
        run(ffmpeg, ['-hide_banner', '-filters'], 15_000),
      ]);
      const caps = parseCaps(e.stdout, f.stdout);
      const lacks = [!caps.h264 && 'an h264 encoder', !caps.gif && 'the gif encoder', !caps.hstack && 'the hstack filter'].filter(Boolean);
      return { ffmpeg, ffprobe, ...caps, missing: lacks.length ? `${ffmpeg} lacks ${lacks.join(', ')}` : undefined };
    } catch (err) {
      return { ...none, ffprobe, missing: `${ffmpeg} did not run (${err instanceof Error ? err.message : err})` };
    }
  })());
}

/** Test seam: forget the probed capabilities (the env may have changed). */
export function resetFfmpegCaps(): void {
  capsMemo = undefined;
}

export async function probeDurationMs(file: string, caps: FfmpegCaps): Promise<number | undefined> {
  if (!caps.ffprobe) return undefined;
  try {
    const { stdout } = await run(caps.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 30_000);
    const s = Number.parseFloat(stdout.trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : undefined;
  } catch {
    return undefined;
  }
}

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

/** Encoder arguments for H.264: libx264 takes a quality target; libopenh264 only a bitrate. */
function h264Args(caps: FfmpegCaps, crf: number): string[] {
  const quality = caps.h264Encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', String(crf)] : ['-b:v', crf > 30 ? '600k' : '1200k'];
  return ['-c:v', caps.h264Encoder!, '-pix_fmt', 'yuv420p', ...quality, '-movflags', '+faststart'];
}

async function toMp4(src: string, dst: string, caps: FfmpegCaps, crf = 28): Promise<void> {
  await run(caps.ffmpeg!, ['-y', '-v', 'error', '-i', src, '-an', '-vf', EVEN, ...h264Args(caps, crf), dst]);
}

async function toGif(src: string, dst: string, caps: FfmpegCaps): Promise<void> {
  await run(caps.ffmpeg!, ['-y', '-v', 'error', '-i', src, '-vf',
    "fps=8,scale='min(640,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    '-loop', '0', dst]);
}

async function sideBySide(left: string, right: string, dst: string, height: number, caps: FfmpegCaps): Promise<void> {
  const h = Math.min(height, 800) - (Math.min(height, 800) % 2);
  const mp4 = dst.endsWith('.mp4');
  await run(caps.ffmpeg!, ['-y', '-v', 'error', '-i', left, '-i', right, '-filter_complex',
    `[0:v]scale=-2:${h},setsar=1[a];[1:v]scale=-2:${h},setsar=1[b];[a][b]hstack=inputs=2:shortest=0,${EVEN}[v]`,
    '-map', '[v]', '-an',
    ...(mp4 ? h264Args(caps, 30) : ['-c:v', 'libvpx', '-b:v', '1M']),
    dst], 300_000);
}

// ── manifest ──────────────────────────────────────────────────────────────────

export interface ClipRecord {
  script: string;
  target: string;
  viewport: string;
  scheme: Scheme;
  webm: string;
  poster?: string;
  mp4?: string;
  gif?: string;
  durationMs?: number;
  durationSource?: 'ffprobe' | 'timed';
  steps: number;
  skipped: string[];
  error?: string;
  recordedAt: string;
}

export interface CompositeRecord {
  script: string;
  viewport: string;
  scheme: Scheme;
  file: string;
  left: string;
  right: string;
  recordedAt: string;
}

export interface Manifest {
  job: string;
  createdAt: string;
  updatedAt: string;
  clips: ClipRecord[];
  composites: CompositeRecord[];
}

const MANIFEST = 'manifest.json';

export function readManifest(dir: string, job: string): Manifest {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as Manifest;
    return { job, createdAt: m.createdAt, updatedAt: m.updatedAt, clips: m.clips ?? [], composites: m.composites ?? [] };
  } catch {
    const now = new Date().toISOString();
    return { job, createdAt: now, updatedAt: now, clips: [], composites: [] };
  }
}

function writeManifest(dir: string, m: Manifest): void {
  m.updatedAt = new Date().toISOString();
  writeFileNoFollow(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));
}

/** Replace any earlier record of the same clip, so a re-run after a mock-up change updates in place. */
function upsert<T>(list: T[], rec: T, same: (a: T) => boolean): void {
  const i = list.findIndex(same);
  if (i >= 0) list[i] = rec;
  else list.push(rec);
}

// ── listing and cleanup ───────────────────────────────────────────────────────

export interface FileInfo {
  path: string;
  bytes: number;
  overLimit?: boolean;
}

function info(file: string | undefined): FileInfo | undefined {
  if (!file) return undefined;
  try {
    const bytes = fs.statSync(file).size;
    return bytes > MAX_OUTPUT_BYTES ? { path: file, bytes, overLimit: true } : { path: file, bytes };
  } catch {
    return undefined;
  }
}

export function describeJob(job: string) {
  const dir = jobDir(job);
  const m = readManifest(dir, job);
  const clips = m.clips.map((c) => ({
    script: c.script,
    target: c.target,
    viewport: c.viewport,
    scheme: c.scheme,
    durationMs: c.durationMs,
    durationSource: c.durationSource,
    webm: info(c.webm),
    mp4: info(c.mp4),
    gif: info(c.gif),
    poster: info(c.poster),
    skipped: c.skipped.length ? c.skipped : undefined,
    error: c.error,
  }));
  const composites = m.composites.map((c) => ({ script: c.script, viewport: c.viewport, scheme: c.scheme, file: info(c.file) }));
  return { job, dir, createdAt: m.createdAt, updatedAt: m.updatedAt, totalBytes: dirBytes(dir), clips, composites };
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

export function listJobs() {
  if (!fs.existsSync(jobsRoot())) return [];
  const out = [];
  for (const name of fs.readdirSync(jobsRoot()).sort()) {
    if (!SLUG.test(name)) continue;
    try {
      const dir = jobDir(name);
      const m = readManifest(dir, name);
      out.push({ job: name, dir, clips: m.clips.length, composites: m.composites.length, updatedAt: m.updatedAt, totalBytes: dirBytes(dir) });
    } catch {
      /* a symlink or stray file under jobs/ is not a job */
    }
  }
  return out;
}

/**
 * Delete one job folder. Only a real directory directly under jobs/ that carries
 * this tool's manifest is removed: a symlink is refused (it would delete its
 * target's contents), and a folder the tool did not create is refused.
 */
export function removeJob(job: string): { job: string; removed: string; bytes: number } {
  const dir = jobDir(job);
  if (busyJobs.has(job)) throw new Error(`job "${job}" is still recording; wait for movie_record to return`);
  if (!fs.existsSync(path.join(dir, MANIFEST))) throw new Error(`refusing to remove ${dir}: it has no ${MANIFEST}, so movie_record did not make it`);
  const bytes = dirBytes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { job, removed: dir, bytes };
}

// ── recording ─────────────────────────────────────────────────────────────────

/** Jobs with a movie_record in flight, so two calls cannot interleave one manifest. */
const busyJobs = new Set<string>();

export interface RecordOptions {
  job: string;
  scriptName: string;
  steps: Step[];
  targets: TargetSpec[];
  viewports: Viewport[];
  schemes: Scheme[];
  session?: string;
  sideBySide?: boolean;
  gif?: boolean;
  /** Called with a short status line as each clip starts (the heartbeat reads it). */
  onStatus?: (line: string) => void;
  /** The request's abort signal: no new clip starts once it fires; finished clips stay listed. */
  signal?: AbortSignal;
}

export interface RecordResult {
  job: string;
  dir: string;
  clips: ClipRecord[];
  composites: CompositeRecord[];
  notes: string[];
}

interface ResolvedTarget {
  spec: TargetSpec;
  /** Where the clip starts. */
  start: string;
  /** Base that relative navigate URLs resolve against. */
  base: string;
  isMockup: boolean;
  served?: Served;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read and scope a saved session once, so every URL it is used on is checked against its domains. */
function loadSession(name: string): { file: string; state: unknown } {
  // Session names keep session_login's own charset (dots included: wall-<host>), minus any "..".
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name.includes('..'))
    throw new Error('session must be the name of a session_login capture');
  const file = sessionFilePath(name);
  if (!fs.existsSync(file)) throw new Error(`session "${name}" not found — capture it with session_login first`);
  try {
    return { file, state: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    throw new Error(`session "${name}" is unreadable or corrupt — recapture it with session_login`);
  }
}

/** The outbound checks every http(s) navigation in a clip passes: the shared exfil guard, then the session scope. */
function checkUrl(url: string, session: { state: unknown; name: string } | undefined, mockOrigin?: string): void {
  if (mockOrigin) {
    // A mock-up is offline (isolateMockup): its own loopback server is the only place it may go.
    if (url.startsWith(mockOrigin + '/')) return;
    throw new Error('refused: a mock-up target runs offline; navigate only within its own folder');
  }
  const guard = guardOutbound(url, secretInventory());
  if (!guard.ok) throw new Error(guard.reason);
  if (session && !sessionAllowsUrl(session.state, url))
    throw new Error(
      `refused: session "${session.name}" holds no identity for ${new URL(url).host}. A captured session is only ` +
        'replayed against the site it was captured on.',
    );
}

async function resolveTarget(spec: TargetSpec, dir: string): Promise<ResolvedTarget> {
  if (spec.url) return { spec, start: spec.url, base: spec.url, isMockup: false };
  let root: string;
  let entry: string;
  if (spec.file) {
    const abs = path.resolve(spec.file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`target "${spec.label}": no file at ${abs}`);
    const real = fs.realpathSync(abs);
    root = path.dirname(real);
    entry = path.basename(real);
    if (entry.startsWith('.')) throw new Error(`target "${spec.label}": the mock-up file may not be a hidden file`);
  } else {
    // An HTML string gets a folder of its own inside the job, kept so the clip can be re-made.
    root = realChildDir(dir, `mockup-${spec.label}`, true);
    entry = 'index.html';
    writeFileNoFollow(path.join(root, entry), spec.html ?? '');
  }
  const served = await serveDir(root);
  const start = `${served.origin}/${encodeURIComponent(entry)}`;
  return { spec, start, base: start, isMockup: true, served };
}

/** Center of a target, scrolled into view first; null when it is not on the page. */
async function centerOf(page: Page, selector: string, timeout: number) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  await loc.scrollIntoViewIfNeeded({ timeout });
  const b = await loc.boundingBox();
  if (!b) throw new Error(`"${selector}" has no box on the page`);
  return { loc, box: b, x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

class StepSkipped extends Error {}

interface ClipRun {
  steps: number;
  skipped: string[];
}

async function runSteps(
  page: Page,
  steps: Step[],
  target: ResolvedTarget,
  vp: Viewport,
  session: { state: unknown; name: string } | undefined,
  /** Filled in as steps finish, so a clip that fails part-way still reports how far it got. */
  run: ClipRun,
): Promise<void> {
  const mouse = { x: vp.width / 2, y: vp.height / 2 };
  const overlay: { caption: string; badge: string; box: null | { x: number; y: number; w: number; h: number; style: string } } = {
    caption: '',
    badge: target.spec.label,
    box: null,
  };
  const paint = () =>
    page
      .evaluate((s) => (window as unknown as { __pwMovie?: { set: (s: unknown) => void } }).__pwMovie?.set(s), { ...overlay, ...mouse })
      .catch(() => {}); // a page mid-navigation has no overlay yet; the next paint catches up
  const moveTo = async (x: number, y: number) => {
    await page.mouse.move(x, y, { steps: 14 });
    mouse.x = x;
    mouse.y = y;
  };

  await page.goto(target.start, { waitUntil: 'load', timeout: 20_000 });
  await page.mouse.move(mouse.x, mouse.y);
  await paint();
  await sleep(400);

  for (const [i, step] of steps.entries()) {
    if (step.caption !== undefined) overlay.caption = step.caption;
    overlay.box = null;
    await paint();
    let hl: string | undefined;
    try {
      const probe = step.optional ? OPTIONAL_PROBE_MS : ACTION_TIMEOUT_MS;
      const find = async (sel: string) => {
        try {
          return await centerOf(page, sel, probe);
        } catch (err) {
          if (step.optional) throw new StepSkipped(`step ${i + 1} (${step.action} ${sel}): not on this page, skipped`);
          throw err;
        }
      };
      hl = typeof step.highlight === 'string' ? step.highlight : step.highlight ? step.target : undefined;
      if (hl) {
        const { box } = await find(hl);
        overlay.box = { x: box.x, y: box.y, w: box.width, h: box.height, style: step.highlightStyle ?? 'box' };
        await paint();
        await sleep(350);
      }
      switch (step.action) {
        case 'navigate': {
          const url = new URL(step.url!, target.base).href;
          if (!/^https?:/.test(url)) throw new Error(`step ${i + 1}: navigate only goes to http(s) URLs`);
          checkUrl(url, session, target.served?.origin);
          await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
          break;
        }
        case 'click': {
          const t = await find(step.target!);
          await moveTo(t.x, t.y);
          await sleep(180);
          await t.loc.click({ timeout: ACTION_TIMEOUT_MS });
          break;
        }
        case 'hover': {
          const t = await find(step.target!);
          await moveTo(t.x, t.y);
          break;
        }
        case 'type': {
          const t = await find(step.target!);
          await moveTo(t.x, t.y);
          await t.loc.click({ timeout: ACTION_TIMEOUT_MS });
          await t.loc.pressSequentially(step.text ?? '', { delay: 55 });
          break;
        }
        case 'press': {
          if (step.target) await (await find(step.target)).loc.press(step.key!, { timeout: ACTION_TIMEOUT_MS });
          else await page.keyboard.press(step.key!);
          break;
        }
        case 'wait': {
          if (step.target) await find(step.target);
          if (step.ms) await sleep(step.ms);
          break;
        }
        case 'scroll': {
          if (step.target) await find(step.target);
          else await page.mouse.wheel(0, step.dy ?? 0);
          break;
        }
      }
      run.steps += 1;
    } catch (err) {
      if (!(err instanceof StepSkipped)) throw err;
      run.skipped.push(err.message);
    }
    // A click may have navigated or reflowed the page; put the overlay back and move
    // the highlight box to wherever the element sits now (or drop it if it is gone).
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    if (overlay.box && hl) {
      const b = await page.locator(hl).first().boundingBox({ timeout: 500 }).catch(() => null);
      overlay.box = b ? { ...overlay.box, x: b.x, y: b.y, w: b.width, h: b.height } : null;
    }
    await paint();
    await sleep(step.holdMs ?? DEFAULT_HOLD_MS);
  }
  overlay.box = null;
  await paint();
  await sleep(600);
}

function clipBase(scriptName: string, target: string, vp: string, scheme: Scheme): string {
  return `${scriptName}-${target}-${vp}-${scheme}`;
}

async function recordOne(
  browser: Browser,
  dir: string,
  opts: RecordOptions,
  target: ResolvedTarget,
  vp: Viewport,
  scheme: Scheme,
  session: { file: string; state: unknown; name: string } | undefined,
  caps: FfmpegCaps,
): Promise<ClipRecord> {
  const base = clipBase(opts.scriptName, target.spec.label, vp.name, scheme);
  const tmp = fs.mkdtempSync(path.join(dir, '.rec-'));
  const rec: ClipRecord = {
    script: opts.scriptName,
    target: target.spec.label,
    viewport: vp.name,
    scheme,
    webm: path.join(dir, `${base}.webm`),
    steps: 0,
    skipped: [],
    recordedAt: new Date().toISOString(),
  };
  let context: BrowserContext | undefined;
  const started = Date.now();
  try {
    if (!target.isMockup) checkUrl(target.start, session);
    context = await browser.newContext({
      // The same disguise web_fetch and the captures use, so a replayed session is not
      // re-challenged for arriving as a different-looking client. The clip's own
      // viewport overrides the stealth default.
      ...stealthContextOptions,
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: vp.mobile === true,
      colorScheme: scheme,
      recordVideo: { dir: tmp, size: { width: vp.width, height: vp.height } },
      // A mock-up never gets the session: cookies ignore ports, so the mock-up's own
      // script on the loopback server could read a localhost dev session otherwise.
      ...(session && !target.isMockup ? { storageState: session.file } : {}),
      ...(target.isMockup ? { serviceWorkers: 'block' as const } : {}),
    });
    await context.addInitScript(OVERLAY_SCRIPT);
    if (target.isMockup) await isolateMockup(context, target.served!.origin);
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    const run: ClipRun = { steps: 0, skipped: [] };
    try {
      await runSteps(page, opts.steps, target, vp, session, run);
    } catch (err) {
      // Playwright's call log carries terminal colour codes; a tool result is not a terminal.
      rec.error = (err instanceof Error ? err.message : String(err)).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2000);
    }
    rec.steps = run.steps;
    rec.skipped = run.skipped;
    rec.poster = path.join(dir, `${base}.png`);
    await page.screenshot({ path: rec.poster }).catch(() => (rec.poster = undefined));
    const video = page.video();
    await context.close();
    context = undefined;
    if (!video) throw new Error('the recording context produced no video');
    await video.saveAs(rec.webm);
  } finally {
    await context?.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const timed = Date.now() - started;
  const probed = await probeDurationMs(rec.webm, caps);
  rec.durationMs = probed ?? timed;
  rec.durationSource = probed !== undefined ? 'ffprobe' : 'timed';
  if (caps.h264) {
    rec.mp4 = path.join(dir, `${base}.mp4`);
    try {
      await toMp4(rec.webm, rec.mp4, caps);
      if (fs.statSync(rec.mp4).size > MAX_OUTPUT_BYTES) await toMp4(rec.webm, rec.mp4, caps, 36);
    } catch (err) {
      log(`mp4 encode failed for ${base}:`, err instanceof Error ? err.message : err);
      fs.rmSync(rec.mp4, { force: true });
      rec.mp4 = undefined;
    }
  }
  if (opts.gif && caps.gif) {
    rec.gif = path.join(dir, `${base}.gif`);
    try {
      await toGif(rec.webm, rec.gif, caps);
      if (fs.statSync(rec.gif).size > MAX_OUTPUT_BYTES) throw new Error('over the size limit');
    } catch (err) {
      log(`gif dropped for ${base}:`, err instanceof Error ? err.message : err);
      fs.rmSync(rec.gif, { force: true });
      rec.gif = undefined;
    }
  }
  return rec;
}

/**
 * A mock-up runs OFFLINE: its requests may reach its own loopback server and
 * nothing else. Anything external (a CDN font, a beacon) is aborted at the first
 * hop, so there is no redirect chain for a route handler to miss (catalog SEC-8),
 * and WebSockets, which context.route never sees, are closed outright. The
 * mock-up's folder is served whole, so this is what keeps a hostile mock-up from
 * reading a sibling file and sending it anywhere: there is nowhere to send it.
 * Service workers are blocked at context creation (they would answer requests
 * this route never sees) and RTCPeerConnection is removed by an init script (a
 * STUN/TURN candidate is a network channel outside HTTP). The init script runs in
 * every frame, so a fresh iframe's copy is gone too; test-movie.mjs proves it with
 * a UDP counter, and fails when the script is removed. Vendor assets into the
 * mock-up's folder instead of linking a CDN.
 */
async function isolateMockup(context: BrowserContext, origin: string): Promise<void> {
  await context.route(/.*/, (route) =>
    route.request().url().startsWith(origin + '/') ? route.continue() : route.abort('accessdenied'),
  );
  await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: 'mock-ups run offline' }));
  await context.addInitScript(
    'for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) { try { delete window[k]; } catch {} }',
  );
}

/**
 * Record every clip one call asks for: targets × viewports × schemes, then the
 * optional side-by-side composites. The manifest is written after EVERY clip, so a
 * call the client gives up on still leaves what it finished visible to movie_list.
 */
export async function recordMovie(opts: RecordOptions): Promise<RecordResult> {
  const clipsWanted = opts.targets.length * opts.viewports.length * opts.schemes.length;
  if (clipsWanted > MAX_CLIPS_PER_CALL)
    throw new Error(`that is ${clipsWanted} clips; at most ${MAX_CLIPS_PER_CALL} per call — split it across calls with the same job`);
  if (opts.sideBySide && opts.targets.length !== 2) throw new Error('sideBySide needs exactly two targets (before, after)');
  const session = opts.session ? { ...loadSession(opts.session), name: opts.session } : undefined;
  if (session && opts.targets.every((t) => !t.url)) throw new Error('session is only used with url targets; none was given');

  if (busyJobs.has(opts.job)) throw new Error(`job "${opts.job}" is already recording`);
  // The folder is made and checked BEFORE the job is marked busy: a refused path must not
  // leave the job id locked for the life of the process.
  const dir = jobDir(opts.job, true);
  const manifest = readManifest(dir, opts.job);
  writeManifest(dir, manifest); // marks the folder as ours before anything else lands in it
  busyJobs.add(opts.job);
  const caps = await ffmpegCaps();
  const notes: string[] = [];
  const clips: ClipRecord[] = [];
  const composites: CompositeRecord[] = [];
  const targets: ResolvedTarget[] = [];
  let browser: Browser | undefined;
  try {
    for (const spec of opts.targets) targets.push(await resolveTarget(spec, dir));
    browser = await chromium.launch({ headless: true, ...STEALTH_LAUNCH });
    let n = 0;
    outer: for (const vp of opts.viewports)
      for (const scheme of opts.schemes)
        for (const t of targets) {
          n += 1;
          if (opts.signal?.aborted) {
            notes.push(`stopped after ${n - 1} of ${clipsWanted} clips: the call was cancelled`);
            break outer;
          }
          opts.onStatus?.(`clip ${n}/${clipsWanted}: ${t.spec.label} ${vp.name} ${scheme}`);
          const rec = await recordOne(browser, dir, opts, t, vp, scheme, session, caps);
          clips.push(rec);
          upsert(manifest.clips, rec, (c) => c.script === rec.script && c.target === rec.target && c.viewport === rec.viewport && c.scheme === rec.scheme);
          writeManifest(dir, manifest);
        }
    if (opts.sideBySide) {
      if (!caps.hstack || !(caps.h264 || caps.vp8)) notes.push(`side-by-side skipped: ${caps.missing ?? 'ffmpeg cannot stack video'}`);
      else
        for (const vp of opts.viewports)
          for (const scheme of opts.schemes) {
            const [l, r] = targets.map((t) => clips.find((c) => c.target === t.spec.label && c.viewport === vp.name && c.scheme === scheme)!);
            const file = path.join(dir, `${opts.scriptName}-compare-${vp.name}-${scheme}.${caps.h264 ? 'mp4' : 'webm'}`);
            opts.onStatus?.(`side-by-side ${vp.name} ${scheme}`);
            try {
              await sideBySide(l.webm, r.webm, file, vp.height, caps);
              const rec: CompositeRecord = { script: opts.scriptName, viewport: vp.name, scheme, file, left: l.target, right: r.target, recordedAt: new Date().toISOString() };
              composites.push(rec);
              upsert(manifest.composites, rec, (c) => c.file === file);
              writeManifest(dir, manifest);
            } catch (err) {
              notes.push(`side-by-side ${vp.name}/${scheme} failed: ${err instanceof Error ? err.message : err}`);
            }
          }
    }
  } finally {
    await browser?.close().catch(() => {});
    await Promise.all(targets.map((t) => t.served?.close()));
    busyJobs.delete(opts.job);
  }
  if (!caps.h264) notes.push(`mp4 skipped: ${caps.missing}. The .webm plays in browsers and claude.ai artifacts.`);
  if (opts.gif && !caps.gif) notes.push(`gif skipped: ${caps.missing}. Use the .png poster as the preview.`);
  if (!caps.ffprobe) notes.push('no ffprobe found: durations are timed from the recording, not probed from the file.');
  return { job: opts.job, dir, clips, composites, notes };
}
