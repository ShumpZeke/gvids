/**
 * Live tests against real Google Vids. Opt-in:
 *   GVIDS_LIVE=1 pnpm test:live            (PowerShell: $env:GVIDS_LIVE=1; pnpm test:live)
 * Requirements: `gvids browser login` (and optionally `gvids auth login` for the Drive part).
 * GVIDS_LIVE_AI=1 additionally runs one AI clip generation (uses your Vids allowance).
 *
 * The suite only touches a video it creates ("gvids live test <timestamp>") and moves
 * that video to the trash at the end (Drive API when logged in, otherwise the editor).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeCli } from '../../src/mcp/server.js';

const LIVE = process.env.GVIDS_LIVE === '1';
const LIVE_AI = process.env.GVIDS_LIVE_AI === '1';
const run = (args: string[], stdin?: string) => invokeCli([...args, '--headless'], {}, stdin);

describe.skipIf(!LIVE)('live: Google Vids editor', () => {
  let id = '';
  const title = `gvids live test ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvids-live-'));

  beforeAll(async () => {
    const status = await run(['browser', 'status']);
    if (!(status.envelope?.data as { signedIn?: boolean } | undefined)?.signedIn) {
      throw new Error('The gvids browser is not signed in. Run: gvids browser login');
    }
  });

  afterAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    if (!id) return;
    const r = await run(['trash', id, '--yes']);
    if (!r.envelope?.ok)
      console.warn(`Could not trash test video ${id}: ${JSON.stringify(r.envelope?.error)}`);
  });

  it('creates a blank video and renames it', async () => {
    const r = await run(['create', title]);
    expect(r.envelope?.ok, JSON.stringify(r.envelope?.error)).toBe(true);
    const data = r.envelope!.data as { id: string; title: string; scenes: number };
    id = data.id;
    expect(data.title).toBe(title);
    expect(data.scenes).toBe(1);
  });

  it('adds, duplicates, moves and deletes scenes', async () => {
    expect((await run(['scene', 'add', id])).envelope?.data).toMatchObject({ index: 2, scenes: 2 });
    expect((await run(['scene', 'duplicate', id, '2'])).envelope?.data).toMatchObject({ scenes: 3 });
    expect((await run(['scene', 'move', id, '3', '--to', '1'])).envelope?.ok).toBe(true);
    expect((await run(['scene', 'delete', id, '3', '--yes'])).envelope?.data).toMatchObject({ scenes: 2 });
    const list = await run(['scene', 'list', id]);
    expect((list.envelope?.data as { count: number }).count).toBe(2);
  });

  it('adds, edits and deletes text', async () => {
    const added = await run(['text', 'add', id, '--scene', '1', '--text', 'Hello from the live test']);
    const objectId = (added.envelope?.data as { object: { id: string } }).object.id;
    expect(objectId).toBeTruthy();
    const edited = await run(['text', 'edit', id, '--scene', '1', '--object', objectId, '--text', 'Edited']);
    expect((edited.envelope?.data as { object: { text: string } }).object.text).toBe('Edited');
    expect((await run(['text', 'delete', id, '--scene', '1', '--object', objectId])).envelope?.ok).toBe(true);
  });

  it('sets a scene duration and a script', async () => {
    const d = await run(['scene', 'duration', id, '2', '--seconds', '6.5']);
    expect(d.envelope?.data).toMatchObject({ scene: 2, seconds: 6.5 });
    const set = await run(['script', 'set', id, '--scene', '2', '--file', '-'], 'Scripted by the live test.');
    expect((set.envelope?.data as { script: string }).script).toBe('Scripted by the live test.');
    const get = await run(['script', 'get', id, '--scene', '1']);
    expect((get.envelope?.data as { scripts: Array<{ script: string }> }).scripts[0]!.script).toBe('');
  });

  it('inserts a local image', async () => {
    const png = path.resolve('examples', 'assets', 'example.png');
    const r = await run(['media', 'add', id, png, '--scene', '2']);
    expect((r.envelope?.data as { object?: { kind: string } }).object?.kind).toBe('image');
  });

  it('sets a background and changes the format', async () => {
    expect((await run(['scene', 'background', id, '1', '--color', '#1a73e8'])).envelope?.ok).toBe(true);
    expect((await run(['format', id, 'portrait'])).envelope?.data).toMatchObject({ format: 'portrait' });
    expect((await run(['format', id, 'landscape'])).envelope?.data).toMatchObject({ format: 'landscape' });
  });

  it('applies template scenes and narrates a scene', async () => {
    const t = await run(['template', 'apply', id, 'How-to video', '--scenes', '1']);
    expect((t.envelope?.data as { inserted: number }).inserted).toBe(1);
    const vo = await run([
      'voiceover',
      'generate',
      id,
      '--scene',
      '1',
      '--script',
      'This is a live test.',
      '--voice',
      'Knox',
    ]);
    expect((vo.envelope?.data as { clip: { scene: number } }).clip.scene).toBe(1);
  });

  it('exports an MP4 through the editor', async () => {
    const target = path.join(outDir, 'live.mp4');
    const r = await run(['export', id, target, '--via-browser']);
    expect(r.envelope?.ok, JSON.stringify(r.envelope?.error)).toBe(true);
    const head = fs.readFileSync(target).subarray(4, 8).toString('latin1');
    expect(head).toBe('ftyp');
  });

  it('downloads an MP4 (Drive API, or the editor without OAuth) and a GIF', async () => {
    const mp4 = path.join(outDir, 'download.mp4');
    const r = await run(['download', id, mp4]);
    expect(r.envelope?.ok, JSON.stringify(r.envelope?.error)).toBe(true);
    const scenes = (await run(['scene', 'list', id])).envelope?.data as {
      scenes: Array<{ durationSeconds?: number }>;
    };
    const total = scenes.scenes.reduce((sum, s) => sum + (s.durationSeconds ?? 0), 0);
    const gif = await run(['export', id, path.join(outDir, 'short.gif'), '--format', 'gif']);
    if (total <= 30) {
      expect(gif.envelope?.ok, JSON.stringify(gif.envelope?.error)).toBe(true);
    } else {
      expect((gif.envelope?.error as { code: string }).code).toBe('FEATURE_UNAVAILABLE');
    }
  });

  it.skipIf(!LIVE_AI)('generates one AI video clip', async () => {
    const r = await run([
      'ai',
      'generate',
      id,
      '--prompt',
      'A calm ocean at sunrise, gentle waves',
      '--scene',
      '1',
      '--timeout',
      '15m',
    ]);
    expect(r.envelope?.ok, JSON.stringify(r.envelope?.error)).toBe(true);
  });

  it('reports capabilities', async () => {
    const r = await run(['capabilities', '--refresh', '--vid', id]);
    const ui = (r.envelope?.data as { ui: Array<{ key: string; state: string }> }).ui;
    expect(ui.find((c) => c.key === 'voiceovers')?.state).toBe('available');
  });

  it('moves the video to the trash and restores it', async () => {
    expect((await run(['trash', id, '--yes'])).envelope?.ok).toBe(true);
    const blocked = await run(['scene', 'list', id]);
    expect((blocked.envelope?.error as { code: string }).code).toBe('VIDEO_IN_TRASH');
    expect((await run(['restore', id])).envelope?.ok).toBe(true);
    expect((await run(['scene', 'list', id])).envelope?.ok).toBe(true);
  });
});

// The Drive API half lives in drive.live.test.ts (it needs an OAuth login and is skipped, not passed, without one).
