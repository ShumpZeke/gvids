import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { Command, CommanderError } from 'commander';
import { HEARTBEAT_MS, TASK_ID_PATTERN, TaskStore, type StoredEnvelope } from '../automation/tasks.js';
import { getPaths } from '../config/paths.js';
import { CancelledError, UsageError } from '../errors/errors.js';
import { ExitCode } from '../errors/exit-codes.js';
import { toGvidsError } from '../errors/map.js';
import { onShutdownFinal, shutdown } from '../utils/shutdown.js';
import { VERSION } from '../version.js';
import {
  commandPath,
  describeCommand,
  describeGroup,
  findCommand,
  GLOBAL_OPTIONS_HELP,
  leafCommands,
  resolveCommand,
} from './catalog.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerAiCommands } from './commands/ai.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerBrowserCommands } from './commands/browser.js';
import { registerConfigCommands } from './commands/config.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerContentCommands } from './commands/content.js';
import { registerCreateCommand } from './commands/create.js';
import { registerDebugCommands } from './commands/debug.js';
import { registerDesignCommands } from './commands/design.js';
import { registerDownloadCommands } from './commands/download.js';
import { registerFileCommands } from './commands/files.js';
import { registerHistoryCommands } from './commands/history.js';
import { registerJobCommands } from './commands/jobs.js';
import { registerMcpCommand } from './commands/mcp.js';
import { registerSceneCommands } from './commands/scene.js';
import { registerShareCommands } from './commands/share.js';
import { registerStoryboardCommands } from './commands/storyboard.js';
import { registerSystemCommands } from './commands/system.js';
import { registerTaskCommands } from './commands/tasks.js';
import { formatFromArgs, processIO, type RuntimeIO, type ServiceOverrides } from './context.js';
import type { CliState, Kit } from './kit.js';
import { createBasicOutput, type OutputFormat } from './output/output.js';

export function createProgram(
  io: RuntimeIO,
  overrides: ServiceOverrides,
  state: CliState,
  format: OutputFormat = 'json',
  argv: string[] = [],
): Command {
  const kit: Kit = { io, overrides, state, argv };
  const program = new Command('gvids');
  program
    .description(
      'Google Vids for agents: JSON-envelope output, typed errors, no prompts. Start with: gvids guide',
    )
    .version(VERSION, '-V, --version', 'print the gvids version')
    .option('--json', 'JSON envelope output (the default)')
    .option('--human', 'human-readable output instead of JSON')
    .option('--pretty', 'indent JSON output')
    .option('--progress', 'stream progress events as JSON lines on stderr')
    .option('-q, --quiet', 'suppress progress output')
    .option('-v, --verbose', 'more detail (JSON log lines on stderr)')
    .option('--debug', 'debug logs, plus Playwright traces and diagnostics (see: gvids config path)')
    .option('-y, --yes', 'confirm destructive or public actions (never prompted)')
    .option('--dry-run', 'validate and describe the command without running it')
    .option('--detach', 'run in the background; returns a task id for `gvids wait`')
    .option('--no-color', 'disable colors in --human output')
    .option('--timeout <duration>', 'limit for long operations, e.g. 90s, 10m, 1h')
    .option('--headless', 'run the automation browser without a window')
    .option('--headed', 'show the automation browser window')
    .option('--no-drive-api', 'never use the Drive API (browser fallbacks only), even when signed in')
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => {
        if (format === 'text') io.stderr.write(s);
      },
      // Parse errors are reported once, by runCli (JSON envelope, or text with --human).
      outputError: () => undefined,
    });

  program.commandsGroup('Start here:');
  registerAgentCommands(program, kit);

  program.commandsGroup('Account:');
  registerAuthCommands(program, kit);
  registerBrowserCommands(program, kit);

  program.commandsGroup('Videos (Drive API, falling back to the editor where possible):');
  registerFileCommands(program, kit);
  registerShareCommands(program, kit);
  registerHistoryCommands(program, kit);
  registerDesignCommands(program, kit);
  registerDownloadCommands(program, kit);

  program.commandsGroup('Editing (Google Vids editor via browser automation):');
  registerCreateCommand(program, kit);
  registerStoryboardCommands(program, kit);
  registerSceneCommands(program, kit);
  registerContentCommands(program, kit);
  registerAiCommands(program, kit);

  program.commandsGroup('Background work & integrations:');
  registerTaskCommands(program, kit);
  registerJobCommands(program, kit);
  registerMcpCommand(program, kit);

  program.commandsGroup('Diagnostics & settings:');
  registerSystemCommands(program, kit);
  registerDebugCommands(program, kit);
  registerConfigCommands(program, kit);
  registerCompletionCommand(program, kit);

  // Every subcommand inherits exit/output behaviour.
  const apply = (cmd: Command): void => {
    for (const sub of cmd.commands) {
      sub.exitOverride();
      sub.configureOutput(program.configureOutput());
      apply(sub);
    }
  };
  apply(program);
  return program;
}

/** Short orientation printed when gvids runs without arguments (JSON format). */
function overview(program: Command): Record<string, unknown> {
  return {
    name: 'gvids',
    version: VERSION,
    about: 'Create and edit Google Vids videos from the command line; built for AI agents.',
    contract: GLOBAL_OPTIONS_HELP,
    start: [
      'gvids guide            # how to use gvids as an agent (Markdown)',
      'gvids commands         # every command with its effect and requirements',
      'gvids <command> --help # arguments and options of one command (JSON)',
      'gvids doctor           # what works on this machine right now',
    ],
    commands: leafCommands(program).map(commandPath),
  };
}

/** Mirrors a --detach worker's stdout so its envelope can be recorded as the task outcome. */
class EnvelopeTee extends Writable {
  text = '';
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.text += s;
    this.target.write(s, () => cb());
  }
}

function lastEnvelope(text: string): StoredEnvelope | undefined {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!) as StoredEnvelope;
      if (typeof parsed.ok === 'boolean') return parsed;
    } catch {
      // not the envelope line
    }
  }
  return undefined;
}

/**
 * The --detach worker side: heartbeat while running, stop gracefully when
 * `gvids task cancel` asks, and record the command's envelope as the outcome.
 */
class WorkerTask {
  private readonly store: TaskStore;
  private readonly timers: NodeJS.Timeout[] = [];
  private finished = false;
  private readonly unregister: () => void;

  constructor(
    readonly id: string,
    io: RuntimeIO,
    readonly tee: EnvelopeTee,
    /** Only the real worker process may exit on cancellation (not in-process tests). */
    ownsProcess: boolean,
  ) {
    this.store = new TaskStore(getPaths(io.env).tasksDir);
    const beat = (): void => {
      const file = this.store.heartbeatFile(id);
      const now = new Date();
      fs.utimes(file, now, now).catch(() => fs.writeFile(file, now.toISOString()).catch(() => undefined));
    };
    beat();
    this.timers.push(setInterval(beat, HEARTBEAT_MS));
    if (ownsProcess) {
      this.timers.push(
        setInterval(() => {
          fs.access(this.store.cancelFile(id))
            .then(() => shutdown('cancel').then(() => process.exit(ExitCode.Cancelled)))
            .catch(() => undefined);
        }, 500),
      );
    }
    for (const t of this.timers) t.unref();
    // On Ctrl+C, SIGTERM or cancellation: report CANCELLED as this task's outcome.
    this.unregister = onShutdownFinal(async () => {
      if (!lastEnvelope(this.tee.text)) {
        const error = new CancelledError('The command was cancelled before it finished.');
        this.tee.write(`${JSON.stringify({ ok: false, data: null, error: error.toJSON() })}\n`);
      }
      await this.finish(ExitCode.Cancelled);
    });
  }

  async finish(exitCode: number): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    for (const t of this.timers) clearInterval(t);
    this.unregister();
    const envelope = lastEnvelope(this.tee.text);
    await this.store
      .finish(this.id, { exitCode, pid: process.pid, ...(envelope ? { result: envelope } : {}) })
      .catch(() => undefined);
  }
}

/**
 * Runs the CLI and returns the exit code. Never calls process.exit, so it can
 * be embedded (tests, MCP server, batch).
 */
export async function runCli(
  argv: string[],
  baseIo: RuntimeIO = processIO(),
  overrides: ServiceOverrides = {},
): Promise<number> {
  const taskId = baseIo.env.GVIDS_TASK_ID;
  // Nested runs (batch items, MCP tool calls) never act as the task's worker.
  if (!taskId || overrides.invocation || !TASK_ID_PATTERN.test(taskId)) {
    return runCliInner(argv, baseIo, overrides);
  }
  const tee = new EnvelopeTee(baseIo.stdout);
  const worker = new WorkerTask(taskId, baseIo, tee, baseIo.stdout === process.stdout);
  let code: number = ExitCode.GenericError;
  try {
    code = await runCliInner(argv, { ...baseIo, stdout: tee }, overrides);
  } finally {
    await worker.finish(code);
  }
  return code;
}

async function runCliInner(argv: string[], io: RuntimeIO, overrides: ServiceOverrides): Promise<number> {
  const state: CliState = { exitCode: ExitCode.Success };
  const userArgs = argv.slice(2);
  const format: OutputFormat = formatFromArgs(userArgs, io.env) ?? 'json';
  const pretty = userArgs.includes('--pretty');
  const out = createBasicOutput(io.stdout, io.stderr, format, pretty);
  const program = createProgram(io, overrides, state, format, userArgs);

  if (
    userArgs.length === 0 ||
    (userArgs.every((a) => a.startsWith('-')) && !userArgs.some(isHelpOrVersion))
  ) {
    if (format === 'text') program.outputHelp();
    else out.result(overview(program));
    return ExitCode.Success;
  }

  const wantsHelp = userArgs.includes('--help') || userArgs.includes('-h') || userArgs[0] === 'help';
  // Agents get JSON help and version; people (--human) get Commander's text.
  if (format === 'json') {
    if (userArgs.includes('-V') || userArgs.includes('--version')) {
      out.result({ version: VERSION });
      return ExitCode.Success;
    }
    if (wantsHelp) {
      const tokens = userArgs[0] === 'help' ? userArgs.slice(1) : userArgs;
      const { command: target, rest } = resolveCommand(program, tokens);
      const unknown = rest.find((t) => !t.startsWith('-'));
      if (
        userArgs[0] === 'help' &&
        unknown !== undefined &&
        (target === undefined || target.commands.length > 0)
      ) {
        out.failure(
          new UsageError(`No command matches "${tokens.filter((t) => !t.startsWith('-')).join(' ')}".`, {
            next: [target ? `gvids help ${commandPath(target)}` : 'gvids commands'],
          }),
        );
        return ExitCode.InvalidArguments;
      }
      if (!target) out.result(overview(program));
      else if (target.commands.length > 0) out.result(describeGroup(target));
      else out.result(describeCommand(target));
      return ExitCode.Success;
    }
  }

  // A command group without a subcommand ("gvids scene"): show what it contains.
  const { command: group, rest } = resolveCommand(program, userArgs);
  if (group && group.commands.length > 0 && !wantsHelp && rest.every((t) => t.startsWith('-'))) {
    if (format === 'text') group.outputHelp();
    else out.result(describeGroup(group));
    return ExitCode.Success;
  }

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(err.code)) {
        return ExitCode.Success;
      }
      const target = findCommand(program, userArgs);
      const path = target ? commandPath(target) : undefined;
      out.failure(
        new UsageError(err.message.replace(/^error: /, ''), {
          ...(path
            ? {
                details: { command: path, usage: `gvids ${path} ${target!.usage()}`.trim() },
                hint: `Run: gvids ${path} --help`,
                next: [`gvids ${path} --help`],
              }
            : { hint: 'Run: gvids commands', next: ['gvids commands'] }),
        }),
      );
      return ExitCode.InvalidArguments;
    }
    const error = toGvidsError(err);
    out.failure(error);
    return error.exitCode;
  }
  return state.exitCode;
}

function isHelpOrVersion(a: string): boolean {
  return a === '--help' || a === '-h' || a === '--version' || a === '-V';
}
