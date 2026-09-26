import fs from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Writes a file atomically (write to temp, then rename) with optional restrictive permissions. */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { mode: options.mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows can refuse to rename over a file that is momentarily locked; fall back to copy.
    if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EBUSY') {
      await fs.copyFile(tmp, file);
      await fs.rm(tmp, { force: true });
    } else {
      throw err;
    }
  }
  if (options.mode !== undefined) {
    await fs.chmod(file, options.mode).catch(() => undefined);
  }
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Turns an arbitrary title into a file name that is valid on Windows, macOS
 * and Linux: strips reserved characters, control characters, trailing dots
 * and spaces, and reserved device names.
 */
export function sanitizeFileName(name: string, fallback = 'video'): string {
  let out = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (out.length > 150) out = out.slice(0, 150).trim();
  if (out === '' || /^\.+$/.test(out)) out = fallback;
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
}

/** Returns `file` if it does not exist, otherwise "name (2).ext", "name (3).ext", ... */
export async function uniquePath(file: string): Promise<string> {
  if (!(await pathExists(file))) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free file name for ${file}`);
}

export function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? process.env.USERPROFILE ?? p;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (home) return path.join(home, p.slice(2));
  }
  return p;
}
