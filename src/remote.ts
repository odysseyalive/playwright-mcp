/**
 * Remote (claude.ai) transport — a gated Streamable-HTTP host for the outward MCP
 * server. Comes up ONLY when PLAYWRIGHT_MCP_PUBLIC_URL is set (see src/index.ts);
 * absent => the process stays stdio-only. Hosted on express so the /mcp endpoint
 * shares an app with the OAuth router (src/auth.ts, Stage 3) and uses the SDK's
 * standard initialize-request session pattern.
 *
 * Dependency direction is one-way: index.ts imports this; this never imports the
 * entry module. The outward Server is supplied via `makeServer` so the upstream
 * proxy + remote denylist stay owned by index.ts.
 *
 * Each MCP session gets its own StreamableHTTPServerTransport + outward Server,
 * all delegating to the SINGLE shared @playwright/mcp chromium. stdout is never
 * written here — logging goes to stderr.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import express, { type Request, type Response, type RequestHandler, type Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:remote]', ...args);

export interface RemoteServerOptions {
  /** Factory producing a fresh remote-scoped outward Server per MCP session. */
  makeServer: () => Server;
  /** Public base URL — the remote on-switch; surfaced in logs (+ OAuth metadata). */
  publicUrl: string;
  /** Local bind port behind nginx (loopback only). */
  port: number;
  /**
   * Stage 3 (OAuth) wiring. `authRouter` mounts the SDK auth endpoints at the app
   * root; `requireAuth` guards the /mcp routes. Both optional so the host is
   * testable before auth lands — when omitted, /mcp is unauthenticated (only ever
   * acceptable behind the localhost bind + nginx allowlist during development).
   */
  authRouter?: Router;
  requireAuth?: RequestHandler;
}

export interface RemoteHandle {
  /** End live sessions and stop accepting connections. */
  close: () => void;
}

/** Start the gated Streamable-HTTP host. Returns a handle for graceful shutdown. */
export function startRemoteServer(opts: RemoteServerOptions): RemoteHandle {
  const { makeServer, publicUrl, port, authRouter, requireAuth } = opts;
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // OAuth endpoints (/.well-known/*, /authorize, /token, /register, …) mount at root.
  if (authRouter) app.use(authRouter);

  const handleSession = async (req: Request, res: Response): Promise<void> => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;

    if (!transport) {
      // New session is allowed only on a POST that carries an initialize request.
      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        transport.onclose = () => {
          const id = transport!.sessionId;
          if (id) sessions.delete(id);
        };
        await makeServer().connect(transport);
      } else {
        res.status(sid ? 404 : 400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: sid ? 'Unknown or expired session' : 'No session; expected an initialize request',
          },
          id: null,
        });
        return;
      }
    }

    await transport.handleRequest(req, res, req.body);
  };

  // POST = client→server messages, GET = SSE stream, DELETE = end session.
  const guards: RequestHandler[] = requireAuth ? [requireAuth] : [];
  app.post('/mcp', ...guards, handleSession);
  app.get('/mcp', ...guards, handleSession);
  app.delete('/mcp', ...guards, handleSession);

  const httpServer: http.Server = app.listen(port, '127.0.0.1', () => {
    log(`ready on http://127.0.0.1:${port}/mcp (public: ${publicUrl}, auth: ${requireAuth ? 'on' : 'OFF'})`);
  });

  return {
    close: () => {
      for (const t of sessions.values()) void t.close().catch(() => {});
      sessions.clear();
      httpServer.close();
    },
  };
}
