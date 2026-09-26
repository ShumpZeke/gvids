import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { GvidsError, UsageError, type SerializedError } from '../../errors/errors.js';
import { ExitCode, type ExitCodeValue } from '../../errors/exit-codes.js';
import { readStream } from '../../utils/input.js';
import { redactArgv } from '../../utils/redact.js';
import {
  describeCommand,
  findCommand,
  GLOBAL_OPTIONS_HELP,
  leafCommands,
  summarizeCommand,
} from '../catalog.js';
import { action, type Kit } from '../kit.js';
import { renderTable } from '../output/format.js';

/** AGENTS.md ships at the package root (next to dist/ and src/). */
async function readGuide(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '../../../AGENTS.md'), path.resolve(here, '../../AGENTS.md')]) {
    const text = await fs.readFile(candidate, 'utf8').catch(() => undefined);
    if (text) return text;
  }
  throw new GvidsError('AGENTS.md was not found next to the gvids installation.', {
    hint: 'Reinstall gvids, or read docs at the project repository.',
  });
}

class Capture extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

export interface BatchItemResult {
  index: number;
  args: string[];
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: SerializedError | null;
  warnings?: string[];
  skipped?: true;
}

/** Refused early with a clear message; the CLI also refuses them by resolved command path. */
const NOT_IN_BATCH = new Set(['batch', 'mcp']);
const PROPAGATED_FLAGS = ['--headless', '--headed', '--dry-run', '--debug', '--verbose', '--no-drive-api'];
/** Global options that take a value, so the command name is found after them. */
const VALUE_OPTIONS = new Set(['--timeout']);

function commandName(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUE_OPTIONS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Accepts a JSON array, `{ "commands": [...] }`, or one JSON array per line. */
export function parseBatchInput(text: string): string[][] {
  const trimmed = text.trim();
  if (!trimmed) throw new UsageError('The batch input is empty.');
  let items: unknown;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    items = Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? [parsed] : parsed;
  } catch {
    items = trimmed
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          throw new UsageError(`Line ${i + 1} of the batch input is not JSON.`, {
            hint: 'Each command is a JSON array of arguments, e.g. ["scene","list","<id>"].',
          });
        }
      });
  }
  if (items && typeof items === 'object' && !Array.isArray(items) && 'commands' in items) {
    items = (items as { commands: unknown }).commands;
  }
  if (!Array.isArray(items)) throw new UsageError('The batch input must be a list of commands.');
  if (items.length === 0) throw new UsageError('The batch input has no commands.');
  return items.map((item, i) => {
    const args = Array.isArray(item) ? item : (item as { args?: unknown })?.args;
    if (!Array.isArray(args) || args.length === 0 || !args.every((a) => typeof a === 'string')) {
      throw new UsageError(`Command ${i + 1} must be a non-empty array of strings.`, {
        hint: 'Example: [["create","Demo"],["scene","list","<id>"]]',
      });
    }
    const list = (args as string[])[0] === 'gvids' ? (args as string[]).slice(1) : (args as string[]);
    const name = commandName(list);
    if (name && NOT_IN_BATCH.has(name))
      throw new UsageError(`"${name}" cannot run inside batch (command ${i + 1}).`);
    return list;
  });
}

export function registerAgentCommands(program: Command, kit: Kit): void {
  program
    .command('guide')
    .description('How to use gvids as an agent: output contract, errors, recipes, limits (Markdown)')
    .action(
      action(kit, async (ctx) => {
        const text = await readGuide();
        // Documentation, not data: printed as Markdown unless --json is given explicitly.
        if (ctx.globals.json) ctx.out.result({ format: 'markdown', text });
        else ctx.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      }),
    );

  program
    .command('commands')
    .description(
      'List every command with its effect, backend and requirements (--full: arguments and options)',
    )
    .argument('[prefix...]', 'only commands starting with these words, e.g. "scene"')
    .option('--full', 'include arguments, options and examples')
    .action(
      action(kit, async (ctx, prefix: string[], flags: { full?: boolean }) => {
        const wanted = prefix.join(' ').trim();
        const root = wanted ? findCommand(program, prefix) : program;
        if (wanted && !root)
          throw new UsageError(`No command matches "${wanted}".`, { next: ['gvids commands'] });
        const leaves = root!.commands.length > 0 ? leafCommands(root!) : [root!];
        const commands = leaves.map((c) => (flags.full ? describeCommand(c) : summarizeCommand(c)));
        ctx.out.result({ contract: GLOBAL_OPTIONS_HELP, count: commands.length, commands }, (d) =>
          renderTable(d.commands as Array<Record<string, unknown>>, [
            { header: 'COMMAND', value: (c) => String(c.command) },
            { header: 'EFFECT', value: (c) => String(c.effect) },
            { header: 'BACKEND', value: (c) => String(c.backend) },
            { header: 'SUMMARY', value: (c) => String(c.summary), maxWidth: 70 },
          ]),
        );
      }),
    );

  program
    .command('batch')
    .description('Run several gvids commands in one call; input is JSON (array of argument arrays)')
    .argument('[file]', 'JSON file with the commands; omit or "-" to read stdin')
    .option('--keep-going', 'continue after a failing command (default: stop at the first failure)')
    .addHelpText(
      'after',
      '\nInput: [["create","Demo"],["scene","list","<id>"]] or one JSON array per line.\nCommands run one after another. --headless/--headed/--dry-run/--debug/--verbose/--timeout apply to every\ncommand; --yes does not (add it per command, after the user approved). An item may use --detach.',
    )
    .action(
      action(kit, async (ctx, file: string | undefined, flags: { keepGoing?: boolean }) => {
        let text: string;
        if (!file || file === '-') {
          text = await readStream(ctx.io.stdin);
        } else {
          const resolved = path.resolve(ctx.io.cwd, file);
          try {
            text = await fs.readFile(resolved, 'utf8');
          } catch (err) {
            throw new UsageError(
              (err as NodeJS.ErrnoException).code === 'ENOENT'
                ? `Batch file not found: ${resolved}`
                : `Could not read the batch file ${resolved}: ${(err as Error).message}`,
            );
          }
        }
        const items = parseBatchInput(text);
        const { runCli } = await import('../program.js');
        const inheritedFlags = kit.argv.filter((a) => PROPAGATED_FLAGS.includes(a));
        const timeoutIndex = kit.argv.indexOf('--timeout');
        const inheritedTimeout = timeoutIndex >= 0 ? kit.argv[timeoutIndex + 1] : undefined;

        const results: BatchItemResult[] = [];
        let stopped = false;
        for (const [index, args] of items.entries()) {
          if (stopped) {
            results.push({ index, args: redactArgv(args), ok: false, exitCode: -1, skipped: true });
            continue;
          }
          const extra = inheritedFlags.filter((f) => !args.includes(f));
          if (inheritedTimeout && !args.includes('--timeout')) extra.push('--timeout', inheritedTimeout);
          // Global flags go first, so an item's own "--" (end of options) cannot swallow them.
          const itemArgs = ['--json', ...extra, ...args.filter((a) => a !== '--human' && a !== '--pretty')];
          const stdout = new Capture();
          const stdin = new PassThrough();
          stdin.end('');
          const shownArgs = redactArgv(args);
          ctx.out.event('batch', { index, args: shownArgs });
          // Items run in-process as nested invocations; they never act as a --detach worker.
          const { GVIDS_TASK_ID: _task, ...env } = ctx.io.env;
          const exitCode = await runCli(
            ['node', 'gvids', ...itemArgs],
            { ...ctx.io, env, stdout, stdin },
            { ...ctx.overrides, invocation: 'batch' },
          );
          let envelope:
            { ok: boolean; data: unknown; error: SerializedError | null; warnings?: string[] } | undefined;
          try {
            envelope = JSON.parse(stdout.text.trim().split(/\r?\n/).pop() ?? '') as typeof envelope;
          } catch {
            envelope = undefined;
          }
          const ok = exitCode === 0 && envelope?.ok === true;
          results.push({
            index,
            args: shownArgs,
            ok,
            exitCode,
            ...(envelope?.data !== undefined && envelope?.data !== null ? { data: envelope.data } : {}),
            ...(envelope?.error ? { error: envelope.error } : {}),
            ...(envelope?.warnings?.length ? { warnings: envelope.warnings } : {}),
          });
          if (!ok && !flags.keepGoing) stopped = true;
        }
        const failed = results.filter((r) => !r.ok && !r.skipped);
        const summary = {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: failed.length,
          skipped: results.filter((r) => r.skipped).length,
          results,
        };
        if (failed.length === 0) {
          ctx.out.result(summary, (d) => `All ${d.total} commands succeeded.`);
          return;
        }
        ctx.partialData = summary;
        const first = failed[0]!;
        throw new GvidsError(
          `${failed.length} of ${results.length} commands failed (first: #${first.index} gvids ${first.args.join(' ')}).`,
          {
            code: 'BATCH_FAILED',
            exitCode: first.exitCode > 0 ? (first.exitCode as ExitCodeValue) : ExitCode.GenericError,
            retryable: first.error?.retryable ?? false,
            needsUser: first.error?.needsUser ?? false,
            ...(first.error?.next ? { next: first.error.next } : {}),
            details: { failedIndex: first.index, firstError: first.error },
          },
        );
      }),
    );
}
