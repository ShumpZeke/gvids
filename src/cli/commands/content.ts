import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Option, type Command } from 'commander';
import { FeatureUnavailableError, UsageError } from '../../errors/errors.js';
import { downloadBlob } from '../../google/downloads.js';
import { readJsonFile, sanitizeFileName, writeFileAtomic } from '../../utils/fs.js';
import {
  parseHexColor,
  parseNumberList,
  parsePositiveInt,
  readTextInput,
  requireFile,
} from '../../utils/input.js';
import type { SceneObject, TemplateInfo } from '../../vids/types.js';
import { slugify } from '../../vids/types.js';
import { parseResource, parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { viaDriveOrBrowser } from './files.js';
import { STOCK_TYPES, type StockType } from '../../browser/pages/stock.js';
import { parseClipTime } from '../../browser/pages/media-tools.js';
import { numberIn } from './design.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { formatDate, renderTable } from '../output/format.js';

interface StyleFlags {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: string;
  align?: 'left' | 'center' | 'right' | 'justify';
  color?: string;
}

/** Style flags, validated before the browser starts. */
function styleFrom(flags: StyleFlags) {
  const size = flags.size ? parsePositiveInt(flags.size, '--size') : undefined;
  if (size !== undefined && size > 400) throw new UsageError(`--size must be at most 400, got ${size}.`);
  return {
    ...(flags.bold !== undefined ? { bold: flags.bold } : {}),
    ...(flags.italic !== undefined ? { italic: flags.italic } : {}),
    ...(flags.underline !== undefined ? { underline: flags.underline } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(flags.align ? { align: flags.align } : {}),
    ...(flags.color ? { color: parseHexColor(flags.color, '--color') } : {}),
  };
}

function requireText(text: string, label: string): string {
  if (!text.trim()) throw new UsageError(`${label} must not be empty.`);
  return text;
}

function addStyleFlags(cmd: Command): Command {
  return cmd
    .option('--bold', 'bold')
    .option('--no-bold', 'not bold')
    .option('--italic', 'italic')
    .option('--no-italic', 'not italic')
    .option('--underline', 'underline')
    .option('--size <pt>', 'font size in points')
    .addOption(
      new Option('--align <align>', 'paragraph alignment').choices(['left', 'center', 'right', 'justify']),
    )
    .option('--color <hex>', 'text color, e.g. "#ffcc00"');
}

function renderObjects(objects: SceneObject[]): string {
  if (objects.length === 0) return 'No objects on this scene.';
  return renderTable(objects, [
    { header: 'OBJECT ID', value: (o) => o.id },
    { header: 'KIND', value: (o) => o.kind },
    { header: 'TEXT', value: (o) => o.text ?? '', maxWidth: 60 },
  ]);
}

// ------------------------------------------------------------ templates cache

interface TemplateCache {
  account?: string;
  refreshedAt: string;
  templates: TemplateInfo[];
}

async function readTemplateCache(ctx: CommandContext): Promise<TemplateCache | undefined> {
  return readJsonFile<TemplateCache>(ctx.paths.templatesCacheFile).catch(() => undefined);
}

async function resolveTemplateName(ctx: CommandContext, input: string): Promise<string> {
  const cache = await readTemplateCache(ctx);
  const slug = slugify(input);
  const hit = cache?.templates.find(
    (t) => t.name === slug || t.displayName.toLowerCase() === input.toLowerCase(),
  );
  return hit?.displayName ?? input;
}

export function registerContentCommands(program: Command, kit: Kit): void {
  // ------------------------------------------------------------------ text
  const text = program.command('text').description('Add, edit and delete text boxes on scenes (browser)');

  text
    .command('list')
    .description('List objects (with IDs) on a scene')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const objects = await withAutomation(ctx, 'Reading scene', (auto) => auto.objects(id, scene));
        ctx.out.result({ id, scene, objects }, (d) => renderObjects(d.objects));
      }),
    );

  addStyleFlags(
    text
      .command('add')
      .description('Add a text box to a scene')
      .argument('<id>', 'video ID or URL')
      .requiredOption('--scene <n>', 'scene number')
      .requiredOption('--text <text|file|->', 'the text (literal, .txt/.md file, or - for stdin)')
      .addOption(
        new Option('--kind <kind>', 'text box style').choices(['title', 'subtitle', 'body']).default('title'),
      ),
  ).action(
    action(
      kit,
      async (
        ctx,
        idArg: string,
        flags: StyleFlags & { scene: string; text: string; kind: 'title' | 'subtitle' | 'body' },
      ) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const content = requireText(
          await readTextInput(flags.text, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--text' }),
          '--text',
        );
        const style = styleFrom(flags);
        const obj = await withAutomation(ctx, 'Adding text', (auto) =>
          auto.addText(id, scene, content, { kind: flags.kind, style }),
        );
        ctx.out.result(
          { id, scene, object: obj },
          (d) => `Added text box ${d.object.id} to scene ${d.scene}.`,
        );
      },
    ),
  );

  addStyleFlags(
    text
      .command('edit')
      .description('Replace the text (and/or style) of a text box')
      .argument('<id>', 'video ID or URL')
      .requiredOption('--scene <n>', 'scene number')
      .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
      .option('--text <text|file|->', 'new text'),
  ).action(
    action(
      kit,
      async (ctx, idArg: string, flags: StyleFlags & { scene: string; object: string; text?: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const content =
          flags.text !== undefined
            ? requireText(
                await readTextInput(flags.text, { cwd: ctx.io.cwd, stdin: ctx.io.stdin, label: '--text' }),
                '--text',
              )
            : undefined;
        const style = styleFrom(flags);
        if (content === undefined && Object.keys(style).length === 0) {
          throw new UsageError('Nothing to change: pass --text and/or style options.');
        }
        const obj = await withAutomation(ctx, 'Editing text', (auto) =>
          auto.editText(id, scene, flags.object, content, style),
        );
        ctx.out.result({ id, scene, object: obj ?? null }, () => `Updated ${flags.object}.`);
      },
    ),
  );

  text
    .command('delete')
    .description('Delete an object from a scene')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene: string; object: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        await withAutomation(ctx, 'Deleting object', (auto) => auto.deleteObject(id, scene, flags.object));
        ctx.out.result(
          { id, scene, deleted: flags.object },
          (d) => `Deleted ${d.deleted} from scene ${d.scene}.`,
        );
      }),
    );

  text
    .command('replace')
    .description('Find and replace text in every scene (Edit > Find and replace)')
    .argument('<id>', 'video ID or URL')
    .argument('<find>', 'text to find (a regular expression with --regex)')
    .argument('[replace]', 'replacement text ("" deletes the matches); omit with --count')
    .option('--match-case', 'match upper and lower case exactly')
    .option('--regex', 'treat <find> as a regular expression (Google Docs syntax)')
    .option('--count', 'only count the matches; change nothing')
    .addHelpText(
      'after',
      '\nExamples:\n  gvids text replace <id> "2025" "2026"\n  gvids text replace <id> "colour" --count',
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          find: string,
          replace: string | undefined,
          flags: { matchCase?: boolean; regex?: boolean; count?: boolean },
        ) => {
          const id = parseVidId(idArg);
          if (!find) throw new UsageError('The text to find must not be empty.');
          if (flags.count && replace !== undefined)
            throw new UsageError('--count takes no replacement text.');
          if (!flags.count && replace === undefined) {
            throw new UsageError('Give the replacement text, or --count to only count matches.');
          }
          const r = await withAutomation(ctx, flags.count ? 'Counting matches' : 'Replacing text', (auto) =>
            auto.findReplace(id, find, flags.count ? undefined : replace, {
              ...(flags.matchCase ? { matchCase: true } : {}),
              ...(flags.regex ? { regex: true } : {}),
            }),
          );
          ctx.out.result({ id, find, ...(flags.count ? {} : { replace }), ...r }, (d) =>
            flags.count
              ? `${d.matches} match${d.matches === 1 ? '' : 'es'} for "${d.find}".`
              : `Replaced ${d.replaced} match${d.replaced === 1 ? '' : 'es'} of "${d.find}".`,
          );
        },
      ),
    );

  // ----------------------------------------------------------------- media
  const media = program.command('media').description('Insert images, video and audio into scenes (browser)');

  const addMedia = action(kit, async (ctx, idArg: string, file: string, flags: { scene: string }) => {
    const id = parseVidId(idArg);
    const scene = parsePositiveInt(flags.scene, '--scene');
    const resolved = await requireFile(file, ctx.io.cwd, 'media');
    const r = await withAutomation(ctx, `Uploading ${path.basename(resolved)}`, (auto) =>
      auto.addMedia(id, scene, resolved, ctx.timeoutMs(10 * 60_000)),
    );
    ctx.out.result(
      { id, scene, file: resolved, ...r },
      (d) =>
        `Inserted ${path.basename(d.file)} into scene ${d.scene}${d.object ? ` as object ${d.object.id}` : d.clip ? ` (${d.clip.label})` : ''}.`,
    );
  });

  media
    .command('add')
    .description(
      'Upload a local image (PNG/JPEG/GIF), video (MP4/MOV/WebM/OGG) or audio (MP3/WAV/M4A/FLAC) into a scene',
    )
    .argument('<id>', 'video ID or URL')
    .argument('<file>', 'local file')
    .option('--scene <n>', 'scene number', '1')
    .action(addMedia);

  program
    .command('video')
    .description('Insert a video clip into a scene (same as `gvids media add`)')
    .command('add')
    .description('Upload a local video clip into a scene (same as `gvids media add`)')
    .argument('<id>', 'video ID or URL')
    .argument('<file>', 'local video file')
    .option('--scene <n>', 'scene number', '1')
    .action(addMedia);

  media
    .command('delete')
    .description('Delete an inserted image/video object from a scene')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene: string; object: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        await withAutomation(ctx, 'Deleting media', (auto) => auto.deleteObject(id, scene, flags.object));
        ctx.out.result({ id, scene, deleted: flags.object }, (d) => `Deleted ${d.deleted}.`);
      }),
    );

  media
    .command('trim')
    .description('Trim a video object (start/end within the clip) and/or loop it (Playback options)')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'video object ID from `gvids text list`')
    .option('--start <time>', 'start point in the clip: seconds (4.5) or m:ss.s')
    .option('--end <time>', 'end point in the clip: seconds or m:ss.s')
    .option('--loop', 'loop the video')
    .option('--no-loop', 'do not loop')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          flags: { scene: string; object: string; start?: string; end?: string; loop?: boolean },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const start = flags.start !== undefined ? parseClipTime(flags.start, '--start') : undefined;
          const end = flags.end !== undefined ? parseClipTime(flags.end, '--end') : undefined;
          if (start !== undefined && end !== undefined && end <= start)
            throw new UsageError('--end must be after --start.');
          if (start === undefined && end === undefined && flags.loop === undefined)
            throw new UsageError('Nothing to change: pass --start, --end or --loop/--no-loop.');
          const r = await withAutomation(ctx, 'Trimming video', (auto) =>
            auto.trimMedia(id, scene, flags.object, {
              ...(start !== undefined ? { start } : {}),
              ...(end !== undefined ? { end } : {}),
              ...(flags.loop !== undefined ? { loop: flags.loop } : {}),
            }),
          );
          ctx.out.result(
            { id, scene, object: flags.object, ...r },
            (d) => `Video ${d.object}: ${d.start ?? '?'} to ${d.end ?? '?'}${d.loop ? ', looping' : ''}.`,
          );
        },
      ),
    );

  media
    .command('sound')
    .description('Volume, mute and audio fades of a video or audio object (Sound)')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
    .addOption(new Option('--volume <percent>', 'volume 0-100').argParser(numberIn('--volume', 0, 100)))
    .option('--mute', 'mute this track')
    .option('--no-mute', 'unmute this track')
    .addOption(new Option('--fade-in <seconds>', 'fade in length').argParser(numberIn('--fade-in', 0, 60)))
    .addOption(new Option('--fade-out <seconds>', 'fade out length').argParser(numberIn('--fade-out', 0, 60)))
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          flags: {
            scene: string;
            object: string;
            volume?: number;
            mute?: boolean;
            fadeIn?: number;
            fadeOut?: number;
          },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const want = {
            ...(flags.volume !== undefined ? { volume: flags.volume } : {}),
            ...(flags.mute !== undefined ? { mute: flags.mute } : {}),
            ...(flags.fadeIn !== undefined ? { fadeIn: flags.fadeIn } : {}),
            ...(flags.fadeOut !== undefined ? { fadeOut: flags.fadeOut } : {}),
          };
          if (Object.keys(want).length === 0)
            throw new UsageError(
              'Nothing to change: pass --volume, --mute/--no-mute, --fade-in or --fade-out.',
            );
          const r = await withAutomation(ctx, 'Changing sound', (auto) =>
            auto.setSound(id, scene, flags.object, want),
          );
          ctx.out.result(
            { id, scene, object: flags.object, ...r },
            (d) =>
              `Object ${d.object}: volume ${d.volume ?? '?'}%${d.mute ? ' (muted)' : ''}, fade in ${d.fadeIn ?? 0}s, fade out ${d.fadeOut ?? 0}s.`,
          );
        },
      ),
    );

  media
    .command('replace')
    .description('Replace a video or image object with a local file, keeping its place and size')
    .argument('<id>', 'video ID or URL')
    .argument('<file>', 'local image or video file')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
    .action(
      action(kit, async (ctx, idArg: string, file: string, flags: { scene: string; object: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const resolved = await requireFile(file, ctx.io.cwd, 'file');
        const obj = await withAutomation(ctx, `Replacing with ${path.basename(resolved)}`, (auto) =>
          auto.replaceMedia(id, scene, flags.object, resolved, ctx.timeoutMs(10 * 60_000)),
        );
        ctx.out.result(
          { id, scene, replaced: flags.object, file: resolved, object: obj ?? null },
          (d) => `Replaced ${d.replaced} with ${path.basename(d.file)}.`,
        );
      }),
    );

  media
    .command('fill')
    .description('Make a video or image fill the scene, or set it as the scene background (Arrange)')
    .argument('<id>', 'video ID or URL')
    .requiredOption('--scene <n>', 'scene number')
    .requiredOption('--object <object-id>', 'object ID from `gvids text list`')
    .option('--background', 'set it as the scene background instead of stretching it on top')
    .action(
      action(
        kit,
        async (ctx, idArg: string, flags: { scene: string; object: string; background?: boolean }) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const mode = flags.background ? 'background' : 'fill';
          await withAutomation(ctx, flags.background ? 'Setting background' : 'Filling the scene', (auto) =>
            auto.fillScene(id, scene, flags.object, mode),
          );
          ctx.out.result({ id, scene, object: flags.object, mode }, (d) =>
            d.mode === 'fill'
              ? `Object ${d.object} now fills scene ${d.scene}.`
              : `Object ${d.object} is now the background of scene ${d.scene}.`,
          );
        },
      ),
    );

  media
    .command('stock')
    .description(
      'Search Stock & web (Getty Images video/photos, Shutterstock music, stickers) and insert a result',
    )
    .argument('<id>', 'video ID or URL')
    .argument('<query>', 'what to search for')
    .option('--scene <n>', 'scene number', '1')
    .addOption(new Option('--type <type>', 'kind of result').choices([...STOCK_TYPES]).default('video'))
    .option('--pick <n>', 'which result to insert (1-based)', '1')
    .addHelpText(
      'after',
      '\nExamples:\n  gvids media stock <id> "sunrise ocean" --scene 2\n  gvids media stock <id> "calm piano" --type music\n  gvids media stock-search <id> "city at night" --type image',
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          query: string,
          flags: { scene: string; type: StockType; pick: string },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const pick = parsePositiveInt(flags.pick, '--pick');
          if (!query.trim()) throw new UsageError('The search text must not be empty.');
          const r = await withAutomation(ctx, `Inserting stock ${flags.type}`, (auto) =>
            auto.insertStock(id, scene, query.trim(), flags.type, pick, ctx.timeoutMs(5 * 60_000)),
          );
          ctx.out.result(
            { id, scene, query, type: flags.type, ...r },
            (d) =>
              `Inserted "${d.title}"${d.provider ? ` (${d.provider})` : ''} into scene ${d.scene}${d.object ? ` as object ${d.object.id}` : ''}.`,
          );
        },
      ),
    );

  media
    .command('stock-search')
    .description('List Stock & web results without inserting anything')
    .argument('<id>', 'video ID or URL (the search panel is opened there)')
    .argument('<query>', 'what to search for')
    .addOption(new Option('--type <type>', 'kind of result').choices([...STOCK_TYPES]).default('video'))
    .option('--limit <n>', 'maximum results', '10')
    .action(
      action(kit, async (ctx, idArg: string, query: string, flags: { type: StockType; limit: string }) => {
        const id = parseVidId(idArg);
        const limit = parsePositiveInt(flags.limit, '--limit');
        if (!query.trim()) throw new UsageError('The search text must not be empty.');
        const results = await withAutomation(ctx, 'Searching stock media', (auto) =>
          auto.stockSearch(id, query.trim(), flags.type, limit),
        );
        ctx.out.result({ id, query, type: flags.type, count: results.length, results }, (d) =>
          d.results.length === 0
            ? 'No results.'
            : renderTable(d.results, [
                { header: '#', value: (r) => String(r.index) },
                { header: 'TITLE', value: (r) => r.title, maxWidth: 70 },
                { header: 'PROVIDER', value: (r) => r.provider ?? '' },
              ]),
        );
      }),
    );

  media
    .command('add-drive')
    .description(
      'Insert a Drive image/video/audio file into a scene (Drive API download + upload; without an OAuth login, the editor’s Drive picker)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('<drive-file>', 'Drive file ID or URL')
    .option('--scene <n>', 'scene number', '1')
    .action(
      action(kit, async (ctx, idArg: string, fileArg: string, flags: { scene: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const file = parseResource(fileArg);
        await viaDriveOrBrowser(
          ctx,
          'inserting it with the editor’s Drive picker',
          async (drive) => {
            const source = await drive.get(file.id, {
              requireVid: false,
              ...(file.resourceKey ? { resourceKey: file.resourceKey } : {}),
            });
            if (!/^(image|video|audio)\//.test(source.mimeType)) {
              throw new FeatureUnavailableError(
                `${source.name} is ${source.mimeType}; only image, video and audio files can be inserted.`,
              );
            }
            const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gvids-media-'));
            try {
              const local = path.join(tmpDir, sanitizeFileName(source.name, 'media'));
              const spinner = ctx.out.spinner(`Downloading ${source.name} from Drive…`);
              await downloadBlob(drive.transport, source.id, local).finally(() => spinner.stop());
              const r = await withAutomation(ctx, `Uploading ${source.name}`, (auto) =>
                auto.addMedia(id, scene, local, ctx.timeoutMs(10 * 60_000)),
              );
              ctx.out.result(
                {
                  id,
                  scene,
                  driveFile: { id: source.id, name: source.name, mimeType: source.mimeType },
                  ...r,
                  method: 'drive-api',
                },
                (d) =>
                  `Inserted "${d.driveFile.name}" into scene ${d.scene}${d.object ? ` as object ${d.object.id}` : ''}.`,
              );
            } finally {
              await fs.rm(tmpDir, { recursive: true, force: true });
            }
          },
          async () => {
            const url =
              `https://drive.google.com/file/d/${file.id}/view` +
              (file.resourceKey ? `?resourcekey=${encodeURIComponent(file.resourceKey)}` : '');
            const r = await withAutomation(ctx, 'Inserting from Drive', (auto) =>
              auto.addDriveMedia(id, scene, url, ctx.timeoutMs(10 * 60_000)),
            );
            ctx.out.result(
              { id, scene, driveFile: { id: file.id }, ...r, method: 'browser' },
              (d) =>
                `Inserted Drive file ${d.driveFile.id} into scene ${d.scene}${d.object ? ` as object ${d.object.id}` : ''}.`,
            );
          },
        );
      }),
    );

  // -------------------------------------------------------------- templates
  const template = program
    .command('template')
    .description('Browse and apply Google Vids templates (browser)');

  template
    .command('list')
    .description('List templates (cached; use --refresh with --vid to re-read them from Vids)')
    .option('--refresh', 're-read the template gallery from the editor')
    .option('--vid <id>', 'video to open the template gallery in (required with --refresh)')
    .action(
      action(kit, async (ctx, flags: { refresh?: boolean; vid?: string }) => {
        let cache = await readTemplateCache(ctx);
        if (flags.refresh || !cache) {
          if (!flags.vid) {
            throw new UsageError(
              cache ? '--refresh needs --vid <id> to open the gallery.' : 'No cached template list yet.',
              { hint: 'Run: gvids template list --refresh --vid <any-video-id>' },
            );
          }
          const vid = parseVidId(flags.vid);
          const templates = await withAutomation(ctx, 'Reading templates', (auto) => auto.templates(vid));
          cache = { refreshedAt: new Date().toISOString(), templates };
          await writeFileAtomic(ctx.paths.templatesCacheFile, `${JSON.stringify(cache, null, 2)}\n`);
        }
        const data = cache;
        ctx.out.result(
          { refreshedAt: data.refreshedAt, count: data.templates.length, templates: data.templates },
          (d) =>
            [
              renderTable(d.templates, [
                { header: 'NAME', value: (t) => t.name },
                { header: 'DISPLAY NAME', value: (t) => t.displayName },
              ]),
              '',
              `${d.count} templates, last verified ${formatDate(d.refreshedAt)}`,
            ].join('\n'),
        );
      }),
    );

  template
    .command('search')
    .description('Search the cached template list')
    .argument('<text>', 'words to match')
    .action(
      action(kit, async (ctx, textArg: string) => {
        const cache = await readTemplateCache(ctx);
        if (!cache)
          throw new UsageError('No cached template list.', {
            hint: 'Run: gvids template list --refresh --vid <id>',
          });
        const words = textArg.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = cache.templates.filter((t) =>
          words.every((w) => `${t.name} ${t.displayName}`.toLowerCase().includes(w)),
        );
        ctx.out.result({ query: textArg, count: matches.length, templates: matches }, (d) =>
          d.templates.length === 0
            ? 'No matching templates.'
            : d.templates.map((t) => `${t.name}  (${t.displayName})`).join('\n'),
        );
      }),
    );

  template
    .command('preview')
    .description('Show what is known about a template (name, locator, last verified)')
    .argument('<template>', 'template name or display name')
    .action(
      action(kit, async (ctx, name: string) => {
        const cache = await readTemplateCache(ctx);
        const slug = slugify(name);
        const hit = cache?.templates.find(
          (t) => t.name === slug || t.displayName.toLowerCase() === name.toLowerCase(),
        );
        if (!hit)
          throw new UsageError(`Template "${name}" is not in the cache.`, {
            hint: 'Run: gvids template list --refresh --vid <id>',
          });
        ctx.out.result(hit, (t) =>
          [
            `${t.displayName}`,
            `  name:          ${t.name}`,
            `  locator:       ${t.locator} (${t.source})`,
            `  last verified: ${formatDate(t.lastVerified)}`,
            '',
            `Apply with: gvids template apply <id> ${t.name}`,
          ].join('\n'),
        );
      }),
    );

  template
    .command('apply')
    .description('Insert a template’s scenes into a video')
    .argument('<id>', 'video ID or URL')
    .argument('<template>', 'template name or display name')
    .option('--after <n>', 'insert after this scene (default: at the end)')
    .option('--scenes <list>', 'only insert these template scenes, e.g. 1,2,5')
    .action(
      action(kit, async (ctx, idArg: string, name: string, flags: { after?: string; scenes?: string }) => {
        const id = parseVidId(idArg);
        const display = await resolveTemplateName(ctx, name);
        const r = await withAutomation(ctx, `Applying template "${display}"`, (auto) =>
          auto.applyTemplate(id, display, {
            ...(flags.after ? { after: parsePositiveInt(flags.after, '--after') } : {}),
            ...(flags.scenes ? { scenes: parseNumberList(flags.scenes, '--scenes') } : {}),
          }),
        );
        ctx.out.result(
          { id, template: display, ...r },
          (d) => `Inserted ${d.inserted} scene(s) from "${d.template}" (now ${d.scenes}).`,
        );
      }),
    );
}
