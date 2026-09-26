import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BrowserSession } from '../browser/session.js';
import { FeatureUnavailableError, GvidsError } from '../errors/errors.js';
import { pathExists } from '../utils/fs.js';

/**
 * MP4 -> GIF conversion on this computer, for videos Vids will not export as GIF
 * (it refuses videos longer than 30 seconds). ffmpeg is used when installed;
 * otherwise the gvids Chrome decodes the video and a small JS encoder (gifenc)
 * writes the GIF, so it works without extra software.
 */
export interface GifOptions {
  /** Frames per second (default 10). */
  fps: number;
  /** Width in pixels; height keeps the aspect ratio (default 640). */
  width: number;
}

/** ffmpeg from GVIDS_FFMPEG or the PATH. */
export async function findFfmpeg(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.GVIDS_FFMPEG) return (await pathExists(env.GVIDS_FFMPEG)) ? env.GVIDS_FFMPEG : undefined;
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function mp4ToGifWithFfmpeg(
  ffmpeg: string,
  input: string,
  output: string,
  options: GifOptions,
): Promise<void> {
  // Two passes in one graph: build a palette from the whole clip, then map every frame to it.
  const filter = `fps=${options.fps},scale=${options.width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vf', filter, '-loop', '0', output];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new GvidsError(
              `ffmpeg could not convert the video to GIF: ${stderr.trim().slice(0, 400) || `exit code ${code}`}`,
            ),
          ),
    );
  });
}

function gifencSource(): Promise<string> {
  const require = createRequire(import.meta.url);
  return fs.readFile(require.resolve('gifenc/dist/gifenc.js'), 'utf8');
}

/** Converts in the gvids browser (Chrome decodes H.264; gifenc quantizes and encodes each frame). */
export async function mp4ToGifInBrowser(
  session: BrowserSession,
  input: string,
  output: string,
  options: GifOptions,
  timeoutMs: number,
): Promise<void> {
  const page = await session.newPage();
  const origin = 'https://gvids.local';
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/in.mp4') return route.fulfill({ path: input, contentType: 'video/mp4' });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>gvids GIF</title>' });
  });
  await page.goto(`${origin}/`);
  await page.addScriptTag({
    content: `var exports = {};\n${await gifencSource()}\nwindow.__gifenc = exports;`,
  });
  const download = page.waitForEvent('download', { timeout: timeoutMs });
  download.catch(() => undefined);
  const problem = await page.evaluate(async ({ fps, width }) => {
    type Enc = {
      GIFEncoder: () => {
        writeFrame(index: Uint8Array, w: number, h: number, o: { palette: number[][]; delay: number }): void;
        finish(): void;
        bytes(): Uint8Array;
      };
      quantize(data: Uint8ClampedArray, colors: number): number[][];
      applyPalette(data: Uint8ClampedArray, palette: number[][]): Uint8Array;
    };
    const enc = (window as unknown as { __gifenc: Enc }).__gifenc;
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    // A blob URL is fully seekable (the local route serves no byte ranges).
    video.src = URL.createObjectURL(await (await fetch('/in.mp4')).blob());
    const ok = await new Promise<boolean>((resolve) => {
      video.onloadeddata = () => resolve(true);
      video.onerror = () => resolve(false);
    });
    if (!ok || !video.videoWidth) return 'decode';
    const w = Math.min(width, video.videoWidth) & ~1;
    const h = Math.max(2, Math.round((video.videoHeight * w) / video.videoWidth) & ~1);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const gif = enc.GIFEncoder();
    const delay = Math.round(1000 / fps);
    const seek = (t: number): Promise<void> =>
      new Promise((resolve) => {
        if (Math.abs(video.currentTime - t) < 0.0005) return resolve();
        video.addEventListener('seeked', () => resolve(), { once: true });
        video.currentTime = t;
      });
    const frames = Math.max(1, Math.floor(video.duration * fps));
    for (let i = 0; i < frames; i++) {
      await seek(Math.min(video.duration - 0.001, i / fps));
      ctx.drawImage(video, 0, 0, w, h);
      const { data } = ctx.getImageData(0, 0, w, h);
      const palette = enc.quantize(data, 256);
      gif.writeFrame(enc.applyPalette(data, palette), w, h, { palette, delay });
    }
    gif.finish();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gif.bytes() as BlobPart], { type: 'image/gif' }));
    a.download = 'out.gif';
    document.body.appendChild(a);
    a.click();
    return undefined;
  }, options);
  try {
    if (problem === 'decode') {
      throw new FeatureUnavailableError(
        'This browser cannot decode the MP4 (H.264), so it cannot make the GIF.',
        {
          hint: ['Install ffmpeg (e.g. winget install ffmpeg), or use Google Chrome for gvids.'],
        },
      );
    }
    const file = await download;
    await file.saveAs(output);
  } finally {
    await page.close().catch(() => undefined);
  }
}
