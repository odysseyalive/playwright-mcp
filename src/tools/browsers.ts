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
 *
 * `pendingWalls` lists this server's bot-wall windows waiting on the human
 * (2026-11-25): a research run that met a wall can see whether the window is still
 * up, how many fetches are waiting on it, and when it has been cleared to retry.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { slotStatus } from '../e2e-slot.js';
import { renderStatus } from '../render-lane.js';
import { browserStatus, idleMs } from '../lifetime.js';
import { pendingWalls } from './web-fetch.js';

const definition: Tool = {
  name: 'browser_status',
  description:
    'List the browsers playwright-mcp servers on this machine have open: owner server and client ' +
    '(pid, session), kind, profile, age, idle time and memory. Read-only. A browser closes on its own ' +
    `after ${Math.round(idleMs() / 60_000)} min unused and when its server exits; the next call relaunches it. ` +
    'pendingWalls lists bot-wall windows web_fetch opened that wait on the human (host, opened at, cleared, ' +
    'fetches waiting); once cleared, retry those fetches. e2eSlot shows the machine-wide e2e suite slot: ' +
    'holder (session/cwd, command, held for, overdue) and the queue; renderLane shows the machine-wide render ' +
    'slots every browser_* call and web_fetch render takes (holders, waiters by session). Renders never wait for a suite.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

async function handler(): Promise<CallToolResult> {
  const rows = await browserStatus();
  const walls = pendingWalls();
  const [e2eSlot, renderLane] = await Promise.all([slotStatus(), renderStatus()]);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            browsers: rows,
            idleCloseAfterSec: Math.round(idleMs() / 1000),
            pendingWalls: walls,
            e2eSlot,
            renderLane,
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
