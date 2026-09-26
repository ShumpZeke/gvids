import type { Locator, Page } from 'playwright';

/**
 * UI text that identifies elements. Automation targets the English UI; every
 * Vids URL gvids opens carries hl=<browser.locale> (default "en") so these
 * labels are stable. Update this directory — and only this directory — when
 * Google renames something.
 */

/** Prefix of the account button's accessible name: "Google Account: Name (email)". */
export const ACCOUNT_BUTTON_PREFIX = 'Google Account:';

/** Exact-or-regex accessible name matcher. */
export type NameMatcher = string | RegExp;

export function exact(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

export function startsWith(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
}

export function button(scope: Page | Locator, name: NameMatcher): Locator {
  return scope.getByRole('button', { name });
}

export function dialog(page: Page, name?: NameMatcher): Locator {
  return name === undefined ? page.getByRole('dialog') : page.getByRole('dialog', { name });
}

/** Side sheets (AI video, voiceover, avatar, text, templates…) are ARIA complementary regions. */
export function sidePanel(page: Page, name?: NameMatcher): Locator {
  return name === undefined ? page.getByRole('complementary') : page.getByRole('complementary', { name });
}

export const COMMON_LABELS = {
  closeSideSheet: 'Close side sheet',
  close: 'Close',
  back: 'Back',
  cancel: 'Cancel',
  apply: 'Apply',
  next: 'Next',
  insert: 'Insert',
} as const;

/** Visible messages Google shows when a feature is not available to the account. */
export const AVAILABILITY_MESSAGES: Array<{
  pattern: RegExp;
  code:
    | 'FEATURE_DISABLED_BY_ADMIN'
    | 'REGIONAL_RESTRICTION'
    | 'QUOTA_EXCEEDED'
    | 'AI_GENERATION_UNAVAILABLE'
    | 'VIDS_ACCESS_REQUIRED';
}> = [
  {
    pattern: /turned off by your (administrator|admin)|your admin(istrator)? has (turned off|disabled)/i,
    code: 'FEATURE_DISABLED_BY_ADMIN',
  },
  {
    pattern: /not (yet )?available in your (country|region)|isn['’]t available in your (country|region)/i,
    code: 'REGIONAL_RESTRICTION',
  },
  {
    pattern:
      /(reached|hit) (your|the) (daily |monthly )?(limit|quota)|no (more )?generations left|out of generations/i,
    code: 'QUOTA_EXCEEDED',
  },
  {
    pattern: /(ai|gemini|generation) (features? )?(is|are) (not|n['’]t) available|can['’]t generate/i,
    code: 'AI_GENERATION_UNAVAILABLE',
  },
  {
    pattern:
      /you need (access|permission) to (use )?(google )?vids|vids isn['’]t available for your account/i,
    code: 'VIDS_ACCESS_REQUIRED',
  },
];
