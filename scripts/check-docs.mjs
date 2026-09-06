#!/usr/bin/env node
/**
 * check-docs — the docs-owner's verification check.
 *
 * Two assertions over the project's shipped prose, both mechanical:
 *   1. every relative markdown link resolves to a file that exists
 *   2. every `npm run <script>` cited in prose exists in package.json
 *
 * Exit 0 = clean, exit 1 = at least one broken reference (each named).
 * Deliberately NOT named test-*.mjs: `npm test` globs those and this is not
 * part of the release gate — it is one employee's own bar.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', '.claude-backups']);

/** Every tracked markdown file that is project prose (not generated, not vendored). */
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const scripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {});
const failures = [];

for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file);

  // 1. relative markdown links — [label](path) where path is not a URL or anchor
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^([a-z]+:)?\/\//i.test(target) || target.startsWith('mailto:')) continue;
    const abs = target.startsWith('/') ? join(ROOT, target) : resolve(dirname(file), target);
    if (!existsSync(abs)) failures.push(`${rel}: broken link -> ${target}`);
  }

  // 2. `npm run <script>` cited in prose must exist in package.json
  for (const m of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
    if (!scripts.includes(m[1])) failures.push(`${rel}: cites \`npm run ${m[1]}\` — not in package.json`);
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.error(`\ncheck-docs: ${failures.length} broken reference(s)`);
  process.exit(1);
}
console.log('check-docs: all markdown links resolve and every cited npm script exists');
