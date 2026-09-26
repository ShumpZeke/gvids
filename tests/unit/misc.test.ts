import { describe, expect, it } from 'vitest';
import { parseClipLabel, formatFromLabel } from '../../src/browser/pages/editor-page.js';
import {
  driveCapabilities,
  isCacheFresh,
  renderCapabilities,
  type CapabilityReport,
} from '../../src/vids/capabilities.js';
import { slugify } from '../../src/vids/types.js';
import { assertLoopbackEndpoint, automationArgs, type LaunchOptions } from '../../src/browser/launcher.js';
import { sanitizeUrl } from '../../src/browser/diagnostics/diagnostics.js';
import { invokeCli, createMcpServer, waitWithProgress } from '../../src/mcp/server.js';
import { fixture } from '../helpers/fake-drive.js';

describe('timeline clip labels', () => {
  it('parses voiceover clips', () => {
    expect(
      parseClipLabel('Welcome to the - Elio starting in scene 1 at 0 seconds with duration 3 seconds'),
    ).toMatchObject({
      kind: 'voiceover',
      scene: 1,
      startSeconds: 0,
      durationSeconds: 3,
      title: 'Welcome to the',
      speaker: 'Elio',
    });
  });

  it('parses minutes and music clips', () => {
    expect(
      parseClipLabel(
        'Without this incredible - Narrator starting in scene 12 at 1 minute 2 seconds with duration 4 seconds',
      ),
    ).toMatchObject({
      scene: 12,
      startSeconds: 62,
    });
    expect(
      parseClipLabel(
        'Futures Bright - Upbeat (Provided by Shutterstock) - Music starting in scene 1 at 0 seconds with duration 1 minute 9 seconds',
      ).kind,
    ).toBe('music');
    expect(parseClipLabel('something else').kind).toBe('unknown');
  });

  it('parses uploaded audio and video clips (no speaker)', () => {
    expect(parseClipLabel('tone.mp3 starting in scene 1 at 2 seconds with duration 3 seconds')).toMatchObject({
      kind: 'audio',
      scene: 1,
      startSeconds: 2,
      durationSeconds: 3,
      title: 'tone.mp3',
    });
    expect(parseClipLabel('intro.mp4 starting in scene 4 at 0 seconds with duration 1 minute 1 second').kind).toBe(
      'video',
    );
  });

  it('maps video size labels', () => {
    expect(formatFromLabel('Landscape 16:9')).toBe('landscape');
    expect(formatFromLabel('Portrait 9:16')).toBe('portrait');
    expect(formatFromLabel('Square 1:1')).toBe('square');
    expect(formatFromLabel('Custom')).toBe('custom');
  });
});

describe('capabilities', () => {
  it('derives Drive capabilities from scopes', () => {
    const full = driveCapabilities({
      authenticated: true,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    expect(full.find((c) => c.key === 'rename')!.state).toBe('available');
    const ro = driveCapabilities({
      authenticated: true,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    expect(ro.find((c) => c.key === 'rename')!.state).toBe('unavailable');
    expect(ro.find((c) => c.key === 'mp4Download')!.state).toBe('available');
    const none = driveCapabilities({ authenticated: false, scopes: [] });
    expect(none.every((c) => c.state === 'unknown')).toBe(true);
  });

  it('renders the report and honours the cache TTL', () => {
    const report = fixture<CapabilityReport>('capabilities.json');
    const text = renderCapabilities(report);
    expect(text).toContain('Google Drive API');
    expect(text).toContain('✓ list vids');
    expect(text).toContain('✗ direct public scene-editing API');
    expect(text).toContain('AI video models: Omni 720p with audio');
    expect(isCacheFresh({ ...report, detectedAt: new Date().toISOString() }, 24)).toBe(true);
    expect(isCacheFresh(report, 1)).toBe(false);
  });
});

describe('misc', () => {
  it('slugifies template names', () => {
    expect(slugify('Movie opening & credits')).toBe('movie-opening-and-credits');
    expect(slugify("Teacher's student report")).toBe('teacher-s-student-report');
  });

  it('only attaches to loopback DevTools endpoints by default', () => {
    expect(assertLoopbackEndpoint('http://127.0.0.1:9222', false).port).toBe('9222');
    expect(() => assertLoopbackEndpoint('http://10.0.0.5:9222', false)).toThrow(/non-local/);
    expect(assertLoopbackEndpoint('http://10.0.0.5:9222', true).hostname).toBe('10.0.0.5');
    expect(() => assertLoopbackEndpoint('ftp://127.0.0.1', false)).toThrow(/http/);
  });

  it('launches the automation browser without extensions or sync, background tabs not throttled, debugging on loopback only', () => {
    const base: Omit<LaunchOptions, 'headless'> = {
      executable: { path: 'chrome', kind: 'chrome', source: 'system' },
      profileDir: '/home/u/.gvids/browser/profile',
      detached: true,
      windowSize: { width: 1400, height: 900 },
    };
    const args = automationArgs({ ...base, headless: true });
    expect(args).toEqual(
      expect.arrayContaining([
        '--user-data-dir=/home/u/.gvids/browser/profile',
        '--remote-debugging-address=127.0.0.1',
        '--disable-extensions',
        '--disable-sync',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--headless=new',
      ]),
    );
    expect(args.at(-1)).toBe('about:blank');
    expect(automationArgs({ ...base, headless: false })).not.toContain('--headless=new');
  });

  it('sanitizes URLs for diagnostics', () => {
    expect(sanitizeUrl('https://docs.google.com/videos/d/X/edit?hl=en&token=secret#scene=id.p')).toBe(
      'https://docs.google.com/videos/d/X/edit?hl=en&token=%E2%80%A6#%E2%80%A6',
    );
  });
});

describe('MCP adapter', () => {
  it('invokes CLI commands in-process and returns envelopes', async () => {
    const r = await invokeCli(['version']);
    expect(r.exitCode).toBe(0);
    expect(r.envelope).toMatchObject({ ok: true, data: { name: 'gvids' } });
  });

  it('registers the expected tools', () => {
    const server = createMcpServer() as unknown as { _registeredTools: Record<string, unknown> };
    const names = Object.keys(server._registeredTools);
    for (const tool of [
      'vids_list',
      'vids_search',
      'vids_create',
      'vids_get',
      'vids_open',
      'vids_storyboard_generate',
      'vids_scene_add',
      'vids_scene_delete',
      'vids_media_add',
      'vids_ai_generate',
      'vids_ai_edit',
      'vids_voiceover_generate',
      'vids_share',
      'vids_download',
    ]) {
      expect(names).toContain(tool);
    }
  });

  const still = {
    exitCode: 8,
    stderr: '',
    envelope: { ok: false, data: null, error: { code: 'STILL_RUNNING' } },
  };
  const done = { exitCode: 0, stderr: '', envelope: { ok: true, data: { finished: true }, error: null } };

  it('vids_wait waits once (45 s) when the client sends no progress token', async () => {
    const calls: string[][] = [];
    const r = await waitWithProgress('task_1', undefined, {}, async (args) => {
      calls.push(args);
      return still;
    });
    expect(calls).toEqual([['wait', 'task_1', '--timeout', '45s']]);
    expect(r.isError).toBe(true);
  });

  it('vids_wait keeps waiting with progress notifications when the client sends a progress token', async () => {
    const results = [still, still, done];
    const notes: Array<{ progressToken: string | number; total?: number }> = [];
    const r = await waitWithProgress(
      'task_1',
      undefined,
      { _meta: { progressToken: 'p1' }, sendNotification: async (n) => void notes.push(n.params) },
      async (args) => {
        expect(args.slice(0, 3)).toEqual(['wait', 'task_1', '--timeout']);
        return results.shift()!;
      },
    );
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({ progressToken: 'p1', total: 600 });
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ ok: true, data: { finished: true } });
  });
});
