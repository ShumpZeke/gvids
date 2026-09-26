import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CodeChallengeMethod,
  GoogleAuth,
  OAuth2Client,
  type AuthClient,
  type Credentials,
} from 'google-auth-library';
import { AuthError, CancelledError, GvidsError } from '../errors/errors.js';
import { mapGoogleApiError } from '../errors/map.js';
import type { GvidsConfig } from '../config/config.js';
import type { GvidsPaths } from '../config/paths.js';
import type { Logger } from '../utils/logger.js';
import { mask } from '../utils/redact.js';
import {
  requireClientCredentials,
  resolveClientCredentials,
  type OAuthClientCredentials,
} from './client-credentials.js';
import { scopesFor, type ScopeProfile } from './scopes.js';
import {
  clearStoreMarker,
  FileTokenStore,
  KeyringTokenStore,
  selectTokenStore,
  type StoredToken,
  type TokenStore,
} from './token-store.js';

export type AuthMethod = 'oauth' | 'access-token-env' | 'refresh-token-env' | 'service-account' | 'none';

export interface AuthStatus {
  authenticated: boolean;
  method: AuthMethod;
  account?: { email?: string; name?: string };
  scopes?: string[];
  tokenStore?: { kind: string; location: string };
  client?: { clientId: string; source: string };
  accessTokenExpiresAt?: string;
  verified?: boolean;
  problem?: string;
  /** Error code behind `problem` (AUTH_REQUIRED, OAUTH_CLIENT_MISSING, TOKEN_EXPIRED, …). */
  problemCode?: string;
  /** Hints of the error behind `problem`. */
  problemHint?: string[];
}

export interface LoopbackLoginOptions {
  credentials: OAuthClientCredentials;
  scopes: string[];
  /** Show the consent URL (always called, so headless users can copy it). */
  onUrl: (url: string) => void;
  /** Try to open the system browser. Failures are ignored. */
  openBrowser?: (url: string) => Promise<void>;
  port?: number;
  timeoutMs?: number;
  loginHint?: string;
  signal?: AbortSignal;
}

const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>gvids</title>
<body style="font-family:system-ui;margin:3rem;max-width:40rem">
<h2>gvids is now signed in.</h2><p>You can close this tab and return to the terminal.</p></body>`;

const FAILURE_PAGE = (reason: string): string => `<!doctype html><meta charset="utf-8"><title>gvids</title>
<body style="font-family:system-ui;margin:3rem;max-width:40rem">
<h2>Sign-in was not completed.</h2><p>${reason.replace(/[<>&]/g, '')}</p><p>Return to the terminal for details.</p></body>`;

/**
 * OAuth 2.0 for installed apps: loopback redirect on 127.0.0.1 with PKCE
 * (S256) and a random state parameter. Tokens never touch stdout.
 */
export async function runLoopbackLogin(options: LoopbackLoginOptions): Promise<Credentials> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = new OAuth2Client({
    clientId: options.credentials.clientId,
    ...(options.credentials.clientSecret ? { clientSecret: options.credentials.clientSecret } : {}),
    redirectUri,
  });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: options.scopes,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });

  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE(error));
        reject(
          new AuthError(
            error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${error}`,
          ),
        );
        return;
      }
      if (!code || returnedState !== state) {
        res
          .writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(FAILURE_PAGE('Unexpected request (state mismatch).'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE);
      resolve(code);
    });
    timer = setTimeout(
      () =>
        reject(new AuthError(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Google sign-in.`)),
      timeoutMs,
    );
    options.signal?.addEventListener('abort', () => reject(new CancelledError('Sign-in cancelled.')), {
      once: true,
    });
  });

  try {
    options.onUrl(authUrl);
    if (options.openBrowser) await options.openBrowser(authUrl).catch(() => undefined);
    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new AuthError('Google did not return a refresh token.', {
        hint: 'Remove gvids from https://myaccount.google.com/permissions and run gvids auth login again.',
      });
    }
    return tokens;
  } catch (err) {
    throw err instanceof GvidsError ? err : mapGoogleApiError(err, { action: 'complete sign-in' });
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  }
}

export interface AuthManagerDeps {
  config: GvidsConfig;
  paths: GvidsPaths;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

interface ResolvedClient {
  client: AuthClient;
  method: AuthMethod;
  store?: TokenStore;
  credentials?: OAuthClientCredentials;
  stored?: StoredToken;
}

/** Central place that knows how gvids authenticates to Google APIs. */
export class AuthManager {
  private resolved: ResolvedClient | undefined;

  constructor(private readonly deps: AuthManagerDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env;
  }

  /** Returns an authorized client or throws AuthError. */
  async getClient(): Promise<AuthClient> {
    return (await this.resolve()).client;
  }

  async getAccessToken(): Promise<string> {
    const client = await this.getClient();
    try {
      const { token } = await client.getAccessToken();
      if (!token) throw new AuthError('Could not obtain a Google access token.');
      return token;
    } catch (err) {
      throw mapGoogleApiError(err, { action: 'refresh the access token' });
    }
  }

  async getRequestHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }

  private async resolve(): Promise<ResolvedClient> {
    if (this.resolved) return this.resolved;
    const env = this.env;
    const accessToken = env.GVIDS_ACCESS_TOKEN;
    if (accessToken) {
      const client = new OAuth2Client();
      client.setCredentials({ access_token: accessToken });
      this.resolved = { client, method: 'access-token-env' };
      return this.resolved;
    }
    const saFile = env.GVIDS_SERVICE_ACCOUNT_FILE;
    if (saFile) {
      const subject = env.GVIDS_IMPERSONATE;
      const auth = new GoogleAuth({
        keyFile: saFile,
        scopes: scopesFor(this.deps.config.auth.scopes),
        ...(subject ? { clientOptions: { subject } } : {}),
      });
      this.resolved = { client: (await auth.getClient()) as AuthClient, method: 'service-account' };
      return this.resolved;
    }
    const envRefresh = env.GVIDS_REFRESH_TOKEN ?? env.GOOGLE_REFRESH_TOKEN;
    if (envRefresh) {
      const credentials = await requireClientCredentials(this.clientOptions());
      const client = this.makeOAuthClient(credentials);
      client.setCredentials({ refresh_token: envRefresh });
      this.resolved = { client, method: 'refresh-token-env', credentials };
      return this.resolved;
    }

    const store = await selectTokenStore(this.deps.config.auth.tokenStore, this.deps.paths);
    let stored: StoredToken | undefined;
    try {
      stored = await store.load();
    } catch (err) {
      throw new AuthError(`Could not read stored credentials from ${store.location}.`, { cause: err });
    }
    if (!stored?.refresh_token) {
      throw new AuthError('Google authentication is required.', {
        hint: ['Run: gvids auth login', 'For CI, set GVIDS_REFRESH_TOKEN with GOOGLE_CLIENT_ID/SECRET.'],
      });
    }
    const credentials = await resolveClientCredentials(this.clientOptions());
    if (!credentials) {
      throw new AuthError('A stored login exists but the OAuth client that created it is not configured.', {
        code: 'OAUTH_CLIENT_MISSING',
        hint: 'Restore client_secret.json or set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, then retry.',
      });
    }
    if (credentials.clientId !== stored.client_id) {
      throw new AuthError('The stored login was created with a different OAuth client.', {
        hint: 'Run: gvids auth login',
        details: { storedClient: mask(stored.client_id), configuredClient: mask(credentials.clientId) },
      });
    }
    const client = this.makeOAuthClient(credentials);
    client.setCredentials({
      refresh_token: stored.refresh_token,
      ...(stored.access_token ? { access_token: stored.access_token } : {}),
      ...(stored.expiry_date ? { expiry_date: stored.expiry_date } : {}),
      ...(stored.scope ? { scope: stored.scope } : {}),
    });
    client.on('tokens', (tokens: Credentials) => {
      // Persist refreshed access tokens so the next command skips a refresh round-trip.
      const next: StoredToken = {
        ...stored,
        ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
        ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      };
      store.save(next).catch((err: unknown) => this.deps.logger.debug({ err }, 'could not persist token'));
    });
    this.resolved = { client, method: 'oauth', store, credentials, stored };
    return this.resolved;
  }

  private clientOptions(): { env: NodeJS.ProcessEnv; clientSecretFile?: string } {
    const file = this.deps.config.auth.clientSecretFile;
    return { env: this.env, ...(file ? { clientSecretFile: file } : {}) };
  }

  private makeOAuthClient(credentials: OAuthClientCredentials): OAuth2Client {
    return new OAuth2Client({
      clientId: credentials.clientId,
      ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
    });
  }

  async login(options: {
    scopes?: ScopeProfile;
    clientId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    onUrl: (url: string) => void;
    openBrowser?: (url: string) => Promise<void>;
    port?: number;
    loginHint?: string;
    timeoutMs?: number;
  }): Promise<AuthStatus> {
    const credentials = await requireClientCredentials({
      env: this.env,
      ...(options.clientId ? { clientId: options.clientId } : {}),
      ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
      ...((options.clientSecretFile ?? this.deps.config.auth.clientSecretFile)
        ? { clientSecretFile: options.clientSecretFile ?? this.deps.config.auth.clientSecretFile }
        : {}),
    });
    const scopes = scopesFor(options.scopes ?? this.deps.config.auth.scopes);
    const tokens = await runLoopbackLogin({
      credentials,
      scopes,
      onUrl: options.onUrl,
      ...(options.openBrowser ? { openBrowser: options.openBrowser } : {}),
      ...(options.port ? { port: options.port } : {}),
      ...(options.loginHint ? { loginHint: options.loginHint } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    const client = this.makeOAuthClient(credentials);
    client.setCredentials(tokens);
    const account = await fetchAccount(client).catch(() => undefined);
    const stored: StoredToken = {
      refresh_token: tokens.refresh_token ?? undefined,
      ...(tokens.access_token ? { access_token: tokens.access_token } : {}),
      ...(tokens.expiry_date ? { expiry_date: tokens.expiry_date } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      token_type: tokens.token_type ?? 'Bearer',
      client_id: credentials.clientId,
      ...(account ? { account } : {}),
      created_at: new Date().toISOString(),
    };
    const store = await selectTokenStore(this.deps.config.auth.tokenStore, this.deps.paths, {
      forWrite: true,
    });
    await store.save(stored);
    this.resolved = undefined;
    return {
      authenticated: true,
      method: 'oauth',
      ...(account ? { account } : {}),
      scopes: (tokens.scope ?? scopes.join(' ')).split(/\s+/).filter(Boolean),
      tokenStore: { kind: store.kind, location: store.location },
      client: { clientId: mask(credentials.clientId), source: credentials.source },
      verified: account !== undefined,
    };
  }

  async logout(options: { revoke: boolean }): Promise<{ revoked: boolean; cleared: string[] }> {
    const cleared: string[] = [];
    let revoked = false;
    const keyring = new KeyringTokenStore();
    const file = new FileTokenStore(this.deps.paths.tokenFile);
    let stored: StoredToken | undefined;
    for (const store of [keyring, file] as TokenStore[]) {
      try {
        stored = stored ?? (await store.load());
      } catch {
        // ignore unreadable stores
      }
    }
    if (options.revoke && stored?.refresh_token) {
      try {
        const client = new OAuth2Client();
        await client.revokeToken(stored.refresh_token);
        revoked = true;
      } catch (err) {
        this.deps.logger.debug({ err: String(err) }, 'token revoke failed');
      }
    }
    for (const store of [keyring, file] as TokenStore[]) {
      if (await store.clear()) cleared.push(store.kind);
    }
    await clearStoreMarker(this.deps.paths);
    this.resolved = undefined;
    return { revoked, cleared };
  }

  async status(options: { verify: boolean }): Promise<AuthStatus> {
    let resolved: ResolvedClient;
    try {
      resolved = await this.resolve();
    } catch (err) {
      const mapped = err instanceof GvidsError ? err : mapGoogleApiError(err);
      const credentials = await resolveClientCredentials(this.clientOptions()).catch(() => undefined);
      return {
        authenticated: false,
        method: 'none',
        problem: mapped.message,
        problemCode: mapped.code,
        ...(mapped.hint.length > 0 ? { problemHint: mapped.hint } : {}),
        ...(credentials
          ? { client: { clientId: mask(credentials.clientId), source: credentials.source } }
          : {}),
      };
    }
    const status: AuthStatus = {
      authenticated: true,
      method: resolved.method,
      ...(resolved.stored?.account ? { account: resolved.stored.account } : {}),
      ...(resolved.stored?.scope ? { scopes: resolved.stored.scope.split(/\s+/).filter(Boolean) } : {}),
      ...(resolved.store
        ? { tokenStore: { kind: resolved.store.kind, location: resolved.store.location } }
        : {}),
      ...(resolved.credentials
        ? { client: { clientId: mask(resolved.credentials.clientId), source: resolved.credentials.source } }
        : {}),
    };
    if (!options.verify) return status;
    try {
      const token = await this.getAccessToken();
      if (resolved.client instanceof OAuth2Client) {
        const info = await resolved.client.getTokenInfo(token);
        status.scopes = info.scopes;
        if (info.expiry_date) status.accessTokenExpiresAt = new Date(info.expiry_date).toISOString();
      }
      const account = await fetchAccount(resolved.client);
      status.account = account;
      status.verified = true;
    } catch (err) {
      const mapped = err instanceof GvidsError ? err : mapGoogleApiError(err);
      status.authenticated = false;
      status.verified = false;
      status.problem = mapped.message;
      status.problemCode = mapped.code;
      if (mapped.hint.length > 0) status.problemHint = mapped.hint;
    }
    return status;
  }
}

/** Uses Drive about.get so no extra userinfo/email scope is needed. */
export async function fetchAccount(client: AuthClient): Promise<{ email?: string; name?: string }> {
  const res = await client.request<{ user?: { emailAddress?: string; displayName?: string } }>({
    url: 'https://www.googleapis.com/drive/v3/about',
    params: { fields: 'user(displayName,emailAddress)' },
  });
  const user = res.data.user ?? {};
  return {
    ...(user.emailAddress ? { email: user.emailAddress } : {}),
    ...(user.displayName ? { name: user.displayName } : {}),
  };
}
