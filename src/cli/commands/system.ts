import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { resolveClientCredentials } from '../../auth/client-credentials.js';
import { commandsFromHints, GvidsError } from '../../errors/errors.js';
import { EXIT_CODE_DESCRIPTIONS, ExitCode } from '../../errors/exit-codes.js';
import { pathExists } from '../../utils/fs.js';
import { CONFIG_KEYS } from '../../config/config.js';
import { mask } from '../../utils/redact.js';
import {
  driveCapabilities,
  isCacheFresh,
  PERMANENTLY_UNAVAILABLE,
  readCapabilityCache,
  renderCapabilities,
  writeCapabilityCache,
  type CapabilityReport,
} from '../../vids/capabilities.js';
import { parseVidId } from '../../vids/urls.js';
import { PACKAGE_NAME, VERSION } from '../../version.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';

async function detectCapabilities(
  ctx: CommandContext,
  options: { vid?: string; deep: boolean; skipUi: boolean },
): Promise<CapabilityReport> {
  const report: CapabilityReport = {
    detectedAt: new Date().toISOString(),
    account: {},
    drive: [],
    ui: [],
    unavailable: PERMANENTLY_UNAVAILABLE,
  };
  // Drive API
  const status = await (await ctx.auth()).status({ verify: true });
  let listWorks: boolean | undefined;
  let probeVid = options.vid;
  if (status.authenticated) {
    report.account.drive = status.account?.email;
    try {
      const res = await (await ctx.drive()).list({ limit: 1, owner: 'me' });
      listWorks = true;
      probeVid ??= res.files[0]?.id;
    } catch {
      listWorks = false;
    }
  }
  report.drive = driveCapabilities({
    authenticated: status.authenticated,
    scopes: status.scopes ?? [],
    ...(listWorks !== undefined ? { listWorks } : {}),
    ...(status.problem ? { problem: status.problem } : {}),
  });
  // Live UI
  if (!options.skipUi) {
    const { probeUi } = await import('../../browser/operations/capabilities.js');
    const session = await ctx.browserSession();
    try {
      const probe = await probeUi(session, ctx.config, ctx.logger, {
        ...(probeVid ? { vid: probeVid } : {}),
        deep: options.deep,
      });
      report.ui = probe.ui;
      if (probe.email) report.account.browser = probe.email;
      if (probe.vidsBuild) report.vidsBuild = probe.vidsBuild;
      if (probe.probeVideo) report.probeVideo = probe.probeVideo;
      if (probe.ai) report.ai = probe.ai;
      if (probe.voices !== undefined) report.voices = probe.voices;
      if (probe.avatars !== undefined) report.avatars = probe.avatars;
    } finally {
      await session.close();
    }
  }
  return report;
}

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  detail?: string;
  hint?: string;
}

const DOCTOR_MARK: Record<DoctorCheck['status'], string> = { pass: '✓', warn: '!', fail: '✗', skip: '-' };

async function runDoctor(
  ctx: CommandContext,
  options: { quick: boolean; vid?: string },
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck): void => {
    checks.push(c);
    ctx.out.detail(`${DOCTOR_MARK[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  };
  // Node
  const [major, minor] = process.versions.node.split('.').map(Number) as [number, number];
  add({
    name: `Node ${process.versions.node}`,
    status: major > 22 || (major === 22 && minor >= 12) ? 'pass' : 'fail',
    ...(major < 22 ? { hint: 'Install Node.js 22.12 or newer.' } : {}),
  });
  // Config directory
  try {
    await fs.mkdir(ctx.paths.home, { recursive: true });
    const probe = path.join(ctx.paths.home, `.doctor-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe);
    add({ name: 'Configuration directory writable', status: 'pass', detail: ctx.paths.home });
  } catch (err) {
    add({ name: 'Configuration directory writable', status: 'fail', detail: String(err) });
  }
  // Keyring
  const { KeyringTokenStore } = await import('../../auth/token-store.js');
  add({
    name: 'OS credential store',
    status: (await KeyringTokenStore.probe()) ? 'pass' : 'warn',
    detail: ctx.config.auth.tokenStore === 'file' ? 'using file storage (auth.tokenStore=file)' : undefined,
    hint: 'Tokens fall back to a 0600 file in ~/.gvids/credentials.',
  });
  // OAuth client
  const client = await resolveClientCredentials({
    env: ctx.io.env,
    ...(ctx.config.auth.clientSecretFile ? { clientSecretFile: ctx.config.auth.clientSecretFile } : {}),
  }).catch(() => undefined);
  add(
    client
      ? {
          name: 'Google OAuth client configured',
          status: 'pass',
          detail: `${mask(client.clientId)} (${client.source})`,
        }
      : {
          name: 'Google OAuth client configured',
          status: 'warn',
          hint: 'See docs/authentication.md, then run gvids auth login.',
        },
  );
  // OAuth + Drive
  const status = await (await ctx.auth()).status({ verify: true });
  if (status.authenticated) {
    add({ name: 'OAuth token valid', status: 'pass', detail: status.account?.email });
    try {
      const res = await (await ctx.drive()).list({ limit: 1 });
      add({ name: 'Drive API reachable', status: 'pass' });
      add({
        name: 'Google Vids files visible via Drive',
        status: 'pass',
        detail: res.files[0] ? `e.g. ${res.files[0].name}` : 'no videos yet',
      });
      if (!options.vid && res.files[0]) options.vid = res.files[0].id;
    } catch (err) {
      add({
        name: 'Drive API reachable',
        status: 'fail',
        detail: err instanceof GvidsError ? err.message : String(err),
      });
    }
    const scopes = status.scopes ?? [];
    add({
      name: 'MP4 download supported (files.download)',
      status: scopes.some((s) => /auth\/drive(\.readonly|\.file)?$/.test(s)) ? 'pass' : 'fail',
    });
  } else {
    add({ name: 'OAuth token valid', status: 'warn', detail: status.problem, hint: 'Run: gvids auth login' });
    add({ name: 'Drive API reachable', status: 'skip', detail: 'not signed in' });
  }
  // Browser
  const { findBrowserExecutable } = await import('../../browser/launcher.js');
  const exe = await findBrowserExecutable(ctx.config.browser.channel, ctx.config.browser.executablePath);
  add(
    exe
      ? { name: `Browser installed (${exe.kind})`, status: 'pass', detail: exe.path }
      : {
          name: 'Browser installed',
          status: 'fail',
          hint: 'Install Google Chrome or run: npx playwright install chromium',
        },
  );
  try {
    const pw = (await import('playwright')) as unknown as { chromium: { name(): string } };
    add({ name: 'Playwright library', status: 'pass', detail: pw.chromium.name() });
  } catch (err) {
    add({ name: 'Playwright library', status: 'fail', detail: String(err) });
  }
  if (options.quick || !exe) {
    add({
      name: 'Browser session & Vids editor',
      status: 'skip',
      detail: options.quick ? '--quick' : 'no browser',
    });
    return checks;
  }
  const profile = await pathExists(ctx.paths.browserProfileDir);
  if (!profile && !ctx.config.browser.cdpEndpoint) {
    add({ name: 'Browser session authenticated', status: 'fail', hint: 'Run: gvids browser login' });
    return checks;
  }
  try {
    const { probeUi } = await import('../../browser/operations/capabilities.js');
    const session = await ctx.browserSession();
    try {
      const probe = await probeUi(session, ctx.config, ctx.logger, {
        ...(options.vid ? { vid: options.vid } : {}),
        deep: false,
      });
      if (!probe.signedIn) {
        add({ name: 'Browser session authenticated', status: 'fail', hint: 'Run: gvids browser login' });
        return checks;
      }
      add({ name: 'Browser session authenticated', status: 'pass', detail: probe.email });
      add({ name: 'Google Vids accessible', status: probe.vidsAccess ? 'pass' : 'fail' });
      if (probe.probeVideo) add({ name: 'Vids editor loads', status: 'pass', detail: probe.probeVideo });
      for (const key of ['storyboard', 'aiVideo', 'voiceovers', 'avatars', 'templates']) {
        const c = probe.ui.find((u) => u.key === key);
        if (c)
          add({
            name: `${c.label} detected`,
            status: c.state === 'available' ? 'pass' : c.state === 'unknown' ? 'skip' : 'warn',
          });
      }
    } finally {
      await session.close();
    }
  } catch (err) {
    add({
      name: 'Vids editor loads',
      status: 'fail',
      detail: err instanceof GvidsError ? err.message : String(err),
      hint: 'Run: gvids debug inspect',
    });
  }
  return checks;
}

export function registerSystemCommands(program: Command, kit: Kit): void {
  program
    .command('capabilities')
    .description('Report what this account can do via the Drive API and the Vids UI')
    .option('--refresh', 'ignore the cache and detect again')
    .option('--vid <id>', 'video to inspect the editor with (default: your most recent)')
    .option('--deep', 'also count voices and avatars (slower)')
    .option('--no-ui', 'only check the Drive API')
    .action(
      action(kit, async (ctx, flags: { refresh?: boolean; vid?: string; deep?: boolean; ui: boolean }) => {
        const cached = await readCapabilityCache(ctx.paths);
        if (
          !flags.refresh &&
          cached &&
          isCacheFresh(cached, ctx.config.capabilities.cacheTtlHours) &&
          flags.ui
        ) {
          ctx.out.result({ ...cached, cached: true }, renderCapabilities);
          return;
        }
        const spinner = ctx.out.spinner('Detecting capabilities…');
        const report = await detectCapabilities(ctx, {
          ...(flags.vid ? { vid: parseVidId(flags.vid) } : {}),
          deep: Boolean(flags.deep),
          skipUi: !flags.ui,
        }).finally(() => spinner.stop());
        if (flags.ui) await writeCapabilityCache(ctx.paths, report);
        ctx.out.result(report, renderCapabilities);
      }),
    );

  program
    .command('doctor')
    .description('Diagnose installation, authentication, browser session and Vids access')
    .option('--quick', 'skip the browser checks')
    .option('--vid <id>', 'video to test the editor with')
    .action(
      action(kit, async (ctx, flags: { quick?: boolean; vid?: string }) => {
        const spinner = ctx.out.spinner('Running checks…');
        const checks = await runDoctor(ctx, {
          quick: Boolean(flags.quick),
          ...(flags.vid ? { vid: parseVidId(flags.vid) } : {}),
        }).finally(() => spinner.stop());
        const failed = checks.filter((c) => c.status === 'fail');
        const warnings = checks.filter((c) => c.status === 'warn').length;
        const report = { ready: failed.length === 0, failures: failed.length, warnings, checks };
        if (failed.length > 0) {
          // Not ready: fail with the whole report as data and the fixes as `next`.
          ctx.partialData = report;
          throw new GvidsError(`gvids is not ready: ${failed.map((c) => c.name).join('; ')}.`, {
            code: 'NOT_READY',
            exitCode: ExitCode.GenericError,
            needsUser: true,
            hint: failed.map((c) => c.hint).filter((h): h is string => Boolean(h)),
            next: commandsFromHints(failed.map((c) => c.hint ?? '')),
            details: { failed: failed.map((c) => c.name) },
          });
        }
        ctx.out.result(report, (d) =>
          [
            'gvids doctor',
            '',
            ...d.checks.map(
              (c) =>
                `${DOCTOR_MARK[c.status]} ${c.name}${c.detail ? `  (${c.detail})` : ''}${c.hint && c.status !== 'pass' ? `\n    → ${c.hint}` : ''}`,
            ),
            '',
            d.warnings ? `System usable with ${d.warnings} warning(s).` : 'System ready.',
          ].join('\n'),
        );
      }),
    );

  program
    .command('version')
    .description('Print version information')
    .action(
      action(kit, async (ctx) => {
        ctx.out.result(
          {
            name: PACKAGE_NAME,
            version: VERSION,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
          },
          (d) => `${d.name} ${d.version} (node ${d.node}, ${d.platform}-${d.arch})`,
        );
      }),
    );

  program
    .command('env')
    .description('Print non-secret diagnostic information for bug reports')
    .action(
      action(kit, async (ctx) => {
        const { findBrowserExecutable } = await import('../../browser/launcher.js');
        const exe = await findBrowserExecutable(
          ctx.config.browser.channel,
          ctx.config.browser.executablePath,
        );
        let playwrightVersion = 'unknown';
        try {
          const require = createRequire(import.meta.url);
          const pkg = JSON.parse(await fs.readFile(require.resolve('playwright/package.json'), 'utf8')) as {
            version: string;
          };
          playwrightVersion = pkg.version;
        } catch {
          // not resolvable (unusual install layout)
        }
        const client = await resolveClientCredentials({ env: ctx.io.env }).catch(() => undefined);
        const envVars = [
          'GOOGLE_CLIENT_ID',
          'GOOGLE_CLIENT_SECRET',
          'GVIDS_CLIENT_ID',
          'GVIDS_CLIENT_SECRET',
          'GVIDS_REFRESH_TOKEN',
          'GOOGLE_REFRESH_TOKEN',
          'GVIDS_ACCESS_TOKEN',
          'GVIDS_SERVICE_ACCOUNT_FILE',
          'GVIDS_IMPERSONATE',
          'GVIDS_HOME',
          ...Object.values(CONFIG_KEYS)
            .map((k) => k.env)
            .filter((e): e is string => Boolean(e)),
          'GVIDS_LOG_FORMAT',
          'NO_COLOR',
          'CI',
        ];
        const data = {
          gvids: VERSION,
          node: process.versions.node,
          os: `${os.type()} ${os.release()} (${process.platform}-${process.arch})`,
          shell: ctx.io.env.SHELL ?? ctx.io.env.ComSpec ?? 'unknown',
          terminal: { stdoutTTY: ctx.io.stdoutIsTTY, stderrTTY: ctx.io.stderrIsTTY },
          paths: {
            home: ctx.paths.home,
            config: ctx.paths.configFile,
            browserProfile: ctx.paths.browserProfileDir,
          },
          browser: {
            executable: exe?.path ?? null,
            kind: exe?.kind ?? null,
            headless: ctx.config.browser.headless,
            external: Boolean(ctx.config.browser.cdpEndpoint),
          },
          playwright: playwrightVersion,
          oauthClient: client ? `${mask(client.clientId)} (${client.source})` : null,
          tokenStore: ctx.config.auth.tokenStore,
          environment: Object.fromEntries(envVars.map((v) => [v, ctx.io.env[v] ? 'set' : 'unset'])),
          exitCodes: EXIT_CODE_DESCRIPTIONS,
        };
        ctx.out.result(data);
      }),
    );
}
