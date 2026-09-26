import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { sanitizeFileName, uniquePath } from '../../src/utils/fs.js';
import { parseNumberList, parsePositiveInt, readTextFile, readTextInput } from '../../src/utils/input.js';
import { mask, redactHtml, redactPersonal, redactString, redactValue } from '../../src/utils/redact.js';
import { formatDuration, parseDateFilter, parseDuration, poll } from '../../src/utils/time.js';
import { tempHome } from '../helpers/cli.js';

describe('redactHtml', () => {
  it('drops inline script bodies but keeps the DOM and script tags', () => {
    const html =
      '<html><head><script nonce="x">var info = {"token":"AC4w5VgSecret:1790"};</script>' +
      '<script src="https://www.gstatic.com/app.js"></script></head>' +
      '<body><div role="toolbar" aria-label="Insertion">me@example.com</div></body></html>';
    const out = redactHtml(html);
    expect(out).not.toContain('AC4w5VgSecret');
    expect(out).toContain('<script nonce="x">/* removed by gvids */</script>');
    expect(out).toContain('<script src="https://www.gstatic.com/app.js">');
    expect(out).toContain('aria-label="Insertion"');
    expect(out).toContain('<email>');
  });
});

describe('redaction', () => {
  it('scrubs Google tokens, auth headers, client secrets and cookies', () => {
    const text = [
      'access ya29.a0AfH6SMBx-very.secret',
      'refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'secret GOCSPX-AbCdEf123456',
      'key AIzaSyA1234567890abcdefghijklmnopqrstu',
      'cookie SID=abc123; __Secure-3PSID=xyz789',
      'http://127.0.0.1:1234/?code=4/0Ab_secret&state=1',
    ].join('\n');
    const out = redactString(text);
    expect(out).not.toMatch(
      /very\.secret|0gAbCdEf|abcdefghijklmnopqrstuvwxyz|AbCdEf123456|A1234567890|abc123|xyz789|4\/0Ab_secret/,
    );
    expect(out).toContain('ya29.[REDACTED]');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('code=[REDACTED]');
  });

  it('redacts secret-looking keys in objects', () => {
    expect(
      redactValue({ refresh_token: 'x', nested: { client_secret: 'y', ok: 'z' }, list: [{ cookie: 'c' }] }),
    ).toEqual({
      refresh_token: '[REDACTED]',
      nested: { client_secret: '[REDACTED]', ok: 'z' },
      list: [{ cookie: '[REDACTED]' }],
    });
  });

  it('keeps error codes readable', () => {
    expect(redactValue({ code: 'AUTH_REQUIRED' })).toEqual({ code: 'AUTH_REQUIRED' });
  });

  it('hides e-mail addresses for diagnostics', () => {
    expect(redactPersonal('Google Account: Jane (jane.doe@example.com)')).toBe(
      'Google Account: Jane (<email>)',
    );
  });

  it('masks identifiers', () => {
    expect(mask('1234567890-abcdefghijklmnop.apps.googleusercontent.com')).toBe('123456….com');
    expect(mask(undefined)).toBe('');
  });
});

describe('durations', () => {
  it.each([
    ['90s', 90_000],
    ['10m', 600_000],
    ['1h30m', 5_400_000],
    ['2500ms', 2500],
    ['45', 45_000],
    ['1.5m', 90_000],
  ])('parses %s', (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  it('rejects junk', () => {
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
    expect(() => parseDuration('10x')).toThrow();
    expect(() => parseDuration('0')).toThrow();
  });

  it('formats', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(65_000)).toBe('1m05s');
    expect(formatDuration(3_723_000)).toBe('1h02m');
  });

  it('parses date filters', () => {
    expect(parseDateFilter('2026-09-01', '--modified-after')).toBe('2026-09-01T00:00:00.000Z');
    expect(() => parseDateFilter('yesterday', '--modified-after')).toThrow(/--modified-after/);
  });
});

describe('poll', () => {
  it('returns once done and reports ticks', async () => {
    let n = 0;
    const ticks: number[] = [];
    const value = await poll({
      check: async () => ++n,
      done: (v) => v >= 3,
      timeoutMs: 5000,
      initialIntervalMs: 5,
      onTick: (v) => ticks.push(v),
      onTimeout: () => new Error('timeout'),
    });
    expect(value).toBe(3);
    expect(ticks).toEqual([1, 2, 3]);
  });

  it('times out with the provided error', async () => {
    await expect(
      poll({
        check: async () => 0,
        done: () => false,
        timeoutMs: 30,
        initialIntervalMs: 10,
        onTimeout: () => new Error('too slow'),
      }),
    ).rejects.toThrow('too slow');
  });
});

describe('file names', () => {
  it.each([
    ['History: Part 1/2', 'History  Part 1 2'.replace(/\s+/g, ' ')],
    ['CON', 'CON_'],
    ['trailing dots...', 'trailing dots'],
    ['   ', 'video'],
    ['a<b>c|d?e*f"g', 'a b c d e f g'],
  ])('sanitizes %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });

  it('finds a unique path', async () => {
    const dir = tempHome();
    const file = path.join(dir, 'video.mp4');
    expect(await uniquePath(file)).toBe(file);
    fs.writeFileSync(file, 'x');
    expect(await uniquePath(file)).toBe(path.join(dir, 'video (2).mp4'));
  });
});

describe('text input', () => {
  it('returns literal text', async () => {
    expect(await readTextInput('Make a video about Mars')).toBe('Make a video about Mars');
  });

  it('reads stdin for "-"', async () => {
    const stdin = new PassThrough();
    stdin.end('from stdin\r\n');
    expect(await readTextInput('-', { stdin })).toBe('from stdin');
  });

  it('reads .txt, .md, .json and .yaml files', async () => {
    const dir = tempHome();
    fs.writeFileSync(path.join(dir, 'p.txt'), '﻿plain\r\ntext\n');
    fs.writeFileSync(path.join(dir, 'p.md'), '# Title\n');
    fs.writeFileSync(path.join(dir, 'p.json'), JSON.stringify({ prompt: 'json prompt' }));
    fs.writeFileSync(path.join(dir, 'p.yaml'), 'script: yaml script\n');
    expect(await readTextInput('p.txt', { cwd: dir })).toBe('plain\ntext');
    expect(await readTextInput('p.md', { cwd: dir })).toBe('# Title');
    expect(await readTextInput('p.json', { cwd: dir })).toBe('json prompt');
    expect(await readTextInput('p.yaml', { cwd: dir })).toBe('yaml script');
    expect(await readTextFile('p.txt', { cwd: dir })).toBe('plain\ntext');
  });

  it('treats a missing bare file name as literal text but errors on explicit paths', async () => {
    const dir = tempHome();
    expect(await readTextInput('notes.txt', { cwd: dir })).toBe('notes.txt');
    await expect(readTextInput('./missing.txt', { cwd: dir, label: '--prompt' })).rejects.toThrow(
      /--prompt: file not found/,
    );
  });

  it('rejects empty stdin', async () => {
    const stdin = new PassThrough();
    stdin.end('   ');
    await expect(readTextInput('-', { stdin, label: '--prompt' })).rejects.toThrow(/nothing was received/);
  });

  it('parses number lists and ints', () => {
    expect(parseNumberList('1,2,4-6', '--slides')).toEqual([1, 2, 4, 5, 6]);
    expect(parseNumberList('3, 1', '--slides')).toEqual([1, 3]);
    expect(() => parseNumberList('0', '--slides')).toThrow();
    expect(() => parseNumberList('a', '--slides')).toThrow();
    expect(parsePositiveInt('5', '--limit')).toBe(5);
    expect(() => parsePositiveInt('-1', '--limit')).toThrow(/--limit/);
  });
});
