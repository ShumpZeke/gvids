import { errors, type Locator, type Page } from 'playwright';
import {
  BrowserSessionError,
  FeatureUnavailableError,
  GvidsError,
  UiChangedError,
} from '../errors/errors.js';
import type { Diagnostics } from './diagnostics/diagnostics.js';
import { AVAILABILITY_MESSAGES } from './selectors/common.js';

export interface UiContext {
  page: Page;
  diagnostics: Diagnostics;
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof errors.TimeoutError || (err instanceof Error && /Timeout \d+ms exceeded/.test(err.message))
  );
}

function isClosed(err: unknown): boolean {
  return (
    err instanceof Error &&
    /Target (page, context or browser )?(has been )?closed|Browser has been closed|browser has disconnected/i.test(
      err.message,
    )
  );
}

/** Looks for Google's "not available" messages anywhere on the page. */
export async function detectAvailabilityProblem(
  page: Page,
): Promise<{ code: (typeof AVAILABILITY_MESSAGES)[number]['code']; message: string } | undefined> {
  if (page.isClosed()) return undefined;
  const text = await page
    .evaluate(() => {
      const parts: string[] = [];
      for (const el of document.querySelectorAll(
        '[role=dialog],[role=alertdialog],[role=alert],[role=status],[role=complementary]',
      )) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) parts.push((el as HTMLElement).innerText);
      }
      return parts.join('\n').slice(0, 20_000);
    })
    .catch(() => '');
  for (const { pattern, code } of AVAILABILITY_MESSAGES) {
    const match = pattern.exec(text);
    if (match) {
      const line = text.split('\n').find((l) => pattern.test(l)) ?? match[0];
      return { code, message: line.trim().slice(0, 300) };
    }
  }
  return undefined;
}

/**
 * Runs one UI step. Playwright timeouts become UiChangedError (with a
 * screenshot and sanitized accessibility snapshot saved for debugging), or a
 * FeatureUnavailableError when Google shows an availability message.
 */
export async function uiStep<T>(ctx: UiContext, what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GvidsError) throw err;
    if (isClosed(err)) {
      throw new BrowserSessionError('The browser page was closed while gvids was using it.', { cause: err });
    }
    if (isTimeout(err)) {
      const availability = await detectAvailabilityProblem(ctx.page);
      if (availability) {
        throw new FeatureUnavailableError(`${what}: ${availability.message}`, {
          code: availability.code,
          cause: err,
        });
      }
      const capture = await ctx.diagnostics.captureFailure(ctx.page, what, err);
      throw new UiChangedError(what, {
        cause: err,
        ...(capture ? { diagnosticsDir: capture.dir, details: { files: capture.files } } : {}),
      });
    }
    throw err;
  }
}

/**
 * Marks a pre-armed event promise (waitForEvent('download'|'filechooser')) as
 * handled, so a failure in the steps before it is awaited cannot crash the
 * process with an unhandled rejection. Awaiting it still throws.
 */
export function armed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** A Playwright-style timeout, so uiStep classifies it like a failed locator wait. */
export function timeoutError(message: string): Error {
  return new errors.TimeoutError(message);
}

/** The accessible name of the first element a locator matches (from its ARIA snapshot). */
export async function accessibleName(locator: Locator): Promise<string> {
  const snapshot = await locator.first().ariaSnapshot({ timeout: 5_000 });
  const m = /^- [\w-]+ "((?:[^"\\]|\\.)*)"/.exec(snapshot.trim());
  return m ? m[1]!.replace(/\\"/g, '"') : '';
}

/** Returns true when the locator becomes visible within the timeout. */
export async function appears(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** First visible element among a locator's matches. */
export function firstVisible(locator: Locator): Locator {
  return locator.filter({ visible: true }).first();
}
