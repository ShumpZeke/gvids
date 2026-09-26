/**
 * Process shutdown coordination. Long-lived resources (browser sessions) register
 * a cleanup here; on Ctrl+C, SIGTERM or `gvids task cancel` the CLI runs every
 * cleanup (bounded by a timeout) before it exits, so tabs are closed, browser
 * leases are released and no gvids-launched browser is orphaned.
 */

type Cleanup = () => Promise<unknown>;

const cleanups = new Set<Cleanup>();
const finalizers = new Set<(reason: ShutdownReason) => Promise<unknown>>();
let started: Promise<void> | undefined;

export type ShutdownReason = 'SIGINT' | 'SIGTERM' | 'cancel';

/** Registers a cleanup to run on shutdown. Returns a function that unregisters it. */
export function onShutdown(fn: Cleanup): () => void {
  cleanups.add(fn);
  return () => {
    cleanups.delete(fn);
  };
}

/** Registers a step that runs after all cleanups (e.g. writing the CANCELLED envelope). */
export function onShutdownFinal(fn: (reason: ShutdownReason) => Promise<unknown>): () => void {
  finalizers.add(fn);
  return () => {
    finalizers.delete(fn);
  };
}

export function isShuttingDown(): boolean {
  return started !== undefined;
}

async function bounded(tasks: Array<Promise<unknown>>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/**
 * Runs all cleanups (in parallel, at most `timeoutMs`), then the finalizers.
 * Idempotent: later calls return the first run's promise.
 */
export function shutdown(reason: ShutdownReason, timeoutMs = 8_000): Promise<void> {
  started ??= (async () => {
    await bounded(
      [...cleanups].map((fn) => fn().catch(() => undefined)),
      timeoutMs,
    );
    await bounded(
      [...finalizers].map((fn) => fn(reason).catch(() => undefined)),
      3_000,
    );
  })();
  return started;
}
