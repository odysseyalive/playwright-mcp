#!/usr/bin/env node
/**
 * slot-bin.ts — the `playwright-mcp-slot` bin entry, and what a detached run's
 * background runner is started with. Its own file rather than dist/index.js:
 * index.ts boots only when it is argv[1] itself, a test an npm bin symlink can
 * fail, and it loads the whole server. This loads the slot and nothing else.
 */

import { slotMain } from './slot-cli.js';

slotMain(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`playwright-mcp-slot: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
