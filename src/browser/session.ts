import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { GvidsConfig } from '../config/config.js';
import type { GvidsPaths } from '../config/paths.js';
import { BrowserSessionError } from '../errors/errors.js';
import { readJsonFile, writeFileAtomic } from '../utils/fs.js';
import type { Logger } from '../utils/logger.js';
import { onShutdown } from '../utils/shutdown.js';
import { sleep } from '../utils/time.js';
import {
  addLease,
  clearLeases,
  liveLeases,
  recordLeaseTabs,
  removeLease,
  withBrowserLock,
} from './coordination.js';
import { Diagnostics } from './diagnostics/diagnostics.js';
import {
  closeViaDevTools,
  findBrowserExecutable,
  launchBrowserProcess,
  probeCdpEndpoint,
  readDevToolsActivePort,
  recoverStuckTabs,
  type BrowserExecutable,
  type LaunchedBrowser,
} from './launcher.js';

export interface BrowserSessionOptions {
  config: GvidsConfig;
  paths: GvidsPaths;
  logger: Logger;
  headless: boolean;
  /** Always show the window (browser login/open). */
  forceHeaded?: boolean;
  /** Leave the browser running when the session closes. */
  keepOpen?: boolean;
  debug: { enabled: boolean; dir: string; trace: boolean };
  cwd: string;
  startUrl?: string;
}

export type SessionMode = 'external' | 'reused' | 'launched';

/** Idle editor tabs kept in a persistent gvids browser for the next command on the same video. */
const MAX_IDLE_TABS = 2;

export interface ManagedBrowserState {
  pid?: number;
  port: number;
  headless: boolean;
  executable: string;
  startedAt: string;
  /**
   * Started (or adopted) by `gvids browser open` / browser.keepOpen: stays running
   * until `gvids browser close`. Otherwise the last command using it closes it.
   */
  persistent?: boolean;
}

export interface RunningBrowserInfo {
  httpEndpoint: string;
  port: number;
  browser?: string;
  state?: ManagedBrowserState;
}

/** Returns the managed (gvids-profile) browser if one is running with a live DevTools endpoint. */
export async function findRunningManagedBrowser(paths: GvidsPaths): Promise<RunningBrowserInfo | undefined> {
  const port = await readDevToolsActivePort(paths.browserProfileDir);
  if (!port) return undefined;
  const httpEndpoint = `http://127.0.0.1:${port.port}`;
  const version = await probeCdpEndpoint(httpEndpoint, 1500);
  if (!version) return undefined;
  const state = await readJsonFile<ManagedBrowserState>(paths.browserStateFile).catch(() => undefined);
  return {
    httpEndpoint,
    port: port.port,
    ...(version.Browser ? { browser: version.Browser } : {}),
    ...(state && state.port === port.port ? { state } : {}),
  };
}

async function readState(paths: GvidsPaths, port: number): Promise<ManagedBrowserState | undefined> {
  const state = await readJsonFile<ManagedBrowserState>(paths.browserStateFile).catch(() => undefined);
  return state && state.port === port ? state : undefined;
}

async function writeState(paths: GvidsPaths, state: ManagedBrowserState): Promise<void> {
  await writeFileAtomic(paths.browserStateFile, `${JSON.stringify(state, null, 2)}\n`).catch(() => undefined);
}

/** Closes the browser behind a DevTools endpoint and waits until it is gone. */
async function closeEndpoint(httpEndpoint: string, launched?: LaunchedBrowser): Promise<void> {
  const closed = await closeViaDevTools(httpEndpoint);
  if (!closed && launched?.process.exitCode === null) launched.process.kill();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await probeCdpEndpoint(httpEndpoint, 500))) await sleep(200);
  if (
    launched?.process &&
    launched.process.exitCode === null &&
    (await probeCdpEndpoint(httpEndpoint, 500))
  ) {
    launched.process.kill();
  }
}

async function connect(endpoint: string, slowMo: number, timeoutMs = 30_000): Promise<Browser> {
  const { chromium } = await import('playwright');
  try {
    return await chromium.connectOverCDP(endpoint, { slowMo, timeout: timeoutMs });
  } catch (err) {
    throw new BrowserSessionError(`Could not attach to the browser at ${endpoint}.`, {
      cause: err,
      hint: ['Is the browser still running?', 'Run: gvids browser status'],
    });
  }
}

/** Gracefully closes a CDP-connected browser (lets Chrome flush cookies to disk). */
async function closeBrowserGracefully(browser: Browser, launched?: LaunchedBrowser): Promise<void> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close');
  } catch {
    // fall through to process kill
  }
  if (launched?.process && launched.process.exitCode === null) {
    const deadline = Date.now() + 10_000;
    while (launched.process.exitCode === null && Date.now() < deadline) await sleep(100);
    if (launched.process.exitCode === null) launched.process.kill();
  }
  await browser.close().catch(() => undefined);
}

/**
 * One browser attachment for the duration of a command. The browser is either
 * an external Chrome the user connected with `gvids browser connect`, an
 * already-running gvids-managed browser, or one launched for this command.
 */
export class BrowserSession {
  readonly diagnostics: Diagnostics;
  private readonly ownPages: Page[] = [];
  /** Run when the session closes (after its tabs are closed or released), e.g. video locks. */
  private readonly closers: Array<() => Promise<void>> = [];
  /** DevTools ids of this session's tabs (recorded in its lease). */
  private readonly tabIds = new Set<string>();
  private tracing = false;
  private closed = false;
  private unregisterShutdown: (() => void) | undefined;

  private constructor(
    readonly browser: Browser,
    readonly context: BrowserContext,
    readonly mode: SessionMode,
    private readonly options: BrowserSessionOptions,
    private readonly launched?: LaunchedBrowser,
    readonly executable?: BrowserExecutable,
    /** This session's lease on the managed browser (not used for external browsers). */
    private readonly lease?: string,
    private readonly httpEndpoint?: string,
    /** The managed browser outlives its commands (browser open / keepOpen). */
    private readonly persistent = false,
  ) {
    const dir = path.resolve(options.cwd, options.debug.dir);
    this.diagnostics = new Diagnostics(dir, options.debug.enabled, options.logger);
  }

  static async start(options: BrowserSessionOptions): Promise<BrowserSession> {
    const { config, logger } = options;
    const external = config.browser.cdpEndpoint;
    if (external) {
      logger.debug({ endpoint: external }, 'attaching to external browser');
      const browser = await connect(external, config.browser.slowMo);
      const context = browser.contexts()[0];
      if (!context) throw new BrowserSessionError('The connected browser has no default context.');
      return BrowserSession.finish(new BrowserSession(browser, context, 'external', options));
    }
    try {
      return await BrowserSession.startManaged(options);
    } catch (err) {
      if (!(err instanceof UnresponsiveBrowser)) throw err;
      // One hung tab blocks attaching to the whole browser: wake or close such tabs first.
      const stuck = await recoverStuckTabs(err.httpEndpoint, { close: true }).catch(() => []);
      if (stuck.length > 0) {
        logger.warn(
          { tabs: stuck.map((t) => ({ url: t.url, recovered: t.recovered, closed: t.closed })) },
          `Recovered ${stuck.length} unresponsive tab(s) in the gvids browser.`,
        );
        try {
          return await BrowserSession.startManaged(options);
        } catch (retryErr) {
          if (!(retryErr instanceof UnresponsiveBrowser)) throw retryErr;
        }
      }
      // Still unreachable. The managed browser is ours: restart it once, keeping it warm
      // (and headless or not) if it was opened with `browser open`.
      logger.warn('The running gvids browser is not responding; restarting it.');
      const previous = await readJsonFile<ManagedBrowserState>(options.paths.browserStateFile).catch(
        () => undefined,
      );
      await withBrowserLock(options.paths, async () => {
        await closeEndpoint(err.httpEndpoint);
        if (await probeCdpEndpoint(err.httpEndpoint, 500)) throw err.cause;
        await clearLeases(options.paths);
      });
      return BrowserSession.startManaged(
        previous?.persistent ? { ...options, keepOpen: true, headless: previous.headless } : options,
      );
    }
  }

  /**
   * Finds or launches the managed browser under the cross-process lock and
   * takes a lease on it, so parallel commands share one browser safely.
   */
  private static async startManaged(options: BrowserSessionOptions): Promise<BrowserSession> {
    const { config, paths, logger } = options;
    const slowMo = config.browser.slowMo;
    const found = await withBrowserLock(paths, async () => {
      const running = await findRunningManagedBrowser(paths);
      if (running) {
        let state = await readState(paths, running.port);
        if (options.keepOpen && state && !state.persistent) {
          // `browser open` adopts a browser another command started: keep it running.
          state = { ...state, persistent: true };
          await writeState(paths, state);
        }
        if (options.forceHeaded && state?.headless) {
          logger.warn(
            'A headless gvids browser is already running; close it first to get a window (gvids browser close).',
          );
        }
        // Drops leases of commands whose process died, closing the tabs they left behind.
        await liveLeases(paths);
        const lease = await addLease(paths, 'reused');
        return {
          lease,
          httpEndpoint: running.httpEndpoint,
          // Unknown state (another gvids version, or a failed write): never close it on our own.
          persistent: state ? state.persistent === true : true,
        };
      }
      const executable = await findBrowserExecutable(config.browser.channel, config.browser.executablePath);
      if (!executable) {
        throw new BrowserSessionError('No Chrome, Edge or Chromium installation was found.', {
          code: 'BROWSER_NOT_FOUND',
          hint: [
            'Install Google Chrome (recommended), or',
            'install Playwright Chromium: npx playwright install chromium, or',
            'point gvids at a browser: gvids config set browser.executablePath <path>',
          ],
        });
      }
      const headless = options.forceHeaded ? false : options.headless;
      logger.debug({ executable: executable.path, headless }, 'launching browser');
      // Always detached: other commands may attach, and it must outlive this process for them.
      const launched = await launchBrowserProcess({
        executable,
        profileDir: paths.browserProfileDir,
        headless,
        detached: true,
        windowSize: { width: config.browser.viewportWidth, height: config.browser.viewportHeight },
        ...(options.startUrl ? { startUrl: options.startUrl } : {}),
      });
      await writeState(paths, {
        ...(launched.pid ? { pid: launched.pid } : {}),
        port: launched.port,
        headless,
        executable: executable.path,
        startedAt: new Date().toISOString(),
        persistent: Boolean(options.keepOpen),
      });
      const lease = await addLease(paths, 'launched');
      return {
        lease,
        httpEndpoint: launched.httpEndpoint,
        persistent: Boolean(options.keepOpen),
        launched,
        executable,
      };
    });
    if (!found.launched) {
      // A deprioritized background tab can stop answering; waking it now avoids a 20 s attach timeout.
      const stuck = await recoverStuckTabs(found.httpEndpoint, { close: false }).catch(() => []);
      if (stuck.length > 0) logger.debug({ stuck }, 'woke unresponsive tabs before attaching');
    }
    let browser: Browser;
    try {
      browser = await connect(found.httpEndpoint, slowMo, found.launched ? 30_000 : 20_000);
    } catch (err) {
      await removeLease(found.lease);
      if (!found.launched) throw new UnresponsiveBrowser(found.httpEndpoint, err);
      throw err;
    }
    const context = browser.contexts()[0];
    if (!context) {
      await removeLease(found.lease);
      throw new BrowserSessionError('The gvids browser has no default context.');
    }
    return BrowserSession.finish(
      new BrowserSession(
        browser,
        context,
        found.launched ? 'launched' : 'reused',
        options,
        found.launched,
        found.executable,
        found.lease,
        found.httpEndpoint,
        found.persistent,
      ),
    );
  }

  private static async finish(session: BrowserSession): Promise<BrowserSession> {
    // Ctrl+C, SIGTERM or `gvids task cancel`: close this session's tabs and release the browser.
    session.unregisterShutdown = onShutdown(() => session.close({ releaseIdle: false }));
    if (session.options.debug.trace) {
      try {
        await session.context.tracing.start({ screenshots: true, snapshots: true, title: 'gvids' });
        session.tracing = true;
      } catch (err) {
        session.options.logger.debug({ err: String(err) }, 'tracing unavailable');
      }
    }
    return session;
  }

  get paths(): GvidsPaths {
    return this.options.paths;
  }

  /** Registers cleanup to run when this session closes (also on Ctrl+C, SIGTERM and task cancel). */
  onClose(fn: () => Promise<void>): void {
    this.closers.push(fn);
  }

  /** Opens a new tab owned by this session (closed again by close()). */
  async newPage(): Promise<Page> {
    return this.adopt(await this.context.newPage());
  }

  private async adopt(page: Page): Promise<Page> {
    page.setDefaultTimeout(this.options.config.browser.timeout);
    page.setDefaultNavigationTimeout(Math.max(60_000, this.options.config.browser.timeout));
    this.diagnostics.attach(page);
    this.ownPages.push(page);
    await this.recordTab(page);
    return page;
  }

  /** Notes the tab's DevTools id in this session's lease: a later command closes it if this process dies. */
  private async recordTab(page: Page): Promise<void> {
    if (!this.lease) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      const { targetInfo } = (await cdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
      await cdp.detach().catch(() => undefined);
      this.tabIds.add(targetInfo.targetId);
      await recordLeaseTabs(this.lease, [...this.tabIds]);
    } catch (err) {
      this.options.logger.debug({ err: String(err) }, 'could not record the tab id');
    }
  }

  /** Whether the browser is kept running between commands (so tabs can be handed to the next one). */
  private get persists(): boolean {
    return this.mode !== 'external' && (this.persistent || Boolean(this.options.keepOpen));
  }

  /**
   * Claims an idle tab left by an earlier command whose URL matches. The claim
   * runs inside the page, so two commands can never take the same tab.
   */
  async claimIdlePage(matches: (url: string) => boolean): Promise<Page | undefined> {
    if (!this.persists) return undefined;
    for (const page of this.context.pages()) {
      if (page.isClosed() || !matches(page.url())) continue;
      const claimed = await page
        .evaluate(() => {
          const w = window as unknown as { __gvidsIdleSince?: number };
          if (typeof w.__gvidsIdleSince !== 'number') return false;
          delete w.__gvidsIdleSince;
          return true;
        })
        .catch(() => false);
      if (claimed) return this.adopt(page);
    }
    return undefined;
  }

  /** Reuses the blank first tab of a freshly launched browser instead of leaving it around. */
  async firstPage(): Promise<Page> {
    if (this.mode === 'launched') {
      const blank = this.context
        .pages()
        .find((p) => p.url() === 'about:blank' || p.url().startsWith('chrome://'));
      if (blank) return this.adopt(blank);
    }
    return this.newPage();
  }

  /** Stops tracing (writing the trace zip) and returns its path. */
  async stopTrace(): Promise<string | undefined> {
    if (!this.tracing) return undefined;
    this.tracing = false;
    const dir = path.resolve(this.options.cwd, this.options.debug.dir);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `trace-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    try {
      await this.context.tracing.stop({ path: file });
      return file;
    } catch (err) {
      this.options.logger.debug({ err: String(err) }, 'could not save trace');
      return undefined;
    }
  }

  /** Marks healthy editor tabs idle for the next command and trims the idle pool. */
  private async releaseIdle(): Promise<Page[]> {
    const kept: Page[] = [];
    for (const page of this.ownPages) {
      if (page.isClosed() || !/\/videos\/d\/[^/]+\/edit/.test(page.url())) continue;
      const ok = await page
        .evaluate(() => {
          (window as unknown as { __gvidsIdleSince?: number }).__gvidsIdleSince = Date.now();
          return true;
        })
        .catch(() => false);
      if (ok) kept.push(page);
    }
    // Keep only the most recently released idle tabs.
    const idle: Array<{ page: Page; since: number }> = [];
    for (const page of this.context.pages()) {
      const since = await page
        .evaluate(() => (window as unknown as { __gvidsIdleSince?: number }).__gvidsIdleSince ?? null)
        .catch(() => null);
      if (typeof since === 'number') idle.push({ page, since });
    }
    idle.sort((a, b) => b.since - a.since);
    for (const { page } of idle.slice(MAX_IDLE_TABS)) await page.close().catch(() => undefined);
    return kept.filter((p) => !p.isClosed());
  }

  async close(
    options: { keepOpen?: boolean; keepPages?: boolean; releaseIdle?: boolean } = {},
  ): Promise<{ trace?: string; log?: string }> {
    if (this.closed) return {};
    this.closed = true;
    this.unregisterShutdown?.();
    const trace = await this.stopTrace().catch(() => undefined);
    const log = await this.diagnostics.flush().catch(() => undefined);
    const keepOpen = options.keepOpen ?? this.options.keepOpen ?? false;
    if (!options.keepPages) {
      const idle = options.releaseIdle && this.persists ? await this.releaseIdle() : [];
      for (const page of this.ownPages) {
        if (!idle.includes(page)) await page.close().catch(() => undefined);
      }
    }
    for (const fn of this.closers.splice(0)) await fn().catch(() => undefined);
    if (this.mode === 'external') {
      // Never close the user's own browser: just disconnect.
      await this.browser.close().catch(() => undefined);
      return { ...(trace ? { trace } : {}), ...(log ? { log } : {}) };
    }
    // Managed browser: the last command using a non-persistent browser closes it.
    const paths = this.options.paths;
    const logger = this.options.logger;
    logger.debug('releasing the browser');
    const shutDown = await withBrowserLock(paths, async () => {
      await removeLease(this.lease);
      if (keepOpen || this.persistent) return false;
      if ((await liveLeases(paths)).length > 0) return false;
      const running = await findRunningManagedBrowser(paths);
      const state = running ? await readState(paths, running.port) : undefined;
      if (running && state?.persistent) return false;
      logger.debug('last user of a one-off browser: closing it');
      await closeBrowserGracefully(this.browser, this.launched);
      logger.debug('browser closed');
      if (this.httpEndpoint && (await probeCdpEndpoint(this.httpEndpoint, 500))) {
        await closeEndpoint(this.httpEndpoint, this.launched);
      }
      await fs.rm(paths.browserStateFile, { force: true }).catch(() => undefined);
      return true;
    }).catch((err: unknown) => {
      this.options.logger.debug({ err: String(err) }, 'could not release the browser');
      return false;
    });
    if (!shutDown) await this.browser.close().catch(() => undefined);
    return { ...(trace ? { trace } : {}), ...(log ? { log } : {}) };
  }
}

/** Thrown when a running managed browser does not accept a CDP connection. */
class UnresponsiveBrowser extends Error {
  constructor(
    readonly httpEndpoint: string,
    override readonly cause: unknown,
  ) {
    super('The running gvids browser is not responding.');
  }
}

/** Closes the running managed browser, if any (other commands using it will fail). Returns false when none was running. */
export async function closeManagedBrowser(paths: GvidsPaths): Promise<boolean> {
  return withBrowserLock(paths, async () => {
    const running = await findRunningManagedBrowser(paths);
    if (!running) {
      await clearLeases(paths);
      return false;
    }
    if (!(await closeViaDevTools(running.httpEndpoint))) {
      const browser = await connect(running.httpEndpoint, 0, 15_000);
      await closeBrowserGracefully(browser);
    }
    // Wait for the DevTools endpoint to disappear so a following launch does not race.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await probeCdpEndpoint(running.httpEndpoint, 500))) await sleep(200);
    await fs.rm(paths.browserStateFile, { force: true }).catch(() => undefined);
    await clearLeases(paths);
    return true;
  });
}

/** How many commands are using the managed browser right now. */
export async function browserUsers(paths: GvidsPaths): Promise<number> {
  return (await liveLeases(paths)).length;
}

/** Runs `fn` with a session and always closes it. */
export async function withSession<T>(
  start: () => Promise<BrowserSession>,
  fn: (session: BrowserSession) => Promise<T>,
  closeOptions: { keepOpen?: boolean } = {},
): Promise<T> {
  const session = await start();
  try {
    return await fn(session);
  } finally {
    await session.close(closeOptions);
  }
}
