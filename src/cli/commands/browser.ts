import fs from 'node:fs/promises';
import type { Command } from 'commander';
import {
  BrowserLoginRequiredError,
  BrowserSessionError,
  FeatureUnavailableError,
  UsageError,
} from '../../errors/errors.js';
import { pathExists } from '../../utils/fs.js';
import { parseDuration } from '../../utils/time.js';
import { parseVidId, vidEditUrl, vidsHomeUrl } from '../../vids/urls.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';

async function profileExists(ctx: CommandContext): Promise<boolean> {
  return pathExists(ctx.paths.browserProfileDir);
}

export interface BrowserStatus {
  profileDir: string;
  profileExists: boolean;
  running: boolean;
  /** Kept running between commands (gvids browser open) rather than closed by the last command. */
  persistent?: boolean;
  headless?: boolean;
  /** gvids commands attached to it right now. */
  sessions?: number;
  endpoint?: string;
  external?: string;
  executable?: string;
  signedIn?: boolean;
  vidsAccess?: boolean;
  email?: string;
  checked: boolean;
  problem?: string;
}

/** Signs in check used by status, doctor and capabilities. */
export async function checkBrowserSignIn(
  ctx: CommandContext,
): Promise<{ signedIn: boolean; vidsAccess: boolean; email?: string }> {
  const { detectSignIn } = await import('../../browser/pages/account.js');
  const session = await ctx.browserSession({ headless: ctx.globals.headed ? false : true });
  try {
    const page = await session.newPage();
    const state = await detectSignIn(page, {
      hl: ctx.config.browser.locale,
      authuser: ctx.config.browser.authuser,
    });
    return {
      signedIn: state.signedIn,
      vidsAccess: state.vidsAccess,
      ...(state.email ? { email: state.email } : {}),
    };
  } finally {
    await session.close();
  }
}

export function renderBrowserStatus(s: BrowserStatus): string {
  const lines = [
    s.external
      ? `Attached browser: ${s.external} (via gvids browser connect)`
      : `Profile: ${s.profileDir}${s.profileExists ? '' : ' (not created yet)'}`,
    `Running: ${
      s.running
        ? `yes${s.endpoint ? ` (${s.endpoint})` : ''}${s.persistent ? ', kept open' : ''}${
            s.sessions ? `, ${s.sessions} command(s) attached` : ''
          }`
        : 'no'
    }`,
  ];
  if (s.executable) lines.push(`Browser: ${s.executable}`);
  if (s.checked) {
    lines.push(
      s.signedIn
        ? `Signed in to Google Vids as ${s.email ?? 'unknown account'}${s.vidsAccess ? '' : ' (but Vids is not available to this account)'}`
        : 'Not signed in. Run: gvids browser login',
    );
  }
  if (s.problem) lines.push(`Problem: ${s.problem}`);
  return lines.join('\n');
}

export function registerBrowserCommands(program: Command, kit: Kit): void {
  const browser = program
    .command('browser')
    .description('Manage the dedicated browser profile used for Vids editor automation');

  browser
    .command('login')
    .description('Open a normal browser window to sign in to Google (you handle password/MFA/CAPTCHA)')
    .option('--wait <duration>', 'how long to wait for you to finish and close the window', '15m')
    .option('--no-verify', 'skip the headless sign-in check afterwards')
    .addHelpText(
      'after',
      [
        '',
        'The window is a plain Chrome/Edge process using the gvids profile, with no automation attached',
        '(Google refuses sign-in in automated browsers). Sign in, wait for Google Vids to load, then close',
        'the window. gvids then verifies the session headlessly. Your password never passes through gvids.',
      ].join('\n'),
    )
    .action(
      action(kit, async (ctx, flags: { wait: string; verify: boolean }) => {
        if (ctx.config.browser.cdpEndpoint) {
          throw new BrowserSessionError('gvids is attached to an external browser (gvids browser connect).', {
            hint: [
              'Sign in to Google in that browser directly, or',
              'run `gvids browser disconnect` to use the gvids-managed profile.',
            ],
          });
        }
        const { closeManagedBrowser } = await import('../../browser/session.js');
        const { findBrowserExecutable, isProfileLocked, runInteractiveBrowser } =
          await import('../../browser/launcher.js');
        await closeManagedBrowser(ctx.paths);
        if (await isProfileLocked(ctx.paths.browserProfileDir)) {
          throw new BrowserSessionError('The gvids browser profile is already open in another window.', {
            code: 'BROWSER_PROFILE_LOCKED',
            hint: 'Close that window and run gvids browser login again.',
          });
        }
        const exe = await findBrowserExecutable(
          ctx.config.browser.channel,
          ctx.config.browser.executablePath,
        );
        if (!exe) {
          throw new BrowserSessionError('No Chrome, Edge or Chromium installation was found.', {
            code: 'BROWSER_NOT_FOUND',
            hint: 'Install Google Chrome, or set: gvids config set browser.executablePath <path>',
          });
        }
        const home = vidsHomeUrl({ hl: ctx.config.browser.locale, authuser: ctx.config.browser.authuser });
        const run = await runInteractiveBrowser({
          executable: exe,
          profileDir: ctx.paths.browserProfileDir,
          url: `https://accounts.google.com/ServiceLogin?hl=en&continue=${encodeURIComponent(home)}`,
          windowSize: { width: ctx.config.browser.viewportWidth, height: ctx.config.browser.viewportHeight },
          timeoutMs: parseDuration(flags.wait),
          // A person runs this command: the instructions go to stderr as plain text in any output format.
          onStarted: () =>
            ctx.io.stderr.write(
              [
                'A browser window is open with the gvids profile.',
                '  1. Sign in to your Google account there (gvids never sees your password).',
                '  2. Wait until Google Vids loads.',
                '  3. Close the browser window to continue.',
                '',
              ].join('\n'),
            ),
        });
        if (run.timedOut) {
          throw new BrowserLoginRequiredError('Timed out waiting for the sign-in window to be closed.', {
            hint: 'Run gvids browser login again (use --wait 30m for more time).',
          });
        }
        if (!flags.verify) {
          ctx.out.result(
            { verified: false, profileDir: ctx.paths.browserProfileDir },
            () => 'Window closed. Verify with: gvids browser status',
          );
          return;
        }
        const spinner = ctx.out.spinner('Checking the Google session…');
        const state = await checkBrowserSignIn(ctx).finally(() => spinner.stop());
        if (!state.signedIn) {
          throw new BrowserLoginRequiredError('The browser profile is still not signed in to Google.', {
            hint: 'Run gvids browser login again and finish signing in before closing the window.',
          });
        }
        if (!state.vidsAccess) {
          throw new FeatureUnavailableError('Signed in, but Google Vids is not available to this account.', {
            code: 'VIDS_ACCESS_REQUIRED',
            hint: 'Vids needs a personal Google account or an eligible Google Workspace edition.',
          });
        }
        ctx.out.result(
          { signedIn: true, email: state.email ?? null, profileDir: ctx.paths.browserProfileDir },
          (d) => `Signed in as ${d.email ?? 'unknown account'}. Profile: ${d.profileDir}`,
        );
      }),
    );

  browser
    .command('status')
    .description(
      'Show the browser profile state and whether it is signed in (fails with LOGIN_REQUIRED and the status as data when not signed in)',
    )
    .option('--no-check', 'do not launch the browser to verify sign-in')
    .action(
      action(kit, async (ctx, flags: { check: boolean }) => {
        const { browserUsers, findRunningManagedBrowser } = await import('../../browser/session.js');
        const { findBrowserExecutable } = await import('../../browser/launcher.js');
        const running = await findRunningManagedBrowser(ctx.paths);
        const exe = await findBrowserExecutable(
          ctx.config.browser.channel,
          ctx.config.browser.executablePath,
        );
        const status: BrowserStatus = {
          profileDir: ctx.paths.browserProfileDir,
          profileExists: await profileExists(ctx),
          running: Boolean(running),
          ...(running
            ? {
                endpoint: running.httpEndpoint,
                sessions: await browserUsers(ctx.paths),
                ...(running.state
                  ? { persistent: running.state.persistent === true, headless: running.state.headless }
                  : {}),
              }
            : {}),
          ...(ctx.config.browser.cdpEndpoint ? { external: ctx.config.browser.cdpEndpoint } : {}),
          ...(exe ? { executable: exe.path } : {}),
          checked: false,
        };
        if (!flags.check) {
          ctx.out.result(status, renderBrowserStatus);
          return;
        }
        if (!status.profileExists && !status.external) {
          ctx.partialData = status;
          throw new BrowserLoginRequiredError('The gvids browser profile has not been signed in yet.');
        }
        try {
          Object.assign(status, await checkBrowserSignIn(ctx), { checked: true });
        } catch (err) {
          // Could not check (no browser, locked profile, …): report that error with the status.
          ctx.partialData = { ...status, problem: err instanceof Error ? err.message : String(err) };
          throw err;
        }
        if (!status.signedIn) {
          ctx.partialData = status;
          throw new BrowserLoginRequiredError();
        }
        if (!status.vidsAccess) {
          ctx.partialData = status;
          throw new FeatureUnavailableError('Signed in, but Google Vids is not available to this account.', {
            code: 'VIDS_ACCESS_REQUIRED',
            hint: 'Vids needs a personal Google account or an eligible Google Workspace edition.',
          });
        }
        ctx.out.result(status, renderBrowserStatus);
      }),
    );

  browser
    .command('open')
    .description(
      'Start the gvids browser and leave it running so later commands reuse it (~2 s instead of ~6 s each); --headless keeps it hidden',
    )
    .argument('[id]', 'video ID or URL to open')
    .action(
      action(kit, async (ctx, idArg: string | undefined) => {
        const headless = ctx.globals.headless === true;
        // A hidden browser needs no landing page: an idle background Vids home tab only
        // costs memory and, in time, stops answering DevTools.
        const url = idArg
          ? vidEditUrl(parseVidId(idArg), {
              hl: ctx.config.browser.locale,
              authuser: ctx.config.browser.authuser,
            })
          : headless
            ? 'about:blank'
            : vidsHomeUrl({ hl: ctx.config.browser.locale, authuser: ctx.config.browser.authuser });
        const session = await ctx.browserSession({ forceHeaded: !headless, headless, keepOpen: true });
        const page = await session.firstPage();
        if (url !== 'about:blank') await page.goto(url);
        // An editor tab is handed to the next command on that video (no reload).
        await session.close(idArg ? { keepOpen: true, releaseIdle: true } : { keepOpen: true, keepPages: true });
        ctx.out.result(
          { opened: url, mode: session.mode, headless, next: ['gvids browser close'] },
          () =>
            'The gvids browser is running. Other gvids commands will reuse it. Close it with: gvids browser close',
        );
      }),
    );

  browser
    .command('close')
    .description(
      'Close the running gvids browser (refuses while gvids commands still use it, unless --force)',
    )
    .option('--force', 'close it even if gvids commands are using it (they will fail)')
    .action(
      action(kit, async (ctx, flags: { force?: boolean }) => {
        const { browserUsers, closeManagedBrowser } = await import('../../browser/session.js');
        const users = await browserUsers(ctx.paths);
        if (users > 0 && !flags.force) {
          throw new UsageError(
            `${users} gvids command(s) are still using the browser; closing it now would make them fail.`,
            {
              hint: 'Wait for them (gvids tasks --status running), or close anyway with --force.',
              next: ['gvids tasks --status running', 'gvids browser close --force'],
              details: { sessions: users },
            },
          );
        }
        const closed = await closeManagedBrowser(ctx.paths);
        ctx.out.result({ closed }, (d) =>
          d.closed ? 'Closed the gvids browser.' : 'The gvids browser was not running.',
        );
      }),
    );

  browser
    .command('reset')
    .description('Delete the gvids browser profile (signs the automation browser out)')
    .action(
      action(kit, async (ctx) => {
        const { closeManagedBrowser } = await import('../../browser/session.js');
        await ctx.confirm(
          `Delete the gvids browser profile at ${ctx.paths.browserProfileDir}? You will need to sign in again.`,
          'delete the browser profile',
        );
        await closeManagedBrowser(ctx.paths);
        try {
          await fs.rm(ctx.paths.browserDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch (err) {
          throw new BrowserSessionError(`Could not delete ${ctx.paths.browserDir}: ${String(err)}`, {
            hint: 'Close any gvids browser windows and retry.',
          });
        }
        await fs.rm(ctx.paths.capabilitiesCacheFile, { force: true });
        ctx.out.result(
          { reset: true, profileDir: ctx.paths.browserProfileDir },
          () => 'Browser profile deleted.',
        );
      }),
    );

  browser
    .command('connect')
    .description(
      'Use a Chrome you started yourself with --remote-debugging-port (and a separate --user-data-dir)',
    )
    .argument('<endpoint>', 'DevTools endpoint, e.g. http://127.0.0.1:9222')
    .option('--allow-remote', 'allow a non-loopback endpoint (dangerous)')
    .addHelpText(
      'after',
      [
        '',
        'Start Chrome first, for example on Windows:',
        '  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\\gvids-chrome',
        'Sign in to Google in that window, then run:',
        '  gvids browser connect http://127.0.0.1:9222',
        '',
        'Security: anything that can reach the port can control that browser and its Google session.',
        'Keep it bound to 127.0.0.1 and close Chrome when you are done. Undo with: gvids browser disconnect',
      ].join('\n'),
    )
    .action(
      action(kit, async (ctx, endpoint: string, flags: { allowRemote?: boolean }) => {
        const { assertLoopbackEndpoint, probeCdpEndpoint } = await import('../../browser/launcher.js');
        const url = assertLoopbackEndpoint(endpoint, Boolean(flags.allowRemote));
        let browserVersion: string | undefined;
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          const info = await probeCdpEndpoint(url.toString().replace(/\/$/, ''), 3000);
          if (!info) {
            throw new BrowserSessionError(`No DevTools endpoint answered at ${endpoint}.`, {
              hint: 'Start Chrome with --remote-debugging-port=9222 and a separate --user-data-dir, then retry.',
            });
          }
          browserVersion = info.Browser;
        }
        await ctx.configStore.setValue('browser.cdpEndpoint', url.toString().replace(/\/$/, ''));
        ctx.out.result(
          { endpoint: url.toString().replace(/\/$/, ''), browser: browserVersion ?? null },
          (d) =>
            `Connected: gvids will drive ${d.browser ?? 'the browser'} at ${d.endpoint}. Undo with: gvids browser disconnect`,
        );
      }),
    );

  browser
    .command('disconnect')
    .description('Stop using an external browser; go back to the gvids-managed profile')
    .action(
      action(kit, async (ctx) => {
        const removed = await ctx.configStore.unset('browser.cdpEndpoint');
        ctx.out.result({ disconnected: removed }, (d) =>
          d.disconnected
            ? 'Now using the gvids-managed browser profile.'
            : 'No external browser was configured.',
        );
      }),
    );
}
