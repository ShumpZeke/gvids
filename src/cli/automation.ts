import type { VidsAutomation } from '../browser/operations/automation.js';
import type { CommandContext } from './context.js';

export interface AutomationControl {
  /** ctx.confirm(), for confirmations that need data read in the browser first. */
  confirm(question: string, action: string): Promise<void>;
}

/**
 * Runs `fn` with a VidsAutomation bound to a fresh (or reused) browser session,
 * restores the editor UI, waits for Drive to save, and always closes the session.
 */
export async function withAutomation<T>(
  ctx: CommandContext,
  label: string,
  fn: (auto: VidsAutomation, control: AutomationControl) => Promise<T>,
): Promise<T> {
  const spinner = ctx.out.spinner(`${label}…`);
  const session = await ctx.browserSession().catch((err: unknown) => {
    spinner.fail();
    throw err;
  });
  const { VidsAutomation } = await import('../browser/operations/automation.js');
  const auto = new VidsAutomation(session, ctx.config, ctx.logger, {
    label,
    // Waiting for another command on the same video counts against this command's --timeout.
    lockTimeoutMs: ctx.timeoutMs(10 * 60_000),
  });
  const control: AutomationControl = {
    confirm: (question, action) => ctx.confirm(question, action),
  };
  let ok = false;
  try {
    const result = await fn(auto, control);
    spinner.update('Saving to Drive…');
    await auto.finish();
    ok = true;
    return result;
  } finally {
    if (ok) spinner.stop();
    else spinner.fail();
    // After success, healthy editor tabs stay open (idle) for the next command on the same video.
    const closed = await session.close({ releaseIdle: ok });
    if (closed.trace)
      ctx.out.info(`Playwright trace: ${closed.trace}  (view: npx playwright show-trace "${closed.trace}")`);
    if (closed.log) ctx.out.detail(`Browser log: ${closed.log}`);
  }
}
