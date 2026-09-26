import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { AuthError, UsageError } from '../../errors/errors.js';
import { downloadRendered, VIDS_DOWNLOAD_MIME, type DownloadProgress } from '../../google/downloads.js';
import { isDirectory, pathExists, sanitizeFileName } from '../../utils/fs.js';
import { formatDuration } from '../../utils/time.js';
import { parseResource, parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { fallbackWarning } from '../fallback.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { formatBytes } from '../output/format.js';

export interface DownloadFlags {
  overwrite?: boolean;
  revision?: string;
}

/** Picks the output path: explicit file, explicit directory, or <downloads.directory>/<title>.mp4. */
export async function resolveOutputPath(
  ctx: CommandContext,
  title: string,
  output: string | undefined,
  extension: string,
): Promise<string> {
  const fileName = `${sanitizeFileName(title)}${extension}`;
  if (!output) return path.resolve(ctx.io.cwd, ctx.config.downloads.directory, fileName);
  const resolved = path.resolve(ctx.io.cwd, output);
  if ((await isDirectory(resolved)) || /[\\/]$/.test(output)) return path.join(resolved, fileName);
  return path.extname(resolved) ? resolved : `${resolved}${extension}`;
}

/** Shared by `download`, `export --format mp4` and workflows. */
export async function downloadMp4(
  ctx: CommandContext,
  idArg: string,
  output: string | undefined,
  flags: DownloadFlags,
): Promise<{ id: string; name: string; path: string; bytes: number; renderMs: number; transferMs: number }> {
  const parsed = parseResource(idArg);
  const drive = await ctx.drive();
  const file = await drive.get(parsed.id, parsed.resourceKey ? { resourceKey: parsed.resourceKey } : {});
  const target = await resolveOutputPath(ctx, file.name, output, '.mp4');
  const progress = ctx.out.progress('Preparing render…');
  let phase: DownloadProgress['phase'] | undefined;
  try {
    const result = await downloadRendered(drive.transport, file.id, target, {
      mimeType: VIDS_DOWNLOAD_MIME,
      pollIntervalMs: ctx.config.downloads.pollIntervalMs,
      timeoutMs: ctx.timeoutMs(ctx.config.downloads.timeoutMs),
      ...(flags.overwrite ? { overwrite: true } : {}),
      ...(flags.revision ? { revisionId: flags.revision } : {}),
      ...((file.resourceKey ?? parsed.resourceKey)
        ? { resourceKey: file.resourceKey ?? parsed.resourceKey }
        : {}),
      onProgress: (p) => {
        if (p.phase !== phase) {
          phase = p.phase;
          if (p.phase === 'rendering') ctx.out.info('Rendering…');
          if (p.phase === 'downloading') ctx.out.info('Downloading…');
        }
        if (p.phase === 'rendering') progress.update(undefined);
        if (p.phase === 'downloading') progress.update(p.percent, p.bytes);
      },
    });
    progress.done('Download complete');
    return {
      id: file.id,
      name: file.name,
      path: result.path,
      bytes: result.bytes,
      renderMs: result.renderMs,
      transferMs: result.transferMs,
    };
  } catch (err) {
    progress.fail('Download failed');
    throw err;
  }
}

/**
 * Renders in the editor (File > Download) and saves the browser download. Used
 * for GIFs and when there is no OAuth login for the Drive API.
 */
export async function downloadViaEditor(
  ctx: CommandContext,
  idArg: string,
  output: string | undefined,
  format: 'mp4' | 'gif',
  flags: { overwrite?: boolean },
): Promise<{
  id: string;
  name: string;
  path: string;
  bytes: number;
  format: 'mp4' | 'gif';
  method: 'browser';
}> {
  const id = parseVidId(idArg);
  // An explicit file name can be checked before the (slow) editor opens; only a
  // directory or the default location needs the video title.
  if (output && !/[\\/]$/.test(output) && !(await isDirectory(path.resolve(ctx.io.cwd, output)))) {
    const target = await resolveOutputPath(ctx, 'video', output, `.${format}`);
    if (!flags.overwrite && (await pathExists(target))) {
      throw new UsageError(`${target} already exists.`, {
        hint: 'Pass --overwrite to replace it, or choose another path.',
      });
    }
  }
  const saved = await withAutomation(
    ctx,
    `Exporting ${format.toUpperCase()} in the editor (rendering can take a while)`,
    async (auto) => {
      const name = await (await auto.editor(id)).title();
      const target = await resolveOutputPath(ctx, name, output, `.${format}`);
      if (!flags.overwrite && (await pathExists(target))) {
        throw new UsageError(`${target} already exists.`, {
          hint: 'Pass --overwrite to replace it, or choose another path.',
        });
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const r = await auto.downloadViaUi(id, format, target, ctx.timeoutMs(ctx.config.downloads.timeoutMs));
      return { name, path: r.path };
    },
  );
  const { size } = await fs.stat(saved.path);
  return { id, name: saved.name, path: saved.path, bytes: size, format, method: 'browser' };
}

/**
 * A GIF of any length: downloads the MP4 (Drive API, or the editor without it) and
 * converts it here, with ffmpeg if installed or in the gvids browser otherwise.
 * GVIDS_GIF_ENGINE=ffmpeg|browser forces one of them.
 */
export async function gifViaLocalConversion(
  ctx: CommandContext,
  idArg: string,
  output: string | undefined,
  options: { fps: number; width: number; overwrite: boolean },
): Promise<{
  id: string;
  name: string;
  path: string;
  bytes: number;
  format: 'gif';
  method: 'local-ffmpeg' | 'local-browser';
  fps: number;
  width: number;
}> {
  const id = parseVidId(idArg);
  const { findFfmpeg, mp4ToGifInBrowser, mp4ToGifWithFfmpeg } = await import('../../media/gif.js');
  const engine = ctx.io.env.GVIDS_GIF_ENGINE?.toLowerCase();
  const ffmpeg = engine === 'browser' ? undefined : await findFfmpeg(ctx.io.env);
  if (engine === 'ffmpeg' && !ffmpeg) {
    throw new UsageError('GVIDS_GIF_ENGINE=ffmpeg, but ffmpeg was not found (PATH or GVIDS_FFMPEG).');
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gvids-gif-'));
  const mp4 = path.join(tmpDir, 'video.mp4');
  try {
    let name: string;
    try {
      name = (await downloadMp4(ctx, idArg, mp4, { overwrite: true })).name;
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      ctx.out.warn(fallbackWarning(err, 'rendering the MP4 with the editor’s File > Download'));
      name = (await downloadViaEditor(ctx, idArg, mp4, 'mp4', { overwrite: true })).name;
    }
    const target = await resolveOutputPath(ctx, name, output, '.gif');
    if (!options.overwrite && (await pathExists(target))) {
      throw new UsageError(`${target} already exists.`, {
        hint: 'Pass --overwrite to replace it, or choose another path.',
      });
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const spinner = ctx.out.spinner(`Converting to GIF (${ffmpeg ? 'ffmpeg' : 'browser'})…`);
    try {
      const gif = { fps: options.fps, width: options.width };
      if (ffmpeg) {
        await mp4ToGifWithFfmpeg(ffmpeg, mp4, target, gif);
      } else {
        const session = await ctx.browserSession();
        try {
          await mp4ToGifInBrowser(session, mp4, target, gif, ctx.timeoutMs(15 * 60_000));
        } finally {
          await session.close();
        }
      }
    } finally {
      spinner.stop();
    }
    const { size } = await fs.stat(target);
    return {
      id,
      name,
      path: target,
      bytes: size,
      format: 'gif',
      method: ffmpeg ? 'local-ffmpeg' : 'local-browser',
      fps: options.fps,
      width: options.width,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function registerDownloadCommands(program: Command, kit: Kit): void {
  program
    .command('download')
    .description(
      'Render and download a video as MP4 (Drive files.download API; without an OAuth login, the editor’s File > Download)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('[output]', 'output file or directory (default: downloads.directory/<title>.mp4)')
    .option('--overwrite', 'replace an existing file')
    .option('--revision <id>', 'download a specific revision')
    .addHelpText(
      'after',
      '\nThe render happens on Google’s side and can take minutes for long videos. Adjust with --timeout 30m.',
    )
    .action(
      action(kit, async (ctx, idArg: string, output: string | undefined, flags: DownloadFlags) => {
        try {
          const result = await downloadMp4(ctx, idArg, output, flags);
          ctx.out.result(
            { ...result, method: 'drive-api' },
            (r) =>
              `Saved: ${r.path} (${formatBytes(r.bytes)}, render ${formatDuration(r.renderMs)}, transfer ${formatDuration(r.transferMs)})`,
          );
        } catch (err) {
          // A specific revision can only be fetched through the API.
          if (!(err instanceof AuthError) || flags.revision) throw err;
          ctx.out.warn(fallbackWarning(err, 'rendering the MP4 with the editor’s File > Download'));
          const result = await downloadViaEditor(ctx, idArg, output, 'mp4', flags);
          ctx.out.result(result, (r) => `Saved: ${r.path} (${formatBytes(r.bytes)})`);
        }
      }),
    );
}
