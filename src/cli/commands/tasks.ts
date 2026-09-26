import { Option, type Command } from 'commander';
import { JobStore, type JobRecord } from '../../automation/job.js';
import { TASK_ID_PATTERN, TaskStore, type TaskRecord } from '../../automation/tasks.js';
import { GvidsError, UsageError } from '../../errors/errors.js';
import { ExitCode } from '../../errors/exit-codes.js';
import { parsePositiveInt } from '../../utils/input.js';
import { sleep } from '../../utils/time.js';
import { action, type Kit } from '../kit.js';
import { formatDate, renderTable } from '../output/format.js';

const JOB_ID_PATTERN = /^job_[0-9]{14}_[0-9a-f]{6}$/;
const DEFAULT_WAIT_MS = 5 * 60_000;

const CANCEL_GRACE_MS = 15_000;

function taskSummary(t: TaskRecord): Record<string, unknown> {
  return {
    id: t.id,
    status: t.status,
    command: t.command,
    createdAt: t.createdAt,
    ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    ...(t.cancelRequestedAt && t.status === 'running' ? { cancelRequestedAt: t.cancelRequestedAt } : {}),
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function stillRunning(
  id: string,
  status: string,
  startedAt: string | undefined,
  extra: Record<string, unknown>,
): GvidsError {
  const elapsedMs = startedAt ? Date.now() - Date.parse(startedAt) : undefined;
  return new GvidsError(`${id} is still ${status}.`, {
    code: 'STILL_RUNNING',
    exitCode: ExitCode.GenerationTimeout,
    retryable: true,
    next: [`gvids wait ${id}`],
    hint: 'This is not a failure: call `gvids wait` again (optionally with a longer --timeout).',
    details: { id, status, ...(elapsedMs !== undefined ? { elapsedMs } : {}), ...extra },
  });
}

export function registerTaskCommands(program: Command, kit: Kit): void {
  program
    .command('wait')
    .description('Wait for a background task (--detach) or workflow job and return its result')
    .argument('<id>', 'task ID (task_…) or workflow job ID (job_…)')
    .addHelpText(
      'after',
      "\nReturns the finished command's own envelope and exit code. If --timeout (default 5m) passes first, fails with STILL_RUNNING (exit 8, retryable): call wait again.",
    )
    .action(
      action(kit, async (ctx, id: string) => {
        const deadline = Date.now() + ctx.timeoutMs(DEFAULT_WAIT_MS);
        if (TASK_ID_PATTERN.test(id)) {
          const store = new TaskStore(ctx.paths.tasksDir);
          for (;;) {
            const task = await store.get(id);
            if (task.status !== 'running') {
              const envelope = task.result ?? {
                ok: task.status === 'succeeded',
                data: null,
                error:
                  task.status === 'succeeded'
                    ? null
                    : {
                        code: task.status === 'cancelled' ? 'CANCELLED' : 'GENERIC_ERROR',
                        message: `Task ${id} ${task.status} without a result.`,
                        exitCode: task.exitCode ?? 1,
                        retryable: false,
                        needsUser: false,
                      },
              };
              ctx.out.envelope(envelope);
              ctx.exitCode = task.exitCode ?? (envelope.ok ? 0 : 1);
              return;
            }
            if (Date.now() >= deadline) {
              throw stillRunning(id, 'running', task.startedAt, {
                command: task.command,
                lastEvent: await store.lastEvent(task),
              });
            }
            await sleep(1000);
          }
        }
        if (JOB_ID_PATTERN.test(id)) {
          const store = new JobStore(ctx.paths.jobsDir);
          for (;;) {
            const job: JobRecord = await store.get(id);
            if (job.status !== 'running' && job.status !== 'pending') {
              if (job.status === 'completed') {
                ctx.out.result(job);
                return;
              }
              throw new GvidsError(`Job ${id} ${job.status}${job.error ? `: ${job.error.message}` : ''}.`, {
                code: job.status === 'cancelled' ? 'CANCELLED' : 'GENERIC_ERROR',
                exitCode: job.status === 'cancelled' ? ExitCode.Cancelled : ExitCode.GenericError,
                ...(job.status === 'failed' ? { next: [`gvids job resume ${id}`] } : {}),
                details: { job },
              });
            }
            if (Date.now() >= deadline) {
              throw stillRunning(id, job.status, job.startedAt, {
                progress: `${job.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length}/${job.steps.length}`,
              });
            }
            await sleep(1000);
          }
        }
        throw new UsageError(`Not a task or job ID: ${id}`, { next: ['gvids tasks', 'gvids jobs'] });
      }),
    );

  program
    .command('tasks')
    .description('List background tasks started with --detach (finished ones are kept for 7 days)')
    .addOption(
      new Option('--status <status>', 'only tasks with this status').choices([
        'running',
        'succeeded',
        'failed',
        'cancelled',
      ]),
    )
    .option('-n, --limit <n>', 'maximum number of tasks', '20')
    .action(
      action(kit, async (ctx, flags: { status?: string; limit: string }) => {
        const limit = parsePositiveInt(flags.limit, '--limit');
        const tasks = (await new TaskStore(ctx.paths.tasksDir).list())
          .filter((t) => !flags.status || t.status === flags.status)
          .slice(0, limit)
          .map(taskSummary);
        ctx.out.result({ count: tasks.length, tasks }, (d) =>
          d.tasks.length === 0
            ? 'No background tasks.'
            : renderTable(d.tasks, [
                { header: 'TASK', value: (t) => String(t.id) },
                { header: 'STATUS', value: (t) => String(t.status) },
                { header: 'CREATED', value: (t) => formatDate(String(t.createdAt)) },
                { header: 'COMMAND', value: (t) => String(t.command), maxWidth: 60 },
              ]),
        );
      }),
    );

  const task = program.command('task').description('Inspect or cancel a background task');

  task
    .command('status')
    .description('Show a background task, its latest progress event and (when done) its result')
    .argument('<task-id>', 'task ID')
    .action(
      action(kit, async (ctx, id: string) => {
        const store = new TaskStore(ctx.paths.tasksDir);
        const record = await store.get(id);
        const lastEvent = record.status === 'running' ? await store.lastEvent(record) : undefined;
        ctx.out.result({ ...record, ...(lastEvent ? { lastEvent } : {}) }, (r) =>
          [
            `${r.id}: ${r.status}`,
            `  ${r.command}`,
            ...(r.lastEvent ? [`  last: ${JSON.stringify(r.lastEvent)}`] : []),
          ].join('\n'),
        );
      }),
    );

  task
    .command('cancel')
    .description(
      'Stop a running background task (it closes its browser tabs first; forced after 15 s). No effect on finished tasks.',
    )
    .argument('<task-id>', 'task ID')
    .action(
      action(kit, async (ctx, id: string) => {
        const store = new TaskStore(ctx.paths.tasksDir);
        let record = await store.get(id);
        if (record.status === 'running') {
          // Ask the worker to stop gracefully (it releases its browser session), then force it.
          await store.requestCancel(id);
          const deadline = Date.now() + CANCEL_GRACE_MS;
          while (record.status === 'running' && Date.now() < deadline) {
            await sleep(250);
            record = await store.get(id);
          }
          if (record.status === 'running') {
            if (record.pid !== undefined && processAlive(record.pid)) {
              try {
                process.kill(record.pid, 'SIGKILL');
              } catch {
                // already gone
              }
            }
            await store.finish(id, {
              exitCode: ExitCode.Cancelled,
              status: 'cancelled',
              result: {
                ok: false,
                data: null,
                error: new GvidsError('The task was cancelled (stopped forcibly).', {
                  code: 'CANCELLED',
                  exitCode: ExitCode.Cancelled,
                }).toJSON(),
              },
            });
            record = await store.get(id);
          }
        }
        ctx.out.result(taskSummary(record), (r) => `${r.id} is ${r.status}.`);
      }),
    );
}
