import { CancelledError, type GvidsError } from '../errors/errors.js';
import { toGvidsError } from '../errors/map.js';
import type { JobRecord, JobStore, StepRecord } from './job.js';

export interface StepResult {
  output?: unknown;
  /** Set by create/open so later steps (and resumes) know the video. */
  vidId?: string;
  vidUrl?: string;
  /** The step's effect already existed (idempotent resume). */
  skipped?: boolean;
}

export interface StepExecutor {
  execute(step: StepRecord, job: JobRecord): Promise<StepResult>;
  close(): Promise<void>;
}

export interface RunHooks {
  onStepStart?(step: StepRecord, index: number, total: number): void;
  onStepDone?(step: StepRecord, index: number, total: number): void;
  onStepFailed?(step: StepRecord, error: GvidsError): void;
}

/**
 * Runs the pending steps of a job in order, persisting state after every
 * transition so an interrupted run can be resumed from the failed step.
 */
export async function runJob(
  store: JobStore,
  job: JobRecord,
  executor: StepExecutor,
  hooks: RunHooks = {},
  signal?: AbortSignal,
): Promise<JobRecord> {
  await store.acquire(job);
  const total = job.steps.length;
  try {
    for (let i = 0; i < total; i++) {
      const step = job.steps[i]!;
      if (step.status === 'done' || step.status === 'skipped') continue;
      const onDisk = await store.get(job.id).catch(() => job);
      if (onDisk.cancelRequested || signal?.aborted) {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        await store.save(job);
        throw new CancelledError(`Job ${job.id} was cancelled before step "${step.id}".`);
      }
      step.status = 'running';
      step.attempts += 1;
      step.startedAt = new Date().toISOString();
      delete step.error;
      await store.save(job);
      hooks.onStepStart?.(step, i, total);
      try {
        const result = await executor.execute(step, job);
        if (result.vidId) {
          job.vidId = result.vidId;
          if (result.vidUrl) job.vidUrl = result.vidUrl;
        }
        step.status = result.skipped ? 'skipped' : 'done';
        if (result.output !== undefined) step.output = result.output;
        step.finishedAt = new Date().toISOString();
        await store.save(job);
        hooks.onStepDone?.(step, i, total);
      } catch (err) {
        const error = toGvidsError(err);
        step.status = 'failed';
        step.error = { code: error.code, message: error.message };
        step.finishedAt = new Date().toISOString();
        job.status = error.code === 'CANCELLED' ? 'cancelled' : 'failed';
        job.error = { code: error.code, message: error.message };
        delete job.owner;
        await store.save(job);
        hooks.onStepFailed?.(step, error);
        throw error;
      }
    }
    job.status = 'completed';
    delete job.error;
    job.finishedAt = new Date().toISOString();
    delete job.owner;
    await store.save(job);
    return job;
  } finally {
    await executor.close().catch(() => undefined);
    if (job.status === 'running') {
      job.status = 'failed';
      delete job.owner;
      await store.save(job).catch(() => undefined);
    }
  }
}

/** Resets failed/running steps so they run again on resume. */
export function prepareResume(job: JobRecord): number {
  let pending = 0;
  for (const step of job.steps) {
    if (step.status === 'failed' || step.status === 'running') step.status = 'pending';
    if (step.status === 'pending') pending++;
  }
  if (job.status !== 'completed') job.status = 'pending';
  delete job.error;
  return pending;
}
