import { PassThrough, Writable } from 'node:stream';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { COMMAND_META } from '../cli/catalog.js';
import type { RuntimeIO, ServiceOverrides } from '../cli/context.js';
import { VERSION } from '../version.js';

class MemoryStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

export interface CliInvocation {
  exitCode: number;
  envelope: { ok: boolean; data: unknown; error: unknown } | undefined;
  stderr: string;
}

/**
 * Runs a gvids command in-process with --json and captured streams. The MCP
 * server is deliberately a thin adapter over the CLI: same validation, same
 * safeguards (confirmations, refusals), same JSON envelopes.
 */
export async function invokeCli(
  args: string[],
  overrides: ServiceOverrides = {},
  stdinText = '',
): Promise<CliInvocation> {
  const { runCli } = await import('../cli/program.js');
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const stdin = new PassThrough();
  stdin.end(stdinText);
  const { GVIDS_TASK_ID: _task, ...env } = process.env;
  const io: RuntimeIO = {
    stdout,
    stderr,
    stdin,
    env: { ...env, NO_COLOR: '1' },
    cwd: process.cwd(),
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  // MCP results are always JSON envelopes: drop --human/--pretty, and put --json first so an
  // argument list containing "--" cannot turn it into a positional value.
  const cliArgs = args.filter((a) => a !== '--human' && a !== '--pretty');
  const exitCode = await runCli(['node', 'gvids', '--json', ...cliArgs], io, {
    invocation: 'mcp',
    ...overrides,
  });
  let envelope: CliInvocation['envelope'];
  try {
    envelope = JSON.parse(stdout.text()) as CliInvocation['envelope'];
  } catch {
    envelope = undefined;
  }
  return { exitCode, envelope, stderr: stderr.text() };
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function toolResult(args: string[], stdinText?: string): Promise<ToolResult> {
  return asToolResult(await invokeCli(args, {}, stdinText));
}

function asToolResult(r: CliInvocation): ToolResult {
  const payload = r.envelope ?? {
    ok: false,
    data: null,
    error: { code: 'GENERIC_ERROR', message: r.stderr.trim() || `exit code ${r.exitCode}` },
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(payload.ok ? {} : { isError: true }),
  };
}

/** The parts of the MCP request context vids_wait uses. */
export interface WaitExtra {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/** Seconds between progress notifications while vids_wait waits. */
const WAIT_SLICE_SECONDS = 15;

/**
 * vids_wait: a plain call waits once (default 45 s). With a progress token it waits in
 * slices, reporting progress between them, up to the full timeout (default 10 minutes).
 */
export async function waitWithProgress(
  taskId: string,
  timeoutSeconds: number | undefined,
  extra: WaitExtra,
  run: (args: string[]) => Promise<CliInvocation> = (args) => invokeCli(args),
): Promise<ToolResult> {
  const token = extra._meta?.progressToken;
  if (token === undefined || !extra.sendNotification) {
    return asToolResult(await run(['wait', taskId, '--timeout', `${timeoutSeconds ?? 45}s`]));
  }
  const total = timeoutSeconds ?? 600;
  const started = Date.now();
  for (;;) {
    const left = total - Math.floor((Date.now() - started) / 1000);
    const slice = Math.max(1, Math.min(WAIT_SLICE_SECONDS, left));
    const r = await run(['wait', taskId, '--timeout', `${slice}s`]);
    const stillRunning =
      (r.envelope?.error as { code?: string } | null | undefined)?.code === 'STILL_RUNNING';
    if (!stillRunning || left <= slice || extra.signal?.aborted) return asToolResult(r);
    const elapsed = Math.round((Date.now() - started) / 1000);
    await extra
      .sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: token,
          progress: elapsed,
          total,
          message: `${taskId} still running (${elapsed}s)`,
        },
      })
      .catch(() => undefined);
  }
}

const id = z.string().describe('Google Vids file ID or URL');
const scene = z.number().int().positive().describe('1-based scene number');
const opt = <T>(flag: string, value: T | undefined, fmt: (v: T) => string = String): string[] =>
  value === undefined || value === null || value === false
    ? []
    : value === true
      ? [flag]
      : [flag, fmt(value)];

/** The CLI command behind each curated tool (for annotations from the command catalog). */
const TOOL_COMMANDS: Record<string, string> = {
  vids_list: 'list',
  vids_search: 'search',
  vids_get: 'info',
  vids_open: 'url',
  vids_create: 'create',
  vids_storyboard_generate: 'storyboard generate',
  vids_scene_list: 'scene list',
  vids_scene_add: 'scene add',
  vids_scene_delete: 'scene delete',
  vids_scene_duration: 'scene duration',
  vids_text_add: 'text add',
  vids_media_add: 'media add',
  vids_template_apply: 'template apply',
  vids_slides_import: 'slides import',
  vids_docs_import: 'docs import',
  vids_ai_generate: 'ai generate',
  vids_ai_edit: 'ai edit',
  vids_voiceover_generate: 'voiceover generate',
  vids_share: 'share',
  vids_permissions: 'permissions',
  vids_download: 'download',
  vids_export: 'export',
  vids_rename: 'rename',
  vids_trash: 'trash',
  vids_restore: 'restore',
  vids_capabilities: 'capabilities',
  vids_run_workflow: 'run',
  vids_job_status: 'job status',
  vids_wait: 'wait',
  vids_commands: 'commands',
};

function annotationsFor(name: string): Record<string, unknown> {
  const meta = COMMAND_META[TOOL_COMMANDS[name] ?? ''];
  if (!meta)
    return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  return {
    readOnlyHint: meta.effect === 'read',
    destructiveHint: meta.effect === 'destructive',
    idempotentHint: Boolean(meta.idempotent),
    openWorldHint: meta.backend !== 'local',
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'gvids', version: VERSION });
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    cb: unknown,
  ) => RegisteredTool;
  /** registerTool with annotations (read-only, destructive, idempotent, open-world) from the catalog. */
  const tool = ((name: string, config: Record<string, unknown>, cb: unknown) =>
    register(
      name,
      { ...config, annotations: annotationsFor(name) },
      cb,
    )) as unknown as McpServer['registerTool'];

  tool(
    'gvids',
    {
      title: 'Run any gvids command',
      description:
        'Runs one gvids command and returns its JSON envelope {ok,data,error,warnings?}. `args` are the words after "gvids", e.g. ["scene","list","<video-id>"]. Discover commands with vids_commands. Destructive or public actions need "--yes" in args: add it only after the user approved. Commands that take more than a minute (AI generation, exports, storyboards) should get "--detach"; then poll with vids_wait. Relative paths resolve against the MCP server\'s working directory.',
      inputSchema: {
        args: z.array(z.string()).min(1).describe('arguments after "gvids"'),
        stdin: z.string().optional().describe('text passed on stdin (for arguments given as "-")'),
      },
    },
    async (a) => toolResult(a.args, a.stdin),
  );

  tool(
    'vids_commands',
    {
      title: 'List gvids commands',
      description:
        'Every gvids command with its effect (read/write/destructive), backend (local/drive/browser), and whether it needs --yes, uses AI allowance, is slow or needs a person. full=true adds arguments and options.',
      inputSchema: {
        prefix: z
          .array(z.string())
          .optional()
          .describe('only commands starting with these words, e.g. ["scene"]'),
        full: z.boolean().optional(),
      },
    },
    async (a) => toolResult(['commands', ...(a.prefix ?? []), ...opt('--full', a.full)]),
  );

  tool(
    'vids_wait',
    {
      title: 'Wait for a background task',
      description:
        "Waits for a task started with --detach (task_…) or a workflow job (job_…) and returns the finished command's envelope. On timeout returns error STILL_RUNNING (retryable): call again. Without a progress token the wait is 45 s by default (below common MCP client request timeouts). When the request carries a progress token, gvids sends a progress notification every 15 s and waits up to timeoutSeconds (default 600), so clients that reset their timeout on progress can wait for a whole AI generation in one call.",
      inputSchema: {
        id: z.string(),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(3600)
          .optional()
          .describe('default 45, or 600 when the client sends a progress token'),
      },
    },
    async (a: { id: string; timeoutSeconds?: number }, extra: WaitExtra) =>
      waitWithProgress(a.id, a.timeoutSeconds, extra),
  );

  tool(
    'vids_list',
    {
      title: 'List Google Vids',
      description: 'List Google Vids files in Drive (newest first).',
      inputSchema: {
        limit: z.number().int().positive().max(1000).optional(),
        folder: z.string().optional(),
        sharedWithMe: z.boolean().optional(),
      },
    },
    async (a) =>
      toolResult([
        'list',
        ...opt('--limit', a.limit),
        ...opt('--folder', a.folder),
        ...opt('--shared-with-me', a.sharedWithMe),
      ]),
  );

  tool(
    'vids_search',
    {
      title: 'Search Google Vids',
      description: 'Search Google Vids by title (or full text), modification date and owner.',
      inputSchema: {
        text: z.string().optional(),
        fullText: z.boolean().optional(),
        modifiedAfter: z.string().optional().describe('YYYY-MM-DD'),
        owner: z.string().optional().describe('"me" or an e-mail address'),
        limit: z.number().int().positive().optional(),
      },
    },
    async (a) =>
      toolResult([
        'search',
        ...(a.text ? [a.text] : []),
        ...opt('--full-text', a.fullText),
        ...opt('--modified-after', a.modifiedAfter),
        ...opt('--owner', a.owner),
        ...opt('--limit', a.limit),
      ]),
  );

  tool(
    'vids_get',
    { title: 'Get video metadata', description: 'Drive metadata for one video.', inputSchema: { id } },
    async (a) => toolResult(['info', a.id]),
  );

  tool(
    'vids_open',
    {
      title: 'Get editor URL',
      description: 'Return the editor URL of a video (does not open a window).',
      inputSchema: { id },
    },
    async (a) => toolResult(['url', a.id]),
  );

  tool(
    'vids_create',
    {
      title: 'Create a video',
      description:
        'Create a new Google Vids video: blank, from a template, or as an AI storyboard draft from a prompt. Uses the signed-in gvids browser.',
      inputSchema: {
        title: z.string().optional(),
        prompt: z.string().optional().describe('AI storyboard prompt (Gemini "Help me create")'),
        template: z.string().optional(),
        format: z.enum(['landscape', 'portrait', 'square']).optional(),
      },
    },
    async (a) =>
      toolResult(
        [
          'create',
          ...(a.title ? [a.title] : []),
          ...(a.prompt ? ['--prompt', '-'] : []),
          ...opt('--template', a.template),
          ...opt('--format', a.format),
        ],
        a.prompt,
      ),
  );

  tool(
    'vids_storyboard_generate',
    {
      title: 'Generate storyboard',
      description: 'Generate an AI storyboard draft (outline → design → scenes) inside an existing video.',
      inputSchema: {
        id,
        prompt: z.string(),
        design: z.number().int().positive().optional(),
        outlineOnly: z.boolean().optional(),
      },
    },
    async (a) =>
      toolResult(
        [
          'storyboard',
          'generate',
          a.id,
          '--prompt',
          '-',
          ...opt('--design', a.design),
          ...opt('--outline-only', a.outlineOnly),
        ],
        a.prompt,
      ),
  );

  tool(
    'vids_scene_list',
    {
      title: 'List scenes',
      description: 'Scenes with duration, transition, text and narration clips.',
      inputSchema: { id },
    },
    async (a) => toolResult(['scene', 'list', a.id]),
  );

  tool(
    'vids_scene_add',
    {
      title: 'Add scene',
      description: 'Add a blank scene at the end or after a scene.',
      inputSchema: { id, after: scene.optional() },
    },
    async (a) => toolResult(['scene', 'add', a.id, ...opt('--after', a.after)]),
  );

  tool(
    'vids_scene_delete',
    {
      title: 'Delete scene',
      description: 'Delete a scene. Requires confirm=true.',
      inputSchema: { id, scene, confirm: z.boolean().describe('must be true to delete') },
    },
    async (a) => toolResult(['scene', 'delete', a.id, String(a.scene), ...(a.confirm ? ['--yes'] : [])]),
  );

  tool(
    'vids_text_add',
    {
      title: 'Add text',
      description: 'Add a text box to a scene.',
      inputSchema: { id, scene, text: z.string(), kind: z.enum(['title', 'subtitle', 'body']).optional() },
    },
    async (a) =>
      toolResult(
        ['text', 'add', a.id, '--scene', String(a.scene), '--text', '-', ...opt('--kind', a.kind)],
        a.text,
      ),
  );

  tool(
    'vids_media_add',
    {
      title: 'Insert media',
      description: 'Upload a local image/video/audio file (path on this machine) into a scene.',
      inputSchema: { id, file: z.string(), scene: scene.optional() },
    },
    async (a) => toolResult(['media', 'add', a.id, a.file, ...opt('--scene', a.scene)]),
  );

  tool(
    'vids_ai_generate',
    {
      title: 'AI video clip',
      description: 'Generate an AI video clip (Vids Omni/Veo). Uses the account’s generation quota.',
      inputSchema: {
        id,
        prompt: z.string(),
        scene: scene.optional(),
        images: z.array(z.string()).optional(),
        aspect: z.string().optional(),
        model: z.string().optional(),
        insert: z
          .enum(['new-scene', 'current-scene', 'none'])
          .optional()
          .describe('default: current-scene when scene is given, else new-scene'),
      },
    },
    async (a) =>
      toolResult(
        [
          'ai',
          'generate',
          a.id,
          '--prompt',
          '-',
          ...opt('--scene', a.scene),
          ...(a.images?.length ? ['--image', ...a.images] : []),
          ...opt('--aspect', a.aspect),
          ...opt('--model', a.model),
          ...opt('--insert', a.insert),
        ],
        a.prompt,
      ),
  );

  tool(
    'vids_ai_edit',
    {
      title: 'AI video edit',
      description: 'Transform a local clip (≤10s) with a prompt. Uses the account’s generation quota.',
      inputSchema: { id, clip: z.string(), prompt: z.string(), scene: scene.optional() },
    },
    async (a) =>
      toolResult(['ai', 'edit', a.id, a.clip, '--prompt', '-', ...opt('--scene', a.scene)], a.prompt),
  );

  tool(
    'vids_voiceover_generate',
    {
      title: 'Voiceover',
      description: 'Generate AI narration for a scene.',
      inputSchema: { id, scene, script: z.string(), voice: z.string().optional() },
    },
    async (a) =>
      toolResult(
        [
          'voiceover',
          'generate',
          a.id,
          '--scene',
          String(a.scene),
          '--script',
          '-',
          ...opt('--voice', a.voice),
        ],
        a.script,
      ),
  );

  tool(
    'vids_share',
    {
      title: 'Share',
      description:
        'Share a video with a person (reader/commenter/writer). Public sharing needs confirm=true.',
      inputSchema: {
        id,
        email: z.string().optional(),
        anyone: z.boolean().optional(),
        role: z.enum(['reader', 'commenter', 'writer']).default('reader'),
        notify: z.boolean().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (a) =>
      toolResult([
        'share',
        a.id,
        ...(a.email ? [a.email] : []),
        ...(a.anyone ? ['--anyone', a.role] : ['--role', a.role]),
        ...(a.notify === false ? ['--no-notify'] : []),
        ...(a.confirm ? ['--yes'] : []),
      ]),
  );

  tool(
    'vids_permissions',
    { title: 'Permissions', description: 'Who can access a video.', inputSchema: { id } },
    async (a) => toolResult(['permissions', a.id]),
  );

  tool(
    'vids_download',
    {
      title: 'Download MP4',
      description:
        'Render and download the video as MP4 to a local path (Drive API; the editor without an OAuth login).',
      inputSchema: { id, output: z.string().optional(), overwrite: z.boolean().optional() },
    },
    async (a) =>
      toolResult(['download', a.id, ...(a.output ? [a.output] : []), ...opt('--overwrite', a.overwrite)]),
  );

  tool(
    'vids_export',
    {
      title: 'Export MP4/GIF',
      description:
        'Export a video to a local file. MP4 uses the Drive API when logged in, otherwise the editor; GIF always uses the editor (Vids only allows GIFs for videos of 30 s or less).',
      inputSchema: {
        id,
        output: z.string().optional(),
        format: z.enum(['mp4', 'gif']).default('mp4'),
        overwrite: z.boolean().optional(),
      },
    },
    async (a) =>
      toolResult([
        'export',
        a.id,
        ...(a.output ? [a.output] : []),
        '--format',
        a.format,
        ...opt('--overwrite', a.overwrite),
      ]),
  );

  tool(
    'vids_rename',
    {
      title: 'Rename',
      description: 'Rename a video (Drive API, or the editor without an OAuth login).',
      inputSchema: { id, name: z.string().min(1) },
    },
    async (a) => toolResult(['rename', a.id, a.name]),
  );

  tool(
    'vids_trash',
    {
      title: 'Move to trash',
      description:
        'Move a video to the trash (recoverable for 30 days with vids_restore). Requires confirm=true.',
      inputSchema: { id, confirm: z.boolean().optional() },
    },
    async (a) => toolResult(['trash', a.id, ...(a.confirm ? ['--yes'] : [])]),
  );

  tool(
    'vids_restore',
    { title: 'Restore from trash', description: 'Take a video out of the trash.', inputSchema: { id } },
    async (a) => toolResult(['restore', a.id]),
  );

  tool(
    'vids_template_apply',
    {
      title: 'Insert template scenes',
      description: 'Insert scenes from a Vids template (name or slug from `gvids template list`).',
      inputSchema: {
        id,
        template: z.string(),
        after: scene.optional().describe('insert after this scene (default: at the end)'),
        scenes: z.array(z.number().int().positive()).optional().describe('template scene numbers'),
      },
    },
    async (a) =>
      toolResult([
        'template',
        'apply',
        a.id,
        a.template,
        ...opt('--after', a.after),
        ...opt('--scenes', a.scenes, (v) => v.join(',')),
      ]),
  );

  tool(
    'vids_slides_import',
    {
      title: 'Import Google Slides',
      description:
        'Append a Google Slides presentation to a (landscape) video. ai=false imports plain slides; by default Gemini adds a script, voiceover, music and animation.',
      inputSchema: {
        id,
        presentation: z.string().describe('presentation ID or URL'),
        slides: z.array(z.number().int().positive()).optional(),
        ai: z.boolean().optional(),
        narration: z.enum(['voiceover', 'avatar']).optional(),
      },
    },
    async (a) =>
      toolResult([
        'slides',
        'import',
        a.id,
        a.presentation,
        ...opt('--slides', a.slides, (v) => v.join(',')),
        ...(a.ai === false ? ['--no-ai'] : []),
        ...opt('--narration', a.narration),
      ]),
  );

  tool(
    'vids_docs_import',
    {
      title: 'Google Doc to video',
      description:
        'Turn a Google Doc into scenes with AI voiceover (File > Docs to video). Gemini drafts one narration script per scene; scriptOnly returns the draft and adds nothing; script replaces drafted scene scripts in order (at most one per drafted scene).',
      inputSchema: {
        id,
        document: z.string().describe('Google Doc ID or URL'),
        voice: z.string().optional().describe('AI voiceover voice, e.g. Kaci (see vids_voiceover_voices)'),
        script: z.array(z.string().min(1).max(800)).optional(),
        scriptOnly: z.boolean().optional(),
      },
    },
    async (a) =>
      toolResult(
        [
          'docs',
          'import',
          a.id,
          a.document,
          ...opt('--voice', a.voice),
          ...(a.script ? ['--script-file', '-'] : []),
          ...opt('--script-only', a.scriptOnly),
        ],
        a.script?.map((part) => part.replace(/\s+/g, ' ').trim()).join('\n\n'),
      ),
  );

  tool(
    'vids_scene_duration',
    {
      title: 'Scene duration',
      description: 'Set a scene’s length in seconds (0.1 s steps).',
      inputSchema: { id, scene, seconds: z.number().positive() },
    },
    async (a) => toolResult(['scene', 'duration', a.id, String(a.scene), '--seconds', String(a.seconds)]),
  );

  tool(
    'vids_capabilities',
    {
      title: 'Capabilities',
      description: 'What this account can do (Drive API + Vids UI).',
      inputSchema: { refresh: z.boolean().optional() },
    },
    async (a) => toolResult(['capabilities', ...opt('--refresh', a.refresh)]),
  );

  tool(
    'vids_run_workflow',
    {
      title: 'Run workflow',
      description:
        'Run a YAML/JSON workflow file as a resumable job. dryRun=true returns the plan. Workflows that share publicly (anyone/domain) need confirm=true after the user approved. Long workflows: use the gvids tool with ["run", file, "--detach"] and vids_wait.',
      inputSchema: {
        file: z.string(),
        dryRun: z.boolean().optional(),
        confirm: z.boolean().optional().describe('approve public sharing steps (after the user agreed)'),
      },
    },
    async (a) => toolResult(['run', a.file, ...opt('--dry-run', a.dryRun), ...(a.confirm ? ['--yes'] : [])]),
  );

  tool(
    'vids_job_status',
    { title: 'Job status', description: 'Status of a workflow job.', inputSchema: { jobId: z.string() } },
    async (a) => toolResult(['job', 'status', a.jobId]),
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}
