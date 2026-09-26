import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireVideoLock,
  addLease,
  liveLeases,
  recordLeaseTabs,
  removeLease,
  withBrowserLock,
} from '../../src/browser/coordination.js';
import { getPaths } from '../../src/config/paths.js';
import { GvidsError, withContext } from '../../src/errors/errors.js';
import { cleanErrorMessage, toGvidsError } from '../../src/errors/map.js';
import { assertGoogleUrl } from '../../src/google/transport.js';
import { redactArgv } from '../../src/utils/redact.js';
import { onShutdown, onShutdownFinal } from '../../src/utils/shutdown.js';
import { tempHome } from '../helpers/cli.js';

describe('browser coordination', () => {
  it('serializes launches across callers', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    const order: string[] = [];
    const slow = (name: string) =>
      withBrowserLock(paths, async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, 60));
        order.push(`${name}:end`);
      });
    await Promise.all([slow('a'), slow('b'), slow('c')]);
    // No two critical sections overlap.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]!.split(':')[0]).toBe(order[i + 1]!.split(':')[0]);
    }
    expect(fs.existsSync(path.join(paths.browserDir, 'launch.lock'))).toBe(false);
  });

  it('breaks a lock left by a dead process', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    fs.mkdirSync(paths.browserDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.browserDir, 'launch.lock'),
      JSON.stringify({ pid: 999_999, since: new Date().toISOString() }),
    );
    const started = Date.now();
    expect(await withBrowserLock(paths, async () => 'ran', 5_000)).toBe('ran');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('times out with a retryable error while another live process holds the lock', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    fs.mkdirSync(paths.browserDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.browserDir, 'launch.lock'),
      JSON.stringify({ pid: process.pid, since: new Date().toISOString(), token: 'other' }),
    );
    const err = await withBrowserLock(paths, async () => 'ran', 300).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GvidsError);
    expect((err as GvidsError).toJSON()).toMatchObject({ code: 'BROWSER_SESSION_ERROR', retryable: true });
  });

  it('counts leases of live processes only', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    const mine = await addLease(paths, 'test');
    const dir = path.dirname(mine);
    fs.writeFileSync(path.join(dir, '999999-dead.json'), JSON.stringify({ pid: 999_999, since: 'x' }));
    expect(await liveLeases(paths)).toEqual([mine]);
    expect(fs.existsSync(path.join(dir, '999999-dead.json'))).toBe(false);
    expect(await liveLeases(paths, mine)).toEqual([]);
    await removeLease(mine);
    expect(await liveLeases(paths)).toEqual([]);
  });

  it('runs commands on one video one at a time, and different videos in parallel', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    const order: string[] = [];
    const edit = async (video: string, name: string): Promise<void> => {
      const release = await acquireVideoLock(paths, video, { label: name, timeoutMs: 5_000 });
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 60));
      order.push(`${name}:end`);
      await release();
    };
    await Promise.all([edit('vidA', 'a1'), edit('vidA', 'a2'), edit('vidB', 'b1')]);
    const a = order.filter((o) => o.startsWith('a'));
    expect(a[0]!.split(':')[0]).toBe(a[1]!.split(':')[0]);
    expect(a[2]!.split(':')[0]).toBe(a[3]!.split(':')[0]);
    // vidB did not wait for vidA: it started before any vidA command finished.
    expect(order.indexOf('b1:start')).toBeLessThan(order.findIndex((o) => o.endsWith(':end')));
    expect(fs.readdirSync(path.join(paths.browserDir, 'videos'))).toEqual([]);
  });

  it('takes over a video lock left by a dead process', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    fs.mkdirSync(path.join(paths.browserDir, 'videos'), { recursive: true });
    fs.writeFileSync(
      path.join(paths.browserDir, 'videos', 'vidA.lock'),
      JSON.stringify({ pid: 999_999, since: new Date().toISOString(), token: 'x' }),
    );
    const release = await acquireVideoLock(paths, 'vidA', { label: 'test', timeoutMs: 2_000 });
    await release();
  });

  it('reports VIDEO_BUSY with the holder while another command keeps the video', async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    const release = await acquireVideoLock(paths, 'vidA', { label: 'Adding text', timeoutMs: 1_000 });
    const waited: unknown[] = [];
    const err = await acquireVideoLock(paths, 'vidA', {
      label: 'Listing scenes',
      timeoutMs: 300,
      onWait: (holder) => waited.push(holder?.label),
    }).catch((e: unknown) => e);
    expect(waited).toEqual(['Adding text']);
    expect((err as GvidsError).toJSON()).toMatchObject({
      code: 'VIDEO_BUSY',
      exitCode: 8,
      retryable: true,
      details: { id: 'vidA', holder: { pid: process.pid, label: 'Adding text' } },
    });
    await release();
  });

  it("records a command's tabs in its lease and drops the lease once the process is gone", async () => {
    const paths = getPaths({ GVIDS_HOME: tempHome() });
    const mine = await addLease(paths, 'test');
    await recordLeaseTabs(mine, ['T1', 'T2']);
    expect(JSON.parse(fs.readFileSync(mine, 'utf8'))).toMatchObject({ pid: process.pid, tabs: ['T1', 'T2'] });
    const dead = path.join(path.dirname(mine), '999999-dead.json');
    fs.writeFileSync(dead, JSON.stringify({ pid: 999_999, since: 'x', tabs: ['T3'] }));
    // No browser is running here, so closing T3 is a no-op; the dead lease must still go.
    expect(await liveLeases(paths)).toEqual([mine]);
    expect(fs.existsSync(dead)).toBe(false);
    await removeLease(mine);
  });
});

describe('error mapping', () => {
  it('turns raw Playwright failures into retryable browser errors without escape codes', () => {
    const raw = new Error(
      'page.goto: net::ERR_ABORTED at https://docs.google.com/videos/d/x/edit\nCall log:\n\u001b[2m  - navigating to "https://docs.google.com/…"\u001b[22m',
    );
    const e = toGvidsError(raw).toJSON();
    expect(e).toMatchObject({ code: 'BROWSER_SESSION_ERROR', exitCode: 7, retryable: true });
    expect(e.message).not.toMatch(/\u001b|Call log/);
    const timeout = Object.assign(new Error('locator.click: Timeout 5000ms exceeded.'), {
      name: 'TimeoutError',
    });
    expect(toGvidsError(timeout).code).toBe('BROWSER_SESSION_ERROR');
    expect(toGvidsError(new Error('boom')).code).toBe('GENERIC_ERROR');
    expect(cleanErrorMessage('\u001b[31mred\u001b[39m')).toBe('red');
  });

  it('withContext adds next steps and details but keeps the classification', () => {
    const base = new GvidsError('Step failed', {
      code: 'UI_CHANGED',
      exitCode: 7,
      hint: 'Run: gvids doctor',
    });
    const e = withContext(base, { next: ['gvids job resume job_1'], details: { jobId: 'job_1' } }).toJSON();
    expect(e).toMatchObject({
      code: 'UI_CHANGED',
      exitCode: 7,
      retryable: true,
      next: ['gvids job resume job_1', 'gvids doctor'],
      details: { jobId: 'job_1' },
    });
  });
});

describe('secrets', () => {
  it('only sends the OAuth token to Google over HTTPS', () => {
    expect(() => assertGoogleUrl('https://www.googleapis.com/download/drive/v3/files/x')).not.toThrow();
    expect(() => assertGoogleUrl('https://lh3.googleusercontent.com/abc=s220')).not.toThrow();
    for (const bad of [
      'http://www.googleapis.com/x',
      'https://evil.example/x',
      'https://googleapis.com.evil.io/',
    ]) {
      expect(() => assertGoogleUrl(bad), bad).toThrow(/Refusing to send Google credentials/);
    }
  });

  it('masks secret flag values in echoed arguments', () => {
    expect(redactArgv(['auth', 'login', '--client-secret', 's3cret', '--port', '8080'])).toEqual([
      'auth',
      'login',
      '--client-secret',
      '[REDACTED]',
      '--port',
      '8080',
    ]);
    expect(redactArgv(['--client-secret=s3cret'])).toEqual(['--client-secret=[REDACTED]']);
    expect(redactArgv(['text', 'ya29.a0AfH6SMBx'])[1]).toBe('ya29.[REDACTED]');
  });
});

describe('shutdown hooks', () => {
  it('registers and unregisters cleanups', () => {
    const off = onShutdown(async () => undefined);
    const offFinal = onShutdownFinal(async () => undefined);
    expect(typeof off).toBe('function');
    off();
    offFinal();
  });
});
