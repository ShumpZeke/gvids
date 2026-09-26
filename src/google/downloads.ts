import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DownloadError, GenerationTimeoutError, GvidsError, UsageError } from '../errors/errors.js';
import { mapGoogleApiError } from '../errors/map.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { poll } from '../utils/time.js';
import type { DriveOperation, DriveTransport } from './transport.js';

export const VIDS_DOWNLOAD_MIME = 'video/mp4';

export type DownloadPhase = 'requesting' | 'rendering' | 'downloading' | 'done';

export interface DownloadProgress {
  phase: DownloadPhase;
  elapsedMs: number;
  bytes?: number;
  totalBytes?: number;
  percent?: number;
  operation?: string;
}

export interface DownloadOptions {
  mimeType?: string;
  resourceKey?: string;
  revisionId?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  mimeType: string;
  operation?: string;
  renderMs: number;
  transferMs: number;
}

/**
 * Downloads a rendered Google Vids file through the Drive API.
 *
 * Vids cannot be exported with files.export (Drive answers fileNotExportable).
 * The documented path is files.download, which returns a long-running
 * operation: poll operations.get until done, then GET response.downloadUri
 * with the same OAuth credentials.
 */
export async function downloadRendered(
  transport: DriveTransport,
  fileId: string,
  destination: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const mimeType = options.mimeType ?? VIDS_DOWNLOAD_MIME;
  const target = path.resolve(destination);
  if (!options.overwrite && (await pathExists(target))) {
    throw new UsageError(`${target} already exists.`, {
      hint: 'Pass --overwrite to replace it, or choose another path.',
    });
  }
  await ensureDir(path.dirname(target));

  const started = Date.now();
  const report = (p: Omit<DownloadProgress, 'elapsedMs'>): void =>
    options.onProgress?.({ ...p, elapsedMs: Date.now() - started });

  report({ phase: 'requesting' });
  let operation: DriveOperation;
  try {
    operation = await transport.startDownload(fileId, {
      mimeType,
      ...(options.resourceKey ? { resourceKey: options.resourceKey } : {}),
      ...(options.revisionId ? { revisionId: options.revisionId } : {}),
    });
  } catch (err) {
    throw mapGoogleApiError(err, { fileId, action: 'start the MP4 render' });
  }

  const operationName = operation.name ?? undefined;
  // Per the Drive docs, only poll when the first response is not already done.
  if (!operation.done) {
    if (!operationName)
      throw new DownloadError('Drive returned a pending download operation without a name.');
    operation = await poll<DriveOperation>({
      check: async () => {
        try {
          return await transport.getOperation(operationName);
        } catch (err) {
          throw mapGoogleApiError(err, { fileId, action: 'check the render status' });
        }
      },
      done: (op) => op.done === true,
      timeoutMs: options.timeoutMs,
      initialIntervalMs: options.pollIntervalMs,
      maxIntervalMs: Math.max(options.pollIntervalMs, 20_000),
      backoff: 1.4,
      ...(options.signal ? { signal: options.signal } : {}),
      onTick: () => report({ phase: 'rendering', operation: operationName }),
      onTimeout: () =>
        new GenerationTimeoutError('The MP4 render', options.timeoutMs, {
          details: { operation: operationName },
        }),
    });
  }
  const renderMs = Date.now() - started;

  if (operation.error) {
    throw new DownloadError(
      `Drive could not render the video: ${operation.error.message ?? 'unknown error'}`,
      {
        details: { operation: operationName, code: operation.error.code },
      },
    );
  }
  const uri = operation.response?.downloadUri;
  if (!uri) {
    throw new DownloadError('Drive finished the operation but returned no download URI.', {
      details: { operation: operationName },
    });
  }

  const transferStart = Date.now();
  let response: Response;
  try {
    response = await transport.fetchAuthorized(uri, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.resourceKey
        ? { headers: { 'X-Goog-Drive-Resource-Keys': `${fileId}/${options.resourceKey}` } }
        : {}),
    });
  } catch (err) {
    throw err instanceof GvidsError
      ? err
      : new DownloadError(`Download request failed: ${String(err)}`, { cause: err });
  }
  if (!response.ok || !response.body) {
    throw new DownloadError(`Downloading the rendered file failed with HTTP ${response.status}.`, {
      details: { status: response.status },
    });
  }

  const totalHeader = response.headers.get('content-length');
  const totalBytes = totalHeader ? Number(totalHeader) : undefined;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      report({
        phase: 'downloading',
        bytes,
        ...(totalBytes ? { totalBytes, percent: (bytes / totalBytes) * 100 } : {}),
      });
      cb(null, chunk);
    },
  });
  const partial = `${target}.gvids-part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      counter,
      createWriteStream(partial),
    );
    if (totalBytes !== undefined && bytes !== totalBytes) {
      throw new DownloadError(`Download was truncated (${bytes} of ${totalBytes} bytes).`);
    }
    await fs.rm(target, { force: true });
    await fs.rename(partial, target);
  } catch (err) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    if (err instanceof GvidsError) throw err;
    throw new DownloadError(`Writing ${target} failed: ${String(err)}`, { cause: err });
  }
  report({ phase: 'done', bytes, ...(totalBytes ? { totalBytes, percent: 100 } : {}) });
  return {
    path: target,
    bytes,
    mimeType,
    ...(operationName ? { operation: operationName } : {}),
    renderMs,
    transferMs: Date.now() - transferStart,
  };
}

/**
 * Downloads a regular (non-Google-native) Drive file's bytes with
 * files.get?alt=media. Used to bring Drive media into the editor.
 */
export async function downloadBlob(
  transport: DriveTransport,
  fileId: string,
  destination: string,
): Promise<{ path: string; bytes: number }> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await transport.fetchAuthorized(url);
  if (!res.ok || !res.body)
    throw new DownloadError(`Downloading Drive file ${fileId} failed with HTTP ${res.status}.`);
  await ensureDir(path.dirname(destination));
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
    counter,
    createWriteStream(destination),
  );
  return { path: destination, bytes };
}

/** Downloads a thumbnail image (thumbnailLink) for a file. */
export async function downloadThumbnail(
  transport: DriveTransport,
  thumbnailLink: string,
  destination: string,
  options: { size?: number; overwrite?: boolean } = {},
): Promise<{ path: string; bytes: number; contentType: string }> {
  const target = path.resolve(destination);
  if (!options.overwrite && (await pathExists(target))) {
    throw new UsageError(`${target} already exists.`, { hint: 'Pass --overwrite to replace it.' });
  }
  // thumbnailLink ends with "=s220"; request a larger rendition when asked.
  const url = options.size ? thumbnailLink.replace(/=s\d+$/, `=s${options.size}`) : thumbnailLink;
  const res = await transport.fetchAuthorized(url);
  if (!res.ok) throw new DownloadError(`Fetching the thumbnail failed with HTTP ${res.status}.`);
  const data = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(target));
  await fs.writeFile(target, data);
  return { path: target, bytes: data.length, contentType: res.headers.get('content-type') ?? 'image/png' };
}
