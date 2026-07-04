#!/usr/bin/env node
/**
 * scaffold-e2e.mjs — CLI front door for the E2E-suite generator. The generator
 * core lives in src/scaffold.ts (compiled to dist/scaffold.js) and is shared with
 * the `session_scaffold_tests` MCP tool, so the two never drift. Requires a build
 * (the installer and `npm run gate` build first).
 *
 * Usage:
 *   node scripts/scaffold-e2e.mjs [--session <name>] [--out <dir>] [--force]
 *
 *   --session <name>  session_login name the suite reuses (default: "default")
 *   --out <dir>       where to write the suite (default: current directory)
 *   --force           overwrite existing files (rewrites the WHOLE template set,
 *                     including a customized example.spec.ts/config)
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { scaffold } from '../dist/scaffold.js';

function parseArgs(argv) {
  const opts = { session: 'default', out: process.cwd(), force: false };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.session = value(++i, '--session');
    else if (a === '--out') opts.out = path.resolve(value(++i, '--out'));
    else if (a === '--force') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      'Usage: node scripts/scaffold-e2e.mjs [--session <name>] [--out <dir>] [--force]\n' +
        '  --force rewrites the WHOLE template set, including a customized example.spec.ts/config.',
    );
    return;
  }
  try {
    const written = scaffold(opts);
    console.log(`Scaffolded an authenticated Playwright E2E suite into ${opts.out}:`);
    for (const rel of written) console.log(`  ${rel}`);
    console.log(
      `\nSession: "${opts.session}"\n\nNext:\n` +
        `  cd ${opts.out}\n` +
        `  npm install -D @playwright/test && npx playwright install chromium\n` +
        `  # capture the login once (from Claude Code):\n` +
        `  #   session_login({ name: "${opts.session}", loginUrl, successSignal, headed: true })\n` +
        `  BASE_URL=http://localhost:3000 npx playwright test\n\n` +
        `See the generated e2e README for CI injection and security notes.`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
