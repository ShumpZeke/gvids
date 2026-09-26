import path from 'node:path';
import type { AuthManager } from '../auth/oauth.js';
import { ConfigStore, type GvidsConfig } from '../config/config.js';
import { getPaths, type GvidsPaths } from '../config/paths.js';
import { AuthError, ConfirmationRequiredError } from '../errors/errors.js';
import { CollaborationService } from '../google/collaboration.js';
import { DriveService } from '../google/drive.js';
import { PermissionsService } from '../google/permissions.js';
import type { DriveTransport } from '../google/transport.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { redactArgv } from '../utils/redact.js';
import { parseDuration } from '../utils/time.js';
import type { BrowserSession, BrowserSessionOptions } from '../browser/session.js';
import { Output, type OutputFormat } from './output/output.js';

export interface GlobalOptions {
  json?: boolean;
  human?: boolean;
  pretty?: boolean;
  progress?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debug?: boolean;
  yes?: boolean;
  color?: boolean;
  timeout?: string;
  headless?: boolean;
  headed?: boolean;
  dryRun?: boolean;
  detach?: boolean;
  /** false with --no-drive-api: behave as if there were no Drive API login. */
  driveApi?: boolean;
}

export interface RuntimeIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

/** What `--detach` needs to start a background worker. Replaceable in tests. */
export interface TaskSpawnSpec {
  taskId: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutFile: string;
  stderrFile: string;
}

/** Hooks that let tests (and embedders) replace side-effecting services. */
export interface ServiceOverrides {
  driveTransport?: () => Promise<DriveTransport>;
  openUrl?: (url: string) => Promise<void>;
  startBrowserSession?: (options: BrowserSessionOptions) => Promise<BrowserSession>;
  spawnTask?: (spec: TaskSpawnSpec) => Promise<{ pid: number }>;
  /**
   * Set when the CLI runs nested inside `batch` or the MCP server: commands that
   * cannot work there (nested batch, mcp, person-only commands) are refused.
   */
  invocation?: 'batch' | 'mcp';
}

export function processIO(): RuntimeIO {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

/**
 * Output format before the config file is read: --human/--json on the command
 * line, then GVIDS_OUTPUT. JSON is the default: gvids is built for agents.
 */
export function formatFromArgs(argv: string[], env: NodeJS.ProcessEnv): OutputFormat | undefined {
  if (argv.includes('--human')) return 'text';
  if (argv.includes('--json')) return 'json';
  if (env.GVIDS_OUTPUT === 'text' || env.GVIDS_OUTPUT === 'json') return env.GVIDS_OUTPUT;
  return undefined;
}

/** Everything a command handler needs. Services are created lazily. */
export class CommandContext {
  private authManager: AuthManager | undefined;
  private driveTransportPromise: Promise<DriveTransport> | undefined;
  /** Exit code for a result that is not a thrown error (e.g. `wait` relaying a failed task). */
  exitCode: number | undefined;
  /** Partial results to include with a failure envelope (e.g. `batch`). */
  partialData: unknown;

  private constructor(
    readonly io: RuntimeIO,
    readonly globals: GlobalOptions,
    readonly configStore: ConfigStore,
    readonly config: GvidsConfig,
    readonly paths: GvidsPaths,
    readonly out: Output,
    readonly logger: Logger,
    readonly overrides: ServiceOverrides,
    /** The user's arguments (without `node gvids`), for retry suggestions. */
    readonly argv: string[],
  ) {}

  static async create(
    io: RuntimeIO,
    globals: GlobalOptions,
    overrides: ServiceOverrides,
    argv: string[] = [],
    options: { lenientConfig?: boolean } = {},
  ): Promise<CommandContext> {
    const paths = getPaths(io.env);
    const configStore = new ConfigStore(paths.configFile, io.env);
    const config = await configStore.load({ lenient: options.lenientConfig ?? false });
    const format: OutputFormat = globals.human ? 'text' : globals.json ? 'json' : config.output.format;
    const verbose = Boolean(globals.verbose) || Boolean(globals.debug);
    const noColor = globals.color === false || io.env.NO_COLOR !== undefined || !config.output.color;
    const out = new Output({
      format,
      pretty: Boolean(globals.pretty),
      progress: Boolean(globals.progress),
      quiet: Boolean(globals.quiet),
      verbose,
      color: !noColor && io.stderrIsTTY,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    const level = globals.debug ? 'debug' : globals.verbose ? 'info' : 'warn';
    const logger =
      format === 'json'
        ? createLogger({
            level,
            stream: io.stderr,
            // Warnings join the envelope; info/debug become JSON lines on stderr only when asked for.
            sink: ({ level: lvl, msg, ...rest }) => {
              const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
              if (lvl >= 40) out.warn(`${msg}${extra}`);
              else if (verbose)
                io.stderr.write(`${JSON.stringify({ type: 'log', level: lvl, msg, ...rest })}\n`);
            },
          })
        : createLogger({ level, stream: io.stderr, json: io.env.GVIDS_LOG_FORMAT === 'json' });
    if (globals.quiet && !globals.debug) logger.level = 'error';
    for (const notice of configStore.notices) out.warn(notice);
    if (configStore.problem) out.warn(`${configStore.problem.message} (using the defaults)`);
    return new CommandContext(io, globals, configStore, config, paths, out, logger, overrides, argv);
  }

  get debug(): boolean {
    return Boolean(this.globals.debug);
  }

  /** Where diagnostics go: debug.directory (relative to the working directory) or <GVIDS_HOME>/debug. */
  get debugDir(): string {
    const configured = this.config.debug.directory;
    return configured ? path.resolve(this.io.cwd, configured) : this.paths.debugDir;
  }

  get yes(): boolean {
    return Boolean(this.globals.yes);
  }

  /** Whether the automation browser should run headless for this command. */
  get headless(): boolean {
    if (this.globals.headed) return false;
    if (this.globals.headless) return true;
    return this.config.browser.headless;
  }

  /** The --timeout value if given, otherwise the supplied default. */
  timeoutMs(defaultMs: number): number {
    return this.globals.timeout ? parseDuration(this.globals.timeout) : defaultMs;
  }

  /** The OAuth manager (loaded on first use: the Google client libraries are large). */
  async auth(): Promise<AuthManager> {
    if (!this.authManager) {
      const { AuthManager } = await import('../auth/oauth.js');
      this.authManager ??= new AuthManager({
        config: this.config,
        paths: this.paths,
        env: this.io.env,
        logger: this.logger,
      });
    }
    return this.authManager;
  }

  async transport(): Promise<DriveTransport> {
    if (this.globals.driveApi === false || this.io.env.GVIDS_DRIVE_API?.toLowerCase() === 'off') {
      throw new AuthError('The Drive API is turned off (--no-drive-api or GVIDS_DRIVE_API=off).', {
        hint: 'Commands with a browser fallback use the Vids web app instead.',
        needsUser: false,
      });
    }
    this.driveTransportPromise ??= this.overrides.driveTransport
      ? this.overrides.driveTransport()
      : (async () => {
          const client = await (await this.auth()).getClient();
          const { GoogleDriveTransport } = await import('../google/transport.js');
          return new GoogleDriveTransport(client);
        })();
    // A failed login attempt must not be cached for the rest of the command.
    this.driveTransportPromise.catch(() => {
      this.driveTransportPromise = undefined;
    });
    return this.driveTransportPromise;
  }

  async drive(): Promise<DriveService> {
    return new DriveService(await this.transport());
  }

  async permissions(): Promise<PermissionsService> {
    return new PermissionsService(await this.transport());
  }

  /** Version history and comments (Drive API). */
  async collaboration(): Promise<CollaborationService> {
    return new CollaborationService(await this.transport());
  }

  /** Starts (or attaches to) the automation browser. Callers must close() it. */
  async browserSession(options: Partial<BrowserSessionOptions> = {}): Promise<BrowserSession> {
    const sessionOptions: BrowserSessionOptions = {
      config: this.config,
      paths: this.paths,
      logger: this.logger,
      headless: this.headless,
      debug: {
        enabled: this.debug || this.config.debug.trace,
        dir: this.debugDir,
        trace: this.debug || this.config.debug.trace,
      },
      cwd: this.io.cwd,
      ...options,
    };
    if (this.overrides.startBrowserSession) return this.overrides.startBrowserSession(sessionOptions);
    const { BrowserSession } = await import('../browser/session.js');
    return BrowserSession.start(sessionOptions);
  }

  async openUrl(url: string): Promise<void> {
    if (this.overrides.openUrl) return this.overrides.openUrl(url);
    const { default: open } = await import('open');
    await open(url);
  }

  /**
   * Guards destructive or public actions. gvids never prompts: without --yes it
   * fails with CONFIRMATION_REQUIRED, whose `next`/`details.retryArgs` give the
   * exact command to run once the user has approved.
   */
  async confirm(_question: string, action: string): Promise<void> {
    if (this.yes) return;
    // --json is the default; leave it out of the suggested command.
    const base = redactArgv(this.argv.filter((a) => a !== '--json'));
    const retry = base.includes('--yes') || base.includes('-y') ? base : [...base, '--yes'];
    throw new ConfirmationRequiredError(action, base.length > 0 ? retry : undefined);
  }
}
