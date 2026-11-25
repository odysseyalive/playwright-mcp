#!/usr/bin/env node
/**
 * e2e-slot.mjs — run this project's Playwright suite inside playwright-mcp's
 * machine-wide e2e slot. Scaffolded by playwright-mcp; `npm run test:e2e` calls it.
 *
 * Why: on 2026-11-25 several e2e suites started by different agent sessions ran
 * at once on one 4-core laptop and locked it up (load average 16). The slot lets
 * one suite run at a time on the machine and queues the rest, FIFO; Playwright
 * workers inside it are capped at half the cores.
 *
 *   npm run test:e2e -- tests/checkout.spec.ts --workers=1
 *   npm run test:e2e -- --detach tests/checkout.spec.ts   (returns at once; prints the log to poll)
 *   npm run test:e2e:direct                                (no slot)
 *
 * It finds the wrapper through the pointer every playwright-mcp server writes at
 * start (<state dir>/playwright-mcp/e2e-slot/wrapper.json), so it needs no path
 * baked in. With CI set, or with no playwright-mcp on this machine, it runs
 * `playwright test` directly. Leading --detach / --log / --max-wait / --max-hold
 * go to the wrapper; everything else goes to `playwright test`.
 *
 * The state directory below mirrors playwright-mcp's src/e2e-slot.ts slotDir():
 * change both together.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function slotDir() {
  if (process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR) return process.env.PLAYWRIGHT_MCP_E2E_SLOT_DIR;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'playwright-mcp', 'state', 'e2e-slot');
  }
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'playwright-mcp', 'e2e-slot');
}

function wrapper() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(slotDir(), 'wrapper.json'), 'utf8'));
    if (typeof p.bin === 'string' && fs.existsSync(p.bin)) return p;
  } catch {
    /* no playwright-mcp server has run here */
  }
  return undefined;
}

const args = process.argv.slice(2);
const wrapperArgs = [];
while (args.length) {
  const a = args[0];
  if (a === '--detach') wrapperArgs.push(args.shift());
  else if (['--log', '--max-wait', '--max-hold'].includes(a) && args.length > 1) wrapperArgs.push(args.shift(), args.shift());
  else if (/^--(log|max-wait|max-hold)=/.test(a)) wrapperArgs.push(args.shift());
  else break;
}

const w = process.env.CI ? undefined : wrapper();
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let child;
if (w) {
  // The node the server runs under (on an old-glibc host, the installer's private one).
  const node = typeof w.node === 'string' && fs.existsSync(w.node) ? w.node : process.execPath;
  child = spawn(node, [w.bin, ...wrapperArgs, '--', 'npx', 'playwright', 'test', ...args], { stdio: 'inherit' });
} else {
  if (!process.env.CI) console.error('e2e-slot: playwright-mcp not found on this machine; running without the slot');
  if (wrapperArgs.length) console.error(`e2e-slot: ignoring ${wrapperArgs.join(' ')} (no slot)`);
  child = spawn(npx, ['playwright', 'test', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('close', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
