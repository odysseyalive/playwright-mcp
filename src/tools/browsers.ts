/**
 * browsers.ts — browser_status: which browsers playwright-mcp has open on this
 * machine, who owns each one, and how long it has sat idle.
 *
 * The 2026-11-24 incident (src/lifetime.ts) was found by another agent reading
 * `ps`: four headless Chromes, 4.4 GB, no way to tell from inside a session
 * which server or client they belonged to. This is that view, from the registry
 * every server keeps, plus the Chromes on playwright-mcp profiles that no file
 * lists (an older server's, or an orphan). `node dist/index.js --browsers` prints
 * the same thing for the human, with no client.
 *
 * Read-only and not queued: it reads files and /proc, launches nothing and
 * closes nothing, so it never waits behind a lease.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { browserStatus, idleMs } from '../lifetime.js';

const definition: Tool = {
  name: 'browser_status',
  description:
    'List the browsers playwright-mcp servers on this machine have open: owner server and client ' +
    '(pid, session), kind, profile, age, idle time and memory. Read-only. A browser closes on its own ' +
    `after ${Math.round(idleMs() / 60_000)} min unused and when its server exits; the next call relaunches it.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

async function handler(): Promise<CallToolResult> {
  const rows = await browserStatus();
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            browsers: rows,
            idleCloseAfterSec: Math.round(idleMs() / 1000),
            note: rows.length
              ? 'serverAlive:false marks an owner that is gone; its browsers are reaped on the next pass.'
              : 'no playwright-mcp browser is running',
          },
          null,
          1,
        ),
      },
    ],
  };
}

export const browserStatusTool = { definition, handler };
