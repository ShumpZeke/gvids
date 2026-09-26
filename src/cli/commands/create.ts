import { Option, type Command } from 'commander';
import type { CreateMode } from '../../browser/operations/automation.js';
import { AuthError, UsageError, withContext } from '../../errors/errors.js';
import { toGvidsError } from '../../errors/map.js';
import { parseNumberList, parsePositiveInt, requireFile } from '../../utils/input.js';
import { VIDEO_FORMATS, type VideoFormat } from '../../vids/types.js';
import { parseDocumentId, parseFolderId, parsePresentationId, vidEditUrl } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { readOutlineFile, resolvePrompt } from './storyboard.js';

interface CreateFlags {
  blank?: boolean;
  template?: string;
  templateScenes?: string;
  slides?: string;
  doc?: string;
  voice?: string;
  upload?: string;
  prompt?: string;
  promptFile?: string;
  outlineFile?: string;
  design?: string;
  format: VideoFormat;
  folder?: string;
  open?: boolean;
  viaApi?: boolean;
}

async function moveIfRequested(
  ctx: CommandContext,
  id: string,
  folder: string | undefined,
): Promise<string | undefined> {
  if (!folder) return undefined;
  try {
    const moved = await (await ctx.drive()).move(id, parseFolderId(folder));
    return moved.parents.join(',');
  } catch (err) {
    if (err instanceof AuthError) {
      ctx.out.warn(
        'Created the video but could not move it: --folder needs the Drive API (run gvids auth login).',
      );
      return undefined;
    }
    throw err;
  }
}

export function registerCreateCommand(program: Command, kit: Kit): void {
  program
    .command('create')
    .description('Create a new Google Vids video (blank, template, upload, Slides, Docs, or AI storyboard)')
    .argument('[title]', 'title for the new video')
    .option('--blank', 'blank video (default)')
    .option('--template <name>', 'start from a template (see: gvids template list)')
    .option('--template-scenes <list>', 'only insert these template scenes, e.g. 1,3')
    .option('--slides <id|url>', 'convert a Google Slides presentation')
    .option('--doc <id|url>', 'convert a Google Doc: Gemini writes a script, with AI voiceover')
    .option('--voice <name>', 'with --doc: the AI voiceover voice')
    .option('--upload <file>', 'start from a local video/image file')
    .option('-p, --prompt <text|file|->', 'generate an AI storyboard draft from a prompt')
    .option('--prompt-file <file>', 'read the storyboard prompt from a file')
    .option('--outline-file <file>', 'use your own outline for the storyboard draft')
    .option('--design <n>', 'storyboard design to use (1-based)')
    .addOption(
      new Option('--format <format>', 'video format').choices([...VIDEO_FORMATS]).default('landscape'),
    )
    .addOption(new Option('--aspect <format>', 'alias for --format').choices([...VIDEO_FORMATS]).hideHelp())
    .option('--folder <id|url>', 'move the new video into this Drive folder (Drive API)')
    .option('--open', 'open the new video in your default browser')
    .option(
      '--via-api',
      'create an empty Vids file with Drive files.create instead of the editor (experimental)',
    )
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  gvids create "History Project"',
        '  gvids create --prompt "Make a 60 second video explaining photosynthesis"',
        '  gvids create "Launch" --prompt prompt.txt --format portrait',
        '  echo "make a video about Mars" | gvids create --prompt -',
        '  gvids create "Onboarding" --template "New employee onboarding"',
        '  gvids create --slides https://docs.google.com/presentation/d/<id>/edit',
        '  gvids create "Explainer" --doc https://docs.google.com/document/d/<id>/edit --voice Kaci',
      ].join('\n'),
    )
    .action(
      action(kit, async (ctx, title: string | undefined, flags: CreateFlags & { aspect?: VideoFormat }) => {
        const format = flags.aspect ?? flags.format;
        const modes = [flags.template, flags.slides, flags.doc, flags.upload].filter(Boolean).length;
        if (modes > 1) throw new UsageError('Choose only one of --template, --slides, --doc, --upload.');
        if (flags.voice && !flags.doc) throw new UsageError('--voice applies to --doc.');
        if (flags.templateScenes && !flags.template)
          throw new UsageError('--template-scenes needs --template.');
        const prompt = await resolvePrompt(ctx, flags, false);
        if (prompt && modes > 0)
          throw new UsageError('--prompt cannot be combined with --template/--slides/--doc/--upload.');

        if (flags.viaApi) {
          if (modes > 0 || prompt) throw new UsageError('--via-api only creates an empty video.');
          const drive = await ctx.drive();
          const file = await drive.createEmpty(
            title ?? 'Untitled video',
            flags.folder ? parseFolderId(flags.folder) : undefined,
          );
          ctx.out.result(
            { ...file, mode: 'drive-api' },
            (f) => `Created "${f.name}" via the Drive API (${f.id})\n${f.url}`,
          );
          return;
        }

        let mode: CreateMode = { kind: 'blank' };
        if (flags.template) {
          mode = {
            kind: 'template',
            template: flags.template,
            ...(flags.templateScenes
              ? { scenes: parseNumberList(flags.templateScenes, '--template-scenes') }
              : {}),
          };
        } else if (flags.slides) {
          mode = { kind: 'slides', presentationId: parsePresentationId(flags.slides) };
        } else if (flags.doc) {
          mode = {
            kind: 'docs',
            documentId: parseDocumentId(flags.doc),
            ...(flags.voice ? { voice: flags.voice } : {}),
          };
        } else if (flags.upload) {
          mode = { kind: 'upload', file: await requireFile(flags.upload, ctx.io.cwd, '--upload') };
        }
        const landscapeOnly = mode.kind === 'template' || mode.kind === 'slides' || mode.kind === 'docs';
        if (landscapeOnly && format !== 'landscape') {
          const what = mode.kind === 'template' ? 'Templates' : mode.kind === 'slides' ? 'Slides conversion' : 'Docs to video';
          ctx.out.warn(`${what} runs on a landscape video; converting to ${format} afterwards.`);
        }
        const outline = flags.outlineFile ? await readOutlineFile(flags.outlineFile, ctx.io.cwd) : undefined;
        const design = flags.design ? parsePositiveInt(flags.design, '--design') : undefined;
        if ((outline || design) && !prompt)
          throw new UsageError('--outline-file and --design only apply with --prompt (the AI storyboard).');
        // The storyboard, templates and Slides/Docs import run in landscape: create landscape, convert after.
        const createFormat: VideoFormat = prompt || landscapeOnly ? 'landscape' : format;

        const result = await withAutomation(ctx, 'Creating video', async (auto) => {
          // Vids disables the storyboard once a video is renamed/edited, so the title is set afterwards.
          const created = await auto.create({
            format: createFormat,
            mode,
            ...(title && !prompt ? { title } : {}),
          });
          try {
            let storyboard;
            if (prompt) {
              storyboard = await auto.storyboard(created.id, {
                prompt,
                timeoutMs: ctx.timeoutMs(ctx.config.ai.timeoutMs),
                ...(outline ? { outline } : {}),
                ...(design ? { design } : {}),
              });
              if (title) await auto.rename(created.id, title);
            }
            if (createFormat !== format) await auto.setFormat(created.id, format);
            // A blank video without a title is not saved to Drive until its first edit.
            if (mode.kind === 'blank' && !prompt && !title) await auto.saveToDrive(created.id);
            const editor = await auto.editor(created.id);
            return {
              ...(await auto.summary(editor)),
              format,
              mode: prompt ? 'storyboard' : mode.kind,
              ...(storyboard ? { storyboard } : {}),
            };
          } catch (err) {
            // The video exists already: report it so the agent can retry on it or remove it.
            throw withContext(toGvidsError(err), {
              details: { createdVideo: { id: created.id, url: created.url } },
              hint: [`The video ${created.id} was created before this step failed.`],
            });
          }
        });
        const folder = await moveIfRequested(ctx, result.id, flags.folder);
        if (flags.open) await ctx.openUrl(vidEditUrl(result.id));
        ctx.out.result({ ...result, ...(folder ? { folder } : {}) }, (r) =>
          [
            `Created "${r.title}" (${r.id}) — ${r.scenes} scene${r.scenes === 1 ? '' : 's'}, ${r.format}`,
            r.url,
          ].join('\n'),
        );
      }),
    );
}
