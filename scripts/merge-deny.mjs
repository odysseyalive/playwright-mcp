#!/usr/bin/env node
// merge-deny.mjs — merge the playwright-mcp deny rules into a Claude Code
// settings.json without disturbing any other key. Used by install.sh / install.ps1.
//
//   node merge-deny.mjs <settings.json> --print   # preview the diff (empty = no change)
//   node merge-deny.mjs <settings.json> --write   # apply the merge in place
//
// The deny list routes all web access through playwright-mcp's web_search/
// web_fetch and blocks the claude-in-chrome extension's tools.
import { readFileSync, writeFileSync } from 'node:fs';

const DENY = ['WebSearch', 'WebFetch', 'mcp__claude-in-chrome'];
const file = process.argv[2];
const mode = process.argv[3] ?? '--print';
if (!file) {
  console.error('usage: merge-deny.mjs <settings.json> [--print|--write]');
  process.exit(2);
}

let settings;
try {
  const raw = readFileSync(file, 'utf8').trim();
  settings = raw ? JSON.parse(raw) : {};
} catch (err) {
  console.error(`cannot parse ${file}: ${err.message}`);
  process.exit(1);
}

const perms = (settings.permissions ??= {});
const existing = Array.isArray(perms.deny) ? perms.deny : [];
const toAdd = DENY.filter((d) => !existing.includes(d));

if (mode === '--print') {
  if (toAdd.length === 0) process.exit(0); // nothing to change → empty output
  console.log(`  permissions.deny (before): ${JSON.stringify(existing)}`);
  console.log(`  permissions.deny (after):  ${JSON.stringify([...existing, ...toAdd])}`);
  console.log(`  adding: ${toAdd.join(', ')}`);
  process.exit(0);
}

if (mode === '--write') {
  perms.deny = [...existing, ...toAdd];
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
