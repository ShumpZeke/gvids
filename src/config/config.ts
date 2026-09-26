import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '../errors/errors.js';
import { getPaths } from './paths.js';

/** The effective configuration: defaults, then the config file, then GVIDS_* environment overrides. */
export interface GvidsConfig {
  browser: {
    headless: boolean;
    timeout: number;
    channel: 'auto' | 'chrome' | 'msedge' | 'chromium';
    executablePath?: string;
    cdpEndpoint?: string;
    keepOpen: boolean;
    locale: string;
    authuser: number;
    slowMo: number;
    viewportWidth: number;
    viewportHeight: number;
  };
  output: {
    /** json: one envelope per command (agent-first default); text: human rendering. */
    format: 'json' | 'text';
    color: boolean;
  };
  downloads: { directory: string; pollIntervalMs: number; timeoutMs: number };
  auth: {
    tokenStore: 'auto' | 'keyring' | 'file';
    scopes: 'full' | 'readonly';
    clientSecretFile?: string;
  };
  ai: { timeoutMs: number };
  capabilities: { cacheTtlHours: number };
  /** directory unset: <GVIDS_HOME>/debug. Relative paths resolve against the working directory. */
  debug: { directory?: string; trace: boolean };
}

type KeyType = 'boolean' | 'number' | 'string' | 'enum';

export interface ConfigKeyInfo {
  type: KeyType;
  description: string;
  values?: readonly string[];
  env?: string;
  /** Default value (absent: the setting is optional and unset by default). */
  default?: unknown;
  /** Numbers: whole numbers only. */
  int?: true;
  /** Numbers: smallest allowed value (exclusive of 0 when `positive`). */
  min?: number;
  positive?: true;
  /** Strings: shortest allowed length (default 1). */
  minLength?: number;
}

/**
 * Every setting: type, constraints, default and env override. Drives validation,
 * `config set` coercion, `config list` and shell completion.
 */
export const CONFIG_KEYS: Record<string, ConfigKeyInfo> = {
  'browser.headless': {
    type: 'boolean',
    default: false,
    description: 'Run the automation browser without a window',
    env: 'GVIDS_HEADLESS',
  },
  'browser.timeout': {
    type: 'number',
    int: true,
    positive: true,
    default: 120_000,
    description: 'Default timeout for a single UI step (ms)',
  },
  'browser.channel': {
    type: 'enum',
    values: ['auto', 'chrome', 'msedge', 'chromium'],
    default: 'auto',
    description: 'Which installed browser to drive',
  },
  'browser.executablePath': {
    type: 'string',
    description: 'Explicit browser executable path',
    env: 'GVIDS_BROWSER_PATH',
  },
  'browser.cdpEndpoint': {
    type: 'string',
    description: 'Attach to an existing Chrome (set by `gvids browser connect`)',
    env: 'GVIDS_CDP_ENDPOINT',
  },
  'browser.keepOpen': {
    type: 'boolean',
    default: false,
    description: 'Leave the managed browser running after a command',
  },
  'browser.locale': {
    type: 'string',
    minLength: 2,
    default: 'en',
    description: 'UI language forced via hl= (automation expects en)',
  },
  'browser.authuser': {
    type: 'number',
    int: true,
    min: 0,
    default: 0,
    description: 'Google account index in the browser (authuser=N)',
  },
  'browser.slowMo': {
    type: 'number',
    int: true,
    min: 0,
    default: 0,
    description: 'Slow down each browser action by N ms (debugging)',
  },
  'browser.viewportWidth': {
    type: 'number',
    int: true,
    min: 800,
    default: 1600,
    description: 'Browser window width',
  },
  'browser.viewportHeight': {
    type: 'number',
    int: true,
    min: 600,
    default: 1000,
    description: 'Browser window height',
  },
  'output.format': {
    type: 'enum',
    values: ['json', 'text'],
    default: 'json',
    description: 'Default output: json envelopes (for agents) or human text',
    env: 'GVIDS_OUTPUT',
  },
  'output.color': { type: 'boolean', default: true, description: 'Use colors in --human output' },
  'downloads.directory': {
    type: 'string',
    default: './downloads',
    description: 'Default directory for downloads',
  },
  'downloads.pollIntervalMs': {
    type: 'number',
    int: true,
    min: 1000,
    default: 5000,
    description: 'Initial render-poll interval (ms)',
  },
  'downloads.timeoutMs': {
    type: 'number',
    int: true,
    positive: true,
    default: 30 * 60_000,
    description: 'Maximum time to wait for an MP4 render (ms)',
  },
  'auth.tokenStore': {
    type: 'enum',
    values: ['auto', 'keyring', 'file'],
    default: 'auto',
    description: 'Where OAuth tokens are stored',
    env: 'GVIDS_TOKEN_STORE',
  },
  'auth.scopes': {
    type: 'enum',
    values: ['full', 'readonly'],
    default: 'full',
    description: 'OAuth scope profile to request',
  },
  'auth.clientSecretFile': { type: 'string', description: 'Path to an OAuth client_secret.json' },
  'ai.timeoutMs': {
    type: 'number',
    int: true,
    positive: true,
    default: 15 * 60_000,
    description: 'Maximum time to wait for AI generations (ms)',
  },
  'capabilities.cacheTtlHours': {
    type: 'number',
    positive: true,
    default: 24,
    description: 'How long discovered capabilities stay cached',
  },
  'debug.directory': {
    type: 'string',
    description: 'Where diagnostics and traces are written (default: <GVIDS_HOME>/debug)',
  },
  'debug.trace': {
    type: 'boolean',
    default: false,
    description: 'Always record Playwright traces for browser commands',
  },
};

/** Why `value` is not acceptable for the setting, or undefined when it is. */
function checkValue(info: ConfigKeyInfo, value: unknown): string | undefined {
  switch (info.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `expected true or false, got ${JSON.stringify(value)}`;
    case 'enum':
      return typeof value === 'string' && info.values?.includes(value)
        ? undefined
        : `expected one of ${info.values?.join(', ')}, got ${JSON.stringify(value)}`;
    case 'string': {
      const min = info.minLength ?? 1;
      if (typeof value !== 'string') return `expected text, got ${JSON.stringify(value)}`;
      return value.length >= min ? undefined : `expected at least ${min} character(s)`;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `expected a number, got ${JSON.stringify(value)}`;
      if (info.int && !Number.isInteger(value)) return `expected a whole number, got ${value}`;
      if (info.positive && value <= 0) return `must be greater than 0, got ${value}`;
      if (info.min !== undefined && value < info.min) return `must be at least ${info.min}, got ${value}`;
      return undefined;
    }
  }
}

interface ConfigIssue {
  key: string;
  message: string;
}

/** Validates a raw configuration object and fills in defaults. Unknown keys are reported, not fatal. */
function validateConfig(raw: Record<string, unknown>): {
  config: GvidsConfig;
  issues: ConfigIssue[];
  unknown: string[];
} {
  const config: Record<string, Record<string, unknown>> = {};
  const issues: ConfigIssue[] = [];
  for (const [key, info] of Object.entries(CONFIG_KEYS)) {
    const [section, name] = key.split('.') as [string, string];
    config[section] ??= {};
    const block = raw[section];
    if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) {
      if (!issues.some((i) => i.key === section))
        issues.push({ key: section, message: 'expected an object' });
      if (info.default !== undefined) config[section]![name] = info.default;
      continue;
    }
    const value = (block as Record<string, unknown> | undefined)?.[name];
    if (value === undefined) {
      if (info.default !== undefined) config[section]![name] = info.default;
      continue;
    }
    const problem = checkValue(info, value);
    if (problem) issues.push({ key, message: problem });
    config[section]![name] = problem ? info.default : value;
  }
  const unknown: string[] = [];
  for (const [section, block] of Object.entries(raw)) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      if (!Object.keys(CONFIG_KEYS).some((k) => k.startsWith(`${section}.`))) unknown.push(section);
      continue;
    }
    for (const name of Object.keys(block)) {
      if (!CONFIG_KEYS[`${section}.${name}`]) unknown.push(`${section}.${name}`);
    }
  }
  return { config: config as unknown as GvidsConfig, issues, unknown };
}

export function coerceConfigValue(key: string, raw: string): unknown {
  const info = CONFIG_KEYS[key];
  if (!info) {
    throw new ConfigError(`Unknown configuration key: ${key}`, {
      hint: `Known keys: ${Object.keys(CONFIG_KEYS).join(', ')}`,
    });
  }
  const value = raw.trim();
  switch (info.type) {
    case 'boolean': {
      const lowered = value.toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
      if (['false', '0', 'no', 'off'].includes(lowered)) return false;
      throw new ConfigError(`${key} expects true or false, got "${raw}".`);
    }
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new ConfigError(`${key} expects a number, got "${raw}".`);
      return num;
    }
    case 'enum': {
      if (!info.values?.includes(value)) {
        throw new ConfigError(`${key} must be one of: ${info.values?.join(', ')}.`);
      }
      return value;
    }
    default:
      return value;
  }
}

function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function deletePath(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const part of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === null || typeof cur !== 'object') return false;
  const last = parts[parts.length - 1]!;
  if (!(last in (cur as Record<string, unknown>))) return false;
  delete (cur as Record<string, unknown>)[last];
  return true;
}

function formatIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => `${i.key}: ${i.message}`).join('; ');
}

/** Keys from earlier gvids versions, mapped onto their replacements when the new key is unset. */
const LEGACY_KEYS: Array<{ key: string; replacedBy: string; convert: (value: unknown) => unknown }> = [
  {
    key: 'output.json',
    replacedBy: 'output.format',
    convert: (v) => (v === true ? 'json' : v === false ? 'text' : undefined),
  },
];

function migrateLegacy(raw: Record<string, unknown>): { raw: Record<string, unknown>; notices: string[] } {
  const out = structuredClone(raw);
  const notices: string[] = [];
  for (const legacy of LEGACY_KEYS) {
    const value = getPath(out, legacy.key);
    if (value === undefined) continue;
    const converted = legacy.convert(value);
    if (getPath(out, legacy.replacedBy) === undefined && converted !== undefined) {
      setPath(out, legacy.replacedBy, converted);
    }
    deletePath(out, legacy.key);
    const effective = getPath(out, legacy.replacedBy);
    notices.push(
      effective === undefined
        ? `Config key ${legacy.key} is obsolete and ignored. Remove it by saving any setting, e.g.: gvids config reset --yes`
        : `Config key ${legacy.key} is obsolete; using ${legacy.replacedBy}=${String(effective)}. Rewrite the file with: gvids config set ${legacy.replacedBy} ${String(effective)}`,
    );
  }
  return { raw: out, notices };
}

/** Applies GVIDS_* environment overrides on top of the file configuration. */
function applyEnvOverrides(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out = structuredClone(raw);
  for (const [key, info] of Object.entries(CONFIG_KEYS)) {
    if (!info.env) continue;
    const value = env[info.env];
    if (value === undefined || value === '') continue;
    try {
      setPath(out, key, coerceConfigValue(key, value));
    } catch {
      // Ignore malformed environment overrides rather than breaking every command.
    }
  }
  return out;
}

export class ConfigStore {
  readonly file: string;
  private raw: Record<string, unknown> = {};
  private loaded = false;
  /** Non-fatal notes from loading (obsolete keys, a broken file read leniently). */
  readonly notices: string[] = [];
  /** Set when a lenient load found an unusable file; the defaults are used instead. */
  problem: ConfigError | undefined;
  /** The file could not be parsed at all: only `reset` may overwrite it. */
  private unreadable = false;

  private assertWritable(): void {
    if (this.unreadable && this.problem) throw this.problem;
  }

  constructor(
    file: string = getPaths().configFile,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = file;
  }

  /**
   * Reads the file. Invalid content throws CONFIG_ERROR, unless `lenient`: then
   * the defaults are used and `problem` is set, so `gvids config …` can repair it.
   */
  async load(options: { lenient?: boolean } = {}): Promise<GvidsConfig> {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ConfigError(`Configuration file must contain a JSON object: ${this.file}`, {
          hint: 'Fix the file by hand, or reset it: gvids config reset --yes',
        });
      }
      const migrated = migrateLegacy(parsed as Record<string, unknown>);
      this.raw = migrated.raw;
      this.notices.push(...migrated.notices);
      const unknown = validateConfig(this.raw).unknown;
      if (unknown.length > 0) {
        this.notices.push(
          `Unknown config key(s) ignored: ${unknown.join(', ')}. See: gvids config list (remove with gvids config unset <key>)`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.raw = {};
      } else {
        const problem =
          err instanceof ConfigError
            ? err
            : err instanceof SyntaxError
              ? new ConfigError(`Configuration file is not valid JSON: ${this.file}`, {
                  hint: 'Fix the file by hand, or reset it: gvids config reset --yes',
                  cause: err,
                })
              : new ConfigError(`Could not read the configuration file ${this.file}: ${String(err)}`, {
                  cause: err,
                });
        if (!options.lenient) throw problem;
        this.problem = problem;
        this.unreadable = true;
        this.raw = {};
      }
    }
    this.loaded = true;
    try {
      return this.effective();
    } catch (err) {
      if (!options.lenient || !(err instanceof ConfigError)) throw err;
      this.problem = err;
      return validateConfig(applyEnvOverrides({}, this.env)).config;
    }
  }

  /** The configuration including defaults and environment overrides (defaults after a lenient load of a bad file). */
  effective(): GvidsConfig {
    const result = validateConfig(applyEnvOverrides(this.raw, this.env));
    if (result.issues.length > 0) {
      if (this.problem) return validateConfig(applyEnvOverrides({}, this.env)).config;
      const keys = [...new Set(result.issues.map((i) => i.key))];
      throw new ConfigError(`Invalid configuration in ${this.file}: ${formatIssues(result.issues)}`, {
        hint: 'Remove the bad setting (gvids config unset <key>), or reset all settings: gvids config reset --yes',
        next: keys.filter((k) => CONFIG_KEYS[k]).map((k) => `gvids config unset ${k}`),
        details: { file: this.file, keys },
      });
    }
    return result.config;
  }

  /** Validation problems of the stored file at `key` (ignores other keys). */
  private issuesAt(raw: Record<string, unknown>, key: string): string | undefined {
    const issues = validateConfig(raw).issues.filter((i) => i.key === key || key.startsWith(`${i.key}.`));
    return issues.length > 0 ? issues.map((i) => i.message).join('; ') : undefined;
  }

  /** Keys explicitly present in the configuration file. */
  explicitKeys(): string[] {
    return Object.keys(CONFIG_KEYS).filter((k) => getPath(this.raw, k) !== undefined);
  }

  get(key: string): unknown {
    if (!CONFIG_KEYS[key]) {
      const legacy = LEGACY_KEYS.find((l) => l.key === key);
      throw new ConfigError(`Unknown configuration key: ${key}`, {
        hint: legacy
          ? `${key} was replaced by ${legacy.replacedBy}.`
          : `Known keys: ${Object.keys(CONFIG_KEYS).join(', ')}`,
        ...(legacy ? { next: [`gvids config get ${legacy.replacedBy}`] } : { next: ['gvids config list'] }),
      });
    }
    return getPath(this.effective(), key);
  }

  async set(key: string, rawValue: string): Promise<unknown> {
    if (!this.loaded) await this.load({ lenient: true });
    const value = coerceConfigValue(key, rawValue);
    await this.setValue(key, value);
    return value;
  }

  /** Programmatic setter used by commands such as `browser connect`. */
  async setValue(key: string, value: unknown): Promise<void> {
    if (!this.loaded) await this.load({ lenient: true });
    this.assertWritable();
    const next = structuredClone(this.raw);
    setPath(next, key, value);
    const problem = this.issuesAt(next, key);
    if (problem) throw new ConfigError(`Invalid value for ${key}: ${problem}`);
    this.raw = next;
    await this.save();
  }

  async unset(key: string): Promise<boolean> {
    if (!this.loaded) await this.load({ lenient: true });
    this.assertWritable();
    const next = structuredClone(this.raw);
    const removed = deletePath(next, key);
    if (removed) {
      this.raw = next;
      await this.save();
    }
    return removed;
  }

  /** Empties the file (also repairs an unreadable one). */
  async reset(): Promise<void> {
    this.raw = {};
    this.problem = undefined;
    this.unreadable = false;
    await this.save();
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.raw, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, this.file);
  }
}

export const DEFAULT_CONFIG: GvidsConfig = validateConfig({}).config;
