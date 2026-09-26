/**
 * Live tests of gvids as separate processes (the built CLI, like an agent runs it):
 * parallel commands sharing one browser, background tasks, cancellation, and the
 * browser lifecycle. Opt-in: GVIDS_LIVE=1 after `pnpm build`, with a signed-in
 * gvids browser. Uses one video it creates and moves it to the trash at the end.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.GVIDS_LIVE === '1';
const entry = path.resolve('dist', 'cli', 'index.js');
type Env = { ok: boolean; data: any; error: any; warnings?: string[] };

function gvids(args: string[]): Promise<{ code: number; env: Env; stderr: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args, '--headless'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code: code ?? -1, env: JSON.parse(out) as Env, stderr: err, ms: Date.now() - started });
      } catch {
        reject(new Error(`gvids ${args.join(' ')} printed no JSON envelope: ${out}${err}`));
      }
    });
  });
}

describe.skipIf(!LIVE)('live: gvids as processes', () => {
  let id = '';
  const title = `gvids process live test ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;

  beforeAll(async () => {
    if (!fs.existsSync(entry)) throw new Error('Build first: pnpm build');
    await gvids(['browser', 'close', '--force']);
    const created = await gvids(['create', title]);
    if (!created.env.ok)
      throw new Error(`Could not create the test video: ${JSON.stringify(created.env.error)}`);
    id = created.env.data.id;
    // Vids disables "Move to trash" for never-edited videos: edit it once so cleanup works.
    await gvids(['scene', 'add', id]);
  });

  afterAll(async () => {
    await gvids(['browser', 'close', '--force']);
    if (id) {
      const r = await gvids(['trash', id, '--yes']);
      if (!r.env.ok) console.warn(`Could not trash test video ${id}: ${JSON.stringify(r.env.error)}`);
    }
    await gvids(['browser', 'close', '--force']);
  });

  it('runs parallel commands on one browser and closes it after the last one', async () => {
    await gvids(['browser', 'close', '--force']);
    const results = await Promise.all([
      gvids(['scene', 'list', id]),
      gvids(['info', id]),
      gvids(['format', id]),
    ]);
    for (const r of results) expect(r.env.ok, JSON.stringify(r.env.error)).toBe(true);
    const status = await gvids(['browser', 'status', '--no-check']);
    expect(status.env.data).toMatchObject({ running: false });
  });

  it('reuses a warm browser and its idle tab', async () => {
    expect((await gvids(['browser', 'open'])).env.ok).toBe(true);
    const first = await gvids(['scene', 'list', id]);
    const second = await gvids(['scene', 'list', id]);
    expect(first.env.ok && second.env.ok).toBe(true);
    expect(second.ms).toBeLessThan(first.ms + 1_000);
    const status = await gvids(['browser', 'status', '--no-check']);
    expect(status.env.data).toMatchObject({ running: true, persistent: true, sessions: 0 });
  });

  it('runs a command in the background and waits for its envelope', async () => {
    const started = await gvids(['scene', 'list', id, '--detach']);
    expect(started.env.data.taskId).toMatch(/^task_/);
    const waited = await gvids(['wait', started.env.data.taskId, '--timeout', '3m']);
    expect(waited.code).toBe(0);
    expect(waited.env).toMatchObject({ ok: true, data: { id } });
  });

  it('browser close refuses while a background task uses the browser; task cancel stops it cleanly', async () => {
    // A slow read: counts voices and avatars in the side panels.
    const started = await gvids(['capabilities', '--refresh', '--deep', '--vid', id, '--detach']);
    const taskId = started.env.data.taskId as string;
    let sessions = 0;
    for (let i = 0; i < 60 && sessions === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      sessions = (await gvids(['browser', 'status', '--no-check'])).env.data.sessions ?? 0;
    }
    expect(sessions).toBeGreaterThan(0);
    const refused = await gvids(['browser', 'close']);
    expect(refused.env.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { sessions } });
    const cancelled = await gvids(['task', 'cancel', taskId]);
    expect(cancelled.env.data).toMatchObject({ status: 'cancelled', exitCode: 130 });
    const waited = await gvids(['wait', taskId]);
    expect(waited.code).toBe(130);
    expect(waited.env.error.code).toBe('CANCELLED');
    // The cancelled worker released the browser (it keeps running: it was opened with browser open).
    expect((await gvids(['browser', 'status', '--no-check'])).env.data.sessions).toBe(0);
    expect((await gvids(['browser', 'close'])).env.data.closed).toBe(true);
  });
});
