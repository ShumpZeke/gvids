import type { Argument, Command, Option } from 'commander';

/**
 * What a command does, for agents deciding whether (and how carefully) to run it.
 * - read: changes nothing (may write a local file you asked for, or a cache)
 * - write: changes a video, sharing, local settings or state; recoverable
 * - destructive: deletes or removes something (trash, delete, remove, reset)
 */
export type Effect = 'read' | 'write' | 'destructive';

/**
 * What must be available:
 * - local: nothing (config, caches, local files, background tasks)
 * - drive: an OAuth login for the Google Drive API (`gvids auth login`)
 * - browser: the signed-in gvids browser profile (`gvids browser login`)
 * - drive|browser: the Drive API when logged in, otherwise the browser
 * - oauth: Google's OAuth endpoints
 */
export type Backend = 'local' | 'drive' | 'browser' | 'drive|browser' | 'oauth';

export interface CommandMeta {
  effect: Effect;
  backend: Backend;
  /** `always`: needs --yes. `conditional`: only for some options (see note). */
  confirm?: 'always' | 'conditional';
  /** Spends Google AI generation allowance (`conditional`: only with some options). */
  aiQuota?: true | 'conditional';
  /** Often takes more than a minute; consider --detach and `gvids wait`. */
  slow?: true;
  /** Needs a person at the keyboard (sign-in, consent). Agents should ask the user to run it. */
  human?: true;
  /** Running it twice has the same effect as once. */
  idempotent?: true;
  note?: string;
}

const read = (backend: Backend, extra: Partial<CommandMeta> = {}): CommandMeta => ({
  effect: 'read',
  backend,
  idempotent: true,
  ...extra,
});
const write = (backend: Backend, extra: Partial<CommandMeta> = {}): CommandMeta => ({
  effect: 'write',
  backend,
  ...extra,
});
const destructive = (backend: Backend, extra: Partial<CommandMeta> = {}): CommandMeta => ({
  effect: 'destructive',
  backend,
  ...extra,
});

/** Metadata for every leaf command, keyed by its path ("scene add"). A unit test keeps it complete. */
export const COMMAND_META: Record<string, CommandMeta> = {
  // agent helpers
  commands: read('local'),
  guide: read('local'),
  batch: write('local', {
    note: 'Runs other gvids commands; each keeps its own effect and needs its own --yes.',
  }),
  wait: read('local', { note: 'Blocks until a background task or workflow job finishes (or --timeout).' }),
  tasks: read('local'),
  'task status': read('local'),
  'task cancel': write('local', { note: 'Stops a background task process.' }),

  // account
  'auth login': write('oauth', { human: true, note: 'Opens a browser for Google consent.' }),
  login: write('oauth', { human: true, note: 'Alias of auth login.' }),
  'auth logout': destructive('oauth', {
    confirm: 'always',
    idempotent: true,
    note: 'Revokes the Drive API login; only a person can sign in again.',
  }),
  'auth status': read('oauth'),
  'auth scopes': read('local'),
  'browser login': write('browser', { human: true, note: 'A person signs in to Google in a window.' }),
  'browser status': read('browser'),
  'browser open': write('browser', {
    idempotent: true,
    note: 'Keeps a browser running for faster commands; --headless for a hidden one. Close with browser close.',
  }),
  'browser close': write('browser', {
    idempotent: true,
    note: 'Refuses while other gvids commands use the browser, unless --force.',
  }),
  'browser reset': destructive('local', {
    confirm: 'always',
    note: 'Deletes the browser profile; a person must sign in again.',
  }),
  'browser connect': write('local', { idempotent: true }),
  'browser disconnect': write('local', { idempotent: true }),

  // files
  list: read('drive|browser', { note: 'Without OAuth: recent videos from the Vids home page.' }),
  search: read('drive|browser', { note: 'Without OAuth: the Vids home search (title matches).' }),
  info: read('drive|browser', { note: 'Without OAuth: title, scenes, duration and format from the editor.' }),
  url: read('local', { note: '--check uses the Drive API.' }),
  open: read('local', { note: 'Opens a window for a person; agents rarely need it.' }),
  rename: write('drive|browser', { idempotent: true }),
  copy: write('drive|browser', {
    note: 'Without OAuth: File > Make a copy; --folder-name picks the folder.',
  }),
  move: write('drive|browser', {
    idempotent: true,
    note: 'Without OAuth: File > Move with --folder-name (or root).',
  }),
  trash: destructive('drive|browser', {
    confirm: 'always',
    idempotent: true,
    note: 'Recoverable for 30 days with `gvids restore`.',
  }),
  restore: write('drive|browser', { idempotent: true }),
  delete: destructive('drive', { confirm: 'always', note: 'Permanent; prefer trash.' }),
  thumbnail: read('drive|browser', { note: '--scene N (or no OAuth): a PNG of that scene from the editor.' }),
  permissions: read('drive|browser', { note: 'Without OAuth: read from the share dialog (ids "ui:…").' }),
  share: write('drive|browser', {
    confirm: 'conditional',
    idempotent: true,
    note: '--anyone and --domain (public access) need --yes.',
  }),
  unshare: destructive('drive|browser', { confirm: 'always', note: "Removes someone's access." }),
  download: read('drive|browser', {
    slow: true,
    note: 'Writes an MP4 file. Without OAuth: rendered in the editor.',
  }),
  export: read('drive|browser', {
    slow: true,
    note: 'Writes an MP4/GIF file. --to-drive saves an MP4 in My Drive instead (a write).',
  }),
  'versions list': read('drive'),
  'versions name': write('browser'),
  'comments list': read('drive'),
  'comments add': write('drive'),
  'comments reply': write('drive'),
  'comments resolve': write('drive', { idempotent: true }),

  // editing
  create: write('browser', {
    slow: true,
    aiQuota: 'conditional',
    note: '--prompt (storyboard), --slides (AI narration) and --doc use Gemini.',
  }),
  'storyboard generate': write('browser', { slow: true, aiQuota: true }),
  'storyboard regenerate': write('browser', { slow: true, aiQuota: true }),
  'storyboard create-draft': write('browser', { slow: true, aiQuota: true }),
  'storyboard inspect': read('browser'),
  'scene list': read('browser'),
  'scene add': write('browser'),
  'scene duplicate': write('browser'),
  'scene delete': destructive('browser', { confirm: 'always' }),
  'scene move': write('browser'),
  'scene duration': write('browser', { idempotent: true }),
  'scene background': write('browser', { idempotent: true }),
  'scene transition': write('browser', { idempotent: true, note: 'Type none removes it.' }),
  animate: write('browser', {
    idempotent: true,
    note: 'Whole scene, or one object with --object (--loop for loops).',
  }),
  'captions styles': read('browser'),
  'captions add': write('browser', {
    note: 'Transcribes the speech (voiceover, avatar, recordings) in the video.',
  }),
  'captions remove': destructive('browser', { confirm: 'always', idempotent: true }),
  'object get': read('browser'),
  'object set': write('browser', { idempotent: true, note: 'Pixels from the top left of the scene.' }),
  format: write('browser', { idempotent: true, note: 'Without a format argument it only reads.' }),
  'text list': read('browser'),
  'text add': write('browser'),
  'text edit': write('browser', { idempotent: true }),
  'text delete': destructive('browser', { note: 'Undo in the Vids editor (version history).' }),
  'text replace': write('browser', { note: '--count only counts (read).' }),
  'media add': write('browser'),
  'media delete': destructive('browser', { note: 'Undo in the Vids editor (version history).' }),
  'media add-drive': write('drive|browser'),
  'media trim': write('browser', { idempotent: true }),
  'media sound': write('browser', { idempotent: true }),
  'media replace': write('browser'),
  'media fill': write('browser', { idempotent: true }),
  'media stock': write('browser', {
    note: 'Getty Images video/photos, Shutterstock music, stickers; inserts result --pick.',
  }),
  'media stock-search': read('browser'),
  'video add': write('browser', { note: 'Alias of media add.' }),
  'template list': read('local', { note: 'Cached list; --refresh reads it from the editor (browser).' }),
  'template search': read('local'),
  'template preview': read('local'),
  'template apply': write('browser'),
  'ai options': read('browser'),
  'ai generate': write('browser', { slow: true, aiQuota: true, note: 'About 4-5 minutes per clip.' }),
  'ai edit': write('browser', { slow: true, aiQuota: true }),
  'ai animate': write('browser', { slow: true, aiQuota: true }),
  'voiceover voices': read('browser'),
  'voiceover generate': write('browser'),
  'voiceover remove': destructive('browser', {
    idempotent: true,
    note: 'Undo in the Vids editor (version history).',
  }),
  'script get': read('browser'),
  'script set': write('browser', { idempotent: true }),
  'image generate': write('browser', { slow: true, aiQuota: true }),
  'music generate': write('browser', {
    slow: true,
    aiQuota: true,
    note: 'Stock tracks without AI: media stock --type music.',
  }),
  'avatar list': read('browser'),
  'avatar generate': write('browser', { slow: true, aiQuota: true }),
  'slides import': write('browser', {
    slow: true,
    aiQuota: 'conditional',
    note: 'AI narration unless --no-ai.',
  }),
  'docs import': write('browser', {
    slow: true,
    aiQuota: true,
    note: 'Gemini drafts the script; --script-only adds nothing (still uses Gemini).',
  }),

  // workflows
  run: write('drive|browser', {
    slow: true,
    aiQuota: 'conditional',
    confirm: 'conditional',
    note: 'Has its own --dry-run (full plan). Workflows that share publicly (anyone/domain) need --yes.',
  }),
  jobs: read('local'),
  'job status': read('local'),
  'job resume': write('drive|browser', {
    slow: true,
    confirm: 'conditional',
    note: 'Remaining public-sharing steps need --yes.',
  }),
  'job cancel': write('local', { idempotent: true }),
  mcp: read('local', { note: 'Starts the MCP server on stdio; not a one-shot command.' }),

  // diagnostics & settings
  capabilities: read('local', { note: 'Cached; --refresh probes the Drive API and the editor.' }),
  doctor: read('drive|browser'),
  version: read('local'),
  env: read('local'),
  'debug inspect': read('browser'),
  'debug screenshot': read('browser'),
  'debug page-html': read('browser'),
  'debug aria': read('browser'),
  'debug trace list': read('local'),
  'debug trace show': read('local', { human: true, note: 'Opens the Playwright trace viewer window.' }),
  'config list': read('local'),
  'config get': read('local'),
  'config set': write('local', { idempotent: true }),
  'config unset': write('local', { idempotent: true }),
  'config reset': destructive('local', { confirm: 'always' }),
  'config path': read('local'),
  completion: read('local'),
};

/** "scene add" for the `add` subcommand of `scene`. */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

export function leafCommands(root: Command): Command[] {
  const out: Command[] = [];
  const walk = (cmd: Command): void => {
    for (const sub of cmd.commands) {
      if (sub.commands.length > 0) walk(sub);
      else out.push(sub);
    }
  };
  walk(root);
  return out;
}

/** Finds the deepest command named by the leading non-option tokens (aliases allowed). */
export function findCommand(root: Command, tokens: string[]): Command | undefined {
  return resolveCommand(root, tokens).command;
}

/**
 * Like findCommand, but also reports how many leading tokens named commands and
 * whether any positional token is left after them.
 */
export function resolveCommand(
  root: Command,
  tokens: string[],
): { command: Command | undefined; consumed: number; rest: string[] } {
  let current = root;
  let found: Command | undefined;
  let consumed = 0;
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    const next = current.commands.find((c) => c.name() === token || c.aliases().includes(token));
    if (!next) break;
    current = next;
    found = next;
    consumed++;
  }
  return { command: found, consumed, rest: tokens.slice(consumed) };
}

/** A command group's own help: its summary and the commands under it. */
export function describeGroup(group: Command): Record<string, unknown> {
  return {
    command: commandPath(group),
    summary: group.description(),
    subcommands: leafCommands(group).map((c) => describeCommand(c)),
  };
}

export interface OptionInfo {
  flags: string;
  name: string;
  type: 'boolean' | 'string' | 'list';
  required?: true;
  default?: unknown;
  choices?: string[];
  description: string;
}

export interface ArgumentInfo {
  name: string;
  required: boolean;
  variadic?: true;
  choices?: string[];
  description: string;
}

export interface CommandInfo extends CommandMeta {
  command: string;
  aliases?: string[];
  summary: string;
  usage: string;
  args: ArgumentInfo[];
  options: OptionInfo[];
  examples?: string[];
}

function optionInfo(o: Option): OptionInfo {
  const info: OptionInfo = {
    flags: o.flags,
    name: o.attributeName(),
    type: o.isBoolean() ? 'boolean' : o.variadic ? 'list' : 'string',
    description: o.description,
  };
  if (o.mandatory) info.required = true;
  if (o.defaultValue !== undefined && !(o.negate && o.defaultValue === true)) info.default = o.defaultValue;
  if (o.argChoices) info.choices = [...o.argChoices];
  return info;
}

function argumentInfo(a: Argument): ArgumentInfo {
  const info: ArgumentInfo = { name: a.name(), required: a.required, description: a.description };
  if (a.variadic) info.variadic = true;
  if (a.argChoices) info.choices = [...a.argChoices];
  return info;
}

/** Examples added with `.addHelpText('after', …)` lines that start with "gvids ". */
const EXAMPLES = new WeakMap<Command, string[]>();
export function setExamples(cmd: Command, examples: string[]): Command {
  EXAMPLES.set(cmd, examples);
  return cmd;
}

export function describeCommand(cmd: Command): CommandInfo {
  const path = commandPath(cmd);
  const meta = COMMAND_META[path] ?? { effect: 'write', backend: 'browser' };
  const info: CommandInfo = {
    command: path,
    summary: cmd.description(),
    usage: `gvids ${path} ${cmd.usage()}`.trim(),
    ...meta,
    args: cmd.registeredArguments.map(argumentInfo),
    options: cmd.options.filter((o) => !o.hidden).map(optionInfo),
  };
  if (cmd.aliases().length > 0) info.aliases = cmd.aliases();
  const examples = EXAMPLES.get(cmd);
  if (examples?.length) info.examples = examples;
  return info;
}

/** One line per command: enough for an agent to pick the right one. */
export function summarizeCommand(cmd: Command): Record<string, unknown> {
  const path = commandPath(cmd);
  const meta = COMMAND_META[path] ?? { effect: 'write', backend: 'browser' };
  return {
    command: path,
    summary: cmd.description(),
    effect: meta.effect,
    backend: meta.backend,
    ...(meta.confirm ? { confirm: meta.confirm } : {}),
    ...(meta.aiQuota ? { aiQuota: meta.aiQuota } : {}),
    ...(meta.slow ? { slow: true } : {}),
    ...(meta.human ? { human: true } : {}),
  };
}

export const GLOBAL_OPTIONS_HELP = [
  'Output: one JSON envelope {"ok","data","error","warnings"?} on stdout; --pretty indents it; --human renders for people.',
  'stderr is silent unless --progress (JSON-line events) or --verbose/--debug (JSON-line logs).',
  'Destructive commands never prompt: they fail with CONFIRMATION_REQUIRED until you pass --yes.',
  '--dry-run validates and describes a command without running it.',
  '--detach runs a command in the background and returns a task id; then: gvids wait <task-id>.',
  '--timeout 10m limits long operations; --headless/--headed choose the browser window.',
];
