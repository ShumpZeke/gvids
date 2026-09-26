import { createRequire } from 'node:module';
import type { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { Chalk, type ChalkInstance } from 'chalk';
import type { GvidsError, SerializedError } from '../../errors/errors.js';
import { redactString, redactValue } from '../../utils/redact.js';
import { formatBytes } from './format.js';

type YamlModule = { parse: typeof yamlParse; stringify: typeof yamlStringify };
export type OutputFormat = 'json' | 'text';

export interface OutputOptions {
  /** `json` (default): one envelope on stdout. `text` (--human): human rendering. */
  format: OutputFormat;
  /** Indent JSON; the default is one line per envelope. */
  pretty?: boolean;
  /** Stream progress events as JSON lines on stderr (JSON format). */
  progress?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  /** Colors in --human output (stderr only). */
  color?: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * The only thing a command writes to stdout. `ok` tells success from failure;
 * `data` is null on failure and `error` is null on success, except for `batch`
 * and `wait`, which may return partial `data` next to an `error`.
 */
export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: SerializedError | null;
  /** Non-fatal notes (fallbacks taken, slow saves, …). Omitted when empty. */
  warnings?: string[];
}

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

/** Streams that already received a command's result (so a shutdown does not print a second one). */
const answered = new WeakMap<NodeJS.WritableStream, boolean>();

export function hasWrittenResult(stream: NodeJS.WritableStream): boolean {
  return answered.has(stream);
}

/** Whether the result written to `stream` was a success (undefined: nothing written yet). */
export function writtenResultOk(stream: NodeJS.WritableStream): boolean | undefined {
  return answered.get(stream);
}

export interface ProgressReporter {
  /** Percentage 0..100, or undefined when the total size is unknown. */
  update(percent: number | undefined, transferredBytes?: number): void;
  done(text?: string): void;
  fail(text?: string): void;
}

/**
 * All output goes through this class so that:
 *  - stdout carries exactly one result envelope (JSON by default);
 *  - stderr stays silent in JSON format unless --progress (JSON lines) or
 *    --verbose/--debug (JSON log lines) are given, so `2>&1` stays parseable;
 *  - warnings travel inside the envelope instead of as loose stderr text;
 *  - --human renders human output, with status lines on stderr.
 */
export class Output {
  readonly format: OutputFormat;
  readonly pretty: boolean;
  readonly progressEvents: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly c: ChalkInstance;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly warnings: string[] = [];
  private readonly started = Date.now();
  private resultWritten = false;

  constructor(options: OutputOptions) {
    this.format = options.format;
    this.pretty = Boolean(options.pretty);
    this.progressEvents = Boolean(options.progress) && options.format === 'json';
    this.quiet = Boolean(options.quiet);
    this.verbose = Boolean(options.verbose);
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.c = new Chalk({ level: options.color && options.format === 'text' ? 1 : 0 });
  }

  get json(): boolean {
    return this.format === 'json';
  }

  get hasWrittenResult(): boolean {
    return this.resultWritten;
  }

  private stringify(value: unknown): string {
    return this.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  }

  private withWarnings<T extends object>(envelope: T): T & { warnings?: string[] } {
    return this.warnings.length > 0 ? { ...envelope, warnings: [...this.warnings] } : envelope;
  }

  /** Writes the command result. `human` renders it for --human; JSON ignores it. */
  result<T>(data: T, human?: (data: T) => string | undefined | void): void {
    this.resultWritten = true;
    answered.set(this.stdout, true);
    if (this.json) {
      const envelope: Envelope<T> = this.withWarnings({ ok: true, data: redactValue(data), error: null });
      this.stdout.write(`${this.stringify(envelope)}\n`);
      return;
    }
    const rendered = human ? human(data) : this.defaultRender(data);
    if (typeof rendered === 'string' && rendered.length > 0) {
      this.stdout.write(`${redactString(rendered)}\n`);
    }
  }

  /** Reports a failure. `data` is only used by commands that return partial results. */
  failure(error: GvidsError, data: unknown = null): void {
    this.resultWritten = true;
    answered.set(this.stdout, false);
    if (this.json) {
      const envelope: Envelope<unknown> = this.withWarnings({
        ok: false,
        data: redactValue(data),
        error: redactValue(error.toJSON()),
      });
      this.stdout.write(`${this.stringify(envelope)}\n`);
      return;
    }
    const lines = [`${this.c.red('Error:')} ${redactString(error.message)}`];
    if (error.hint.length > 0) {
      lines.push('');
      for (const h of error.hint) lines.push(`  ${redactString(h)}`);
    }
    if (this.verbose) lines.push('', this.c.dim(`code: ${error.code}  exit: ${error.exitCode}`));
    this.stderr.write(`${lines.join('\n')}\n`);
  }

  /** Writes a stored envelope (e.g. a background task's result) in the current format. */
  envelope(envelope: Envelope<unknown>): void {
    this.resultWritten = true;
    answered.set(this.stdout, envelope.ok);
    if (this.json) {
      this.stdout.write(`${this.stringify(this.withWarnings(redactValue(envelope)))}\n`);
      return;
    }
    for (const w of envelope.warnings ?? []) this.warn(w);
    if (envelope.ok) {
      const rendered = this.defaultRender(envelope.data);
      if (rendered) this.stdout.write(`${redactString(rendered)}\n`);
    } else if (envelope.error) {
      const lines = [`${this.c.red('Error:')} ${redactString(envelope.error.message)}`];
      for (const h of envelope.error.hint ?? []) lines.push(`  ${redactString(h)}`);
      this.stderr.write(`${lines.join('\n')}\n`);
    }
  }

  /** A progress/diagnostic event: a JSON line on stderr with --progress, nothing otherwise. */
  event(type: string, fields: Record<string, unknown> = {}): void {
    if (!this.progressEvents) return;
    const line = { type, ms: Date.now() - this.started, ...fields };
    this.stderr.write(`${JSON.stringify(redactValue(line))}\n`);
  }

  info(message: string): void {
    if (this.json) return this.event('status', { message });
    if (this.quiet) return;
    this.stderr.write(`${redactString(message)}\n`);
  }

  /** Verbose-only diagnostic text. */
  detail(message: string): void {
    if (this.json) {
      if (this.verbose) this.event('detail', { message });
      return;
    }
    if (!this.verbose || this.quiet) return;
    this.stderr.write(`${this.c.dim(redactString(message))}\n`);
  }

  success(message: string): void {
    if (this.json) return this.event('status', { message });
    if (this.quiet) return;
    this.stderr.write(`${this.c.green('✓')} ${redactString(message)}\n`);
  }

  /** Non-fatal problem or notable fallback. JSON: goes into the envelope's `warnings`. */
  warn(message: string): void {
    const safe = redactString(message);
    if (this.json) {
      if (!this.warnings.includes(safe)) this.warnings.push(safe);
      this.event('warning', { message: safe });
      return;
    }
    if (this.quiet) return;
    this.stderr.write(`${this.c.yellow('!')} ${safe}\n`);
  }

  /** Status updates for a long step: JSON progress events, or distinct stderr lines with --human. */
  spinner(text: string): Spinner {
    let last = '';
    const emit = (t: string): void => {
      if (t === last) return;
      last = t;
      if (this.json) this.event('status', { message: t });
      else if (!this.quiet) this.stderr.write(`${redactString(t)}\n`);
    };
    emit(text);
    return {
      update: emit,
      succeed: (t) => {
        if (t) emit(t);
      },
      fail: (t) => {
        if (t) emit(t);
      },
      stop: () => undefined,
    };
  }

  progress(label: string): ProgressReporter {
    let lastBucket = -1;
    const status = this.spinner(label);
    return {
      update: (percent, transferred) => {
        if (percent === undefined) {
          if (this.json) this.event('progress', { message: label, bytes: transferred });
          return;
        }
        const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
        const bucket = Math.floor(rounded / 10);
        if (bucket === lastBucket) return;
        lastBucket = bucket;
        if (this.json) this.event('progress', { message: label, percent: rounded, bytes: transferred });
        else
          status.update(
            `${label} ${rounded}%${transferred === undefined ? '' : ` (${formatBytes(transferred)})`}`,
          );
      },
      done: (text) => status.succeed(text),
      fail: (text) => status.fail(text),
    };
  }

  private defaultRender(data: unknown): string {
    if (data === undefined || data === null) return '';
    if (typeof data === 'string') return data;
    // Loaded on demand: only --human output needs it.
    const YAML = createRequire(import.meta.url)('yaml') as YamlModule;
    return YAML.stringify(data).trimEnd();
  }
}

/** Output used before global options are parsed. JSON unless the argv asks for text. */
export function createBasicOutput(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  format: OutputFormat = 'json',
  pretty = false,
): Output {
  return new Output({ format, pretty, stdout, stderr });
}
