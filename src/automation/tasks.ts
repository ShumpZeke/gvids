import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GvidsError, NotFoundError, shellJoin, type SerializedError } from '../errors/errors.js';
import { ExitCode } from '../errors/exit-codes.js';
import { redactArgv } from '../utils/redact.js';
import { writeFileAtomic } from '../utils/fs.js';

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/** The JSON envelope a command printed (see Output). */
export interface StoredEnvelope {
  ok: boolean;
  data: unknown;
  error: SerializedError | null;
  warnings?: string[];
}

/** A command started with --detach, running (or finished) in its own process. */
export interface TaskRecord {
  id: string;
  /** gvids arguments, without --detach (secret flag values masked). */
  args: string[];
  command: string;
  cwd: string;
  status: TaskStatus;
  pid?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  /** The command's envelope once it finished. */
  result?: StoredEnvelope;
  /** Set while `gvids task cancel` waits for the worker to stop. */
  cancelRequestedAt?: string;
  stdoutFile: string;
  stderrFile: string;
}

/** Written once by whoever finishes the task (normally the worker itself). */
interface TaskOutcome {
  status: Exclude<TaskStatus, 'running'>;
  exitCode: number;
  finishedAt: string;
  result?: StoredEnvelope;
  pid?: number;
}

export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `task_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
}

export const TASK_ID_PATTERN = /^task_[0-9]{14}_[0-9a-f]{6}$/;

/** A worker refreshes its heartbeat this often; a much older heartbeat means it is gone. */
export const HEARTBEAT_MS = 5_000;
const HEARTBEAT_STALE_MS = 60_000;
/** Finished tasks older than this are deleted when a new task starts. */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GvidsError(`Task file is corrupted: ${file}`, {
      code: 'TASK_NOT_FOUND',
      exitCode: ExitCode.NotFound,
      hint: 'Delete the file, or start the command again.',
    });
  }
}

function outcomeStatus(exitCode: number): TaskOutcome['status'] {
  return exitCode === ExitCode.Cancelled ? 'cancelled' : exitCode === 0 ? 'succeeded' : 'failed';
}

/**
 * Background tasks under ~/.gvids/tasks. Per task:
 *   <id>.json          the record, written only by the starting process
 *   <id>.result.json   the outcome, written once when the task ends
 *   <id>.alive         heartbeat, touched by the running worker
 *   <id>.cancel        cancellation request from `gvids task cancel`
 *   <id>.out.jsonl / <id>.err.jsonl   the worker's stdout / stderr
 * Separate files mean the starter and the worker never overwrite each other.
 */
export class TaskStore {
  constructor(readonly dir: string) {}

  private base(id: string): string {
    if (!TASK_ID_PATTERN.test(id)) {
      throw new NotFoundError(`Invalid task ID: ${id}`, {
        code: 'TASK_NOT_FOUND',
        hint: 'Task IDs look like task_20260923204609_484d4b. List tasks with: gvids tasks',
      });
    }
    return path.join(this.dir, id);
  }

  private recordFile(id: string): string {
    return `${this.base(id)}.json`;
  }

  private outcomeFile(id: string): string {
    return `${this.base(id)}.result.json`;
  }

  heartbeatFile(id: string): string {
    return `${this.base(id)}.alive`;
  }

  cancelFile(id: string): string {
    return `${this.base(id)}.cancel`;
  }

  async create(args: string[], cwd: string): Promise<TaskRecord> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.prune().catch(() => undefined);
    const id = newTaskId();
    const safeArgs = redactArgv(args);
    const task: TaskRecord = {
      id,
      args: safeArgs,
      command: shellJoin(['gvids', ...safeArgs]),
      cwd,
      status: 'running',
      createdAt: new Date().toISOString(),
      stdoutFile: `${this.base(id)}.out.jsonl`,
      stderrFile: `${this.base(id)}.err.jsonl`,
    };
    await writeFileAtomic(this.recordFile(id), `${JSON.stringify(task, null, 2)}\n`);
    return task;
  }

  /** Records the worker's pid (the starter's only update after create). */
  async markStarted(id: string, pid: number): Promise<TaskRecord> {
    const record = await this.readRecord(id);
    record.pid = pid;
    record.startedAt = new Date().toISOString();
    await writeFileAtomic(this.recordFile(id), `${JSON.stringify(record, null, 2)}\n`);
    return this.merge(record);
  }

  /** Records the outcome. The first outcome wins; later calls are ignored. */
  async finish(
    id: string,
    outcome: { exitCode: number; result?: StoredEnvelope; pid?: number; status?: TaskOutcome['status'] },
  ): Promise<void> {
    const file = this.outcomeFile(id);
    const done: TaskOutcome = {
      status: outcome.status ?? outcomeStatus(outcome.exitCode),
      exitCode: outcome.exitCode,
      finishedAt: new Date().toISOString(),
      ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
    };
    try {
      // 'wx': exclusive create, so a late second writer cannot replace the real outcome.
      await fs.writeFile(file, `${JSON.stringify(done, null, 2)}\n`, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await fs.rm(this.heartbeatFile(id), { force: true }).catch(() => undefined);
    await fs.rm(this.cancelFile(id), { force: true }).catch(() => undefined);
  }

  private async readRecord(id: string): Promise<TaskRecord> {
    const record = await readJson<TaskRecord>(this.recordFile(id));
    if (!record) {
      throw new NotFoundError(`Task not found: ${id}`, {
        code: 'TASK_NOT_FOUND',
        hint: 'List tasks with: gvids tasks',
      });
    }
    return record;
  }

  private async merge(record: TaskRecord): Promise<TaskRecord> {
    const outcome = await readJson<TaskOutcome>(this.outcomeFile(record.id)).catch(() => undefined);
    const cancelRequested = await fs
      .stat(this.cancelFile(record.id))
      .then((s) => s.mtime.toISOString())
      .catch(() => undefined);
    if (!outcome) return cancelRequested ? { ...record, cancelRequestedAt: cancelRequested } : record;
    return {
      ...record,
      status: outcome.status,
      exitCode: outcome.exitCode,
      finishedAt: outcome.finishedAt,
      ...(outcome.result ? { result: outcome.result } : {}),
    };
  }

  async get(id: string): Promise<TaskRecord> {
    return this.reconcile(await this.merge(await this.readRecord(id)));
  }

  async list(): Promise<TaskRecord[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const tasks: TaskRecord[] = [];
    for (const f of files) {
      const m = /^(task_[0-9]{14}_[0-9a-f]{6})\.json$/.exec(f);
      if (!m) continue;
      const task = await this.get(m[1]!).catch(() => undefined);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Why a still-"running" task is known to be dead, or undefined if it may be alive. */
  private async deathReason(task: TaskRecord): Promise<string | undefined> {
    if (task.pid === undefined) {
      // Never got a pid: the start failed if that was long ago.
      return Date.now() - Date.parse(task.createdAt) > HEARTBEAT_STALE_MS
        ? 'The background process never started.'
        : undefined;
    }
    if (!processAlive(task.pid)) return 'The background process ended without reporting a result.';
    const beat = await fs
      .stat(this.heartbeatFile(task.id))
      .then((s) => s.mtimeMs)
      .catch(() => undefined);
    const since = beat ?? Date.parse(task.startedAt ?? task.createdAt);
    // The pid is alive but the worker stopped beating: the pid belongs to another process now.
    if (Date.now() - since > HEARTBEAT_STALE_MS)
      return 'The background process stopped responding (no heartbeat).';
    return undefined;
  }

  /** A "running" task whose process is gone is recorded as failed. */
  private async reconcile(task: TaskRecord): Promise<TaskRecord> {
    if (task.status !== 'running') return task;
    const reason = await this.deathReason(task);
    if (!reason) return task;
    await this.finish(task.id, {
      exitCode: ExitCode.GenericError,
      result: {
        ok: false,
        data: null,
        error: {
          code: 'GENERIC_ERROR',
          message: reason,
          exitCode: ExitCode.GenericError,
          retryable: true,
          needsUser: false,
          hint: [`The worker's output: ${task.stderrFile}`],
        },
      },
    });
    return this.merge(await this.readRecord(task.id));
  }

  /** Asks the worker to stop gracefully (it checks for this file while running). */
  async requestCancel(id: string): Promise<void> {
    await fs.writeFile(this.cancelFile(id), new Date().toISOString(), 'utf8');
  }

  /** Last JSON event the worker wrote to stderr (progress, warnings), if any. */
  async lastEvent(task: TaskRecord): Promise<unknown> {
    const text = await fs.readFile(task.stderrFile, 'utf8').catch(() => '');
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!);
      } catch {
        // not a JSON line
      }
    }
    return undefined;
  }

  /** Deletes the files of tasks that finished more than a week ago. */
  async prune(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const task of await this.list()) {
      if (task.status === 'running' || !task.finishedAt) continue;
      if (now - Date.parse(task.finishedAt) < KEEP_FINISHED_MS) continue;
      const base = this.base(task.id);
      for (const suffix of ['.json', '.result.json', '.alive', '.cancel', '.out.jsonl', '.err.jsonl']) {
        await fs.rm(`${base}${suffix}`, { force: true }).catch(() => undefined);
      }
      removed++;
    }
    return removed;
  }
}

/** Path of the CLI entry to start workers with (dist/cli/index.js, or the .ts source under tsx). */
export function cliEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.resolve(here, '..', 'cli', 'index.js');
  if (existsSync(js)) return js;
  return path.resolve(here, '..', 'cli', 'index.ts');
}

/** Starts a detached worker process whose stdout/stderr go to the task files. */
export async function spawnWorker(spec: {
  taskId: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdoutFile: string;
  stderrFile: string;
}): Promise<{ pid: number }> {
  const out = openSync(spec.stdoutFile, 'a');
  const err = openSync(spec.stderrFile, 'a');
  try {
    const child = spawn(process.execPath, [...process.execArgv, cliEntry(), ...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env, GVIDS_TASK_ID: spec.taskId },
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('Could not start the background process.');
    child.unref();
    return { pid };
  } finally {
    closeSync(out);
    closeSync(err);
  }
}
