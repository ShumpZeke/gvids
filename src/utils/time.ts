import { CancelledError, UsageError } from '../errors/errors.js';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
};

/**
 * Parses durations such as "90s", "10m", "1h30m", "2500ms". A bare number is
 * interpreted as seconds.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new UsageError(`Invalid duration: ${input}`);
    return Math.round(input * 1000);
  }
  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (seconds <= 0) throw new UsageError(`Invalid duration "${input}": must be greater than zero.`);
    return Math.round(seconds * 1000);
  }
  const re = /(\d+(?:\.\d+)?)\s*(ms|sec|s|min|m|hr|h)/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(re)) {
    total += Number(match[1]) * UNIT_MS[match[2]!]!;
    consumed += match[0];
  }
  if (total <= 0 || consumed.replace(/\s+/g, '') !== text.replace(/\s+/g, '')) {
    throw new UsageError(`Invalid duration "${input}". Use forms like 30s, 10m, 1h30m.`);
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface PollOptions<T> {
  /** Called repeatedly until it returns a value that `done` accepts. */
  check: () => Promise<T>;
  done: (value: T) => boolean;
  timeoutMs: number;
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  backoff?: number;
  signal?: AbortSignal;
  onTick?: (value: T, elapsedMs: number) => void;
  /** Error to throw when the timeout expires. */
  onTimeout: (last: T | undefined) => Error;
}

/**
 * Bounded polling with exponential backoff. This is the only waiting
 * primitive used for long operations — there are no fixed sleeps.
 */
export async function poll<T>(options: PollOptions<T>): Promise<T> {
  const start = Date.now();
  let interval = options.initialIntervalMs ?? 1000;
  const maxInterval = options.maxIntervalMs ?? 15_000;
  const backoff = options.backoff ?? 1.5;
  let last: T | undefined;
  for (;;) {
    last = await options.check();
    const elapsed = Date.now() - start;
    options.onTick?.(last, elapsed);
    if (options.done(last)) return last;
    const remaining = options.timeoutMs - elapsed;
    if (remaining <= 0) throw options.onTimeout(last);
    await sleep(Math.min(interval, remaining), options.signal);
    interval = Math.min(Math.round(interval * backoff), maxInterval);
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Parses a date filter (YYYY-MM-DD or full ISO) into an RFC 3339 timestamp. */
export function parseDateFilter(value: string, flag: string): string {
  const trimmed = value.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? new Date(`${trimmed}T00:00:00Z`) : new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(`${flag} expects a date like 2026-09-01, got "${value}".`);
  }
  return date.toISOString();
}
