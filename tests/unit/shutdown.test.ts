/**
 * Shutdown (Ctrl+C, SIGTERM, `gvids task cancel`) is process-wide state, so these
 * tests live in their own file (vitest isolates modules per file).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../../src/automation/tasks.js';
import { isShuttingDown, onShutdown, onShutdownFinal, shutdown } from '../../src/utils/shutdown.js';
import { cli, tempHome } from '../helpers/cli.js';

describe('shutdown', () => {
  it('runs cleanups, then finalizers, once; failures after it are reported as CANCELLED', async () => {
    const order: string[] = [];
    onShutdown(async () => {
      order.push('cleanup');
    });
    onShutdown(async () => {
      throw new Error('a failing cleanup does not stop the others');
    });
    onShutdownFinal(async (reason) => {
      order.push(`final:${reason}`);
    });
    expect(isShuttingDown()).toBe(false);
    await Promise.all([shutdown('cancel'), shutdown('SIGINT')]);
    expect(order).toEqual(['cleanup', 'final:cancel']);
    expect(isShuttingDown()).toBe(true);

    // A command torn down mid-way (its tabs closed) reports the cancellation, not the side effect.
    const r = await cli(['info', 'short']);
    expect(r.code).toBe(130);
    expect(r.json?.error).toMatchObject({ code: 'CANCELLED', exitCode: 130 });

    // A --detach worker records the task as cancelled.
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['info', 'short'], home);
    await store.markStarted(task.id, process.pid);
    await cli(['info', 'short'], { home, env: { GVIDS_TASK_ID: task.id } });
    expect(await store.get(task.id)).toMatchObject({ status: 'cancelled', exitCode: 130 });
  });
});
