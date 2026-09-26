import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeDriveTransport } from '../helpers/fake-drive.js';
import { cli, tempHome } from '../helpers/cli.js';

const VID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789vid1';

describe('CLI (in-process, fake Drive)', () => {
  it('prints help and version (JSON by default, text with --human)', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.json?.data.commands).toContain('scene add');
    const text = await cli(['--help', '--human']);
    expect(text.stdout).toMatch(/Google Vids for agents/);
    expect(text.stdout).toMatch(/Start here:/);
    expect((await cli(['--version'])).json?.data).toEqual({ version: expect.any(String) });
    const version = await cli(['version', '--json']);
    expect(version.json?.data).toMatchObject({ name: 'gvids' });
  });

  it('lists videos as JSON envelopes', async () => {
    const r = await cli(['list', '--json'], { drive: new FakeDriveTransport() });
    expect(r.code).toBe(0);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.data.count).toBe(2);
    expect(r.json?.data.files[0]).toMatchObject({ id: VID1, name: 'Biology: Photosynthesis' });
    expect(r.stdout).not.toMatch(/\u001b\[/);
  });

  it('ls alias and --ids output', async () => {
    const r = await cli(['ls', '--ids'], { drive: new FakeDriveTransport() });
    expect(r.json?.data.ids).toHaveLength(2);
    const text = await cli(['ls', '--ids', '--human'], { drive: new FakeDriveTransport() });
    expect(text.stdout.trim().split('\n')).toHaveLength(2);
  });

  it('searches with filters', async () => {
    const t = new FakeDriveTransport();
    const r = await cli(['search', 'biology', '--owner', 'me', '--modified-after', '2026-09-01', '--json'], {
      drive: t,
    });
    expect(r.json?.data.count).toBe(1);
    const q = (t.calls[0]!.args[0] as { q: string }).q;
    expect(q).toContain("name contains 'biology'");
    expect(q).toContain("modifiedTime > '2026-09-01T00:00:00.000Z'");
  });

  it('accepts URLs wherever an ID is expected', async () => {
    const r = await cli(['info', `https://docs.google.com/videos/d/${VID1}/edit?usp=sharing`, '--json'], {
      drive: new FakeDriveTransport(),
    });
    expect(r.json?.data.id).toBe(VID1);
    const human = await cli(['info', VID1, '--human'], { drive: new FakeDriveTransport() });
    expect(human.stdout).toMatch(/Name\s+Biology: Photosynthesis/);
  });

  it('renames, copies and moves', async () => {
    const t = new FakeDriveTransport();
    expect((await cli(['rename', VID1, 'CLI Test', '--json'], { drive: t })).json?.data.name).toBe(
      'CLI Test',
    );
    expect((await cli(['cp', VID1, '--name', 'Dup', '--json'], { drive: t })).json?.data.name).toBe('Dup');
    const mv = await cli(
      [
        'mv',
        VID1,
        'https://drive.google.com/drive/folders/0AFolderTargetFolderTargetFolderTarget01',
        '--json',
      ],
      { drive: t },
    );
    expect(mv.json?.data.parents).toEqual(['0AFolderTargetFolderTargetFolderTarget01']);
  });

  it('requires --yes for destructive actions in non-interactive mode', async () => {
    const t = new FakeDriveTransport();
    const r = await cli(['delete', VID1, '--json'], { drive: t });
    expect(r.code).toBe(2);
    expect(r.json?.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(t.files.some((f) => f.id === VID1)).toBe(true);
    const ok = await cli(['delete', VID1, '--yes', '--json'], { drive: t });
    expect(ok.json?.data).toMatchObject({ deleted: true, id: VID1 });
    expect(t.files.some((f) => f.id === VID1)).toBe(false);
  });

  it('trash needs confirmation and restore does not', async () => {
    const t = new FakeDriveTransport();
    expect((await cli(['trash', VID1], { drive: t })).code).toBe(2);
    expect((await cli(['rm', VID1, '-y', '--json'], { drive: t })).json?.data.trashed).toBe(true);
    expect((await cli(['restore', VID1, '--json'], { drive: t })).json?.data.trashed).toBe(false);
  });

  it('shares with people and requires confirmation for public links', async () => {
    const t = new FakeDriveTransport();
    const r = await cli(['share', VID1, 'person@example.com', '--role', 'writer', '--no-notify', '--json'], {
      drive: t,
    });
    expect(r.json?.data).toMatchObject({
      action: 'created',
      permission: { role: 'writer', emailAddress: 'person@example.com' },
    });
    const pub = await cli(['share', VID1, '--anyone', 'reader', '--json'], { drive: t });
    expect(pub.json?.error.code).toBe('CONFIRMATION_REQUIRED');
    const pubOk = await cli(['share', VID1, '--anyone', 'reader', '--yes', '--json'], { drive: t });
    expect(pubOk.json?.data.permission.type).toBe('anyone');
    const perms = await cli(['permissions', VID1, '--json'], { drive: t });
    expect(perms.json?.data.permissions.length).toBe(4);
    const refused = await cli(['unshare', VID1, 'person@example.com'], { drive: t });
    expect(refused.json?.error.code).toBe('CONFIRMATION_REQUIRED');
    const un = await cli(['unshare', VID1, 'person@example.com', '--yes'], { drive: t });
    expect(un.json?.data.removed[0].emailAddress).toBe('person@example.com');
    expect((await cli(['share', VID1, '--json'], { drive: t })).json?.error.code).toBe('INVALID_ARGUMENT');
  });

  it('downloads MP4 through the long-running operation into the downloads directory', async () => {
    const home = tempHome();
    const t = new FakeDriveTransport();
    const r = await cli(['download', VID1, '--json'], { drive: t, home });
    expect(r.code).toBe(0);
    expect(r.json?.data.path).toBe(
      path.join(home, 'downloads', 'Biology  Photosynthesis.mp4'.replace('  ', ' ')),
    );
    expect(fs.readFileSync(r.json!.data.path, 'utf8')).toBe('fake mp4 bytes');
    const again = await cli(['download', VID1, '--json'], { drive: t, home });
    expect(again.json?.error.message).toMatch(/already exists/);
    const explicit = await cli(['download', VID1, 'custom.mp4', '--json'], { drive: t, home });
    expect(explicit.json?.data.path).toBe(path.join(home, 'custom.mp4'));
  });

  it('export --format mp4 uses the Drive API', async () => {
    const home = tempHome();
    const r = await cli(['export', VID1, 'e.mp4', '--json'], { drive: new FakeDriveTransport(), home });
    expect(r.json?.data).toMatchObject({ method: 'drive-api', format: 'mp4' });
  });

  it('reports authentication problems with exit code 3', async () => {
    // Drive-only filters cannot fall back to the Vids home page.
    const r = await cli(['list', '--starred'], { env: { GVIDS_TOKEN_STORE: 'file' } });
    expect(r.code).toBe(3);
    expect(r.json?.error).toMatchObject({
      code: 'AUTH_REQUIRED',
      needsUser: true,
      next: ['gvids auth login'],
    });
    // Without OAuth, plain list falls back to the browser (stubbed out in unit tests).
    const fallback = await cli(['list'], { env: { GVIDS_TOKEN_STORE: 'file' } });
    expect(fallback.json?.error.code).toBe('LOGIN_REQUIRED');
    expect(fallback.json?.warnings?.[0]).toMatch(/No Drive API login/);
  });

  it('reports unknown commands and bad arguments as JSON with exit code 2', async () => {
    const r = await cli(['frobnicate', '--json']);
    expect(r.code).toBe(2);
    expect(r.json?.error.code).toBe('INVALID_ARGUMENT');
    const bad = await cli(['list', '--limit', 'zero', '--json'], { drive: new FakeDriveTransport() });
    expect(bad.code).toBe(2);
    const badUrl = await cli(['info', 'https://example.com/x', '--json'], {
      drive: new FakeDriveTransport(),
    });
    expect(badUrl.json?.error.message).toMatch(/Not a Google URL/);
  });

  it('manages configuration', async () => {
    const home = tempHome();
    await cli(['config', 'set', 'browser.headless', 'true'], { home });
    const get = await cli(['config', 'get', 'browser.headless', '--json'], { home });
    expect(get.json?.data).toEqual({ key: 'browser.headless', value: true });
    const list = await cli(['config', 'list', '--json'], { home });
    expect(list.json?.data.settings.find((s: { key: string }) => s.key === 'browser.headless')).toMatchObject(
      { value: true, source: 'config' },
    );
    const bad = await cli(['config', 'set', 'browser.headless', 'maybe', '--json'], { home });
    expect(bad.code).toBe(2);
  });

  it('prints shell completion scripts (raw, so `>> ~/.bashrc` works)', async () => {
    const ps = await cli(['completion', 'powershell']);
    expect(ps.json).toBeUndefined();
    expect(ps.stdout).toContain('Register-ArgumentCompleter -Native -CommandName gvids');
    expect(ps.stdout).toContain("'scene' = @(");
    const bash = await cli(['completion', 'bash']);
    expect(bash.stdout).toMatch(/^# gvids bash completion/);
    expect(bash.stdout).toContain('complete -o default -F _gvids_complete gvids');
    const fish = await cli(['completion', 'fish']);
    expect(fish.stdout).toContain("complete -c gvids -n '__fish_use_subcommand'");
    const asJson = await cli(['completion', 'bash', '--json']);
    expect(asJson.json?.data.script).toContain('_gvids_complete');
  });

  it('url works offline', async () => {
    const r = await cli(['url', VID1, '--json']);
    expect(r.json?.data.url).toBe(`https://docs.google.com/videos/d/${VID1}/edit`);
  });

  it('plans workflows with --dry-run', async () => {
    const r = await cli([
      'run',
      path.resolve('tests/fixtures/workflows/weather.yaml'),
      '--dry-run',
      '--json',
    ]);
    expect(r.json?.data.steps.length).toBe(10);
  });

  it('auth scopes explains the requested scopes', async () => {
    const r = await cli(['auth', 'scopes', '--json']);
    expect(r.json?.data.profiles[0].scopes[0].scope).toBe('https://www.googleapis.com/auth/drive');
  });

  it('env never prints secret values', async () => {
    const r = await cli(['env', '--json'], {
      env: {
        GOOGLE_CLIENT_SECRET: 'GOCSPX-supersecret',
        GOOGLE_CLIENT_ID: '12345-abc.apps.googleusercontent.com',
      },
    });
    expect(r.stdout).not.toContain('supersecret');
    expect(r.json?.data.environment.GOOGLE_CLIENT_SECRET).toBe('set');
  });

  it('prints a JSON overview when run without arguments', async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.json?.data).toMatchObject({ name: 'gvids' });
    expect(r.json?.data.start[0]).toMatch(/gvids guide/);
    expect(r.stderr).toBe('');
  });

  it('describes one command as JSON for --help', async () => {
    const r = await cli(['scene', 'delete', '--help']);
    expect(r.json?.data).toMatchObject({
      command: 'scene delete',
      effect: 'destructive',
      backend: 'browser',
      confirm: 'always',
      args: [
        { name: 'id', required: true },
        { name: 'scene', required: true },
      ],
    });
    const group = await cli(['help', 'scene']);
    expect(group.json?.data.subcommands.map((c: { command: string }) => c.command)).toContain('scene move');
  });

  it('lists the command catalog', async () => {
    const all = await cli(['commands']);
    expect(all.json?.data.count).toBeGreaterThan(80);
    expect(
      all.json?.data.commands.find((c: { command: string }) => c.command === 'ai generate'),
    ).toMatchObject({
      aiQuota: true,
      slow: true,
    });
    const scenes = await cli(['commands', 'scene', '--full']);
    expect(scenes.json?.data.commands.every((c: { command: string }) => c.command.startsWith('scene'))).toBe(
      true,
    );
    expect(scenes.json?.data.commands[0].options).toBeDefined();
  });

  it('usage errors say how to get help', async () => {
    const r = await cli(['scene', 'add']);
    expect(r.code).toBe(2);
    expect(r.json?.error).toMatchObject({ code: 'INVALID_ARGUMENT', next: ['gvids scene add --help'] });
    expect(r.json?.error.details.usage).toMatch(/gvids scene add/);
  });

  it('never prompts: destructive commands return the approved retry command', async () => {
    const r = await cli(['scene', 'delete', VID1, '2']);
    expect(r.code).toBe(2);
    expect(r.json?.error).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      needsUser: true,
      next: [`gvids scene delete ${VID1} 2 --yes`],
      details: { retryArgs: ['scene', 'delete', VID1, '2', '--yes'] },
    });
  });

  it('--dry-run describes a command without running it', async () => {
    const t = new FakeDriveTransport();
    const r = await cli(['trash', VID1, '--dry-run'], { drive: t });
    expect(r.json?.data).toMatchObject({
      dryRun: true,
      command: 'trash',
      args: { id: VID1 },
      effect: 'destructive',
      requiresUserApproval: true,
      run: `gvids trash ${VID1} --yes`,
    });
    expect(t.calls).toHaveLength(0);
  });

  it('--human renders for people', async () => {
    const r = await cli(['url', VID1, '--human']);
    expect(r.stdout).toBe(`https://docs.google.com/videos/d/${VID1}/edit\n`);
  });

  it('--detach starts a background task that wait can report on', async () => {
    const home = tempHome();
    // The fake worker is this (live) process; the real one is a detached child.
    const overrides = { spawnTask: async () => ({ pid: process.pid }) };
    const started = await cli(['url', VID1, '--detach'], { home, overrides });
    expect(started.json?.data).toMatchObject({ status: 'running', pid: process.pid });
    const taskId = started.json?.data.taskId as string;
    expect(taskId).toMatch(/^task_\d{14}_[0-9a-f]{6}$/);
    const listed = await cli(['tasks'], { home });
    expect(listed.json?.data.tasks[0]).toMatchObject({ id: taskId, command: `gvids url ${VID1}` });

    // Simulate the worker: run the command with GVIDS_TASK_ID set (as the child process would).
    await cli(['url', VID1, '--json', '--progress'], { home, env: { GVIDS_TASK_ID: taskId } });
    const waited = await cli(['wait', taskId], { home });
    expect(waited.code).toBe(0);
    expect(waited.json).toMatchObject({ ok: true, data: { id: VID1 } });
    const status = await cli(['task', 'status', taskId], { home });
    expect(status.json?.data).toMatchObject({ status: 'succeeded', exitCode: 0 });
  });

  it('wait times out with a retryable STILL_RUNNING error', async () => {
    const home = tempHome();
    const started = await cli(['url', VID1, '--detach'], {
      home,
      overrides: { spawnTask: async () => ({ pid: process.pid }) },
    });
    const taskId = started.json?.data.taskId as string;
    const r = await cli(['wait', taskId, '--timeout', '1s'], { home });
    expect(r.code).toBe(8);
    expect(r.json?.error).toMatchObject({
      code: 'STILL_RUNNING',
      retryable: true,
      next: [`gvids wait ${taskId}`],
    });
  });

  it('refuses to detach commands that need a person or stdin', async () => {
    expect((await cli(['browser', 'login', '--detach'])).json?.error.code).toBe('INVALID_ARGUMENT');
    expect(
      (await cli(['text', 'add', VID1, '--scene', '1', '--text', '-', '--detach'])).json?.error.message,
    ).toMatch(/stdin/);
  });

  it('batch runs several commands and reports each result', async () => {
    const t = new FakeDriveTransport();
    const ok = await cli(['batch'], {
      drive: t,
      stdin: JSON.stringify([
        ['url', VID1],
        ['info', VID1],
      ]),
    });
    expect(ok.code).toBe(0);
    expect(ok.json?.data).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(ok.json?.data.results[1].data.id).toBe(VID1);

    const failing = await cli(['batch'], {
      drive: t,
      stdin: ['["url","not a url"]', `["url","${VID1}"]`].join('\n'),
    });
    expect(failing.code).toBe(2);
    expect(failing.json?.ok).toBe(false);
    expect(failing.json?.error.code).toBe('BATCH_FAILED');
    expect(failing.json?.data).toMatchObject({ total: 2, failed: 1, skipped: 1 });

    const keepGoing = await cli(['batch', '--keep-going'], {
      drive: t,
      stdin: JSON.stringify({
        commands: [
          ['url', 'not a url'],
          ['url', VID1],
        ],
      }),
    });
    expect(keepGoing.json?.data).toMatchObject({ failed: 1, succeeded: 1, skipped: 0 });

    const nested = await cli(['batch'], { stdin: JSON.stringify([['batch']]) });
    expect(nested.json?.error.code).toBe('INVALID_ARGUMENT');
  });

  it('prints the agent guide as Markdown', async () => {
    const r = await cli(['guide']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^# /);
    const json = await cli(['guide', '--json']);
    expect(json.json?.data.format).toBe('markdown');
  });
});
