import path from 'node:path';
import { Option, type Command } from 'commander';
import { JobStore, type JobRecord, type StepRecord } from '../../automation/job.js';
import { prepareResume, runJob } from '../../automation/runner.js';
import type { StepPlan } from '../../automation/workflow.js';
import { shellJoin, UsageError, withContext } from '../../errors/errors.js';
import { toGvidsError } from '../../errors/map.js';
import { parsePositiveInt } from '../../utils/input.js';
import { redactArgv } from '../../utils/redact.js';
import { onShutdown } from '../../utils/shutdown.js';
import { formatDuration } from '../../utils/time.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { formatDate, renderTable } from '../output/format.js';

const STEP_MARK: Record<StepRecord['status'], string> = {
  pending: ' ',
  running: '…',
  done: '✓',
  skipped: '=',
  failed: '✗',
};

export function renderJob(job: JobRecord): string {
  const lines = [
    `Job ${job.id} — ${job.name}`,
    `  status:   ${job.status}${job.error ? ` (${job.error.code}: ${job.error.message})` : ''}`,
    `  workflow: ${job.workflowFile}`,
    ...(job.vidId ? [`  video:    ${job.vidUrl ?? job.vidId}`] : []),
    `  created:  ${formatDate(job.createdAt)}`,
    '',
    ...job.steps.map(
      (s) =>
        `  [${STEP_MARK[s.status]}] ${s.id.padEnd(22)} ${s.description}${s.error ? `\n        ${s.error.code}: ${s.error.message}` : ''}`,
    ),
  ];
  if (job.status === 'failed') lines.push('', `Resume with: gvids job resume ${job.id}`);
  return lines.join('\n');
}

/** Steps that make the video public (anyone with the link, or a whole domain). */
function publicShares(steps: Array<Pick<StepPlan, 'type' | 'params' | 'description'>>): string[] {
  return steps
    .filter((s) => s.type === 'share' && (s.params.anyone === true || typeof s.params.domain === 'string'))
    .map((s) => s.description);
}

/** Same rule as `gvids share --anyone/--domain`: public sharing needs the user's approval (--yes). */
async function confirmPublicSharing(
  ctx: CommandContext,
  steps: Array<Pick<StepPlan, 'type' | 'params' | 'description'>>,
): Promise<void> {
  const shares = publicShares(steps);
  if (shares.length === 0) return;
  await ctx.confirm(
    `The workflow will: ${shares.join('; ')}. Continue?`,
    `run a workflow that shares publicly (${shares.join('; ')})`,
  );
}

/** The workflow schema and planner (zod, yaml) load only for workflow commands. */
const workflows = () => import('../../automation/workflow.js');

async function execute(ctx: CommandContext, store: JobStore, job: JobRecord): Promise<JobRecord> {
  const { LiveExecutor } = await import('../../automation/executor.js');
  const executor = new LiveExecutor(ctx, path.dirname(job.workflowFile));
  const started = Date.now();
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  // Interrupted (Ctrl+C, SIGTERM, task cancel): record it so `gvids job resume` can continue.
  const unregister = onShutdown(async () => {
    controller.abort();
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.error = { code: 'CANCELLED', message: 'Interrupted.' };
      job.finishedAt = new Date().toISOString();
      delete job.owner;
      await store.save(job);
    }
  });
  try {
    return await runJob(
      store,
      job,
      executor,
      {
        onStepStart: (s, i, total) => ctx.out.info(`[${i + 1}/${total}] ${s.description}…`),
        onStepDone: (s) => ctx.out.detail(`    ${s.status === 'skipped' ? 'already done' : 'done'}`),
        onStepFailed: (s, e) => ctx.out.warn(`Step "${s.id}" failed: ${e.message}`),
      },
      controller.signal,
    ).then((done) => {
      ctx.out.success(`Workflow finished in ${formatDuration(Date.now() - started)}.`);
      return done;
    });
  } catch (err) {
    // Say which job failed and how to continue it.
    throw withContext(toGvidsError(err), {
      next: [`gvids job resume ${job.id}`, `gvids job status ${job.id}`],
      details: { jobId: job.id },
    });
  } finally {
    unregister();
    process.removeListener('SIGINT', onSigint);
  }
}

export function registerJobCommands(program: Command, kit: Kit): void {
  program
    .command('run')
    .description('Run a video workflow described in YAML or JSON (resumable job)')
    .argument('<file>', 'workflow file (.yaml, .yml or .json)')
    .addHelpText(
      'after',
      '\nSee docs/workflows.md and examples/*.yaml. Failed runs resume with: gvids job resume <job-id>',
    )
    .action(
      action(kit, async (ctx, file: string) => {
        const { loadWorkflow, planWorkflow } = await workflows();
        const loaded = await loadWorkflow(path.resolve(ctx.io.cwd, file));
        const steps = planWorkflow(loaded.workflow);
        // The global --dry-run: for workflows it returns the full step plan.
        if (ctx.globals.dryRun) {
          const shares = publicShares(steps);
          const needsYes = shares.length > 0 && !ctx.yes;
          const runArgs = redactArgv(ctx.argv.filter((a) => a !== '--dry-run' && a !== '--json'));
          ctx.out.result(
            {
              dryRun: true,
              workflow: loaded.path,
              name: loaded.workflow.name,
              steps,
              run: shellJoin(['gvids', ...(needsYes ? [...runArgs, '--yes'] : runArgs)]),
              ...(needsYes ? { requiresUserApproval: true, publicSharing: shares } : {}),
            },
            (d) =>
              [
                `Plan for "${d.name}" (${d.steps.length} steps):`,
                ...d.steps.map(
                  (s, i) =>
                    `  ${String(i + 1).padStart(2)}. ${s.description}${s.browser ? '' : '  [Drive API]'}`,
                ),
                ...(d.requiresUserApproval
                  ? ['', 'Shares publicly: needs --yes after the user approves.']
                  : []),
              ].join('\n'),
          );
          return;
        }
        await confirmPublicSharing(ctx, steps);
        const store = new JobStore(ctx.paths.jobsDir);
        const job = await store.create({
          name: loaded.workflow.name,
          workflowFile: loaded.path,
          workflowHash: loaded.hash,
          steps,
        });
        ctx.out.info(`Job ${job.id} started (${steps.length} steps).`);
        try {
          const done = await execute(ctx, store, job);
          ctx.out.result(done, renderJob);
        } catch (err) {
          ctx.out.info(`State saved. Resume with: gvids job resume ${job.id}`);
          throw err;
        }
      }),
    );

  program
    .command('jobs')
    .description('List workflow jobs')
    .addOption(
      new Option('--status <status>', 'only jobs with this status').choices([
        'pending',
        'running',
        'failed',
        'completed',
        'cancelled',
      ]),
    )
    .option('-n, --limit <n>', 'maximum number of jobs', '20')
    .action(
      action(kit, async (ctx, flags: { status?: string; limit: string }) => {
        const limit = parsePositiveInt(flags.limit, '--limit');
        const store = new JobStore(ctx.paths.jobsDir);
        const jobs = (await store.list())
          .filter((j) => !flags.status || j.status === flags.status)
          .slice(0, limit);
        ctx.out.result(
          {
            jobs: jobs.map((j) => ({
              id: j.id,
              name: j.name,
              status: j.status,
              createdAt: j.createdAt,
              vidId: j.vidId ?? null,
              progress: `${j.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length}/${j.steps.length}`,
            })),
          },
          (d) =>
            d.jobs.length === 0
              ? 'No jobs yet. Start one with: gvids run workflow.yaml'
              : renderTable(d.jobs, [
                  { header: 'JOB', value: (j) => j.id },
                  { header: 'STATUS', value: (j) => j.status },
                  { header: 'STEPS', value: (j) => j.progress },
                  { header: 'CREATED', value: (j) => formatDate(j.createdAt) },
                  { header: 'NAME', value: (j) => j.name, maxWidth: 40 },
                ]),
        );
      }),
    );

  const job = program.command('job').description('Inspect, resume or cancel a workflow job');

  job
    .command('status')
    .description('Show a job and its steps')
    .argument('<job-id>', 'job ID')
    .action(
      action(kit, async (ctx, id: string) => {
        const record = await new JobStore(ctx.paths.jobsDir).get(id);
        ctx.out.result(record, renderJob);
      }),
    );

  job
    .command('resume')
    .description('Resume a failed or interrupted job from the first unfinished step')
    .argument('<job-id>', 'job ID')
    .option('--force', 'resume even if the workflow file changed since the job started')
    .action(
      action(kit, async (ctx, id: string, flags: { force?: boolean }) => {
        const store = new JobStore(ctx.paths.jobsDir);
        const record = await store.get(id);
        if (record.status === 'completed') {
          ctx.out.result(record, (r) => `Job ${r.id} already completed.`);
          return;
        }
        if (store.isLocked(record))
          throw new UsageError(`Job ${id} is running in another process (pid ${record.owner?.pid}).`);
        const { loadWorkflow } = await workflows();
        const loaded = await loadWorkflow(record.workflowFile);
        if (loaded.hash !== record.workflowHash && !flags.force) {
          throw new UsageError('The workflow file changed since this job started.', {
            hint: 'Start a new run (gvids run) or pass --force to resume with the recorded steps.',
          });
        }
        await confirmPublicSharing(
          ctx,
          record.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped'),
        );
        const pending = prepareResume(record);
        await store.save(record);
        ctx.out.info(`Resuming ${id}: ${pending} step(s) left.`);
        const done = await execute(ctx, store, record);
        ctx.out.result(done, renderJob);
      }),
    );

  job
    .command('cancel')
    .description('Cancel a job (a running job stops before its next step)')
    .argument('<job-id>', 'job ID')
    .action(
      action(kit, async (ctx, id: string) => {
        const record = await new JobStore(ctx.paths.jobsDir).requestCancel(id);
        ctx.out.result(record, (r) =>
          r.status === 'cancelled'
            ? `Job ${r.id} cancelled.`
            : r.cancelRequested
              ? `Cancellation requested; ${r.id} stops before its next step.`
              : `Job ${r.id} is ${r.status}.`,
        );
      }),
    );
}
