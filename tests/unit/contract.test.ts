/**
 * Regression tests for the agent contract: one parseable envelope, typed errors
 * with accurate exit codes, validation before side effects, and safeguards that
 * hold in every interface (CLI, batch, MCP, workflows, background tasks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskStore } from '../../src/automation/tasks.js';
import { invokeCli } from '../../src/mcp/server.js';
import { FakeDriveTransport } from '../helpers/fake-drive.js';
import { cli, tempHome } from '../helpers/cli.js';

const VID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789vid1';
const browserNeverStarts = {
  startBrowserSession: async () => {
    throw new Error('the browser must not start for this command');
  },
};

describe('envelope contract', () => {
  it('a command group without a subcommand describes the group', async () => {
    const r = await cli(['scene']);
    expect(r.code).toBe(0);
    expect(r.json?.data.command).toBe('scene');
    expect(r.json?.data.subcommands.map((c: { command: string }) => c.command)).toContain('scene delete');
    const nested = await cli(['debug', 'trace']);
    expect(nested.json?.data.command).toBe('debug trace');
    const human = await cli(['scene', '--human']);
    expect(human.stdout).toMatch(/Usage: gvids scene/);
  });

  it('help for an unknown command is an error, not the overview', async () => {
    const r = await cli(['help', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.json?.error).toMatchObject({ code: 'INVALID_ARGUMENT', next: ['gvids commands'] });
  });

  it('parse errors are reported once, with the command to get help', async () => {
    const r = await cli(['scene', 'list', '--human']);
    expect(r.code).toBe(2);
    expect(r.stderr.match(/missing required argument/g)).toHaveLength(1);
    expect(r.stderr).toMatch(/gvids scene list --help/);
  });

  it('argument errors from handlers point at the command help', async () => {
    const r = await cli(['scene', 'delete', VID1, 'x']);
    expect(r.json?.error).toMatchObject({ code: 'INVALID_ARGUMENT', next: ['gvids scene delete --help'] });
  });

  it('a malformed --timeout fails fast even where the command does not use it', async () => {
    const r = await cli(['tasks', '--timeout', 'soon']);
    expect(r.code).toBe(2);
    expect(r.json?.error.code).toBe('INVALID_ARGUMENT');
  });

  it('rejects unknown list filters', async () => {
    expect((await cli(['tasks', '--status', 'bogus'])).json?.error.code).toBe('INVALID_ARGUMENT');
    expect((await cli(['tasks', '--limit', '0'])).json?.error.code).toBe('INVALID_ARGUMENT');
    expect((await cli(['jobs', '--status', 'bogus'])).json?.error.code).toBe('INVALID_ARGUMENT');
  });

  it('explains IDs that are neither IDs nor URLs', async () => {
    const r = await cli(['info', 'short']);
    expect(r.json?.error.message).toMatch(/Not a valid Google Vids file ID or URL/);
  });
});

describe('status commands report failure consistently', () => {
  it('auth status without a login is AUTH_REQUIRED with the status as data', async () => {
    const r = await cli(['auth', 'status', '--no-verify'], { env: { GVIDS_TOKEN_STORE: 'file' } });
    expect(r.code).toBe(3);
    expect(r.json).toMatchObject({
      ok: false,
      data: { authenticated: false },
      error: { code: 'AUTH_REQUIRED', needsUser: true, next: ['gvids auth login'] },
    });
  });

  it('browser status reports a missing sign-in as LOGIN_REQUIRED', async () => {
    const r = await cli(['browser', 'status'], { overrides: browserNeverStarts });
    expect(r.code).toBe(3);
    expect(r.json?.error.code).toBe('LOGIN_REQUIRED');
    expect(r.json?.data).toMatchObject({ profileExists: false, running: false });
    const quick = await cli(['browser', 'status', '--no-check']);
    expect(quick.json).toMatchObject({ ok: true, data: { checked: false } });
  });
});

describe('validation happens before any browser or API work', () => {
  const cases: Array<[string, string[], RegExp]> = [
    ['text color', ['text', 'add', VID1, '--scene', '1', '--text', 'Hi', '--color', 'red'], /--color/],
    ['text size', ['text', 'add', VID1, '--scene', '1', '--text', 'Hi', '--size', '9000'], /--size/],
    ['empty text', ['text', 'add', VID1, '--scene', '1', '--text', ' '], /must not be empty/],
    ['empty rename', ['rename', VID1, '  '], /must not be empty/],
    ['missing upload', ['create', 'X', '--upload', 'nope.mp4'], /--upload: file not found/],
    ['missing clip', ['ai', 'edit', VID1, 'nope.mp4', '--prompt', 'x'], /clip: file not found/],
    ['missing image', ['ai', 'generate', VID1, '--prompt', 'x', '--image', 'nope.png'], /--image/],
    ['design without prompt', ['create', 'X', '--design', '2'], /only apply with --prompt/],
    ['bad storyboard design', ['storyboard', 'generate', VID1, '--prompt', 'x', '--design', '0'], /--design/],
  ];
  for (const [name, args, message] of cases) {
    it(name, async () => {
      const r = await cli(args, { overrides: browserNeverStarts });
      expect(r.code, r.stdout).toBe(2);
      expect(r.json?.error.message).toMatch(message);
    });
  }

  it('reports broken outline and batch files as argument errors', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'outline.json'), '{broken');
    const outline = await cli(
      ['storyboard', 'create-draft', VID1, '--prompt', 'x', '--outline-file', 'outline.json'],
      { home, overrides: browserNeverStarts },
    );
    expect(outline.json?.error.code).toBe('INVALID_ARGUMENT');
    const batch = await cli(['batch', 'missing.json'], { home });
    expect(batch.json?.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(batch.json?.error.message).toMatch(/Batch file not found/);
  });
});

describe('dry-run', () => {
  it('wins over --detach: nothing starts', async () => {
    const home = tempHome();
    let spawned = 0;
    const r = await cli(['scene', 'delete', VID1, '2', '--dry-run', '--detach'], {
      home,
      overrides: {
        spawnTask: async () => {
          spawned++;
          return { pid: process.pid };
        },
      },
    });
    expect(r.json?.data).toMatchObject({ dryRun: true, detach: true, requiresUserApproval: true });
    expect(spawned).toBe(0);
    expect((await cli(['tasks'], { home })).json?.data.count).toBe(0);
  });

  it('never runs destructive Drive calls', async () => {
    const t = new FakeDriveTransport();
    for (const args of [
      ['delete', VID1, '--yes', '--dry-run'],
      ['unshare', VID1, 'person@example.com', '--yes', '--dry-run'],
      ['trash', VID1, '--yes', '--dry-run'],
    ]) {
      const r = await cli(args, { drive: t });
      expect(r.json?.data.dryRun).toBe(true);
    }
    expect(t.calls).toHaveLength(0);
  });

  it('masks secret flag values in the plan', async () => {
    const r = await cli([
      'auth',
      'login',
      '--client-id',
      'x.apps',
      '--client-secret',
      'hunter2',
      '--dry-run',
    ]);
    expect(r.stdout).not.toContain('hunter2');
    expect(r.json?.data.run).toMatch(/--client-secret "?\[REDACTED\]/);
  });
});

describe('confirmations cannot be bypassed', () => {
  it('unshare and auth logout need --yes', async () => {
    const t = new FakeDriveTransport();
    const un = await cli(['unshare', VID1, 'person@example.com'], { drive: t });
    expect(un.json?.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(t.calls.some((c) => c.method === 'deletePermission')).toBe(false);
    const logout = await cli(['auth', 'logout']);
    expect(logout.json?.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      next: ['gvids auth logout --yes'],
    });
  });

  it('a workflow that shares publicly needs --yes, like gvids share --anyone', async () => {
    const home = tempHome();
    const wf = path.join(home, 'public.yaml');
    fs.writeFileSync(
      wf,
      'name: Public\nid: 1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789vid1\nshare:\n  - anyone: true\n',
    );
    const plan = await cli(['run', wf, '--dry-run'], { home });
    expect(plan.json?.data).toMatchObject({ requiresUserApproval: true });
    expect(plan.json?.data.run).toMatch(/--yes$/);
    const refused = await cli(['run', wf], { home, drive: new FakeDriveTransport() });
    expect(refused.json?.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await cli(['jobs'], { home })).json?.data.jobs).toHaveLength(0);
  });

  it('batch items keep their own confirmation rules', async () => {
    const t = new FakeDriveTransport();
    const r = await cli(['batch', '--yes'], { drive: t, stdin: JSON.stringify([['delete', VID1]]) });
    expect(r.json?.error.code).toBe('BATCH_FAILED');
    expect(r.json?.data.results[0].error.code).toBe('CONFIRMATION_REQUIRED');
    expect(t.files.some((f) => f.id === VID1)).toBe(true);
  });

  it('batch refuses nested batch/mcp however the flags are ordered', async () => {
    for (const item of [['batch'], ['--yes', 'batch'], ['--timeout', '5m', 'mcp'], ['--human', 'mcp']]) {
      const r = await cli(['batch'], { stdin: JSON.stringify([item]) });
      expect(r.json?.error.code, JSON.stringify(item)).toBe('INVALID_ARGUMENT');
    }
  });

  it('batch and MCP hand person-only commands back to the user', async () => {
    const b = await cli(['batch', '--keep-going'], { stdin: JSON.stringify([['browser', 'login']]) });
    expect(b.json?.data.results[0].error).toMatchObject({ code: 'USER_ACTION_REQUIRED', needsUser: true });
    const m = await invokeCli(['--yes', 'auth', 'login']);
    expect(m.envelope?.error).toMatchObject({ code: 'USER_ACTION_REQUIRED', next: ['gvids auth login'] });
  });

  it('MCP refuses mcp whatever comes first, and always answers in JSON', async () => {
    for (const args of [['mcp'], ['--yes', 'mcp'], ['--human', 'mcp']]) {
      const r = await invokeCli(args);
      expect(r.envelope?.error, JSON.stringify(args)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    const human = await invokeCli(['version', '--human']);
    expect(human.envelope?.ok).toBe(true);
    const dashes = await invokeCli(['url', '--', VID1]);
    expect(dashes.envelope).toMatchObject({ ok: true, data: { id: VID1 } });
  });
});

describe('configuration', () => {
  it('an invalid config file can still be repaired', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{"browser":{"timeout":"soon"}}');
    const blocked = await cli(['tasks'], { home });
    expect(blocked.json?.error).toMatchObject({
      code: 'CONFIG_ERROR',
      next: ['gvids config unset browser.timeout'],
    });
    const listed = await cli(['config', 'list'], { home });
    expect(listed.json?.ok).toBe(true);
    expect(listed.json?.warnings?.[0]).toMatch(/Invalid configuration/);
    expect((await cli(['config', 'set', 'browser.headless', 'true'], { home })).json?.ok).toBe(true);
    expect((await cli(['config', 'unset', 'browser.timeout'], { home })).json?.data.removed).toBe(true);
    expect((await cli(['tasks'], { home })).json?.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({
      browser: { headless: true },
    });
  });

  it('an unparseable config file is only replaced by reset', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{bad');
    expect((await cli(['config', 'set', 'browser.headless', 'true'], { home })).json?.error.code).toBe(
      'CONFIG_ERROR',
    );
    expect((await cli(['config', 'reset', '--yes'], { home })).json?.ok).toBe(true);
    expect((await cli(['version'], { home })).json?.ok).toBe(true);
  });

  it('maps the obsolete output.json key onto output.format', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{"output":{"json":false}}');
    const r = await cli(['config', 'get', 'output.format', '--json'], { home });
    expect(r.json?.data.value).toBe('text');
    expect(r.json?.warnings?.[0]).toMatch(/output\.json is obsolete/);
    const plain = await cli(['version'], { home });
    expect(plain.json).toBeUndefined();
    expect(plain.stdout).toMatch(/^gvids /);
  });
});

describe('background tasks', () => {
  it('a worker that finishes before its pid is recorded keeps its result', async () => {
    const home = tempHome();
    let taskId = '';
    const r = await cli(['url', VID1, '--detach'], {
      home,
      overrides: {
        // The worker runs to completion inside spawn, before the starter records the pid.
        spawnTask: async (spec) => {
          taskId = spec.taskId;
          await cli(['url', VID1, '--json'], { home, env: { GVIDS_TASK_ID: spec.taskId } });
          return { pid: process.pid };
        },
      },
    });
    expect(r.json?.data.taskId).toBe(taskId);
    const waited = await cli(['wait', taskId], { home });
    expect(waited.code).toBe(0);
    expect(waited.json).toMatchObject({ ok: true, data: { id: VID1 } });
  });

  it('a batch inside a worker does not finish the task after its first item', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['batch'], home);
    await store.markStarted(task.id, process.pid);
    const drive = new FakeDriveTransport();
    let midway: string | undefined;
    const r = await cli(['batch'], {
      home,
      drive,
      env: { GVIDS_TASK_ID: task.id },
      stdin: JSON.stringify([
        ['url', VID1],
        ['info', VID1],
      ]),
      overrides: {
        driveTransport: async () => {
          midway = (await store.get(task.id)).status;
          return drive;
        },
      },
    });
    expect(r.json?.data.succeeded).toBe(2);
    expect(midway).toBe('running');
    const done = await store.get(task.id);
    expect(done).toMatchObject({ status: 'succeeded', result: { ok: true, data: { total: 2 } } });
  });

  it('marks a task failed when its process is gone or stops beating', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const dead = await store.create(['version'], home);
    await store.markStarted(dead.id, 999_999);
    expect((await store.get(dead.id)).status).toBe('failed');

    const reused = await store.create(['version'], home);
    await store.markStarted(reused.id, process.pid);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.writeFileSync(store.heartbeatFile(reused.id), 'x');
    fs.utimesSync(store.heartbeatFile(reused.id), old, old);
    const stale = await store.get(reused.id);
    expect(stale.status).toBe('failed');
    expect(stale.result?.error?.message).toMatch(/heartbeat/);
  });

  it('the first outcome wins', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['version'], home);
    await store.finish(task.id, { exitCode: 0, result: { ok: true, data: 1, error: null } });
    await store.finish(task.id, { exitCode: 1 });
    expect(await store.get(task.id)).toMatchObject({ status: 'succeeded', exitCode: 0 });
  });

  it('task cancel stops a task and records CANCELLED', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['ai', 'generate', VID1], home);
    await store.markStarted(task.id, process.pid);
    // Simulate a worker that honours the cancel request.
    const watcher = setInterval(() => {
      if (fs.existsSync(store.cancelFile(task.id))) {
        void store.finish(task.id, { exitCode: 130 });
        clearInterval(watcher);
      }
    }, 50);
    const r = await cli(['task', 'cancel', task.id], { home });
    clearInterval(watcher);
    expect(r.json?.data).toMatchObject({ id: task.id, status: 'cancelled', exitCode: 130 });
    const again = await cli(['task', 'cancel', task.id], { home });
    expect(again.json?.data.status).toBe('cancelled');
  });

  it('prunes finished tasks after a week', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['version'], home);
    await store.finish(task.id, { exitCode: 0 });
    expect(await store.prune(Date.now() + 8 * 24 * 60 * 60_000)).toBe(1);
    expect(await store.list()).toHaveLength(0);
  });

  it('reports corrupted task files clearly', async () => {
    const home = tempHome();
    const store = new TaskStore(path.join(home, 'tasks'));
    const task = await store.create(['version'], home);
    fs.writeFileSync(path.join(home, 'tasks', `${task.id}.json`), '{oops');
    const r = await cli(['task', 'status', task.id], { home });
    expect(r.json?.error).toMatchObject({ code: 'TASK_NOT_FOUND' });
    expect(r.json?.error.message).toMatch(/corrupted/);
  });
});

describe('workflows', () => {
  it('a failed run names the job and how to resume it', async () => {
    const home = tempHome();
    const wf = path.join(home, 'w.yaml');
    fs.writeFileSync(wf, 'name: Fails\nscenes:\n  - title: Hello\n');
    const r = await cli(['run', wf], { home });
    expect(r.json?.ok).toBe(false);
    const jobId = r.json?.error.details.jobId as string;
    expect(jobId).toMatch(/^job_/);
    expect(r.json?.error.next[0]).toBe(`gvids job resume ${jobId}`);
  });
});
