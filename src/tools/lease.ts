/**
 * lease.ts — browser_lease_acquire / browser_lease_release: hold the shared
 * browser for a multi-call turn.
 *
 * Every browser_* call already waits its turn in the browser queue (src/queue.ts),
 * so a single call never collides with another. What a single call cannot do is
 * keep its place BETWEEN calls: after navigate returns, another agent's evaluate
 * may run before this agent's snapshot. A lease closes that gap. Its token is the
 * caller's identity, because every agent in a Claude Code session shares one MCP
 * connection and the server cannot tell them apart any other way.
 *
 * Two tools rather than one with an `action`: each has one required shape, and the
 * queue's own errors name browser_lease_acquire, so the model is pointed at a tool
 * that exists under that name.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { ToolContext } from '../tools.js';
import { browserQueue, secs } from '../queue.js';
import { queueTurn } from './session.js';

const errorResult = (err: unknown): CallToolResult => ({
  content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const acquireDefinition: Tool = {
  name: 'browser_lease_acquire',
  description:
    'Hold the shared browser for a multi-step turn (e.g. navigate → snapshot → click) so no other ' +
    'agent can run a browser_* call in between. Every browser_* call is already queued one at a time, ' +
    'so you need this only when several calls must run back to back. Waits its turn like any call, ' +
    'then returns a lease token: pass it as `lease` on each browser_* call (and session_attach) of ' +
    'your turn, then call browser_lease_release. While you hold it, calls without it wait. ' +
    `It ends on its own after ${secs(browserQueue.limits.idleMs)} with no call carrying it, and ` +
    `after ${secs(browserQueue.limits.maxLeaseMs)} at most. Leases do not nest: release before ` +
    'acquiring again. web_fetch is not queued and needs no lease.',
  inputSchema: {
    type: 'object',
    properties: {
      holder: {
        type: 'string',
        description:
          'Optional short name for who is holding the browser (e.g. "linkedin-scout"). Other callers ' +
          'see it while they wait, and in the error if they give up.',
      },
    },
  },
};

async function acquireHandler(args: Record<string, unknown>, ctx?: ToolContext): Promise<CallToolResult> {
  try {
    const holder = args.holder != null ? String(args.holder) : undefined;
    // queueTurn for its heartbeat and abort signal; the queue labels an acquire itself.
    const { onWait, signal } = queueTurn(ctx, 'browser_lease_acquire');
    const grant = await browserQueue.acquire({ holder, signal, onWait });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ...grant,
              note:
                'pass this lease on every browser_* call of your turn; call browser_lease_release when done. ' +
                `It lapses after ${secs(grant.idleMs)} unused, ${secs(grant.maxLeaseMs)} at most.`,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (err) {
    return errorResult(err);
  }
}

const releaseDefinition: Tool = {
  name: 'browser_lease_release',
  description:
    'End a browser lease from browser_lease_acquire, so the next caller in the queue gets the browser. ' +
    'Safe to call twice: releasing a lease that already ended or expired says so and changes nothing. ' +
    'A token this server never issued is an error.',
  inputSchema: {
    type: 'object',
    properties: {
      lease: { type: 'string', description: 'The token browser_lease_acquire returned.' },
    },
    required: ['lease'],
  },
};

async function releaseHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const result = browserQueue.release(String(args.lease ?? ''));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return errorResult(err);
  }
}

export const leaseAcquireTool = { definition: acquireDefinition, handler: acquireHandler };
export const leaseReleaseTool = { definition: releaseDefinition, handler: releaseHandler };
