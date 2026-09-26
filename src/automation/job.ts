import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GvidsError, NotFoundError } from '../errors/errors.js';
import { readJsonFile, writeFileAtomic } from '../utils/fs.js';
import type { StepPlan } from './workflow.js';

export type JobStatus = 'pending' | 'running' | 'failed' | 'completed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StepRecord {
  id: string;
  type: StepPlan['type'];
  description: string;
  browser: boolean;
  params: Record<string, unknown>;
  status: StepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
  output?: unknown;
}

export interface JobRecord {
  id: string;
  name: string;
  workflowFile: string;
  workflowHash: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Video the job operates on, recorded as soon as it exists (enables safe resume). */
  vidId?: string;
  vidUrl?: string;
  steps: StepRecord[];
  error?: { code: string; message: string };
  cancelRequested?: boolean;
  owner?: { pid: number; host: string; since: string };
}

export function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `job_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Persists jobs as one JSON file per job under ~/.gvids/jobs. */
export class JobStore {
  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!/^job_[0-9]{14}_[0-9a-f]{6}$/.test(id))
      throw new NotFoundError(`Invalid job ID: ${id}`, { code: 'JOB_NOT_FOUND' });
    return path.join(this.dir, `${id}.json`);
  }

  async create(input: {
    name: string;
    workflowFile: string;
    workflowHash: string;
    steps: StepPlan[];
  }): Promise<JobRecord> {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: newJobId(),
      name: input.name,
      workflowFile: input.workflowFile,
      workflowHash: input.workflowHash,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      steps: input.steps.map((s) => ({ ...s, status: 'pending', attempts: 0 })),
    };
    await this.save(job);
    return job;
  }

  async save(job: JobRecord): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.file(job.id), `${JSON.stringify(job, null, 2)}\n`);
  }

  async get(id: string): Promise<JobRecord> {
    const job = await readJsonFile<JobRecord>(this.file(id));
    if (!job)
      throw new NotFoundError(`Job not found: ${id}`, {
        code: 'JOB_NOT_FOUND',
        hint: 'List jobs with: gvids jobs',
      });
    return job;
  }

  async list(): Promise<JobRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const jobs: JobRecord[] = [];
    for (const f of files.filter((x) => /^job_.*\.json$/.test(x))) {
      const job = await readJsonFile<JobRecord>(path.join(this.dir, f)).catch(() => undefined);
      if (job) jobs.push(job);
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** True if another live process currently runs the job. */
  isLocked(job: JobRecord): boolean {
    if (job.status !== 'running' || !job.owner) return false;
    if (job.owner.host !== os.hostname()) return true;
    return job.owner.pid !== process.pid && processAlive(job.owner.pid);
  }

  async acquire(job: JobRecord): Promise<void> {
    if (this.isLocked(job)) {
      throw new GvidsError(`Job ${job.id} is already running (pid ${job.owner!.pid}).`, {
        code: 'JOB_LOCKED',
        exitCode: 2,
        hint: `Wait for it, or cancel it: gvids job cancel ${job.id}`,
      });
    }
    job.owner = { pid: process.pid, host: os.hostname(), since: new Date().toISOString() };
    job.status = 'running';
    job.startedAt ??= new Date().toISOString();
    job.cancelRequested = false;
    await this.save(job);
  }

  async requestCancel(id: string): Promise<JobRecord> {
    const job = await this.get(id);
    if (job.status === 'completed' || job.status === 'cancelled') return job;
    if (job.status === 'running' && this.isLocked(job)) {
      job.cancelRequested = true;
    } else {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      delete job.owner;
    }
    await this.save(job);
    return job;
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }
}
