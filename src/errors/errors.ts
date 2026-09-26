import { ExitCode, type ExitCodeValue } from './exit-codes.js';

export type ErrorCode =
  | 'GENERIC_ERROR'
  | 'INVALID_ARGUMENT'
  | 'CONFIRMATION_REQUIRED'
  | 'AUTH_REQUIRED'
  | 'OAUTH_CLIENT_MISSING'
  | 'TOKEN_EXPIRED'
  | 'INSUFFICIENT_SCOPES'
  | 'LOGIN_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'VIDS_NOT_FOUND'
  | 'VIDEO_IN_TRASH'
  | 'NOT_A_VID'
  | 'FEATURE_UNAVAILABLE'
  | 'FEATURE_DISABLED_BY_ADMIN'
  | 'VIDS_ACCESS_REQUIRED'
  | 'AI_GENERATION_UNAVAILABLE'
  | 'REGIONAL_RESTRICTION'
  | 'QUOTA_EXCEEDED'
  | 'BROWSER_NOT_FOUND'
  | 'BROWSER_SESSION_ERROR'
  | 'BROWSER_PROFILE_LOCKED'
  | 'UI_CHANGED'
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_FAILED'
  | 'DOWNLOAD_ERROR'
  | 'GOOGLE_API_ERROR'
  | 'API_NOT_ENABLED'
  | 'RATE_LIMITED'
  | 'CONFIG_ERROR'
  | 'WORKFLOW_INVALID'
  | 'JOB_NOT_FOUND'
  | 'JOB_LOCKED'
  | 'TASK_NOT_FOUND'
  | 'STILL_RUNNING'
  | 'VIDEO_BUSY'
  | 'BATCH_FAILED'
  | 'NOT_READY'
  | 'USER_ACTION_REQUIRED'
  | 'TIMEOUT'
  | 'CANCELLED';

/** Failures worth retrying as-is (possibly with a longer --timeout). */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'GENERATION_TIMEOUT',
  'TIMEOUT',
  'BROWSER_SESSION_ERROR',
  'UI_CHANGED',
  'DOWNLOAD_ERROR',
  'STILL_RUNNING',
  'VIDEO_BUSY',
]);

/** Failures only a person can resolve (sign-in, consent, approval, admin or plan changes). */
const NEEDS_USER: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'AUTH_REQUIRED',
  'OAUTH_CLIENT_MISSING',
  'TOKEN_EXPIRED',
  'INSUFFICIENT_SCOPES',
  'LOGIN_REQUIRED',
  'CONFIRMATION_REQUIRED',
  'PERMISSION_DENIED',
  'VIDS_ACCESS_REQUIRED',
  'FEATURE_DISABLED_BY_ADMIN',
  'REGIONAL_RESTRICTION',
  'QUOTA_EXCEEDED',
  'API_NOT_ENABLED',
  'BROWSER_NOT_FOUND',
  'BROWSER_PROFILE_LOCKED',
  'NOT_READY',
  'USER_ACTION_REQUIRED',
]);

/** Pulls runnable commands out of hints such as "Run: gvids auth login" or "or:  gvids doctor". */
export function commandsFromHints(hints: string[]): string[] {
  const out: string[] = [];
  for (const hint of hints) {
    const m = /(?:^|:\s+)(gvids [^()\n]*?)(?:\s{2,}.*)?$/.exec(hint.trim());
    if (m && !out.includes(m[1]!.trim())) out.push(m[1]!.trim());
  }
  return out;
}

export interface GvidsErrorOptions {
  code?: ErrorCode;
  exitCode?: ExitCodeValue;
  /** Actionable next steps shown to the user (one per line). */
  hint?: string | string[];
  /** Machine-readable extra information. Must never contain secrets. */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** Override the per-code default: is retrying the same command reasonable? */
  retryable?: boolean;
  /** Override the per-code default: must a person act before this can succeed? */
  needsUser?: boolean;
  /** Commands to run next (default: those mentioned in the hints). */
  next?: string[];
}

/** The `error` object of a JSON envelope. */
export interface SerializedError {
  code: ErrorCode;
  message: string;
  /** Process exit code (also returned by the command). */
  exitCode: number;
  /** Retrying the same command (maybe with a longer --timeout) can succeed. */
  retryable: boolean;
  /** A person must act first (sign in, consent, approve, change settings); ask them. */
  needsUser: boolean;
  /** Suggested next commands, most useful first. */
  next?: string[];
  hint?: string[];
  details?: Record<string, unknown>;
}

/** Base class for every error the CLI reports deliberately. */
export class GvidsError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCodeValue;
  readonly hint: string[];
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;
  readonly needsUser: boolean;
  readonly next: string[];

  constructor(message: string, options: GvidsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'GENERIC_ERROR';
    this.exitCode = options.exitCode ?? ExitCode.GenericError;
    this.hint = options.hint === undefined ? [] : Array.isArray(options.hint) ? options.hint : [options.hint];
    this.details = options.details;
    this.retryable = options.retryable ?? RETRYABLE.has(this.code);
    this.needsUser = options.needsUser ?? NEEDS_USER.has(this.code);
    this.next = options.next ?? commandsFromHints(this.hint);
  }

  toJSON(): SerializedError {
    const out: SerializedError = {
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
      retryable: this.retryable,
      needsUser: this.needsUser,
    };
    if (this.next.length > 0) out.next = this.next;
    if (this.hint.length > 0) out.hint = this.hint;
    if (this.details && Object.keys(this.details).length > 0) out.details = this.details;
    return out;
  }
}

type SubclassOptions = Omit<GvidsErrorOptions, 'exitCode'>;

export class UsageError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'INVALID_ARGUMENT', ...options, exitCode: ExitCode.InvalidArguments });
  }
}

export class ConfirmationRequiredError extends GvidsError {
  /** `retry` is the exact argv to run once the user has approved (it includes --yes). */
  constructor(action: string, retry?: string[]) {
    super(`Refusing to ${action} without confirmation.`, {
      code: 'CONFIRMATION_REQUIRED',
      exitCode: ExitCode.InvalidArguments,
      hint: "Get the user's approval, then re-run the same command with --yes.",
      ...(retry ? { next: [shellJoin(['gvids', ...retry])], details: { action, retryArgs: retry } } : {}),
    });
  }
}

/** Joins argv for display, quoting arguments that a shell would split or expand. */
export function shellJoin(args: string[]): string {
  return args
    .map((a) =>
      a === '' ? '""' : /^[A-Za-z0-9_@%+=:,./#-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`,
    )
    .join(' ');
}

export class AuthError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, {
      code: 'AUTH_REQUIRED',
      hint: 'Run: gvids auth login',
      ...options,
      exitCode: ExitCode.AuthRequired,
    });
  }
}

export class BrowserLoginRequiredError extends GvidsError {
  constructor(
    message = 'The gvids browser profile is not signed in to Google.',
    options: SubclassOptions = {},
  ) {
    super(message, {
      code: 'LOGIN_REQUIRED',
      hint: [
        'Run: gvids browser login',
        'or connect to a Chrome you are already signed into: gvids browser connect http://127.0.0.1:9222',
      ],
      ...options,
      exitCode: ExitCode.AuthRequired,
    });
  }
}

export class PermissionError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'PERMISSION_DENIED', ...options, exitCode: ExitCode.PermissionDenied });
  }
}

export class NotFoundError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'NOT_FOUND', ...options, exitCode: ExitCode.NotFound });
  }
}

export class VidsNotFoundError extends NotFoundError {
  constructor(id: string, options: SubclassOptions = {}) {
    super(`Google Vids file not found or not accessible: ${id}`, {
      code: 'VIDS_NOT_FOUND',
      hint: [
        'Check the ID or URL, and that the signed-in account can open it.',
        'A video that was started but never edited is not saved to Drive yet.',
        'List your videos with: gvids list',
      ],
      details: { id },
      ...options,
    });
  }
}

export class NotAVidError extends GvidsError {
  constructor(id: string, mimeType: string | undefined) {
    super(`File ${id} is not a Google Vids file (mimeType: ${mimeType ?? 'unknown'}).`, {
      code: 'NOT_A_VID',
      exitCode: ExitCode.InvalidArguments,
      details: { id, mimeType },
      hint: 'gvids only manages files with mimeType application/vnd.google-apps.vid.',
    });
  }
}

export type FeatureErrorCode =
  | 'FEATURE_UNAVAILABLE'
  | 'FEATURE_DISABLED_BY_ADMIN'
  | 'VIDS_ACCESS_REQUIRED'
  | 'AI_GENERATION_UNAVAILABLE'
  | 'REGIONAL_RESTRICTION'
  | 'QUOTA_EXCEEDED';

export class FeatureUnavailableError extends GvidsError {
  constructor(message: string, options: Omit<SubclassOptions, 'code'> & { code?: FeatureErrorCode } = {}) {
    super(message, {
      hint: 'Run: gvids capabilities --refresh   to see what this account can use.',
      ...options,
      code: options.code ?? 'FEATURE_UNAVAILABLE',
      exitCode: ExitCode.FeatureUnavailable,
    });
  }
}

export class BrowserSessionError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, {
      code: 'BROWSER_SESSION_ERROR',
      hint: ['Run: gvids doctor', 'Run: gvids browser status'],
      ...options,
      exitCode: ExitCode.BrowserAutomationFailure,
    });
  }
}

export class UiChangedError extends GvidsError {
  constructor(what: string, options: SubclassOptions & { diagnosticsDir?: string } = {}) {
    const hint = [
      'The Google Vids interface may have changed.',
      'Run: gvids debug inspect',
      'or:  gvids doctor',
    ];
    if (options.diagnosticsDir) hint.push(`Diagnostics saved to: ${options.diagnosticsDir}`);
    super(`${what} could not be located.`, {
      code: 'UI_CHANGED',
      ...options,
      hint: options.hint ?? hint,
      exitCode: ExitCode.BrowserAutomationFailure,
    });
  }
}

export class GenerationTimeoutError extends GvidsError {
  constructor(what: string, timeoutMs: number, options: SubclassOptions = {}) {
    super(`${what} did not finish within ${Math.round(timeoutMs / 1000)}s.`, {
      code: 'GENERATION_TIMEOUT',
      hint: 'Increase the limit with --timeout (for example --timeout 20m), or check the video in the browser.',
      details: { timeoutMs },
      ...options,
      exitCode: ExitCode.GenerationTimeout,
    });
  }
}

export class GenerationFailedError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'GENERATION_FAILED', ...options, exitCode: ExitCode.BrowserAutomationFailure });
  }
}

export class DownloadError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'DOWNLOAD_ERROR', ...options, exitCode: ExitCode.GoogleApiFailure });
  }
}

export class GoogleApiError extends GvidsError {
  readonly status: number | undefined;
  readonly reason: string | undefined;

  constructor(
    message: string,
    options: SubclassOptions & { status?: number; reason?: string; exitCode?: ExitCodeValue } = {},
  ) {
    super(message, {
      code: options.code ?? 'GOOGLE_API_ERROR',
      hint: options.hint,
      details: { ...options.details, status: options.status, reason: options.reason },
      cause: options.cause,
      exitCode: options.exitCode ?? ExitCode.GoogleApiFailure,
      // Server-side (5xx) failures are transient; client errors are not.
      ...(options.retryable !== undefined
        ? { retryable: options.retryable }
        : options.status !== undefined && options.status >= 500
          ? { retryable: true }
          : {}),
    });
    this.status = options.status;
    this.reason = options.reason;
  }
}

export class ConfigError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'CONFIG_ERROR', ...options, exitCode: ExitCode.InvalidArguments });
  }
}

export class WorkflowError extends GvidsError {
  constructor(message: string, options: SubclassOptions = {}) {
    super(message, { code: 'WORKFLOW_INVALID', ...options, exitCode: ExitCode.InvalidArguments });
  }
}

export class CancelledError extends GvidsError {
  constructor(message = 'Cancelled.') {
    super(message, { code: 'CANCELLED', exitCode: ExitCode.Cancelled });
  }
}

export class TimeoutError extends GvidsError {
  constructor(what: string, timeoutMs: number, options: SubclassOptions = {}) {
    super(`${what} timed out after ${Math.round(timeoutMs / 1000)}s.`, {
      code: 'TIMEOUT',
      details: { timeoutMs },
      hint: 'Retry, or increase the limit with --timeout.',
      ...options,
      exitCode: ExitCode.GenerationTimeout,
    });
  }
}

export function isGvidsError(value: unknown): value is GvidsError {
  return value instanceof GvidsError;
}

/**
 * Returns a copy of `error` with extra `next` commands and `details` (e.g. the
 * job ID of a failed workflow step), keeping its code, exit code and flags.
 */
export function withContext(
  error: GvidsError,
  extra: { next?: string[]; details?: Record<string, unknown>; hint?: string[] },
): GvidsError {
  const next = [...(extra.next ?? []), ...error.next.filter((n) => !extra.next?.includes(n))];
  const copy = new GvidsError(error.message, {
    code: error.code,
    exitCode: error.exitCode,
    hint: [...error.hint, ...(extra.hint ?? [])],
    details: { ...error.details, ...extra.details },
    retryable: error.retryable,
    needsUser: error.needsUser,
    next,
    cause: error,
  });
  copy.name = error.name;
  return copy;
}
