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

/** templates/e2e, resolved relative to this module (dist/scaffold.js → ../templates/e2e). */
const TEMPLATE_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'templates', 'e2e');

export interface ScaffoldOptions {
  /** session_login name the suite reuses (default "default"). */
  session?: string;
  /** Target directory to write into (default the current working directory). */
  out?: string;
  /** Overwrite existing files instead of refusing. */
  force?: boolean;
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
}: ScaffoldOptions = {}): string[] {
  if (!fs.existsSync(TEMPLATE_DIR)) {
    throw new Error(`template directory not found: ${TEMPLATE_DIR}`);
  }
  const files = walk(TEMPLATE_DIR);

  const collisions = files
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
    const src = path.join(TEMPLATE_DIR, rel);
    const dest = path.join(out, rel);
    const body = fs.readFileSync(src, 'utf8').split(PLACEHOLDER).join(session);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    written.push(rel);
  }
  return written;
}
