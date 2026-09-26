import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserSessionError, GvidsError } from '../errors/errors.js';
import { pathExists } from '../utils/fs.js';
import { sleep } from '../utils/time.js';

export type BrowserChannel = 'auto' | 'chrome' | 'msedge' | 'chromium';

export interface BrowserExecutable {
  path: string;
  kind: 'chrome' | 'msedge' | 'chromium' | 'custom';
  source: 'config' | 'system' | 'playwright';
}

function windowsCandidates(): Array<{ path: string; kind: BrowserExecutable['kind'] }> {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA ?? '';
  return [
    { path: path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
    { path: path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' },
    ...(local
      ? [{ path: path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), kind: 'chrome' as const }]
      : []),
    { path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'msedge' },
    { path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), kind: 'msedge' },
  ];
}

function macCandidates(): Array<{ path: string; kind: BrowserExecutable['kind'] }> {
  const home = process.env.HOME ?? '';
  return [
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', kind: 'chrome' },
    { path: path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), kind: 'chrome' },
    { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'msedge' },
    { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', kind: 'chromium' },
  ];
}

function linuxCandidates(): Array<{ path: string; kind: BrowserExecutable['kind'] }> {
  const dirs = (process.env.PATH ?? '/usr/bin:/usr/local/bin').split(':');
  const names: Array<[string, BrowserExecutable['kind']]> = [
    ['google-chrome', 'chrome'],
    ['google-chrome-stable', 'chrome'],
    ['microsoft-edge', 'msedge'],
    ['microsoft-edge-stable', 'msedge'],
    ['chromium', 'chromium'],
    ['chromium-browser', 'chromium'],
  ];
  return names.flatMap(([name, kind]) => dirs.map((d) => ({ path: path.join(d, name), kind })));
}

async function playwrightChromium(): Promise<string | undefined> {
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    return p && (await pathExists(p)) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds a Chromium-based browser. Installed Google Chrome is preferred: Google
 * sign-in works normally in it, and it is what Vids officially supports.
 */
export async function findBrowserExecutable(
  channel: BrowserChannel,
  explicitPath?: string,
): Promise<BrowserExecutable | undefined> {
  if (explicitPath) {
    return (await pathExists(explicitPath))
      ? { path: explicitPath, kind: 'custom', source: 'config' }
      : undefined;
  }
  const candidates =
    process.platform === 'win32'
      ? windowsCandidates()
      : process.platform === 'darwin'
        ? macCandidates()
        : linuxCandidates();
  const wanted = channel === 'auto' ? undefined : channel;
  for (const c of candidates) {
    if (wanted && c.kind !== wanted) continue;
    if (await pathExists(c.path)) return { path: c.path, kind: c.kind, source: 'system' };
  }
  if (channel === 'auto' || channel === 'chromium') {
    const bundled = await playwrightChromium();
    if (bundled) return { path: bundled, kind: 'chromium', source: 'playwright' };
  }
  return undefined;
}

export interface DevToolsPort {
  port: number;
  browserPath: string;
}

export async function readDevToolsActivePort(profileDir: string): Promise<DevToolsPort | undefined> {
  try {
    const text = await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const [portLine, pathLine] = text.split(/\r?\n/);
    const port = Number(portLine);
    if (!Number.isInteger(port) || port <= 0) return undefined;
    return { port, browserPath: pathLine?.trim() ?? '' };
  } catch {
    return undefined;
  }
}

export interface CdpVersionInfo {
  Browser?: string;
  'Protocol-Version'?: string;
  'User-Agent'?: string;
  webSocketDebuggerUrl?: string;
}

/** GET <endpoint>/json/version with a short timeout. */
export async function probeCdpEndpoint(
  httpEndpoint: string,
  timeoutMs = 2000,
): Promise<CdpVersionInfo | undefined> {
  const url = `${httpEndpoint.replace(/\/+$/, '')}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return (await res.json()) as CdpVersionInfo;
  } catch {
    return undefined;
  }
}

/**
 * Sends Browser.close over a bare DevTools WebSocket. Unlike a Playwright
 * connection this does not attach to any tab, so it works even when a tab is
 * hung (e.g. stuck behind a modal dialog).
 */
export async function closeViaDevTools(httpEndpoint: string, timeoutMs = 5000): Promise<boolean> {
  const info = await probeCdpEndpoint(httpEndpoint, timeoutMs);
  if (!info?.webSocketDebuggerUrl) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      const ws = new WebSocket(info.webSocketDebuggerUrl!);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      ws.addEventListener('message', () => done(true));
      ws.addEventListener('close', () => done(true));
      ws.addEventListener('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * Sends one DevTools command over a bare WebSocket (browser or page target) and
 * returns its result, or undefined on error or timeout. A bare connection does not
 * attach to other tabs, so it works when a Playwright attach would hang.
 */
export async function cdpCommand(
  webSocketUrl: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 3000,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | undefined;
    const done = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    try {
      ws = new WebSocket(webSocketUrl);
      ws.addEventListener('open', () => ws!.send(JSON.stringify({ id: 1, method, params })));
      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: unknown;
          };
          if (msg.id === 1) done(msg.error ? undefined : (msg.result ?? {}));
        } catch {
          // not ours
        }
      });
      ws.addEventListener('error', () => done(undefined));
      ws.addEventListener('close', () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}

export interface PageTarget {
  id: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** The browser's tabs, from GET <endpoint>/json/list. */
export async function listPageTargets(httpEndpoint: string, timeoutMs = 2000): Promise<PageTarget[]> {
  try {
    const res = await fetch(`${httpEndpoint.replace(/\/+$/, '')}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const targets = (await res.json()) as Array<PageTarget & { type?: string }>;
    return targets.filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  } catch {
    return [];
  }
}

/** Closes one tab through the DevTools HTTP endpoint (no attach needed). */
export async function closeTarget(
  httpEndpoint: string,
  targetId: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${httpEndpoint.replace(/\/+$/, '')}/json/close/${encodeURIComponent(targetId)}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export interface StuckTab {
  id: string;
  url: string;
  /** Answers again after being brought to the front. */
  recovered: boolean;
  closed: boolean;
}

/**
 * Finds tabs whose page does not answer DevTools within `probeMs` (one busy or
 * deprioritized tab blocks attaching to the whole browser), brings each to the
 * front to wake it, and optionally closes the ones that still do not answer.
 */
export async function recoverStuckTabs(
  httpEndpoint: string,
  options: { close: boolean; probeMs?: number },
): Promise<StuckTab[]> {
  const probeMs = options.probeMs ?? 1500;
  const probe = (t: PageTarget): Promise<boolean> =>
    cdpCommand(
      t.webSocketDebuggerUrl,
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      probeMs,
    ).then((r) => r !== undefined);
  const targets = await listPageTargets(httpEndpoint);
  const answers = await Promise.all(targets.map(probe));
  const stuck: StuckTab[] = [];
  for (const [i, target] of targets.entries()) {
    if (answers[i]) continue;
    await cdpCommand(target.webSocketDebuggerUrl, 'Page.bringToFront', {}, probeMs);
    await sleep(300);
    const recovered = await probe(target);
    const closed = !recovered && options.close ? await closeTarget(httpEndpoint, target.id) : false;
    stuck.push({ id: target.id, url: target.url, recovered, closed });
  }
  return stuck;
}

/**
 * Detects whether another Chrome process currently owns the profile. Chrome
 * holds `lockfile` open exclusively on Windows and uses a SingletonLock
 * symlink ("host-pid") on macOS/Linux.
 */
export async function isProfileLocked(profileDir: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const lockfile = path.join(profileDir, 'lockfile');
    if (!(await pathExists(lockfile))) return false;
    try {
      const handle = await fs.open(lockfile, 'r+');
      await handle.close();
      return false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  }
  try {
    const target = await fs.readlink(path.join(profileDir, 'SingletonLock'));
    const pid = Number(target.split('-').pop());
    if (!Number.isInteger(pid)) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  executable: BrowserExecutable;
  profileDir: string;
  headless: boolean;
  /** Detach so the browser outlives this process (browser open / keepOpen). */
  detached: boolean;
  windowSize: { width: number; height: number };
  startUrl?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface LaunchedBrowser {
  process: ChildProcess;
  pid: number | undefined;
  port: number;
  httpEndpoint: string;
}

/**
 * Command-line arguments of the automation browser.
 *
 * - Extensions and sync stay off: signing in to Chrome in the gvids profile syncs
 *   the user's extensions and other Chrome data into it, and extension content
 *   scripts would run inside the pages gvids drives.
 * - Background tabs are not throttled: a warm browser keeps several tabs, and
 *   Chrome deprioritizes the hidden ones of a visible window until they stop
 *   answering DevTools, which blocks every later attach.
 */
export function automationArgs(options: LaunchOptions): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--lang=en-US',
    `--window-size=${options.windowSize.width},${options.windowSize.height}`,
    ...(options.headless ? ['--headless=new'] : []),
    ...(options.extraArgs ?? []),
    options.startUrl ?? 'about:blank',
  ];
}

/**
 * Starts the browser as a normal process with a dedicated user-data directory
 * and a DevTools port on 127.0.0.1, then waits for DevToolsActivePort.
 * Chrome itself refuses remote debugging on the default profile, so gvids
 * always uses its own profile directory.
 */
export async function launchBrowserProcess(options: LaunchOptions): Promise<LaunchedBrowser> {
  await fs.mkdir(options.profileDir, { recursive: true });
  await fs.rm(path.join(options.profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(options.executable.path, automationArgs(options), {
    detached: options.detached,
    stdio: 'ignore',
    windowsHide: options.headless,
  });
  let exited: number | null | undefined;
  let spawnError: Error | undefined;
  child.once('exit', (code) => {
    exited = code;
  });
  child.once('error', (err) => {
    spawnError = err;
  });
  if (options.detached) child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (spawnError) {
      throw new BrowserSessionError(`Could not start ${options.executable.path}: ${spawnError.message}`, {
        code: 'BROWSER_NOT_FOUND',
      });
    }
    const port = await readDevToolsActivePort(options.profileDir);
    if (port) {
      const httpEndpoint = `http://127.0.0.1:${port.port}`;
      if (await probeCdpEndpoint(httpEndpoint, 1000)) {
        return { process: child, pid: child.pid, port: port.port, httpEndpoint };
      }
    }
    if (exited !== undefined) {
      // The process can exit immediately when the profile is already open in another window.
      if (await isProfileLocked(options.profileDir)) {
        throw new BrowserSessionError(
          'The gvids browser profile is already open in another browser window.',
          {
            code: 'BROWSER_PROFILE_LOCKED',
            hint: ['Close that window, or run: gvids browser close', 'Then retry the command.'],
          },
        );
      }
      throw new BrowserSessionError(`The browser exited during startup (exit code ${exited}).`);
    }
    await sleep(150);
  }
  child.kill();
  throw new BrowserSessionError('Timed out waiting for the browser DevTools endpoint.', {
    hint: ['Run: gvids doctor', 'If a gvids browser window is open, close it and retry.'],
  });
}

/**
 * Starts the browser for a human to use, with no DevTools port and no
 * automation attached. Google refuses sign-in in browsers that are being
 * driven over CDP, so `gvids browser login` uses this: the user signs in
 * normally, closes the window, and only then does gvids attach to the profile.
 * Resolves with the exit code once the window is closed.
 */
export async function runInteractiveBrowser(options: {
  executable: BrowserExecutable;
  profileDir: string;
  url: string;
  windowSize: { width: number; height: number };
  timeoutMs: number;
  onStarted?: () => void;
}): Promise<{ exitCode: number | null; timedOut: boolean; durationMs: number }> {
  await fs.mkdir(options.profileDir, { recursive: true });
  const started = Date.now();
  const child = spawn(
    options.executable.path,
    [
      `--user-data-dir=${options.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      // Signing in to Google here must not pull the user's Chrome data (extensions, history) into the profile.
      '--disable-sync',
      // Exit when the window closes even if a Google component extension runs in the background.
      '--disable-background-mode',
      '--lang=en-US',
      `--window-size=${options.windowSize.width},${options.windowSize.height}`,
      '--new-window',
      options.url,
    ],
    { stdio: 'ignore', detached: false },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: null, timedOut: true, durationMs: Date.now() - started });
    }, options.timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(
        new BrowserSessionError(`Could not start ${options.executable.path}: ${err.message}`, {
          code: 'BROWSER_NOT_FOUND',
        }),
      );
    });
    child.once('spawn', () => options.onStarted?.());
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false, durationMs: Date.now() - started });
    });
  });
}

export function assertLoopbackEndpoint(endpoint: string, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (err) {
    throw new GvidsError(`Invalid CDP endpoint: ${endpoint}`, {
      code: 'INVALID_ARGUMENT',
      exitCode: 2,
      cause: err,
    });
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new GvidsError('CDP endpoint must start with http://, https://, ws:// or wss://', {
      code: 'INVALID_ARGUMENT',
      exitCode: 2,
    });
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (!loopback && !allowRemote) {
    throw new GvidsError(`Refusing to attach to a non-local browser (${url.hostname}).`, {
      code: 'INVALID_ARGUMENT',
      exitCode: 2,
      hint: 'Remote DevTools endpoints give full control of a signed-in browser. Pass --allow-remote if you really mean it.',
    });
  }
  return url;
}
