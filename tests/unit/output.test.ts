import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Output, type OutputOptions } from '../../src/cli/output/output.js';
import { formatBytes, renderTable, truncate } from '../../src/cli/output/format.js';
import { UsageError } from '../../src/errors/errors.js';

class Sink extends Writable {
  data = '';
  override _write(c: Buffer | string, _e: BufferEncoding, cb: () => void): void {
    this.data += c.toString();
    cb();
  }
}

const sanitizeTable = (t: string): string[] => t.split('\n');

function make(opts: Partial<Omit<OutputOptions, 'stdout' | 'stderr'>> = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const out = new Output({ format: 'json', stdout, stderr, ...opts });
  return { out, stdout, stderr };
}

const ANSI = /\u001b\[/;

describe('Output (JSON, the default)', () => {
  it('prints exactly one compact envelope and keeps stderr silent', () => {
    const { out, stdout, stderr } = make();
    out.info('status that must not appear');
    out.success('done');
    out.spinner('working').succeed('ok');
    out.result({ files: [1, 2] }, () => 'human');
    expect(stdout.data).toBe('{"ok":true,"data":{"files":[1,2]},"error":null}\n');
    expect(stderr.data).toBe('');
    expect(stdout.data).not.toMatch(ANSI);
  });

  it('indents with --pretty', () => {
    const { out, stdout } = make({ pretty: true });
    out.result({ a: 1 });
    expect(stdout.data).toBe('{\n  "ok": true,\n  "data": {\n    "a": 1\n  },\n  "error": null\n}\n');
  });

  it('puts warnings inside the envelope instead of on stderr', () => {
    const { out, stdout, stderr } = make();
    out.warn('fell back to the editor');
    out.warn('fell back to the editor');
    out.result({ ok: 1 });
    expect(JSON.parse(stdout.data).warnings).toEqual(['fell back to the editor']);
    expect(stderr.data).toBe('');
  });

  it('reports failures as envelopes with agent fields', () => {
    const { out, stdout } = make();
    out.failure(new UsageError('bad flag', { hint: 'Run: gvids scene add --help' }));
    expect(JSON.parse(stdout.data)).toEqual({
      ok: false,
      data: null,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'bad flag',
        exitCode: 2,
        retryable: false,
        needsUser: false,
        next: ['gvids scene add --help'],
        hint: ['Run: gvids scene add --help'],
      },
    });
  });

  it('can attach partial data to a failure', () => {
    const { out, stdout } = make();
    out.failure(new UsageError('1 of 2 failed'), { results: [1] });
    expect(JSON.parse(stdout.data).data).toEqual({ results: [1] });
  });

  it('streams JSON-line progress events on stderr with --progress', () => {
    const { out, stdout, stderr } = make({ progress: true });
    out.info('Opening the editor');
    const p = out.progress('Downloading');
    p.update(12, 2048);
    out.warn('slow save');
    out.result({ ok: true });
    const events = stderr.data
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['status', 'status', 'progress', 'warning']);
    expect(events[2]).toMatchObject({ message: 'Downloading', percent: 12, bytes: 2048 });
    expect(typeof events[0].ms).toBe('number');
    expect(JSON.parse(stdout.data).warnings).toEqual(['slow save']);
  });

  it('redacts secrets from results', () => {
    const { out, stdout } = make();
    out.result({ access_token: 'ya29.secret-token-value', note: 'Bearer abcdefghijklmnop' });
    const parsed = JSON.parse(stdout.data);
    expect(parsed.data.access_token).toBe('[REDACTED]');
    expect(parsed.data.note).toBe('Bearer [REDACTED]');
  });

  it('relays a stored envelope as-is', () => {
    const { out, stdout } = make();
    out.envelope({
      ok: false,
      data: null,
      error: { code: 'GENERIC_ERROR', message: 'x', exitCode: 1, retryable: false, needsUser: false },
    });
    expect(JSON.parse(stdout.data).error.message).toBe('x');
  });
});

describe('Output (--human)', () => {
  it('writes human results to stdout and errors to stderr', () => {
    const { out, stdout, stderr } = make({ format: 'text' });
    out.result({ n: 1 }, (d) => `n=${d.n}`);
    out.failure(new UsageError('nope', { hint: 'fix it' }));
    expect(stdout.data).toBe('n=1\n');
    expect(stderr.data).toContain('Error: nope');
    expect(stderr.data).toContain('fix it');
  });

  it('--quiet hides status lines but keeps results', () => {
    const { out, stdout, stderr } = make({ format: 'text', quiet: true });
    out.info('hidden');
    out.success('hidden too');
    out.spinner('working').succeed('done');
    out.result('visible');
    expect(stderr.data).toBe('');
    expect(stdout.data).toBe('visible\n');
  });

  it('prints progress deciles once', () => {
    const { out, stderr } = make({ format: 'text' });
    const p = out.progress('Downloading');
    for (const pct of [1, 5, 12, 15, 42, 89, 100]) p.update(pct);
    p.done('Saved');
    expect(stderr.data.trim().split('\n')).toEqual([
      'Downloading',
      'Downloading 1%',
      'Downloading 12%',
      'Downloading 42%',
      'Downloading 89%',
      'Downloading 100%',
      'Saved',
    ]);
  });
});

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
    expect(formatBytes(undefined)).toBe('-');
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });

  it('renders aligned tables', () => {
    const table = renderTable(
      [
        { a: 'x', b: 'long value' },
        { a: 'yyy', b: 'v' },
      ],
      [
        { header: 'A', value: (r) => r.a },
        { header: 'B', value: (r) => r.b },
      ],
    );
    expect(sanitizeTable(table)).toEqual(['A    B', 'x    long value', 'yyy  v']);
  });
});
