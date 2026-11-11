#!/usr/bin/env node
// merge-crush.mjs — register playwright-mcp with Crush in its global config,
// without disturbing anything else. Used by install.sh / install.ps1. Crush has
// no `mcp add` CLI subcommand; its config is a file, so this edits the file.
//
//   node merge-crush.mjs <node> <dist/index.js> --print   # preview (empty = no change)
//   node merge-crush.mjs <node> <dist/index.js> --write   # apply in place
//
// Where it writes, and why:
//   - Crush's global config folder is $CRUSH_GLOBAL_CONFIG when set, otherwise
//     $XDG_CONFIG_HOME/crush, default ~/.config/crush on every OS, Windows
//     included. It holds crushrc (bash, the current format) and crush.json
//     (legacy JSON, still read). Both were measured on Crush v0.100.0.
//   - Also measured on v0.100.0: when both files name the same MCP server, the
//     crush.json entry wins, whatever the docs say. So an entry that already sits
//     in crush.json is updated there (other keys kept); otherwise a marked block
//     goes into crushrc, and a re-run replaces that block rather than adding one.
//
// A new entry gets timeout 300. Crush's default is 10 seconds.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME = 'playwright-mcp';
const TIMEOUT = 300;
const BEGIN = `# >>> ${NAME} (written by its installer; a re-run replaces this block) >>>`;
const END = `# <<< ${NAME} <<<`;

const [nodeCmd, entry, mode = '--print'] = process.argv.slice(2);
if (!nodeCmd || !entry || !['--print', '--write'].includes(mode)) {
  console.error('usage: merge-crush.mjs <node> <dist/index.js> [--print|--write]');
  process.exit(2);
}

const configDir =
  process.env.CRUSH_GLOBAL_CONFIG ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'crush');
const rcFile = path.join(configDir, 'crushrc');
const jsonFile = path.join(configDir, 'crush.json');

/** Single-quote for bash: nothing inside is expanded, and ' becomes '\''. */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const block = [
  BEGIN,
  `mcp add ${NAME} --type stdio --command ${sq(nodeCmd)} --args ${sq(entry)} --timeout ${TIMEOUT}`,
  END,
].join('\n');

const changes = []; // { file, body, note }

// ── crush.json: update an existing entry in place ─────────────────────────────
let jsonHasEntry = false;
if (existsSync(jsonFile)) {
  const raw = readFileSync(jsonFile, 'utf8');
  let config;
  try {
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    // Crush accepts JSON with comments and trailing commas; JSON.parse does not.
    // Leave such a file alone. If it names this server, say so, because that
    // entry would win over the crushrc block and could point at an old path.
    if (raw.includes(`"${NAME}"`)) {
      console.error(
        `${jsonFile} mentions ${NAME} but could not be parsed (${err.message}). ` +
          `Set its command to ${JSON.stringify(nodeCmd)} and args to ${JSON.stringify([entry])} by hand.`,
      );
      process.exit(1);
    }
  }
  const current = config?.mcp?.[NAME];
  if (current && typeof current === 'object') {
    jsonHasEntry = true;
    const next = { ...current, type: 'stdio', command: nodeCmd, args: [entry] };
    if (next.timeout === undefined) next.timeout = TIMEOUT;
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      config.mcp[NAME] = next;
      changes.push({
        file: jsonFile,
        body: JSON.stringify(config, null, 2) + '\n',
        note: `  mcp.${NAME} (before): ${JSON.stringify(current)}\n  mcp.${NAME} (after):  ${JSON.stringify(next)}`,
      });
    }
  }
}

// ── crushrc: replace our block, or append it when crush.json has no entry ─────
const rc = existsSync(rcFile) ? readFileSync(rcFile, 'utf8') : '';
const lines = rc.split(/\r?\n/);
const begin = lines.findIndex((l) => l.startsWith(`# >>> ${NAME} `));
const end = begin === -1 ? -1 : lines.indexOf(END, begin + 1);
if (begin !== -1 && end === -1) {
  console.error(`${rcFile} has the opening ${NAME} marker but no closing one. Fix or remove that block by hand.`);
  process.exit(1);
}
if (begin !== -1) {
  const old = lines.slice(begin, end + 1).join('\n');
  if (old !== block) {
    const next = [...lines.slice(0, begin), ...block.split('\n'), ...lines.slice(end + 1)].join('\n');
    changes.push({ file: rcFile, body: next, note: `  replacing the ${NAME} block:\n${block}` });
  }
} else if (!jsonHasEntry) {
  const sep = rc === '' ? '' : rc.endsWith('\n') ? '\n' : '\n\n';
  changes.push({ file: rcFile, body: `${rc}${sep}${block}\n`, note: `  appending:\n${block}` });
}

if (mode === '--print') {
  for (const c of changes) console.log(`${c.file}\n${c.note}`);
  process.exit(0);
}

for (const c of changes) {
  mkdirSync(path.dirname(c.file), { recursive: true });
  writeFileSync(c.file, c.body);
}
process.exit(0);
