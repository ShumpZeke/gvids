import type { Page } from 'playwright';
import {
  isGoogleSignInUrl,
  isVidsEditorUrl,
  isVidsHomeUrl,
  vidsHomeUrl,
  type VidsUrlOptions,
} from '../../vids/urls.js';
import { sleep } from '../../utils/time.js';
import { ACCOUNT_BUTTON_PREFIX } from '../selectors/common.js';

export interface SignInState {
  signedIn: boolean;
  /** False when the account is signed in but Vids is not available to it. */
  vidsAccess: boolean;
  email?: string;
  /** Sanitized final URL kind, for diagnostics. */
  landedOn: 'vids-home' | 'vids-editor' | 'sign-in' | 'marketing' | 'other';
}

const EMAIL_IN_LABEL = /\(([^()\s]+@[^()\s]+)\)/;

/** Reads the signed-in account e-mail from the Google account button, if present. */
export async function readAccountEmail(page: Page): Promise<string | undefined> {
  const label = await page
    .locator(`[aria-label^="${ACCOUNT_BUTTON_PREFIX}"]`)
    .first()
    .getAttribute('aria-label', { timeout: 5000 })
    .catch(() => null);
  return label ? EMAIL_IN_LABEL.exec(label)?.[1] : undefined;
}

export function classifyUrl(url: string): SignInState['landedOn'] {
  if (isGoogleSignInUrl(url)) return 'sign-in';
  if (isVidsEditorUrl(url)) return 'vids-editor';
  if (isVidsHomeUrl(url)) return 'vids-home';
  if (/^https:\/\/(workspace\.google\.com|vids\.google\.com)/.test(url)) return 'marketing';
  return 'other';
}

/**
 * Loads the Vids home page and reports whether the browser profile is signed
 * in. Google redirects signed-out sessions to accounts.google.com.
 */
export async function detectSignIn(
  page: Page,
  urlOptions: VidsUrlOptions,
  timeoutMs = 45_000,
): Promise<SignInState> {
  await page.goto(vidsHomeUrl(urlOptions), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const landedOn = classifyUrl(page.url());
    if (landedOn === 'sign-in') return { signedIn: false, vidsAccess: false, landedOn };
    if (landedOn === 'marketing') return { signedIn: true, vidsAccess: false, landedOn };
    if (landedOn === 'vids-home' || landedOn === 'vids-editor') {
      const email = await readAccountEmail(page);
      if (email) return { signedIn: true, vidsAccess: true, email, landedOn };
    }
    await sleep(300);
  }
  const landedOn = classifyUrl(page.url());
  return {
    signedIn: landedOn === 'vids-home' || landedOn === 'vids-editor',
    vidsAccess: landedOn === 'vids-home' || landedOn === 'vids-editor',
    landedOn,
  };
}

/**
 * Waits while the user signs in by hand in a visible window. Returns once the
 * Vids home (or an editor) is shown with an account button.
 */
export async function waitForManualSignIn(page: Page, timeoutMs: number): Promise<SignInState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return { signedIn: false, vidsAccess: false, landedOn: 'other' };
    }
    const landedOn = classifyUrl(page.url());
    if (landedOn === 'vids-home' || landedOn === 'vids-editor') {
      const email = await readAccountEmail(page);
      if (email) return { signedIn: true, vidsAccess: true, email, landedOn };
    }
    if (landedOn === 'marketing') return { signedIn: true, vidsAccess: false, landedOn };
    await sleep(1000);
  }
  return { signedIn: false, vidsAccess: false, landedOn: classifyUrl(page.url()) };
}
