import { pino, type Logger, type LevelWithSilent } from 'pino';
import { redactString } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  level: LevelWithSilent;
  /** Where log lines go. Always stderr in the CLI so stdout stays machine-readable. */
  stream: NodeJS.WritableStream;
  /** Emit raw JSON lines instead of the compact human format. */
  json?: boolean;
  /** Receives every (redacted) record instead of the stream; used by agent-first JSON output. */
  sink?: (record: LogRecord) => void;
}

export interface LogRecord {
  level: number;
  msg: string;
  [key: string]: unknown;
}

const REDACT_PATHS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'authorization',
  'cookie',
  'tokens',
  'credentials',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.client_secret',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.tokens',
];

const LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

/**
 * Creates the process logger. Lines are redacted twice: structurally by pino
 * (known secret keys) and textually by redactString (token-shaped values).
 */
export function createLogger(options: LoggerOptions): Logger {
  const destination = {
    write(line: string): void {
      const safe = redactString(line);
      if (options.sink) {
        try {
          const { time: _time, ...record } = JSON.parse(safe) as LogRecord;
          options.sink({ ...record, msg: String(record.msg ?? '') });
        } catch {
          // Unparseable log lines are dropped rather than corrupting the output stream.
        }
        return;
      }
      if (options.json) {
        options.stream.write(safe);
        return;
      }
      try {
        const record = JSON.parse(safe) as Record<string, unknown>;
        const { level, time, msg, pid: _pid, hostname: _hostname, ...rest } = record;
        const label = LEVEL_LABELS[Number(level)] ?? String(level);
        const clock = typeof time === 'string' ? time.slice(11, 23) : '';
        const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
        options.stream.write(`${clock} [${label}] ${String(msg ?? '')}${extra}\n`);
      } catch {
        options.stream.write(safe);
      }
    },
  };
  return pino(
    {
      level: options.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
