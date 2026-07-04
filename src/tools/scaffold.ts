/**
 * scaffold.ts (tool) — session_scaffold_tests: the MCP front door for the
 * E2E-suite generator (core in src/scaffold.ts, shared with the
 * scripts/scaffold-e2e.mjs CLI). Lets any project — without knowing this repo's
 * path — generate a deterministic Playwright suite that reuses a session captured
 * by session_login. Writes only the template (no session/secret data); the
 * storageState artifact stays at its mode-600 user-scoped path.
 *
 * Spec: /session-method (Consumer 2). DEC-2026-06-08-e2e-test-scaffold-storagestate
 * (amended — the tool was added after the CLI on the discoverability priority).
 */

import path from 'node:path';

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { scaffold } from '../scaffold.js';

const definition: Tool = {
  name: 'session_scaffold_tests',
  description:
    'Scaffold a deterministic Playwright E2E test suite (playwright.config.ts + a ' +
    'freshness-guard setup project + an example spec + README) into a project. The ' +
    'suite reuses a login captured by session_login (its mode-600 storageState) — it ' +
    'never logs in or embeds credentials. Use after capturing a session to freeze a ' +
    'flow as a runner-executed test. Writes no session data into the project.',
  inputSchema: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'The session_login name the suite reuses (default "default").',
      },
      outDir: {
        type: 'string',
        description:
          "Target project directory to write into. Defaults to the server's working " +
          'directory — pass the project path explicitly to be sure.',
      },
      force: {
        type: 'boolean',
        description:
          'Overwrite existing files instead of refusing. WARNING: this rewrites the whole ' +
          'template set — including a previously scaffolded example.spec.ts or config you have ' +
          'since customized. Default false.',
      },
    },
  },
};

async function handler(args: Record<string, unknown>): Promise<CallToolResult> {
  const session = args.session ? String(args.session) : 'default';
  const out = path.resolve(args.outDir ? String(args.outDir) : process.cwd());
  const force = Boolean(args.force);

  try {
    const written = scaffold({ session, out, force });
    const text =
      `Scaffolded an authenticated Playwright E2E suite into ${out}:\n` +
      written.map((rel) => `  ${rel}`).join('\n') +
      `\n\nSession: "${session}"\n` +
      `Next: install @playwright/test in that project, capture the login once with ` +
      `session_login({ name: "${session}", … }) (headed:true for 2FA), then ` +
      `\`npx playwright test\`. The generated README covers CI injection and security.`;
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [
        { type: 'text', text: err instanceof Error ? err.message : String(err) },
      ],
      isError: true,
    };
  }
}

export const sessionScaffoldTool = { definition, handler };
