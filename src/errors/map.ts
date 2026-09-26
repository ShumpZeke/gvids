import { ExitCode } from './exit-codes.js';
import {
  AuthError,
  BrowserSessionError,
  DownloadError,
  GoogleApiError,
  GvidsError,
  NotFoundError,
  PermissionError,
  UsageError,
  VidsNotFoundError,
} from './errors.js';

interface ApiErrorShape {
  status?: number;
  reason?: string;
  message?: string;
  oauthError?: string;
  networkCode?: string;
}

/** Extracts the interesting parts of a gaxios/googleapis error without depending on gaxios types. */
export function describeApiError(err: unknown): ApiErrorShape {
  if (typeof err !== 'object' || err === null) return { message: String(err) };
  const e = err as {
    message?: string;
    code?: string | number;
    status?: number;
    response?: { status?: number; data?: unknown };
    errors?: Array<{ reason?: string; message?: string }>;
  };
  const shape: ApiErrorShape = {};
  shape.status = e.response?.status ?? (typeof e.status === 'number' ? e.status : undefined);
  if (typeof e.code === 'number' && shape.status === undefined) shape.status = e.code;
  if (typeof e.code === 'string' && /^E[A-Z]+/.test(e.code)) shape.networkCode = e.code;

  const data = e.response?.data as
    | {
        error?:
          | string
          | {
              message?: string;
              status?: string;
              errors?: Array<{ reason?: string; message?: string }>;
              details?: Array<{ reason?: string; '@type'?: string }>;
            };
        error_description?: string;
      }
    | undefined;

  if (data && typeof data.error === 'string') {
    // OAuth token endpoint style: { error: 'invalid_grant', error_description: '...' }
    shape.oauthError = data.error;
    shape.message = data.error_description ?? data.error;
  } else if (data && typeof data.error === 'object' && data.error) {
    shape.message = data.error.message;
    shape.reason =
      data.error.errors?.[0]?.reason ??
      data.error.details?.find((d) => typeof d.reason === 'string')?.reason ??
      data.error.status;
  }
  if (!shape.reason && Array.isArray(e.errors) && e.errors[0]?.reason) shape.reason = e.errors[0].reason;
  if (!shape.message) shape.message = e.message;
  return shape;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const SCOPE_REASONS = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'insufficientScopes',
]);
const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);

export interface MapContext {
  /** The file ID involved, used to build a friendlier not-found error. */
  fileId?: string;
  /** Short description of what was being attempted, e.g. "rename". */
  action?: string;
}

/** Converts any error thrown by the Google API client into a typed GvidsError. */
export function mapGoogleApiError(err: unknown, ctx: MapContext = {}): GvidsError {
  if (err instanceof GvidsError) return err;
  const info = describeApiError(err);
  const action = ctx.action ? ` while trying to ${ctx.action}` : '';
  const apiMessage = info.message ?? 'Unknown Google API error';

  if (info.oauthError === 'invalid_grant') {
    return new AuthError('The stored Google OAuth token was rejected (expired or revoked).', {
      code: 'TOKEN_EXPIRED',
      hint: [
        'Run: gvids auth login',
        'If your OAuth consent screen is in "Testing" mode, Google expires refresh tokens after 7 days.',
      ],
      cause: err,
    });
  }
  if (info.oauthError === 'invalid_client' || info.oauthError === 'unauthorized_client') {
    return new AuthError(`The OAuth client was rejected by Google (${info.oauthError}).`, {
      code: 'OAUTH_CLIENT_MISSING',
      hint: [
        'Check GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or your client_secret.json.',
        'See docs/authentication.md',
      ],
      cause: err,
    });
  }
  if (info.networkCode) {
    return new GoogleApiError(`Network error contacting Google (${info.networkCode})${action}.`, {
      reason: info.networkCode,
      hint: 'Check your internet connection or proxy settings, then retry.',
      cause: err,
      retryable: true,
    });
  }

  const status = info.status;
  const reason = info.reason;

  if (status === 401) {
    return new AuthError(`Google rejected the credentials${action}.`, {
      code: 'AUTH_REQUIRED',
      details: { status, reason },
      cause: err,
    });
  }
  if (reason && SCOPE_REASONS.has(reason)) {
    return new AuthError(`The OAuth token does not include the scopes needed${action}.`, {
      code: 'INSUFFICIENT_SCOPES',
      hint: ['Run: gvids auth login --scopes full', 'See: gvids auth scopes'],
      details: { status, reason },
      cause: err,
    });
  }
  if (reason && API_DISABLED_REASONS.has(reason)) {
    return new GoogleApiError('The Google Drive API is not enabled for your OAuth client’s Cloud project.', {
      code: 'API_NOT_ENABLED',
      status,
      reason,
      hint: 'Enable it at https://console.cloud.google.com/apis/library/drive.googleapis.com and retry.',
      cause: err,
    });
  }
  if (status === 429 || (reason && RATE_LIMIT_REASONS.has(reason))) {
    return new GoogleApiError(`Google API rate limit reached${action}.`, {
      code: 'RATE_LIMITED',
      status,
      reason,
      hint: 'Wait a minute and retry.',
      cause: err,
    });
  }
  if (status === 404) {
    if (ctx.fileId) return new VidsNotFoundError(ctx.fileId, { cause: err });
    return new NotFoundError(apiMessage, { details: { status, reason }, cause: err });
  }
  if (status === 403) {
    return new PermissionError(`${apiMessage}${ctx.action ? ` (${ctx.action})` : ''}`, {
      details: { status, reason },
      hint: 'Check that the signed-in account has the required access to this file.',
      cause: err,
    });
  }
  if (reason === 'fileNotExportable' || reason === 'fileNotDownloadable' || reason === 'cannotDownloadFile') {
    // A policy/format refusal: retrying the same request cannot succeed.
    return new DownloadError(apiMessage, { details: { status, reason }, cause: err, retryable: false });
  }
  if (status === 400) {
    return new UsageError(`Google rejected the request${action}: ${apiMessage}`, {
      details: { status, reason },
      cause: err,
    });
  }
  return new GoogleApiError(`Google API error${action}: ${apiMessage}`, {
    status,
    reason,
    cause: err,
    exitCode: ExitCode.GoogleApiFailure,
  });
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Strips terminal escapes and Playwright's multi-line "Call log:" from an error message. */
export function cleanErrorMessage(message: string): string {
  const withoutLog = message.replace(ANSI, '').split(/\n\s*Call log:/)[0] ?? '';
  return withoutLog.replace(/\s+\n/g, '\n').trim() || 'Unknown error';
}

/** Playwright/CDP failures that mean the page or browser went away or never loaded. */
const BROWSER_FAILURE =
  /net::ERR_|Navigation (failed|timeout)|frame was detached|Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected|Execution context was destroyed|Protocol error|WebSocket error|connectOverCDP/i;

/** Converts an arbitrary thrown value into a GvidsError for reporting. */
export function toGvidsError(err: unknown): GvidsError {
  if (err instanceof GvidsError) return err;
  if (err instanceof Error) {
    const withResponse = err as { response?: unknown; config?: unknown };
    if (withResponse.response !== undefined || withResponse.config !== undefined) {
      return mapGoogleApiError(err);
    }
    const message = cleanErrorMessage(err.message);
    if (err.name === 'TimeoutError' || BROWSER_FAILURE.test(message)) {
      // Raw Playwright failures outside a UI step (navigation, a closed tab, a lost connection).
      return new BrowserSessionError(`The browser step failed: ${message}`, {
        cause: err,
        retryable: true,
        hint: ['Retry the command.', 'If it keeps failing: gvids browser close, then retry.'],
        next: [],
      });
    }
    return new GvidsError(message, { code: 'GENERIC_ERROR', cause: err });
  }
  return new GvidsError(cleanErrorMessage(String(err)), { code: 'GENERIC_ERROR' });
}
