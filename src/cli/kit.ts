import type { Command } from 'commander';
import { spawnWorker, TaskStore } from '../automation/tasks.js';
import { CancelledError, GvidsError, shellJoin, UsageError, withContext } from '../errors/errors.js';
import { ExitCode } from '../errors/exit-codes.js';
import { toGvidsError } from '../errors/map.js';
import { parseHexColor, parsePositiveInt, requireFile } from '../utils/input.js';
import { redactArgv } from '../utils/redact.js';
import { isShuttingDown } from '../utils/shutdown.js';
import { parseDuration } from '../utils/time.js';
import { parseDocumentId, parseFolderId, parsePresentationId, parseVidId } from '../vids/urls.js';
import { COMMAND_META, commandPath } from './catalog.js';
import {
  CommandContext,
  formatFromArgs,
  type GlobalOptions,
  type RuntimeIO,
  type ServiceOverrides,
} from './context.js';
import { createBasicOutput } from './output/output.js';

export interface CliState {
  exitCode: number;
}

/** Shared wiring passed to every command registrar. */
export interface Kit {
  io: RuntimeIO;
  overrides: ServiceOverrides;
  state: CliState;
  /** The user's arguments (without `node gvids`). */
  argv: string[];
}

/** Commands that implement --dry-run themselves (with a richer plan). */
const SELF_DRY_RUN = new Set(['run', 'batch']);

/** Commands that cannot run in the background. */
const NOT_DETACHABLE = new Set([
  'mcp',
  'completion',
  'guide',
  'commands',
  'wait',
  'tasks',
  'task status',
  'task cancel',
]);

/** Commands that cannot run nested in `batch` or behind the MCP server. */
const NOT_NESTABLE: Record<'batch' | 'mcp', Set<string>> = {
  // A nested batch could recurse; mcp would take over the process's stdio.
  batch: new Set(['batch', 'mcp']),
  mcp: new Set(['mcp', 'completion']),
};

/** Commands that still work with a broken configuration file, so it can be repaired or inspected. */
const CONFIG_TOLERANT = new Set([
  'config list',
  'config get',
  'config set',
  'config unset',
  'config reset',
  'config path',
  'version',
  'commands',
  'guide',
  'env',
  'completion',
]);

/** Arguments for the background worker: same command, JSON output, progress events for `task status`. */
function workerArgs(argv: string[]): string[] {
  const args = argv.filter((a) => a !== '--detach' && a !== '--human' && a !== '--pretty');
  if (!args.includes('--json')) args.push('--json');
  if (!args.includes('--progress')) args.push('--progress');
  return args;
}

/** Refuses commands that cannot work in the current nesting (batch item, MCP tool call). */
function assertNestable(kit: Kit, path: string): void {
  const via = kit.overrides.invocation;
  if (!via) return;
  if (NOT_NESTABLE[via].has(path)) {
    throw new UsageError(`"gvids ${path}" cannot run inside ${via === 'mcp' ? 'the MCP server' : 'batch'}.`);
  }
  if (COMMAND_META[path]?.human) {
    // Sign-in commands wait for a person at a browser window: hand them to the user.
    throw new GvidsError(`"gvids ${path}" needs a person at the keyboard; it cannot run inside ${via}.`, {
      code: 'USER_ACTION_REQUIRED',
      exitCode: ExitCode.InvalidArguments,
      hint: `Ask the user to run it in a terminal: gvids ${path}`,
      next: [`gvids ${path}`],
    });
  }
}

async function detach(ctx: CommandContext, kit: Kit, path: string): Promise<void> {
  const meta = COMMAND_META[path];
  if (NOT_DETACHABLE.has(path) || meta?.human) {
    throw new UsageError(`"gvids ${path}" cannot run with --detach.`);
  }
  if (kit.argv.includes('-')) {
    throw new UsageError('--detach cannot read stdin ("-"); put the input in a file and pass its path.');
  }
  const store = new TaskStore(ctx.paths.tasksDir);
  const args = workerArgs(kit.argv);
  const task = await store.create(
    args.filter((a) => a !== '--json' && a !== '--progress'),
    ctx.io.cwd,
  );
  const spawner = ctx.overrides.spawnTask ?? spawnWorker;
  let pid: number;
  try {
    ({ pid } = await spawner({
      taskId: task.id,
      args,
      cwd: ctx.io.cwd,
      env: ctx.io.env,
      stdoutFile: task.stdoutFile,
      stderrFile: task.stderrFile,
    }));
  } catch (err) {
    await store.finish(task.id, {
      exitCode: ExitCode.GenericError,
      result: { ok: false, data: null, error: toGvidsError(err).toJSON() },
    });
    throw err;
  }
  const started = await store.markStarted(task.id, pid);
  ctx.out.result(
    {
      taskId: started.id,
      status: started.status,
      pid,
      command: started.command,
      next: [`gvids wait ${started.id}`, `gvids task status ${started.id}`],
    },
    (d) => `Started ${d.taskId} (pid ${d.pid}): ${d.command}\nWait for it with: gvids wait ${d.taskId}`,
  );
}

const WHOLE_NUMBER_OPTIONS = ['scene', 'after', 'before', 'to', 'limit', 'size', 'design', 'attempts'];
const FILE_OPTIONS = ['upload', 'outlineFile', 'promptFile', 'scriptFile', 'clientSecretFile'];

/**
 * The checks a dry run can make without touching Google: video/folder/slides
 * IDs, whole numbers, hex colors and local input files. The real run repeats them.
 */
async function validateInputs(
  ctx: CommandContext,
  path: string,
  named: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<void> {
  const cwd = ctx.io.cwd;
  for (const [name, value] of Object.entries(named)) {
    if (typeof value !== 'string') continue;
    if (name === 'id' || name === 'vid-id') parseVidId(value);
    else if (name === 'slides-id') parsePresentationId(value);
    else if (name === 'doc-id') parseDocumentId(value);
    else if (name === 'folder' && path === 'move') parseFolderId(value);
    else if (name === 'scene') parsePositiveInt(value, 'scene');
    else if (['file', 'clip', 'image'].includes(name) && path !== 'thumbnail')
      await requireFile(value, cwd, name);
  }
  for (const name of WHOLE_NUMBER_OPTIONS) {
    const value = options[name];
    if (typeof value === 'string') parsePositiveInt(value, `--${name}`);
  }
  for (const name of FILE_OPTIONS) {
    const value = options[name];
    if (typeof value === 'string' && value !== '-') await requireFile(value, cwd, `--${name}`);
  }
  if (Array.isArray(options.image)) {
    for (const f of options.image as string[]) await requireFile(f, cwd, '--image');
  }
  if (typeof options.vid === 'string') parseVidId(options.vid);
  if ((path === 'text add' || path === 'text edit') && typeof options.color === 'string') {
    parseHexColor(options.color, '--color');
  }
}

async function dryRun(
  ctx: CommandContext,
  kit: Kit,
  command: Command,
  path: string,
  args: unknown[],
): Promise<void> {
  const meta = COMMAND_META[path];
  const named: Record<string, unknown> = {};
  command.registeredArguments.forEach((a, i) => {
    if (args[i] !== undefined) named[a.name()] = args[i];
  });
  const options = Object.fromEntries(Object.entries(command.opts()).filter(([, v]) => v !== undefined));
  await validateInputs(ctx, path, named, options);
  // --json is the default; leave it out of the suggested command.
  const runArgs = redactArgv(kit.argv.filter((a) => a !== '--dry-run' && a !== '--json'));
  const needsYes = meta?.confirm === 'always' && !ctx.yes;
  ctx.out.result(
    {
      dryRun: true,
      command: path,
      args: named,
      options,
      effect: meta?.effect,
      backend: meta?.backend,
      ...(meta?.confirm ? { confirm: meta.confirm } : {}),
      ...(meta?.aiQuota ? { aiQuota: meta.aiQuota } : {}),
      ...(meta?.slow ? { slow: true } : {}),
      ...(meta?.human ? { human: true } : {}),
      ...(meta?.note ? { note: meta.note } : {}),
      ...(ctx.globals.detach ? { detach: true } : {}),
      run: shellJoin(['gvids', ...(needsYes ? [...runArgs, '--yes'] : runArgs)]),
      ...(needsYes ? { requiresUserApproval: true } : {}),
    },
    (d) =>
      [
        `Would run: ${d.run}`,
        `effect: ${d.effect}, backend: ${d.backend}${d.aiQuota ? ', uses AI allowance' : ''}`,
        ...(d.requiresUserApproval ? ['Needs --yes after the user approves.'] : []),
      ].join('\n'),
  );
}

/** Adds "how to get help" to argument errors that do not say what to do next. */
function withHelp(error: GvidsError, path: string): GvidsError {
  if (error.code !== 'INVALID_ARGUMENT' || error.next.length > 0 || !path) return error;
  return withContext(error, { next: [`gvids ${path} --help`] });
}

/**
 * Wraps a command handler: builds the CommandContext from global options,
 * handles the generic --detach and --dry-run flags, runs the handler, and
 * converts any thrown error into an error envelope plus exit code. Handlers
 * never call process.exit themselves.
 */
export function action<Args extends unknown[]>(
  kit: Kit,
  handler: (ctx: CommandContext, ...args: Args) => Promise<void>,
): (...raw: unknown[]) => Promise<void> {
  return async (...raw: unknown[]): Promise<void> => {
    const command = raw[raw.length - 1] as Command;
    const args = raw.slice(0, -1) as Args;
    const globals = command.optsWithGlobals<GlobalOptions>();
    const path = commandPath(command);
    let ctx: CommandContext;
    try {
      ctx = await CommandContext.create(kit.io, globals, kit.overrides, kit.argv, {
        lenientConfig: CONFIG_TOLERANT.has(path),
      });
    } catch (err) {
      const error = toGvidsError(err);
      createBasicOutput(
        kit.io.stdout,
        kit.io.stderr,
        globals.human ? 'text' : (formatFromArgs(kit.argv, kit.io.env) ?? 'json'),
        Boolean(globals.pretty),
      ).failure(error);
      kit.state.exitCode = error.exitCode;
      return;
    }
    try {
      assertNestable(kit, path);
      // Fail fast on a malformed --timeout, whether or not this command uses it.
      if (globals.timeout !== undefined) parseDuration(globals.timeout);
      // --dry-run wins over --detach: describe the command, start nothing.
      if (globals.dryRun && !SELF_DRY_RUN.has(path)) {
        await dryRun(ctx, kit, command, path, args);
        return;
      }
      if (globals.detach && !kit.io.env.GVIDS_TASK_ID) {
        await detach(ctx, kit, path);
        return;
      }
      await handler(ctx, ...args);
      if (ctx.exitCode !== undefined) kit.state.exitCode = ctx.exitCode;
    } catch (err) {
      // While Ctrl+C / SIGTERM / `task cancel` tears the command down (closing its tabs),
      // its failures are side effects of the cancellation: report CANCELLED instead.
      const error = isShuttingDown()
        ? new CancelledError('The command was cancelled before it finished.')
        : withHelp(toGvidsError(err), path);
      if (ctx.debug && err instanceof Error && err.stack) ctx.logger.debug(err.stack);
      ctx.out.failure(error, ctx.partialData ?? null);
      kit.state.exitCode = error.exitCode;
    }
  };
}
