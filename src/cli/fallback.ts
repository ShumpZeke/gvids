import type { AuthError } from '../errors/errors.js';

/**
 * The warning for a command that falls back from the Drive API to the Vids web
 * app. It names the reason, so an expired or under-scoped login is not mistaken
 * for "no login".
 */
export function fallbackWarning(err: AuthError, doing: string): string {
  const reason =
    err.code === 'AUTH_REQUIRED' && /authentication is required/i.test(err.message)
      ? 'No Drive API login'
      : /Drive API is turned off/.test(err.message)
        ? 'Drive API turned off'
        : `Drive API unavailable (${err.code}: ${err.message.replace(/\.$/, '')})`;
  return `${reason}; ${doing} through the Vids web app instead.`;
}
