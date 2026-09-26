import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import path from 'node:path';
import { UsageError } from '../errors/errors.js';

type YamlModule = { parse: typeof yamlParse; stringify: typeof yamlStringify };
export const TEXT_EXTENSIONS = ['.txt', '.md', '.markdown'];
export const STRUCTURED_EXTENSIONS = ['.json', '.yaml', '.yml'];

export async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface TextInputOptions {
  stdin?: NodeJS.ReadableStream;
  cwd?: string;
  /** Field names to look for when a JSON/YAML file contains an object. */
  fields?: string[];
  /** Name used in error messages, e.g. "--prompt". */
  label?: string;
}

function looksLikePath(value: string): boolean {
  if (value.includes('\n') || value.length > 400) return false;
  const ext = path.extname(value).toLowerCase();
  if ([...TEXT_EXTENSIONS, ...STRUCTURED_EXTENSIONS].includes(ext)) return true;
  return /^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/|~[\\/])/.test(value);
}

function extractFromStructured(data: unknown, fields: string[], label: string, file: string): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const field of fields) {
      const v = (data as Record<string, unknown>)[field];
      if (typeof v === 'string') return v;
    }
  }
  throw new UsageError(
    `${label}: ${file} must contain a string or an object with one of: ${fields.join(', ')}.`,
  );
}

/**
 * Resolves a text argument that may be literal text, "-" (read stdin), or a
 * path to a .txt/.md/.json/.yaml file.
 */
export async function readTextInput(value: string, options: TextInputOptions = {}): Promise<string> {
  const label = options.label ?? 'input';
  const fields = options.fields ?? ['prompt', 'text', 'script'];
  if (value === '-') {
    const text = await readStream(options.stdin ?? process.stdin);
    if (text.trim() === '') throw new UsageError(`${label}: nothing was received on stdin.`);
    return text.replace(/\r\n/g, '\n').trimEnd();
  }
  if (looksLikePath(value)) {
    const file = path.resolve(options.cwd ?? process.cwd(), value);
    let content: string | undefined;
    try {
      content = await fs.readFile(file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A value like "notes.txt" that is not a file is treated as literal text only
      // when it does not look like an explicit path.
      if (code === 'ENOENT' && !/^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/|~[\\/])/.test(value)) {
        return value;
      }
      if (code === 'ENOENT') throw new UsageError(`${label}: file not found: ${file}`);
      throw err;
    }
    const ext = path.extname(file).toLowerCase();
    content = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
      const data = parseStructured(content, file, label);
      return extractFromStructured(data, fields, label, file).trimEnd();
    }
    return content.trimEnd();
  }
  return value;
}

/** Reads an explicit file argument (e.g. --script-file); "-" means stdin. */
export async function readTextFile(file: string, options: TextInputOptions = {}): Promise<string> {
  if (file === '-') return readTextInput('-', options);
  const resolved = path.resolve(options.cwd ?? process.cwd(), file);
  try {
    const content = await fs.readFile(resolved, 'utf8');
    const ext = path.extname(resolved).toLowerCase();
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (STRUCTURED_EXTENSIONS.includes(ext)) {
      return readTextInput(resolved, options);
    }
    return normalized.trimEnd();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`${options.label ?? 'file'}: file not found: ${resolved}`);
    }
    throw err;
  }
}

/**
 * Resolves a local input file and checks that it exists, before any browser or
 * API work starts (so a typo cannot leave a half-made video behind).
 */
export async function requireFile(file: string, cwd: string, label: string): Promise<string> {
  const resolved = path.resolve(cwd, file);
  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat) throw new UsageError(`${label}: file not found: ${resolved}`);
  if (!stat.isFile()) throw new UsageError(`${label}: not a file: ${resolved}`);
  return resolved;
}

/** Accepts "#1a2b3c" or "1a2b3c"; returns "#1a2b3c". */
export function parseHexColor(value: string, label: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new UsageError(`${label} expects a hex color like #ff8800, got "${value}".`);
  return `#${m[1]!.toLowerCase()}`;
}

/** Parses a JSON or YAML document, reporting syntax errors as usage errors. */
export function parseStructured(text: string, file: string, label: string): unknown {
  const json = path.extname(file).toLowerCase() === '.json';
  try {
    if (json) return JSON.parse(text) as unknown;
    const YAML = createRequire(import.meta.url)('yaml') as YamlModule;
    return YAML.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(
      `${label}: ${file} is not valid ${json ? 'JSON' : 'YAML'}: ${(err as Error).message}`,
    );
  }
}

/** Parses "1,2,4-6" into [1,2,4,5,6]. */
export function parseNumberList(value: string, label: string): number[] {
  const out = new Set<number>();
  for (const part of value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < a) throw new UsageError(`${label}: invalid range "${part}".`);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(part) && Number(part) >= 1) {
      out.add(Number(part));
    } else {
      throw new UsageError(`${label}: "${part}" is not a positive number or range.`);
    }
  }
  if (out.size === 0) throw new UsageError(`${label}: expected a list like 1,2,4-6.`);
  return [...out].sort((x, y) => x - y);
}

export function parsePositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new UsageError(`${label} must be a positive whole number, got "${value}".`);
  }
  return Number(value);
}
