/**
 * Process exit codes. These are part of the public contract of the CLI and are
 * documented in docs/commands.md — do not renumber.
 */
export const ExitCode = {
  Success: 0,
  GenericError: 1,
  InvalidArguments: 2,
  AuthRequired: 3,
  PermissionDenied: 4,
  NotFound: 5,
  FeatureUnavailable: 6,
  BrowserAutomationFailure: 7,
  GenerationTimeout: 8,
  GoogleApiFailure: 9,
  Cancelled: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export const EXIT_CODE_DESCRIPTIONS: Record<ExitCodeValue, string> = {
  0: 'success',
  1: 'generic error',
  2: 'invalid arguments or usage',
  3: 'authentication required (OAuth or browser sign-in)',
  4: 'permission denied',
  5: 'not found',
  6: 'feature unavailable for this account, region, or UI',
  7: 'browser automation failure (UI changed, session problem)',
  8: 'generation or render timeout',
  9: 'Google API failure',
  130: 'cancelled by user',
};
