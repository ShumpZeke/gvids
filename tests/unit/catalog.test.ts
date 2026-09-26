import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_META,
  commandPath,
  describeCommand,
  findCommand,
  leafCommands,
} from '../../src/cli/catalog.js';
import { createProgram } from '../../src/cli/program.js';
import { createMcpServer } from '../../src/mcp/server.js';

const sink = new Writable({ write: (_c, _e, cb) => cb() });
const program = createProgram(
  {
    stdout: sink,
    stderr: sink,
    stdin: new PassThrough(),
    env: {},
    cwd: process.cwd(),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  },
  {},
  { exitCode: 0 },
);
const paths = leafCommands(program).map(commandPath);

describe('command catalog', () => {
  it('annotates every command and nothing else', () => {
    expect(paths.filter((p) => !COMMAND_META[p])).toEqual([]);
    expect(Object.keys(COMMAND_META).filter((k) => !paths.includes(k))).toEqual([]);
  });

  it('describes every command', () => {
    const undescribed = leafCommands(program)
      .filter((c) => c.description().trim().length < 10)
      .map(commandPath);
    expect(undescribed).toEqual([]);
  });

  it('guards destructive and public actions with --yes', () => {
    for (const p of [
      'trash',
      'delete',
      'scene delete',
      'unshare',
      'auth logout',
      'browser reset',
      'config reset',
    ]) {
      expect(COMMAND_META[p], p).toMatchObject({ effect: 'destructive', confirm: 'always' });
    }
    // Every other destructive command must say why it needs no --yes (undo in the editor).
    for (const [p, meta] of Object.entries(COMMAND_META)) {
      if (meta.effect === 'destructive' && meta.confirm !== 'always') expect(meta.note, p).toMatch(/Undo/);
    }
    expect(COMMAND_META.run!.confirm).toBe('conditional');
    expect(COMMAND_META.share!.confirm).toBe('conditional');
  });

  it('flags AI allowance, slow work and person-only commands', () => {
    for (const p of ['ai generate', 'ai edit', 'ai animate', 'avatar generate', 'storyboard generate']) {
      expect(COMMAND_META[p]!.aiQuota, p).toBe(true);
      expect(COMMAND_META[p]!.slow, p).toBe(true);
    }
    for (const p of ['browser login', 'auth login']) expect(COMMAND_META[p]!.human, p).toBe(true);
  });

  it('describes arguments, options and choices', () => {
    const info = describeCommand(findCommand(program, ['ai', 'generate'])!);
    expect(info.usage).toMatch(/^gvids ai generate/);
    expect(info.args).toEqual([{ name: 'id', required: true, description: 'video ID or URL' }]);
    const insert = info.options.find((o) => o.name === 'insert');
    expect(insert).toMatchObject({ type: 'string', choices: ['new-scene', 'current-scene', 'none'] });
    const image = info.options.find((o) => o.name === 'image');
    expect(image?.type).toBe('list');
    // Global options are documented once, not per command.
    expect(info.options.some((o) => o.name === 'yes')).toBe(false);
  });

  it('resolves aliases', () => {
    expect(commandPath(findCommand(program, ['ls'])!)).toBe('list');
    expect(commandPath(findCommand(program, ['scene', 'ls'])!)).toBe('scene list');
  });
});

describe('MCP tools', () => {
  const server = createMcpServer() as unknown as {
    _registeredTools: Record<string, { annotations?: Record<string, boolean> }>;
  };
  const tools = server._registeredTools;

  it('carries annotations from the catalog', () => {
    expect(tools.vids_scene_list!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.vids_trash!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.vids_rename!.annotations).toMatchObject({ idempotentHint: true, openWorldHint: true });
    expect(tools.vids_commands!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    for (const [name, tool] of Object.entries(tools)) expect(tool.annotations, name).toBeDefined();
  });

  it('offers a generic tool for any command', () => {
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['gvids', 'vids_commands', 'vids_wait']));
    expect(tools.gvids!.annotations).toMatchObject({ destructiveHint: true });
  });
});
