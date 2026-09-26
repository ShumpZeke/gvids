import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import type { StoryboardResult } from '../../browser/operations/automation.js';
import { UsageError } from '../../errors/errors.js';
import {
  parsePositiveInt,
  parseStructured,
  readTextFile,
  readTextInput,
  requireFile,
} from '../../utils/input.js';
import { parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';

/** Outline files: JSON/YAML array (or { outline: [...] }), or text with one topic per line. */
export async function readOutlineFile(file: string, cwd: string): Promise<string[]> {
  const resolved = path.resolve(cwd, file);
  let text: string;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    throw new UsageError(`Outline file not found: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  let data: unknown;
  if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
    data = parseStructured(text, resolved, '--outline-file');
  } else {
    return text
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  }
  const list = Array.isArray(data) ? data : (data as { outline?: unknown })?.outline;
  if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
    throw new UsageError(`${resolved} must contain a list of scene topics.`);
  }
  return list as string[];
}

export interface PromptFlags {
  prompt?: string;
  promptFile?: string;
}

export async function resolvePrompt(
  ctx: CommandContext,
  flags: PromptFlags,
  required: boolean,
): Promise<string | undefined> {
  if (flags.prompt && flags.promptFile)
    throw new UsageError('Use either --prompt or --prompt-file, not both.');
  if (flags.promptFile)
    return readTextFile(flags.promptFile, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--prompt-file' });
  if (flags.prompt)
    return readTextInput(flags.prompt, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--prompt' });
  if (required)
    throw new UsageError('A prompt is required: --prompt "…", --prompt-file file.md, or --prompt - (stdin).');
  return undefined;
}

export function renderStoryboard(r: StoryboardResult & { id: string }): string {
  const lines = ['Outline:', ...r.outline.map((t, i) => `  ${String(i + 1).padStart(2)}. ${t}`)];
  if (r.created) {
    lines.push('', `Draft created with design ${r.design}: ${r.scenesBefore} → ${r.scenesAfter} scenes.`);
    lines.push(`https://docs.google.com/videos/d/${r.id}/edit`);
  } else {
    lines.push('', 'Outline only — no draft was created.');
  }
  return lines.join('\n');
}

interface GenerateFlags extends PromptFlags {
  design?: string;
  outlineFile?: string;
  contextDriveFile?: string[];
  ref?: string[];
  outlineOnly?: boolean;
}

/**
 * --ref: uploads local reference images/videos to Drive (Drive API) and returns
 * their Drive names, which the storyboard @-mentions like --context-drive-file.
 */
export async function uploadRefs(ctx: CommandContext, refs: string[] | undefined): Promise<string[]> {
  if (!refs?.length) return [];
  const files = [];
  for (const f of refs) files.push(await requireFile(f, ctx.io.cwd, '--ref'));
  const drive = await ctx.drive();
  const names: string[] = [];
  for (const f of files) {
    const up = await drive.uploadReference(f);
    ctx.out.warn(`Uploaded reference ${f} to Drive as "${up.name}".`);
    names.push(up.name);
  }
  return names;
}

function storyboardOptions(
  ctx: CommandContext,
  prompt: string,
  flags: GenerateFlags,
  outline?: string[],
  refNames: string[] = [],
) {
  const contextFiles = [...(flags.contextDriveFile ?? []), ...refNames];
  return {
    prompt,
    timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
    ...(flags.design ? { design: parsePositiveInt(flags.design, '--design') } : {}),
    ...(outline ? { outline } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    ...(flags.outlineOnly ? { outlineOnly: true } : {}),
  };
}

function addGenerateFlags(cmd: Command): Command {
  return cmd
    .option('-p, --prompt <text|file|->', 'what the video is about (text, a .txt/.md file, or - for stdin)')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .option('--design <n>', 'which of the offered designs to use (1-based)', '1')
    .option(
      '--outline-file <file>',
      'replace Gemini’s outline with your own topics (JSON/YAML list or one per line)',
    )
    .option('--context-drive-file <name...>', 'Drive files to @-mention as context (experimental)')
    .option(
      '--ref <file...>',
      'local reference images/videos: uploaded to Drive, then @-mentioned (Drive API)',
    )
    .option('--outline-only', 'stop after the outline and print it (no draft is created)');
}

export function registerStoryboardCommands(program: Command, kit: Kit): void {
  const sb = program
    .command('storyboard')
    .description('Gemini storyboard ("Help me create"): prompt → outline → draft video (browser)');

  addGenerateFlags(
    sb
      .command('generate')
      .description('Generate an AI storyboard draft in a new, still-unedited video')
      .argument('<id>', 'video ID or URL (Vids only offers the storyboard before a video is edited)')
      .addHelpText(
        'after',
        '\nExamples:\n  gvids storyboard generate <id> --prompt "Explain the quarterly results to executives"\n  cat prompt.md | gvids storyboard generate <id> --prompt -\n  gvids storyboard generate <id> --prompt-file prompt.md --outline-file outline.txt --design 3',
      ),
  ).action(
    action(kit, async (ctx, idArg: string, flags: GenerateFlags) => {
      const id = parseVidId(idArg);
      const prompt = (await resolvePrompt(ctx, flags, true))!;
      const outline = flags.outlineFile ? await readOutlineFile(flags.outlineFile, ctx.io.cwd) : undefined;
      const options = storyboardOptions(ctx, prompt, flags, outline, await uploadRefs(ctx, flags.ref));
      const result = await withAutomation(ctx, 'Generating storyboard', (auto) =>
        auto.storyboard(id, options),
      );
      ctx.out.result({ id, ...result }, renderStoryboard);
    }),
  );

  addGenerateFlags(
    sb
      .command('regenerate')
      .description('Like generate, but asks Gemini for a different outline first ("Try again")')
      .argument('<id>', 'video ID or URL (must still be a new, unedited video)')
      .option('--attempts <n>', 'how many times to request a new outline', '1'),
  ).action(
    action(kit, async (ctx, idArg: string, flags: GenerateFlags & { attempts: string }) => {
      const id = parseVidId(idArg);
      const prompt = (await resolvePrompt(ctx, flags, true))!;
      const outline = flags.outlineFile ? await readOutlineFile(flags.outlineFile, ctx.io.cwd) : undefined;
      const options = {
        ...storyboardOptions(ctx, prompt, flags, outline, await uploadRefs(ctx, flags.ref)),
        retryOutline: parsePositiveInt(flags.attempts, '--attempts'),
      };
      const result = await withAutomation(ctx, 'Regenerating storyboard', (auto) =>
        auto.storyboard(id, options),
      );
      ctx.out.result({ id, ...result }, renderStoryboard);
    }),
  );

  sb.command('create-draft')
    .description('Create a draft from your own outline (prompt + --outline-file)')
    .argument('<id>', 'video ID or URL')
    .option('-p, --prompt <text|file|->', 'what the video is about')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .requiredOption('--outline-file <file>', 'scene topics (JSON/YAML list or one per line)')
    .option('--design <n>', 'design to use (1-based)', '1')
    .action(
      action(kit, async (ctx, idArg: string, flags: GenerateFlags) => {
        const id = parseVidId(idArg);
        const prompt = (await resolvePrompt(ctx, flags, true))!;
        const outline = await readOutlineFile(flags.outlineFile!, ctx.io.cwd);
        const options = storyboardOptions(ctx, prompt, flags, outline);
        const result = await withAutomation(ctx, 'Creating draft', (auto) => auto.storyboard(id, options));
        ctx.out.result({ id, ...result }, renderStoryboard);
      }),
    );

  sb.command('inspect')
    .description('Show the storyboard: scenes, on-screen text, durations and scripts')
    .argument('<id>', 'video ID or URL')
    .option('--no-scripts', 'skip reading per-scene scripts (faster)')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scripts: boolean }) => {
        const id = parseVidId(idArg);
        const data = await withAutomation(ctx, 'Reading storyboard', async (auto) => {
          const scenes = await auto.scenes(id);
          const scripts = flags.scripts ? await auto.getScripts(id) : [];
          return scenes.map((s) => ({
            ...s,
            script: scripts.find((x) => x.scene === s.index)?.script ?? null,
          }));
        });
        ctx.out.result({ id, scenes: data }, (d) =>
          d.scenes
            .map((s) =>
              [
                `Scene ${s.index}${s.durationSeconds !== undefined ? ` (${s.durationSeconds}s)` : ''}${s.transitionIn ? ` ← ${s.transitionIn}` : ''}`,
                s.text ? `  text:   ${s.text}` : undefined,
                s.script ? `  script: ${s.script}` : undefined,
                ...s.clips.map((c) => `  clip:   ${c.speaker ?? c.kind}: ${c.title ?? c.label}`),
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n'),
        );
      }),
    );
}
