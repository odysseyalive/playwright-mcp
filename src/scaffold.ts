/**
 * scaffold.ts — the E2E-suite generator core, shared by two front doors: the
 * `session_scaffold_tests` MCP tool (src/tools/scaffold.ts) and the
 * `scripts/scaffold-e2e.mjs` CLI (`npm run scaffold:e2e`). One implementation,
 * so the two can never drift.
 *
 * It copies templates/e2e/* (config + freshness-guard setup + example spec +
 * README) into a target project, substituting the session name. It writes NO
 * session data — only the template, with __SESSION_NAME__ replaced. The
 * storageState artifact stays at its mode-600 user-scoped path; the generated
 * config references it by resolved path only. See /session-method.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER = '__SESSION_NAME__';
const PROJECT_PLACEHOLDER = '__PROJECT_NAME__';

/** templates/e2e, resolved relative to this module (dist/scaffold.js → ../templates/e2e). */
const TEMPLATE_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'templates', 'e2e');

/** templates/suite — the full methodology pack + project-local AI skill (suite_scaffold). */
export const SUITE_TEMPLATE_DIR = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  'templates',
  'suite',
);

/**
 * Skill folders are written twice. Claude Code reads project skills only from
 * .claude/skills; Codex reads them only from .agents/skills (the Agent Skills
 * path). Crush reads both and shows a skill once. So every template file under
 * the first prefix is also written under the second.
 */
const SKILL_DIR = path.join('.claude', 'skills') + path.sep;
const SKILL_MIRROR = path.join('.agents', 'skills') + path.sep;

/** A template path plus its mirror, when it has one. */
function destinations(rel: string): string[] {
  return rel.startsWith(SKILL_DIR) ? [rel, SKILL_MIRROR + rel.slice(SKILL_DIR.length)] : [rel];
}

/**
 * Substituted values land inside TS string literals AND parsed JSON
 * (e2e-suite.config.json) — restrict to characters that are inert in both.
 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export interface ScaffoldOptions {
  /** session_login name the suite reuses (default "default"). */
  session?: string;
  /** Target directory to write into (default the current working directory). */
  out?: string;
  /** Overwrite existing files instead of refusing. */
  force?: boolean;
  /** Template tree to copy (default templates/e2e; suite_scaffold passes SUITE_TEMPLATE_DIR). */
  templateDir?: string;
  /** Value for __PROJECT_NAME__ (suite templates only; default "app"). */
  project?: string;
}

/** Collect every file under dir, relative to it. */
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out;
}

/**
 * Generate the suite. Returns the list of written relative paths.
 * Throws if a target file exists and `force` is false (listing all collisions).
 */
export function scaffold({
  session = 'default',
  out = process.cwd(),
  force = false,
  templateDir = TEMPLATE_DIR,
  project = 'app',
}: ScaffoldOptions = {}): string[] {
  if (!SAFE_NAME.test(session)) {
    throw new Error(`invalid session name (allowed: letters, digits, . _ -): ${session}`);
  }
  if (!SAFE_NAME.test(project)) {
    throw new Error(`invalid project name (allowed: letters, digits, . _ -): ${project}`);
  }
  if (!fs.existsSync(templateDir)) {
    throw new Error(`template directory not found: ${templateDir}`);
  }
  const files = walk(templateDir);

  const collisions = files
    .flatMap(destinations)
    .map((rel) => path.join(out, rel))
    .filter((dest) => fs.existsSync(dest));
  if (collisions.length && !force) {
    throw new Error(
      `refusing to overwrite existing files (use force):\n` +
        collisions.map((c) => `  ${c}`).join('\n'),
    );
  }

  const written: string[] = [];
  for (const rel of files) {
    const src = path.join(templateDir, rel);
    const body = fs
      .readFileSync(src, 'utf8')
      .split(PLACEHOLDER)
      .join(session)
      .split(PROJECT_PLACEHOLDER)
      .join(project);
    for (const destRel of destinations(rel)) {
      const dest = path.join(out, destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      written.push(destRel);
    }
  }
  return written;
}

/**
 * The npm scripts a scaffolded suite runs through. `test:e2e` goes through the
 * machine-wide e2e slot (src/e2e-slot.ts) by way of the generated
 * tests/e2e-slot.mjs, which needs no path baked into the project; it runs
 * directly under CI or where playwright-mcp is absent. `test:e2e:direct` skips
 * the slot outright. Added 2026-11-25 after concurrent suites from several agent
 * sessions locked up a 4-core laptop.
 */
export const E2E_SCRIPTS: Readonly<Record<string, string>> = {
  'test:e2e': 'node tests/e2e-slot.mjs',
  'test:e2e:direct': 'playwright test',
};

/**
 * Add E2E_SCRIPTS to the target's package.json, keys that are absent only: a
 * script the project already has is its own and stays as it is. No package.json
 * means nothing is written. Returns one line for the scaffold result.
 */
export function addE2eScripts(out: string): string {
  const file = path.join(out, 'package.json');
  const lines = Object.entries(E2E_SCRIPTS).map(([k, v]) => `"${k}": "${v}"`).join(', ');
  if (!fs.existsSync(file)) return `No package.json in ${out}: add these scripts when you create one: ${lines}.`;
  let raw: string;
  let pkg: { scripts?: Record<string, string> };
  try {
    raw = fs.readFileSync(file, 'utf8');
    pkg = JSON.parse(raw);
  } catch (err) {
    return `package.json was not changed (${err instanceof Error ? err.message : String(err)}); add these scripts by hand: ${lines}.`;
  }
  pkg.scripts ??= {};
  const added: string[] = [];
  const kept: string[] = [];
  for (const [k, v] of Object.entries(E2E_SCRIPTS)) {
    if (pkg.scripts[k] === undefined) {
      pkg.scripts[k] = v;
      added.push(k);
    } else if (pkg.scripts[k] !== v) kept.push(k);
  }
  if (added.length) {
    const indent = /^\{\s*\n([ \t]+)"/.exec(raw)?.[1] ?? '  ';
    fs.writeFileSync(file, JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
  }
  return (
    (added.length ? `package.json: added ${added.map((k) => `"${k}"`).join(', ')}.` : 'package.json: the e2e scripts were already there.') +
    (kept.length ? ` Left your own ${kept.map((k) => `"${k}"`).join(', ')} as it is; the slot runner is: ${lines}.` : '')
  );
}

/** The run lines both scaffold tools hand back. */
export const E2E_RUN_NOTE =
  'Run it as `npm run test:e2e -- [specs] [--workers=1]`: it waits its turn in the machine-wide e2e slot, one suite ' +
  'at a time across every session, and caps workers at half the cores. For a long run add --detach first ' +
  '(`npm run test:e2e -- --detach [specs]`): it returns at once with a log path, whose last line becomes `done <code>`. ' +
  '`npm run test:e2e:direct` (and CI) skips the slot.';
