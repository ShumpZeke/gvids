import fs from 'node:fs/promises';
import { Option, type Command } from 'commander';
import { DOCS_LABELS } from '../../browser/selectors/docs.js';
import { AuthError, FeatureUnavailableError, UsageError } from '../../errors/errors.js';
import {
  parseNumberList,
  parsePositiveInt,
  parseStructured,
  readTextFile,
  readTextInput,
  requireFile,
} from '../../utils/input.js';
import { formatDuration } from '../../utils/time.js';
import { parseDocumentId, parsePresentationId, parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { fallbackWarning } from '../fallback.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { formatBytes, renderTable } from '../output/format.js';
import { downloadMp4, downloadViaEditor, gifViaLocalConversion } from './download.js';
import { numberIn } from './design.js';
import {
  IMAGE_ASPECTS,
  IMAGE_STYLES,
  type ImageAspect,
  type ImageStyle,
} from '../../browser/pages/generate.js';

async function scriptFrom(
  ctx: CommandContext,
  flags: { script?: string; scriptFile?: string },
): Promise<string> {
  if (flags.script && flags.scriptFile) throw new UsageError('Use either --script or --script-file.');
  if (flags.scriptFile)
    return readTextFile(flags.scriptFile, {
      cwd: ctx.io.cwd,
      stdin: ctx.io.stdin,
      label: '--script-file',
      fields: ['script', 'text'],
    });
  if (flags.script)
    return readTextInput(flags.script, {
      cwd: ctx.io.cwd,
      stdin: ctx.io.stdin,
      label: '--script',
      fields: ['script', 'text'],
    });
  throw new UsageError(
    'A script is required: --script "…", --script-file narration.txt, or --script - (stdin).',
  );
}

/**
 * Docs to video --script-file: a JSON/YAML list of strings (or { script: [...] }),
 * or plain text with one paragraph per scene (blank lines between scenes).
 */
export async function readSceneScripts(ctx: CommandContext, file: string): Promise<string[]> {
  let parts: string[];
  if (/\.(json|ya?ml)$/i.test(file)) {
    const resolved = await requireFile(file, ctx.io.cwd, '--script-file');
    const data = parseStructured(
      (await fs.readFile(resolved, 'utf8')).replace(/^\uFEFF/, ''),
      resolved,
      '--script-file',
    );
    const list = Array.isArray(data)
      ? data
      : ((data as { script?: unknown; scenes?: unknown } | null)?.script ??
        (data as { scenes?: unknown } | null)?.scenes);
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string'))
      throw new UsageError(`--script-file: ${resolved} must hold a list of scene scripts (strings).`);
    parts = list.map((v) => v.trim());
  } else {
    const text = await readTextFile(file, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--script-file' });
    parts = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  }
  parts = parts.filter(Boolean);
  if (parts.length === 0) throw new UsageError('--script-file holds no scene scripts.');
  const long = parts.findIndex((p) => p.length > DOCS_LABELS.maxSceneChars);
  if (long >= 0)
    throw new UsageError(
      `--script-file: scene ${long + 1} has ${parts[long]!.length} characters; Vids allows ${DOCS_LABELS.maxSceneChars} per scene.`,
    );
  return parts;
}

function aspectName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === 'landscape' || v === '16:9') return 'Landscape';
  if (v === 'portrait' || v === '9:16') return 'Portrait';
  if (v === 'square' || v === '1:1') return 'Square';
  return value;
}

interface AiFlags {
  prompt?: string;
  promptFile?: string;
  image?: string[];
  model?: string;
  aspect?: string;
  scene?: string;
  insert?: 'new-scene' | 'current-scene' | 'none';
}

async function promptFrom(ctx: CommandContext, flags: AiFlags): Promise<string> {
  if (flags.promptFile)
    return readTextFile(flags.promptFile, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--prompt-file' });
  if (flags.prompt)
    return readTextInput(flags.prompt, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--prompt' });
  throw new UsageError('A prompt is required: --prompt "…" (or a .txt/.md file, or - for stdin).');
}

/** Reference images, checked before the browser starts. */
async function imagesFrom(ctx: CommandContext, flags: AiFlags): Promise<string[]> {
  const out: string[] = [];
  for (const f of flags.image ?? []) out.push(await requireFile(f, ctx.io.cwd, '--image'));
  return out;
}

function addAiFlags(cmd: Command): Command {
  return cmd
    .option('-p, --prompt <text|file|->', 'what to generate (text, file, or - for stdin)')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .option('--model <name>', 'model as shown in Vids (see: gvids ai options <id>)')
    .option('--aspect <landscape|portrait|16:9|9:16>', 'aspect ratio')
    .option('--scene <n>', 'select this scene first (the clip is added there)')
    .addOption(
      new Option(
        '--insert <target>',
        'where the finished clip goes (default: current-scene with --scene, else new-scene)',
      ).choices(['new-scene', 'current-scene', 'none']),
    );
}

function insertedText(r: { inserted: boolean; insert: string }): string {
  if (!r.inserted) return 'generated; not inserted (it is in the AI video gallery of the side sheet)';
  return r.insert === 'current-scene' ? 'inserted into the scene' : 'inserted in a new scene';
}

export function registerAiCommands(program: Command, kit: Kit): void {
  // ------------------------------------------------------------------- ai
  const ai = program.command('ai').description('AI video generation and editing (Omni/Veo in Vids; browser)');

  ai.command('options')
    .description('Show the AI video models and aspect ratios this account is offered')
    .argument('<id>', 'video ID or URL (the AI panel is opened there)')
    .addOption(
      new Option('--mode <mode>', 'panel tab').choices(['create', 'edit', 'animate']).default('create'),
    )
    .action(
      action(kit, async (ctx, idArg: string, flags: { mode: 'create' | 'edit' | 'animate' }) => {
        const id = parseVidId(idArg);
        const r = await withAutomation(ctx, 'Reading AI options', (auto) => auto.aiOptions(id, flags.mode));
        ctx.out.result({ id, mode: flags.mode, ...r }, (d) =>
          [
            `Models:  ${d.models.join(', ') || '(none)'}${d.model ? `   (selected: ${d.model})` : ''}`,
            `Aspects: ${d.aspects.join(', ') || '(none)'}${d.aspect ? `   (selected: ${d.aspect})` : ''}`,
          ].join('\n'),
        );
      }),
    );

  addAiFlags(
    ai
      .command('generate')
      .description('Generate an AI video clip from text (and optional reference images)')
      .argument('<id>', 'video ID or URL')
      .option('--image <file...>', 'reference images ("ingredients")')
      .addHelpText(
        'after',
        '\nUses your Vids AI generation quota. Examples:\n  gvids ai generate <id> --prompt "Cinematic aerial view of New York at night"\n  gvids ai generate <id> --prompt prompt.txt --image person.png --image logo.png --aspect portrait',
      ),
  ).action(
    action(kit, async (ctx, idArg: string, flags: AiFlags) => {
      const id = parseVidId(idArg);
      const prompt = await promptFrom(ctx, flags);
      const aspect = aspectName(flags.aspect);
      const images = await imagesFrom(ctx, flags);
      const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
      const started = Date.now();
      const r = await withAutomation(ctx, 'Generating AI video (this can take a few minutes)', (auto) =>
        auto.aiGenerate(id, {
          mode: 'create',
          prompt,
          timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
          ...(images.length ? { images } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(aspect ? { aspect } : {}),
          ...(scene ? { scene } : {}),
          ...(flags.insert ? { insert: flags.insert } : {}),
        }),
      );
      ctx.out.result(
        { id, elapsedMs: Date.now() - started, ...r },
        (d) =>
          `AI clip ${insertedText(d)}${d.clip ? `: ${d.clip.label}` : d.object ? ` as object ${d.object.id}` : ''} (${formatDuration(d.elapsedMs)}).`,
      );
    }),
  );

  addAiFlags(
    ai
      .command('edit')
      .description('Transform a video clip (10s or less) with a prompt')
      .argument('<id>', 'video ID or URL')
      .argument('<clip>', 'local video file to edit')
      .option('--image <file...>', 'reference image(s) (ingredients, where supported)'),
  ).action(
    action(kit, async (ctx, idArg: string, clip: string, flags: AiFlags) => {
      const id = parseVidId(idArg);
      const prompt = await promptFrom(ctx, flags);
      const aspect = aspectName(flags.aspect);
      const source = await requireFile(clip, ctx.io.cwd, 'clip');
      const images = await imagesFrom(ctx, flags);
      const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
      const started = Date.now();
      const r = await withAutomation(ctx, 'Editing clip with AI (this can take a few minutes)', (auto) =>
        auto.aiGenerate(id, {
          mode: 'edit',
          prompt,
          source,
          timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
          ...(images.length ? { images } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(aspect ? { aspect } : {}),
          ...(scene ? { scene } : {}),
          ...(flags.insert ? { insert: flags.insert } : {}),
        }),
      );
      ctx.out.result(
        { id, elapsedMs: Date.now() - started, ...r },
        (d) => `Edited clip ${insertedText(d)} (${formatDuration(d.elapsedMs)}).`,
      );
    }),
  );

  addAiFlags(
    ai
      .command('animate')
      .description('Animate a still image into a video clip')
      .argument('<id>', 'video ID or URL')
      .argument('<image>', 'local image file'),
  ).action(
    action(kit, async (ctx, idArg: string, image: string, flags: AiFlags) => {
      const id = parseVidId(idArg);
      const prompt = await promptFrom(ctx, flags);
      const aspect = aspectName(flags.aspect);
      const source = await requireFile(image, ctx.io.cwd, 'image');
      const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
      const r = await withAutomation(ctx, 'Animating image (this can take a few minutes)', (auto) =>
        auto.aiGenerate(id, {
          mode: 'animate',
          prompt,
          source,
          timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
          ...(flags.model ? { model: flags.model } : {}),
          ...(aspect ? { aspect } : {}),
          ...(scene ? { scene } : {}),
          ...(flags.insert ? { insert: flags.insert } : {}),
        }),
      );
      ctx.out.result({ id, ...r }, (d) => `Animated clip ${insertedText(d)}.`);
    }),
  );

  // ------------------------------------------------------------ voiceover
  const vo = program
    .command('voiceover')
    .description('AI voiceover (text-to-speech narration) per scene (browser)');

  vo.command('voices')
    .description('List available voices')
    .argument('<id>', 'video ID or URL (the voiceover panel is opened there)')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const voices = await withAutomation(ctx, 'Reading voices', (auto) => auto.voices(id));
        ctx.out.result({ count: voices.length, voices }, (d) =>
          renderTable(d.voices, [
            { header: 'VOICE', value: (v) => v.name },
            { header: 'DESCRIPTION', value: (v) => v.description },
            { header: 'GROUP', value: (v) => v.group ?? '' },
          ]),
        );
      }),
    );

  vo.command('generate')
    .description('Generate narration for a scene from a script')
    .argument('<id>', 'video ID or URL')
    .option('--scene <n>', 'scene number', '1')
    .option('--script <text|file|->', 'narration text (supports [audio tags] like [excitedly])')
    .option('--script-file <file>', 'read the narration from a file')
    .option('--voice <name>', 'voice name, e.g. Elio (see: gvids voiceover voices <id>)')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          flags: { scene: string; script?: string; scriptFile?: string; voice?: string },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const script = await scriptFrom(ctx, flags);
          const clip = await withAutomation(ctx, 'Generating voiceover', (auto) =>
            auto.voiceover(id, scene, script, {
              timeoutMs: ctx.timeoutMs(3 * 60_000),
              ...(flags.voice ? { voice: flags.voice } : {}),
            }),
          );
          ctx.out.result({ id, scene, clip }, (d) =>
            `Voiceover added to scene ${d.scene}: ${d.clip.speaker ?? ''} ${d.clip.durationSeconds !== undefined ? `(${d.clip.durationSeconds}s)` : ''}`.trim(),
          );
        },
      ),
    );

  vo.command('remove')
    .description('Remove the voiceover clip(s) that start in a scene')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const removed = await withAutomation(ctx, 'Removing voiceover', (auto) =>
          auto.removeVoiceover(id, scene),
        );
        ctx.out.result({ id, scene, removed }, (d) =>
          d.removed.length
            ? `Removed ${d.removed.length} voiceover clip(s) from scene ${d.scene}.`
            : `Scene ${d.scene} has no voiceover.`,
        );
      }),
    );

  // --------------------------------------------------------------- script
  const script = program.command('script').description('Read and write per-scene scripts (browser)');

  script
    .command('get')
    .description('Print scene scripts')
    .argument('<id>', 'video ID or URL')
    .option('--scene <n>', 'only this scene')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene?: string }) => {
        const id = parseVidId(idArg);
        const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
        const scripts = await withAutomation(ctx, 'Reading scripts', (auto) => auto.getScripts(id, scene));
        ctx.out.result({ id, scripts }, (d) =>
          d.scripts.map((s) => (scene ? s.script : `Scene ${s.scene}: ${s.script || '(empty)'}`)).join('\n'),
        );
      }),
    );

  script
    .command('set')
    .description('Set a scene’s script (without generating audio)')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .option('--file <file>', 'script file (.txt/.md/.json/.yaml, or - for stdin)')
    .option('--text <text>', 'script text')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene: string; file?: string; text?: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const text = await scriptFrom(ctx, {
          ...(flags.file ? { scriptFile: flags.file } : {}),
          ...(flags.text ? { script: flags.text } : {}),
        });
        const r = await withAutomation(ctx, 'Writing script', (auto) => auto.setScript(id, scene, text));
        ctx.out.result({ id, ...r }, (d) => `Scene ${d.scene} script set (${d.script.length} characters).`);
      }),
    );

  // ------------------------------------------------------- image and music
  program
    .command('image')
    .description('AI images (Insert > Generate an image; browser)')
    .command('generate')
    .description('Generate an AI image from a prompt and insert it into a scene')
    .argument('<id>', 'video ID or URL')
    .option('-p, --prompt <text|file|->', 'what to draw (text, file, or - for stdin)')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .option('--scene <n>', 'scene number', '1')
    .addOption(new Option('--aspect <aspect>', 'image shape').choices(Object.keys(IMAGE_ASPECTS)))
    .addOption(new Option('--style <style>', 'drawing style').choices([...IMAGE_STYLES]))
    .addHelpText(
      'after',
      '\nUses Google AI allowance. Example:\n  gvids image generate <id> --prompt "A red balloon over hills at dawn" --style watercolor --aspect landscape',
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          flags: AiFlags & { scene: string; aspect?: ImageAspect; style?: ImageStyle },
        ) => {
          const id = parseVidId(idArg);
          const prompt = await promptFrom(ctx, flags);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const started = Date.now();
          const r = await withAutomation(ctx, 'Generating an AI image', (auto) =>
            auto.generateImage(id, scene, {
              prompt,
              timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
              ...(flags.aspect ? { aspect: flags.aspect } : {}),
              ...(flags.style ? { style: flags.style } : {}),
            }),
          );
          ctx.out.result(
            { id, scene, elapsedMs: Date.now() - started, ...r },
            (d) =>
              `Generated image inserted into scene ${d.scene}${d.object ? ` as object ${d.object.id}` : ''}.`,
          );
        },
      ),
    );

  program
    .command('music')
    .description(
      'AI music (Insert > Generate music; browser). Stock tracks: gvids media stock <id> <query> --type music',
    )
    .command('generate')
    .description('Generate an AI song or instrumental from a prompt and add it to a scene')
    .argument('<id>', 'video ID or URL')
    .option('-p, --prompt <text|file|->', 'genre, mood, instruments, or your own lyrics')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .option('--scene <n>', 'scene number', '1')
    .option('--full', 'a full song (default: a 30-second clip)')
    .option('--vocals', 'allow vocals (default: instrumental)')
    .addHelpText(
      'after',
      '\nUses Google AI allowance. Example:\n  gvids music generate <id> --prompt "light acoustic guitar for a travel video" --scene 1',
    )
    .action(
      action(
        kit,
        async (ctx, idArg: string, flags: AiFlags & { scene: string; full?: boolean; vocals?: boolean }) => {
          const id = parseVidId(idArg);
          const prompt = await promptFrom(ctx, flags);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const started = Date.now();
          const r = await withAutomation(ctx, 'Generating AI music', (auto) =>
            auto.generateMusic(id, scene, {
              prompt,
              full: Boolean(flags.full),
              instrumental: !flags.vocals,
              timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
            }),
          );
          const clip = r.clip ? { ...r.clip, kind: 'music' as const } : undefined;
          ctx.out.result(
            { id, scene, elapsedMs: Date.now() - started, ...r, ...(clip ? { clip } : {}) },
            (d) => `Generated music added to scene ${d.scene}${d.clip ? `: ${d.clip.label}` : ''}.`,
          );
        },
      ),
    );

  // --------------------------------------------------------------- avatar
  const avatar = program.command('avatar').description('AI avatars that speak your script (browser)');

  avatar
    .command('list')
    .description('List available avatars (preset and your custom avatars)')
    .argument('<id>', 'video ID or URL (the avatar panel is opened there)')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const avatars = await withAutomation(ctx, 'Reading avatars', (auto) => auto.avatars(id));
        ctx.out.result({ count: avatars.length, avatars }, (d) =>
          renderTable(d.avatars, [
            { header: 'AVATAR', value: (a) => a.name },
            { header: 'VOICE', value: (a) => a.description },
            { header: 'CATEGORY', value: (a) => a.category },
            { header: 'TAGS', value: (a) => a.tags.join(', ') },
          ]),
        );
      }),
    );

  avatar
    .command('generate')
    .description('Generate an avatar clip speaking a script in a scene')
    .argument('<id>', 'video ID or URL')
    .option('--scene <n>', 'scene number', '1')
    .option('--avatar <name>', 'avatar name, e.g. Finley (see: gvids avatar list <id>)')
    .option('--script <text|file|->', 'what the avatar says')
    .option('--script-file <file>', 'read the script from a file')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          flags: { scene: string; avatar?: string; script?: string; scriptFile?: string },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const text = await scriptFrom(ctx, flags);
          const r = await withAutomation(ctx, 'Generating avatar (this can take a few minutes)', (auto) =>
            auto.avatar(id, scene, text, {
              timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
              ...(flags.avatar ? { avatar: flags.avatar } : {}),
            }),
          );
          ctx.out.result({ id, scene, ...r }, () => `Avatar clip added to scene ${scene}.`);
        },
      ),
    );

  // --------------------------------------------------------------- slides
  const slides = program.command('slides').description('Google Slides → Vids conversion (browser)');

  slides
    .command('import')
    .description(
      'Import a Google Slides presentation into an existing video (landscape only). By default Gemini adds a script, AI voiceover, music and animation, like the Vids UI; --no-ai imports plain slides.',
    )
    .argument('<vid-id>', 'video ID or URL')
    .argument('<slides-id>', 'presentation ID or URL')
    .option('--slides <list>', 'only these slides, e.g. 1,3-5')
    .option('--no-ai', 'import the slides without an AI script, voiceover, music or animation')
    .addOption(
      new Option('--narration <kind>', 'AI narration (default: voiceover)').choices(['voiceover', 'avatar']),
    )
    .action(
      action(
        kit,
        async (
          ctx,
          vidArg: string,
          slidesArg: string,
          flags: { slides?: string; ai: boolean; narration?: 'voiceover' | 'avatar' },
        ) => {
          const id = parseVidId(vidArg);
          const presentation = parsePresentationId(slidesArg);
          if (!flags.ai && flags.narration)
            throw new UsageError('--narration needs the AI script (drop --no-ai).');
          const r = await withAutomation(ctx, 'Importing slides (this can take a few minutes)', (auto) =>
            auto.importSlides(id, presentation, {
              timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
              ai: flags.ai,
              ...(flags.slides ? { slides: parseNumberList(flags.slides, '--slides') } : {}),
              ...(flags.narration ? { narration: flags.narration } : {}),
            }),
          );
          ctx.out.result(
            { id, presentation, ...r },
            (d) =>
              `Imported ${d.slides} slide(s)${d.ai ? ' with AI narration' : ''}: ${d.scenesBefore} → ${d.scenesAfter} scenes.`,
          );
        },
      ),
    );

  // ----------------------------------------------------------------- docs
  const docs = program.command('docs').description('Google Docs → Vids conversion (browser, Gemini)');

  docs
    .command('import')
    .description(
      'Turn a Google Doc into scenes with AI voiceover (File > Docs to video). Gemini drafts one narration script per scene; --script-only returns the draft and adds nothing.',
    )
    .argument('<vid-id>', 'video ID or URL')
    .argument('<doc-id>', 'Google Doc ID or URL')
    .option('--voice <name>', 'AI voiceover voice, e.g. Kaci (see: gvids voiceover voices <id>)')
    .option(
      '--script-file <file>',
      'replace the drafted scene scripts in order: a JSON/YAML list, or text with a blank line between scenes',
    )
    .option('--script-only', 'stop after Gemini drafts the script (the draft is discarded; nothing is added)')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  gvids docs import <vid-id> https://docs.google.com/document/d/<doc-id>/edit --script-only',
        '  gvids docs import <vid-id> <doc-id> --voice Kaci --script-file scenes.txt',
      ].join('\n'),
    )
    .action(
      action(
        kit,
        async (
          ctx,
          vidArg: string,
          docArg: string,
          flags: { voice?: string; scriptFile?: string; scriptOnly?: boolean },
        ) => {
          const id = parseVidId(vidArg);
          const document = parseDocumentId(docArg);
          const script = flags.scriptFile ? await readSceneScripts(ctx, flags.scriptFile) : undefined;
          const r = await withAutomation(
            ctx,
            flags.scriptOnly
              ? 'Drafting a script from the document'
              : 'Converting the document (this can take a few minutes)',
            (auto) =>
              auto.importDoc(id, document, {
                timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
                ...(script ? { script } : {}),
                ...(flags.voice ? { voice: flags.voice } : {}),
                ...(flags.scriptOnly ? { scriptOnly: true } : {}),
              }),
          );
          ctx.out.result({ id, document, ...r }, (d) =>
            d.created
              ? `Added the document as ${d.scenesAfter - d.scenesBefore} scene(s) with ${d.voice ?? 'AI'} voiceover: ${d.scenesBefore} → ${d.scenesAfter} scenes.`
              : [
                  `Draft script (${d.script.length} scenes, voice ${d.voice ?? 'default'}); nothing was added:`,
                  ...d.script.map((line, i) => `${i + 1}. ${line}`),
                ].join('\n'),
          );
        },
      ),
    );

  // --------------------------------------------------------------- export
  program
    .command('export')
    .description('Export a video: MP4 via the Drive API (default) or GIF via the editor')
    .argument('<id>', 'video ID or URL')
    .argument('[output]', 'output file or directory')
    .addOption(new Option('--format <format>', 'output format').choices(['mp4', 'gif']).default('mp4'))
    .option('--via-browser', 'use the editor’s File > Download instead of the Drive API')
    .option('--to-drive', 'render an MP4 into My Drive (File > Export to Drive) instead of downloading')
    .option('--local', 'GIF: always convert the MP4 on this computer (any length; ffmpeg or the browser)')
    .addOption(
      new Option('--fps <n>', 'GIF made locally: frames per second (1-30, default 10)').argParser(
        numberIn('--fps', 1, 30),
      ),
    )
    .addOption(
      new Option('--width <px>', 'GIF made locally: width in pixels (64-1920, default 640)').argParser(
        numberIn('--width', 64, 1920),
      ),
    )
    .option('--overwrite', 'replace an existing file')
    .addHelpText(
      'after',
      '\nVids exports GIFs only for videos up to 30 s; longer videos are converted from the MP4 on this computer\n(ffmpeg when installed, otherwise the gvids browser).',
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          output: string | undefined,
          flags: {
            format: 'mp4' | 'gif';
            viaBrowser?: boolean;
            toDrive?: boolean;
            local?: boolean;
            fps?: number;
            width?: number;
            overwrite?: boolean;
          },
        ) => {
          if (flags.toDrive) {
            if (output || flags.format !== 'mp4') {
              throw new UsageError(
                '--to-drive saves an MP4 in My Drive: it takes no output file or --format gif.',
              );
            }
            const id = parseVidId(idArg);
            const r = await withAutomation(ctx, 'Exporting to Drive (this can take a few minutes)', (auto) =>
              auto.exportToDrive(id, ctx.timeoutMs(15 * 60_000)),
            );
            ctx.out.result(
              { id, ...r, format: 'mp4', method: 'browser' },
              (d) => `Exported to My Drive: ${d.url}`,
            );
            return;
          }
          if (flags.format === 'gif') {
            if (!flags.local) {
              try {
                const r = await downloadViaEditor(ctx, idArg, output, 'gif', {
                  ...(flags.overwrite ? { overwrite: true } : {}),
                });
                ctx.out.result(r, (d) => `Saved: ${d.path} (${formatBytes(d.bytes)})`);
                return;
              } catch (err) {
                const refused =
                  err instanceof FeatureUnavailableError &&
                  (err.details as { refused?: string })?.refused === 'gif';
                if (!refused) throw err;
                ctx.out.warn(
                  'Vids exports GIFs only for videos up to 30 seconds; converting the MP4 on this computer instead.',
                );
              }
            }
            const r = await gifViaLocalConversion(ctx, idArg, output, {
              fps: flags.fps ?? 10,
              width: flags.width ?? 640,
              overwrite: Boolean(flags.overwrite),
            });
            ctx.out.result(r, (d) => `Saved: ${d.path} (${formatBytes(d.bytes)})`);
            return;
          }
          if (flags.format === 'mp4' && !flags.viaBrowser) {
            try {
              const r = await downloadMp4(ctx, idArg, output, {
                ...(flags.overwrite ? { overwrite: true } : {}),
              });
              ctx.out.result(
                { ...r, format: 'mp4', method: 'drive-api' },
                (d) => `Saved: ${d.path} (${formatBytes(d.bytes)})`,
              );
              return;
            } catch (err) {
              if (!(err instanceof AuthError)) throw err;
              ctx.out.warn(fallbackWarning(err, 'rendering the MP4 with the editor’s File > Download'));
            }
          }
          const r = await downloadViaEditor(ctx, idArg, output, flags.format, {
            ...(flags.overwrite ? { overwrite: true } : {}),
          });
          ctx.out.result(r, (d) => `Saved: ${d.path} (${formatBytes(d.bytes)})`);
        },
      ),
    );
}
