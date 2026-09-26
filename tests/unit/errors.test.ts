import { describe, expect, it } from 'vitest';
import {
  AuthError,
  commandsFromHints,
  ConfirmationRequiredError,
  FeatureUnavailableError,
  GvidsError,
  shellJoin,
  UiChangedError,
} from '../../src/errors/errors.js';
import { ExitCode } from '../../src/errors/exit-codes.js';
import { describeApiError, mapGoogleApiError, toGvidsError } from '../../src/errors/map.js';

function apiError(status: number, reason?: string, message = 'boom'): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: { error: { code: status, message, errors: reason ? [{ reason, message }] : [] } },
    },
  });
}

describe('GvidsError', () => {
  it('serializes code, message, hint and details', () => {
    const err = new FeatureUnavailableError('AI is off', {
      code: 'FEATURE_DISABLED_BY_ADMIN',
      details: { feature: 'ai' },
    });
    expect(err.exitCode).toBe(ExitCode.FeatureUnavailable);
    expect(err.toJSON()).toEqual({
      code: 'FEATURE_DISABLED_BY_ADMIN',
      message: 'AI is off',
      exitCode: 6,
      retryable: false,
      needsUser: true,
      next: ['gvids capabilities --refresh'],
      hint: ['Run: gvids capabilities --refresh   to see what this account can use.'],
      details: { feature: 'ai' },
    });
  });

  it('marks retryable and user-dependent failures for agents', () => {
    expect(new UiChangedError('The Insert menu').toJSON()).toMatchObject({
      retryable: true,
      needsUser: false,
      next: ['gvids debug inspect', 'gvids doctor'],
    });
    const login = new GvidsError('sign in', { code: 'LOGIN_REQUIRED', hint: 'Run: gvids browser login' });
    expect(login.toJSON()).toMatchObject({
      retryable: false,
      needsUser: true,
      next: ['gvids browser login'],
    });
    const custom = new GvidsError('x', { code: 'UI_CHANGED', retryable: false, next: ['gvids a'] });
    expect(custom.toJSON()).toMatchObject({ retryable: false, next: ['gvids a'] });
  });

  it('extracts commands from hints only where a command is quoted plainly', () => {
    expect(
      commandsFromHints([
        'Run: gvids auth login',
        'or:  gvids doctor',
        'Resume with: gvids job resume job_1',
        'Edit or rename it first (gvids rename x "…"), or trash it in Drive.',
        'Nothing to run here.',
      ]),
    ).toEqual(['gvids auth login', 'gvids doctor', 'gvids job resume job_1']);
  });

  it('confirmation errors carry the exact approved command', () => {
    const err = new ConfirmationRequiredError('trash "Demo"', ['trash', 'abc', '--yes']);
    expect(err.toJSON()).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      needsUser: true,
      next: ['gvids trash abc --yes'],
      details: { retryArgs: ['trash', 'abc', '--yes'] },
    });
    expect(shellJoin(['gvids', 'rename', 'id', 'My "big" video'])).toBe(
      'gvids rename id "My \\"big\\" video"',
    );
  });

  it('UiChangedError gives actionable guidance', () => {
    const err = new UiChangedError("Google Vids' AI Video button", { diagnosticsDir: '/tmp/d' });
    expect(err.message).toBe("Google Vids' AI Video button could not be located.");
    expect(err.hint.join('\n')).toMatch(/gvids debug inspect/);
    expect(err.hint.join('\n')).toMatch(/gvids doctor/);
    expect(err.exitCode).toBe(ExitCode.BrowserAutomationFailure);
  });

  it('ConfirmationRequiredError is a usage error', () => {
    const err = new ConfirmationRequiredError('delete "x"');
    expect(err.code).toBe('CONFIRMATION_REQUIRED');
    expect(err.exitCode).toBe(ExitCode.InvalidArguments);
  });
});

describe('mapGoogleApiError', () => {
  it.each([
    [401, undefined, 'AUTH_REQUIRED', ExitCode.AuthRequired],
    [403, 'insufficientPermissions', 'INSUFFICIENT_SCOPES', ExitCode.AuthRequired],
    [403, 'accessNotConfigured', 'API_NOT_ENABLED', ExitCode.GoogleApiFailure],
    [403, 'userRateLimitExceeded', 'RATE_LIMITED', ExitCode.GoogleApiFailure],
    [429, undefined, 'RATE_LIMITED', ExitCode.GoogleApiFailure],
    [403, 'insufficientFilePermissions', 'PERMISSION_DENIED', ExitCode.PermissionDenied],
    [404, 'notFound', 'NOT_FOUND', ExitCode.NotFound],
    [400, 'invalid', 'INVALID_ARGUMENT', ExitCode.InvalidArguments],
    [500, 'backendError', 'GOOGLE_API_ERROR', ExitCode.GoogleApiFailure],
  ])('maps HTTP %s / %s to %s', (status, reason, code, exit) => {
    const mapped = mapGoogleApiError(apiError(status, reason));
    expect(mapped.code).toBe(code);
    expect(mapped.exitCode).toBe(exit);
  });

  it('uses the file ID for not-found errors', () => {
    const mapped = mapGoogleApiError(apiError(404, 'notFound'), { fileId: 'abc123' });
    expect(mapped.code).toBe('VIDS_NOT_FOUND');
    expect(mapped.message).toContain('abc123');
  });

  it('maps invalid_grant from the token endpoint', () => {
    const err = Object.assign(new Error('invalid_grant'), {
      response: {
        status: 400,
        data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
      },
    });
    const mapped = mapGoogleApiError(err);
    expect(mapped).toBeInstanceOf(AuthError);
    expect(mapped.code).toBe('TOKEN_EXPIRED');
    expect(mapped.hint.join(' ')).toMatch(/7 days/);
  });

  it('maps network failures', () => {
    const mapped = mapGoogleApiError(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }),
    );
    expect(mapped.message).toMatch(/Network error/);
  });

  it('passes GvidsError through', () => {
    const original = new GvidsError('x', { code: 'CONFIG_ERROR' });
    expect(mapGoogleApiError(original)).toBe(original);
    expect(toGvidsError(original)).toBe(original);
  });

  it('describes nested Google error details', () => {
    const err = Object.assign(new Error('x'), {
      response: {
        status: 403,
        data: { error: { message: 'scope', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } },
      },
    });
    expect(describeApiError(err)).toMatchObject({
      status: 403,
      reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
      message: 'scope',
    });
  });

  it('toGvidsError wraps plain errors', () => {
    const wrapped = toGvidsError(new Error('plain'));
    expect(wrapped.code).toBe('GENERIC_ERROR');
    expect(wrapped.message).toBe('plain');
    expect(toGvidsError('string').message).toBe('string');
  });
});
