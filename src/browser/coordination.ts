import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GvidsPaths } from '../config/paths.js';
import { BrowserSessionError, GvidsError } from '../errors/errors.js';
import { ExitCode } from '../errors/exit-codes.js';
import { closeTarget, readDevToolsActivePort } from './launcher.js';
import { sleep } from '../utils/time.js';

/**
 * Cross-process coordination for the one managed (gvids-profile) browser:
 *
 * - a lock file serializes "find or launch the browser" and "close it if unused",
 *   so two commands started together cannot both launch Chrome on the same profile;
 * - every attached command holds a lease file, so a browser launched for one
 *   command is closed only when the last command using it has finished.
 *
 * Stale locks and leases (their process is gone) are ignored and cleaned up.
 */

const LOCK_STALE_MS = 2 * 60_000;
const BUSY = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
/** Windows refuses to delete a file another process is reading at that moment: retry briefly. */
const RM_RETRY = { force: true, maxRetries: 10, retryDelay: 30 } as const;
const LEASE_MAX_AGE_MS = 6 * 60 * 60_000;

interface Holder {
  pid: number;
  since: string;
  token?: string;
}

function lockFile(paths: GvidsPaths): string {
  return path.join(paths.browserDir, 'launch.lock');
}

function leasesDir(paths: GvidsPaths): string {
  return path.join(paths.browserDir, 'leases');
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(file: string): Promise<{ holder?: Holder; mtimeMs?: number } | undefined> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    try {
      return { holder: JSON.parse(text) as Holder, mtimeMs: stat.mtimeMs };
    } catch {
      return { mtimeMs: stat.mtimeMs };
    }
  } catch {
    return undefined;
  }
}

/** Runs `fn` while holding the browser lock (waits up to `timeoutMs` for another holder). */
export async function withBrowserLock<T>(
  paths: GvidsPaths,
  fn: () => Promise<T>,
  timeoutMs = 90_000,
): Promise<T> {
  const file = lockFile(paths);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.writeFile(
        file,
        JSON.stringify({ pid: process.pid, since: new Date().toISOString(), token } satisfies Holder),
        { flag: 'wx' },
      );
      break;
    } catch (err) {
      // EEXIST: held. EPERM/EBUSY/EACCES: on Windows the old file is still being deleted.
      if (!BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      const current = await readHolder(file);
      const stale =
        current !== undefined &&
        ((current.holder && !processAlive(current.holder.pid)) ||
          (current.mtimeMs !== undefined && Date.now() - current.mtimeMs > LOCK_STALE_MS));
      if (stale) {
        await fs.rm(file, RM_RETRY).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new BrowserSessionError('Another gvids command is still starting or closing the browser.', {
          retryable: true,
          hint: 'Retry in a moment. If this persists, run: gvids browser close',
          details: { lock: file, holder: current?.holder?.pid },
        });
      }
      await sleep(100 + Math.floor(Math.random() * 150));
    }
  }
  try {
    return await fn();
  } finally {
    // Only remove our own lock: a file that is empty or someone else's belongs to another holder.
    const current = await readHolder(file);
    if (current?.holder?.token === token) await fs.rm(file, RM_RETRY).catch(() => undefined);
  }
}

/** Registers this session as a user of the managed browser. Returns the lease file. */
export async function addLease(paths: GvidsPaths, label: string): Promise<string> {
  const dir = leasesDir(paths);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ pid: process.pid, since: new Date().toISOString(), token: label } satisfies Holder),
  );
  return file;
}

export async function removeLease(file: string | undefined): Promise<void> {
  if (file) await fs.rm(file, RM_RETRY).catch(() => undefined);
}

interface LeaseRecord extends Holder {
  /** DevTools target ids of the tabs this command opened or claimed. */
  tabs?: string[];
}

/** Records which tabs a command owns, so they can be closed if its process dies without cleanup. */
export async function recordLeaseTabs(file: string | undefined, tabs: string[]): Promise<void> {
  if (!file) return;
  const current = await readHolder(file);
  if (!current?.holder) return;
  await fs
    .writeFile(file, JSON.stringify({ ...current.holder, tabs } satisfies LeaseRecord))
    .catch(() => undefined);
}

/** Closes tabs left behind by a command whose process is gone (killed, not cancelled). */
async function closeOrphanTabs(paths: GvidsPaths, tabs: string[]): Promise<void> {
  const port = await readDevToolsActivePort(paths.browserProfileDir);
  if (!port) return;
  for (const id of tabs) await closeTarget(`http://127.0.0.1:${port.port}`, id).catch(() => false);
}

/** Leases of live processes (other than `except`); stale ones are deleted, and their tabs closed. */
export async function liveLeases(paths: GvidsPaths, except?: string): Promise<string[]> {
  const dir = leasesDir(paths);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const live: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (file === except || !name.endsWith('.json')) continue;
    const current = await readHolder(file);
    const pid = current?.holder?.pid ?? Number(name.split('-')[0]);
    const tooOld = current?.mtimeMs !== undefined && Date.now() - current.mtimeMs > LEASE_MAX_AGE_MS;
    if (!Number.isInteger(pid) || !processAlive(pid) || tooOld) {
      const tabs = (current?.holder as LeaseRecord | undefined)?.tabs ?? [];
      if (tabs.length > 0) await closeOrphanTabs(paths, tabs);
      await fs.rm(file, { force: true }).catch(() => undefined);
      continue;
    }
    live.push(file);
  }
  return live;
}

/** Forgets every lease (after the browser was closed explicitly). */
export async function clearLeases(paths: GvidsPaths): Promise<void> {
  await fs.rm(leasesDir(paths), { recursive: true, force: true }).catch(() => undefined);
}

/** A holder older than this is ignored even if its pid is alive again (pid reuse). */
const VIDEO_LOCK_MAX_AGE_MS = 3 * 60 * 60_000;

export interface VideoLockHolder extends Holder {
  /** What the holding command is doing ("Adding text", …). */
  label?: string;
}

function videoLockFile(paths: GvidsPaths, id: string): string {
  return path.join(paths.browserDir, 'videos', `${id.replace(/[^\w-]/g, '_')}.lock`);
}

/**
 * Takes the exclusive lock on one video. Commands on different videos run in
 * parallel; two commands editing the same video at once would interfere (each
 * works in its own tab), so the second waits for the first. The lock belongs to
 * a token, not a process, so parallel MCP calls in one process wait too.
 * Returns the function that releases it.
 */
export async function acquireVideoLock(
  paths: GvidsPaths,
  id: string,
  options: { label: string; timeoutMs: number; onWait?: (holder: VideoLockHolder | undefined) => void },
): Promise<() => Promise<void>> {
  const file = videoLockFile(paths, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + options.timeoutMs;
  let announced = false;
  for (;;) {
    try {
      const holder: VideoLockHolder = {
        pid: process.pid,
        since: new Date().toISOString(),
        token,
        label: options.label,
      };
      await fs.writeFile(file, JSON.stringify(holder), { flag: 'wx' });
      break;
    } catch (err) {
      if (!BUSY.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      const current = await readHolder(file);
      const holder = current?.holder as VideoLockHolder | undefined;
      const stale =
        current !== undefined &&
        ((holder !== undefined && !processAlive(holder.pid)) ||
          (current.mtimeMs !== undefined && Date.now() - current.mtimeMs > VIDEO_LOCK_MAX_AGE_MS));
      if (stale) {
        await fs.rm(file, RM_RETRY).catch(() => undefined);
        continue;
      }
      if (!announced) {
        announced = true;
        options.onWait?.(holder);
      }
      if (Date.now() >= deadline) {
        throw new GvidsError(`Another gvids command is still working on video ${id}.`, {
          code: 'VIDEO_BUSY',
          exitCode: ExitCode.GenerationTimeout,
          hint: [
            'Commands on the same video run one at a time. Retry when the other command has finished,',
            'or pass a longer --timeout to wait for it.',
          ],
          details: {
            id,
            ...(holder ? { holder: { pid: holder.pid, since: holder.since, label: holder.label } } : {}),
          },
        });
      }
      await sleep(200 + Math.floor(Math.random() * 150));
    }
  }
  return async () => {
    const current = await readHolder(file);
    if ((current?.holder as VideoLockHolder | undefined)?.token === token) {
      await fs.rm(file, RM_RETRY).catch(() => undefined);
    }
  };
}
