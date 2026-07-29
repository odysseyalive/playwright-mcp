/**
 * Remote-surface authentication — proxy-mode OAuth for claude.ai with GitHub as
 * the upstream login (ledger DEC-2026-06-26).
 *
 * GitHub has no Dynamic Client Registration, and claude.ai's connector flow needs
 * DCR + OAuth metadata discovery. So this server acts as its OWN authorization
 * server (via the SDK's mcpAuthRouter): claude.ai registers + runs PKCE against
 * US, while we delegate the actual human login to GitHub on the back-channel and
 * issue our own short-lived tokens. Authorization is LOCKED to a single GitHub
 * login — every other GitHub user is rejected after login.
 *
 * Stores are in-memory: a process restart forces a re-auth. That is acceptable
 * for a single-user connector and keeps secrets off disk. stdout is never written
 * here (it carries the stdio MCP stream); logging goes to stderr.
 *
 * RFC 9207 (MCP 2026-07-28, SEP-2468; ledger DEC-2026-07-28): because we ARE the
 * authorization server, every authorization response we emit carries the `iss`
 * identifier so a client can detect an AS mix-up before redeeming the code. The
 * SDK's own authorize handler does not emit it, so we add it on our side.
 * KNOWN GAP: the SDK's authorizationHandler redirects its own late validation
 * failures straight to the client, and those responses still carry no `iss` —
 * closing that would mean forking the SDK, so compliance here is ours-only.
 */

import crypto from 'node:crypto';

import express, { type Request, type Response, type RequestHandler, type Router } from 'express';
import {
  mcpAuthRouter,
  mcpAuthMetadataRouter,
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const log = (...args: unknown[]) => console.error('[playwright-mcp:auth]', ...args);

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 min — code is single-use anyway
const DEFAULT_TOKEN_TTL_S = 60 * 60; // 1 hour access tokens (refreshable)

export interface GitHubAuthConfig {
  /** Public base URL of this MCP server (the issuer); must be https in production. */
  publicUrl: string;
  /** GitHub OAuth app credentials. */
  clientId: string;
  clientSecret: string;
  /** The single GitHub login permitted to use this connector (case-insensitive). */
  allowedLogin: string;
  /** Access-token lifetime in seconds (default 3600). */
  tokenTtlSeconds?: number;
}

export interface RemoteAuth {
  /** Express router mounting the OAuth endpoints + the GitHub callback (root mount). */
  router: Router;
  /** Bearer guard for the /mcp routes. */
  requireAuth: RequestHandler;
}

interface PendingTxn {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes?: string[];
}
interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  login: string;
  scopes: string[];
  expiresAt: number;
}
interface TokenRecord {
  clientId: string;
  login: string;
  scopes: string[];
  expiresAt: number;
}

/**
 * OAuthServerProvider that fronts GitHub. claude.ai talks OAuth 2.1 + PKCE to us;
 * we talk OAuth to GitHub and gate on a single login.
 */
class GitHubProxyOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pendingTxns = new Map<string, PendingTxn>();
  private readonly authCodes = new Map<string, AuthCodeRecord>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, TokenRecord>();
  private readonly callbackUrl: string;

  /**
   * @param issuer RFC 9207 issuer identifier for the `iss` authorization-response
   *   parameter. MUST be byte-identical to the `issuer` in our AS metadata —
   *   buildGitHubAuth() derives both from the same `issuerUrl.href`, which is why
   *   this is injected rather than recomputed here.
   */
  constructor(
    private readonly config: GitHubAuthConfig,
    private readonly issuer: string,
  ) {
    this.callbackUrl = new URL('/oauth/github/callback', config.publicUrl).href;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      // The SDK register handler generates client_id before calling this
      // (clientIdGeneration defaults to true), so the runtime object is full.
      registerClient: (client) => {
        const full = client as unknown as OAuthClientInformationFull;
        this.clients.set(full.client_id, full);
        return full;
      },
    };
  }

  /** Begin the flow by redirecting the user to GitHub; we finish in the callback. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const txnId = crypto.randomUUID();
    this.pendingTxns.set(txnId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes,
    });

    const gh = new URL(GITHUB_AUTHORIZE_URL);
    gh.searchParams.set('client_id', this.config.clientId);
    gh.searchParams.set('redirect_uri', this.callbackUrl);
    gh.searchParams.set('state', txnId);
    gh.searchParams.set('scope', 'read:user');
    gh.searchParams.set('allow_signup', 'false');
    res.redirect(gh.href);
  }

  /** GitHub redirects here; we verify identity, then hand claude.ai our own code. */
  readonly gitHubCallback: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const txnId = typeof req.query.state === 'string' ? req.query.state : '';
    const txn = this.pendingTxns.get(txnId);
    if (!txn) {
      res.status(400).send('Unknown or expired authorization transaction.');
      return;
    }
    this.pendingTxns.delete(txnId);

    const redirect = new URL(txn.redirectUri);
    if (txn.state) redirect.searchParams.set('state', txn.state);
    // RFC 9207: EVERY authorization response carries `iss` — success and error
    // alike — so set it here, on the one URL both branches below redirect to.
    redirect.searchParams.set('iss', this.issuer);

    try {
      const ghToken = await this.exchangeGitHubCode(code);
      const login = await this.fetchGitHubLogin(ghToken);

      // Identity lock — the single security gate on who may use this connector.
      if (login.toLowerCase() !== this.config.allowedLogin.toLowerCase()) {
        log(`denied: GitHub login "${login}" is not the allowed login`);
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', `GitHub user "${login}" is not authorized for this server.`);
        res.redirect(redirect.href);
        return;
      }

      const authCode = crypto.randomBytes(32).toString('hex');
      this.authCodes.set(authCode, {
        clientId: txn.clientId,
        redirectUri: txn.redirectUri,
        codeChallenge: txn.codeChallenge,
        login,
        scopes: txn.scopes ?? [],
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      });
      redirect.searchParams.set('code', authCode);
      res.redirect(redirect.href);
    } catch (err) {
      log('GitHub auth failed:', err instanceof Error ? err.message : String(err));
      res.status(502).send('GitHub authentication failed.');
    }
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.requireAuthCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string, // PKCE already validated by the SDK token handler
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const rec = this.requireAuthCode(client, authorizationCode);
    if (redirectUri && redirectUri !== rec.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.authCodes.delete(authorizationCode); // single use
    return this.issueTokens(rec.clientId, rec.login, rec.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const rec = this.refreshTokens.get(refreshToken);
    if (!rec || rec.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    const grantScopes = scopes && scopes.length ? scopes : rec.scopes;
    return this.issueTokens(rec.clientId, rec.login, grantScopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.accessTokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) {
      if (rec) this.accessTokens.delete(token);
      throw new InvalidTokenError('Token is invalid or expired');
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      extra: { login: rec.login },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.accessTokens.delete(request.token);
    this.refreshTokens.delete(request.token);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private requireAuthCode(client: OAuthClientInformationFull, code: string): AuthCodeRecord {
    const rec = this.authCodes.get(code);
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return rec;
  }

  private issueTokens(clientId: string, login: string, scopes: string[]): OAuthTokens {
    const accessToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const ttl = this.config.tokenTtlSeconds ?? DEFAULT_TOKEN_TTL_S;
    const record: TokenRecord = { clientId, login, scopes, expiresAt: Date.now() + ttl * 1000 };
    this.accessTokens.set(accessToken, record);
    this.refreshTokens.set(refreshToken, { clientId, login, scopes, expiresAt: Number.MAX_SAFE_INTEGER });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ttl,
      scope: scopes.length ? scopes.join(' ') : undefined,
      refresh_token: refreshToken,
    };
  }

  private async exchangeGitHubCode(code: string): Promise<string> {
    const resp = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.callbackUrl,
      }),
    });
    if (!resp.ok) throw new Error(`GitHub token exchange HTTP ${resp.status}`);
    const data = (await resp.json()) as { access_token?: string; error?: string };
    if (!data.access_token) throw new Error(`GitHub token exchange: ${data.error ?? 'no access_token'}`);
    return data.access_token;
  }

  private async fetchGitHubLogin(accessToken: string): Promise<string> {
    const resp = await fetch(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'playwright-mcp',
      },
    });
    if (!resp.ok) throw new Error(`GitHub user fetch HTTP ${resp.status}`);
    const data = (await resp.json()) as { login?: string };
    if (!data.login) throw new Error('GitHub user response has no login');
    return data.login;
  }
}

/**
 * Build the remote-surface auth: an express router (OAuth metadata + endpoints +
 * the GitHub callback, mounted at root) and a bearer guard for /mcp.
 */
export function buildGitHubAuth(config: GitHubAuthConfig): RemoteAuth {
  const issuerUrl = new URL(config.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const scopesSupported = ['mcp'];
  const resourceName = 'playwright-mcp';

  // issuerUrl.href is the ONE source for the issuer identifier: createOAuthMetadata
  // publishes it as `issuer`, and the provider echoes the same string back as the
  // RFC 9207 `iss` parameter. A client comparing the two must see them match.
  const provider = new GitHubProxyOAuthProvider(config, issuerUrl.href);

  // ONE options object feeds both the SDK router and our metadata copy below.
  // mcpAuthRouter derives its metadata from these internally; if the two were
  // built from separate literals, adding an option here (baseUrl,
  // serviceDocumentationUrl, …) would silently omit it from the document we
  // actually serve, because ours shadows the SDK's.
  const authOptions = { provider, issuerUrl, resourceServerUrl, scopesSupported, resourceName };
  const oauthRouter = mcpAuthRouter(authOptions);

  // Advertise RFC 9207 support. mcpAuthRouter builds its metadata internally with
  // no hook for extra fields, so we serve the same document plus the flag from our
  // OWN metadata router mounted FIRST — express matches mounts in order, so this
  // shadows the identical routes inside oauthRouter. OAuthMetadataSchema is a
  // z.looseObject, so the added field survives client-side validation.
  const oauthMetadata = {
    ...createOAuthMetadata(authOptions),
    authorization_response_iss_parameter_supported: true,
  };

  const router = express.Router();
  router.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl, scopesSupported, resourceName }));
  router.use(oauthRouter); // /.well-known/*, /authorize, /token, /register, /revoke
  router.get('/oauth/github/callback', provider.gitHubCallback);

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  return { router, requireAuth };
}
