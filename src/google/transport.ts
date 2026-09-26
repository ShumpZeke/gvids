import { drive as createDrive, type drive_v3 } from '@googleapis/drive';
import type { AuthClient } from 'google-auth-library';
import { DownloadError } from '../errors/errors.js';
import type { DriveFileResource, DrivePermissionResource } from './files.js';

/** A Drive long-running operation (files.download). */
export interface DriveOperation {
  name?: string | null;
  done?: boolean | null;
  error?: { code?: number | null; message?: string | null } | null;
  response?: {
    '@type'?: string;
    downloadUri?: string | null;
    partialDownloadAllowed?: boolean | null;
    [key: string]: unknown;
  } | null;
  metadata?: Record<string, unknown> | null;
}

export interface ListFilesParams {
  q: string;
  pageSize: number;
  pageToken?: string;
  orderBy?: string;
  fields: string;
  corpora?: 'user' | 'drive' | 'allDrives';
  driveId?: string;
}

export interface AboutInfo {
  user?: { emailAddress?: string | null; displayName?: string | null } | null;
  storageQuota?: { limit?: string | null; usage?: string | null } | null;
}

/**
 * The narrow set of Drive REST calls gvids makes. The production
 * implementation wraps @googleapis/drive; tests supply an in-memory fake.
 * Every call sets supportsAllDrives so shared drives work.
 */
export interface DriveTransport {
  listFiles(params: ListFilesParams): Promise<{ files: DriveFileResource[]; nextPageToken?: string }>;
  getFile(id: string, fields: string, resourceKey?: string): Promise<DriveFileResource>;
  createFile(
    body: { name: string; mimeType: string; parents?: string[] },
    fields: string,
  ): Promise<DriveFileResource>;
  updateFile(
    id: string,
    body: { name?: string; trashed?: boolean; starred?: boolean },
    params: { addParents?: string; removeParents?: string; fields: string },
  ): Promise<DriveFileResource>;
  copyFile(
    id: string,
    body: { name?: string; parents?: string[] },
    fields: string,
  ): Promise<DriveFileResource>;
  deleteFile(id: string): Promise<void>;
  listPermissions(id: string, fields: string): Promise<DrivePermissionResource[]>;
  createPermission(
    id: string,
    body: {
      type: string;
      role: string;
      emailAddress?: string;
      domain?: string;
      allowFileDiscovery?: boolean;
    },
    options: { sendNotificationEmail?: boolean; emailMessage?: string; fields: string },
  ): Promise<DrivePermissionResource>;
  updatePermission(
    id: string,
    permissionId: string,
    body: { role: string },
    fields: string,
  ): Promise<DrivePermissionResource>;
  deletePermission(id: string, permissionId: string): Promise<void>;
  startDownload(
    id: string,
    params: { mimeType?: string; revisionId?: string; resourceKey?: string },
  ): Promise<DriveOperation>;
  getOperation(name: string): Promise<DriveOperation>;
  /** Authorized GET for URLs Drive hands back (download URIs, thumbnails). */
  fetchAuthorized(
    url: string,
    init?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<Response>;
  about(): Promise<AboutInfo>;
  listRevisions(id: string, fields: string): Promise<DriveRevisionResource[]>;
  listComments(id: string, fields: string): Promise<DriveCommentResource[]>;
  createComment(id: string, body: { content: string }, fields: string): Promise<DriveCommentResource>;
  createReply(
    id: string,
    commentId: string,
    body: { content?: string; action?: 'resolve' | 'reopen' },
    fields: string,
  ): Promise<DriveReplyResource>;
}

export interface DriveRevisionResource {
  id?: string | null;
  modifiedTime?: string | null;
  keepForever?: boolean | null;
  lastModifyingUser?: { displayName?: string | null; emailAddress?: string | null } | null;
}

export interface DriveReplyResource {
  id?: string | null;
  content?: string | null;
  action?: string | null;
  createdTime?: string | null;
  author?: { displayName?: string | null; emailAddress?: string | null } | null;
}

export interface DriveCommentResource extends DriveReplyResource {
  modifiedTime?: string | null;
  resolved?: boolean | null;
  deleted?: boolean | null;
  quotedFileContent?: { value?: string | null } | null;
  replies?: DriveReplyResource[] | null;
}

/** Only idempotent methods are retried automatically. */
const RETRY_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'];
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

interface RetryableError {
  code?: string;
  config?: {
    method?: string;
    signal?: { aborted?: boolean };
    retryConfig?: { retry?: number; currentRetryAttempt?: number; noResponseRetries?: number };
  };
  response?: { status?: number; data?: { error?: { errors?: Array<{ reason?: string }> } } };
}

/**
 * Retry policy for Drive calls: network errors, 429 and 5xx as usual, plus 403
 * "rateLimitExceeded"/"userRateLimitExceeded" (Drive reports its per-user limits,
 * e.g. on comments, as 403). Only idempotent methods are retried.
 */
export function shouldRetryDriveRequest(err: RetryableError): boolean {
  const config = err.config?.retryConfig;
  if (!config || !config.retry) return false;
  if (err.code === 'AbortError' || (err.config?.signal?.aborted && err.code !== 'TimeoutError')) return false;
  if (!RETRY_METHODS.includes((err.config?.method ?? 'GET').toUpperCase())) return false;
  const attempt = config.currentRetryAttempt ?? 0;
  if (attempt >= config.retry) return false;
  if (!err.response) return attempt < (config.noResponseRetries ?? 2);
  const status = err.response.status ?? 0;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status === 403) {
    return (err.response.data?.error?.errors ?? []).some((e) => RATE_LIMIT_REASONS.has(e.reason ?? ''));
  }
  return false;
}

const RETRY_CONFIG = {
  retry: 5,
  noResponseRetries: 2,
  httpMethodsToRetry: RETRY_METHODS,
  statusCodesToRetry: [
    [403, 403],
    [429, 429],
    [500, 599],
  ] as Array<[number, number]>,
  shouldRetry: shouldRetryDriveRequest,
};

/** Hosts that may receive the OAuth bearer token (Drive download URIs and thumbnails). */
const TOKEN_HOSTS = /(^|\.)(googleapis\.com|google\.com|googleusercontent\.com)$/i;

/** Refuses to send the access token anywhere but Google over HTTPS. */
export function assertGoogleUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError(`Drive returned an invalid URL: ${url}`, { retryable: false });
  }
  if (parsed.protocol !== 'https:' || !TOKEN_HOSTS.test(parsed.hostname)) {
    throw new DownloadError(
      `Refusing to send Google credentials to ${parsed.protocol}//${parsed.hostname}.`,
      {
        retryable: false,
      },
    );
  }
}

function resourceKeyHeader(id: string, resourceKey?: string): Record<string, string> | undefined {
  return resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : undefined;
}

export class GoogleDriveTransport implements DriveTransport {
  private readonly drive: drive_v3.Drive;

  constructor(private readonly auth: AuthClient) {
    this.drive = createDrive({
      version: 'v3',
      auth: auth as unknown as drive_v3.Options['auth'],
      retryConfig: RETRY_CONFIG,
    } as drive_v3.Options);
  }

  async listFiles(params: ListFilesParams): Promise<{ files: DriveFileResource[]; nextPageToken?: string }> {
    const res = await this.drive.files.list({
      q: params.q,
      pageSize: params.pageSize,
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      ...(params.orderBy ? { orderBy: params.orderBy } : {}),
      fields: params.fields,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: params.corpora ?? (params.driveId ? 'drive' : 'allDrives'),
      ...(params.driveId ? { driveId: params.driveId } : {}),
    });
    return {
      files: (res.data.files ?? []) as DriveFileResource[],
      ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
    };
  }

  async getFile(id: string, fields: string, resourceKey?: string): Promise<DriveFileResource> {
    const headers = resourceKeyHeader(id, resourceKey);
    const res = await this.drive.files.get(
      { fileId: id, fields, supportsAllDrives: true },
      headers ? { headers } : {},
    );
    return res.data as DriveFileResource;
  }

  async createFile(
    body: { name: string; mimeType: string; parents?: string[] },
    fields: string,
  ): Promise<DriveFileResource> {
    const res = await this.drive.files.create({ requestBody: body, fields, supportsAllDrives: true });
    return res.data as DriveFileResource;
  }

  async updateFile(
    id: string,
    body: { name?: string; trashed?: boolean; starred?: boolean },
    params: { addParents?: string; removeParents?: string; fields: string },
  ): Promise<DriveFileResource> {
    const res = await this.drive.files.update({
      fileId: id,
      requestBody: body,
      fields: params.fields,
      supportsAllDrives: true,
      ...(params.addParents ? { addParents: params.addParents } : {}),
      ...(params.removeParents ? { removeParents: params.removeParents } : {}),
    });
    return res.data as DriveFileResource;
  }

  async copyFile(
    id: string,
    body: { name?: string; parents?: string[] },
    fields: string,
  ): Promise<DriveFileResource> {
    const res = await this.drive.files.copy({
      fileId: id,
      requestBody: body,
      fields,
      supportsAllDrives: true,
    });
    return res.data as DriveFileResource;
  }

  async deleteFile(id: string): Promise<void> {
    await this.drive.files.delete({ fileId: id, supportsAllDrives: true });
  }

  async listPermissions(id: string, fields: string): Promise<DrivePermissionResource[]> {
    const out: DrivePermissionResource[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.permissions.list({
        fileId: id,
        fields: `nextPageToken,permissions(${fields})`,
        supportsAllDrives: true,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      out.push(...((res.data.permissions ?? []) as DrivePermissionResource[]));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async createPermission(
    id: string,
    body: {
      type: string;
      role: string;
      emailAddress?: string;
      domain?: string;
      allowFileDiscovery?: boolean;
    },
    options: { sendNotificationEmail?: boolean; emailMessage?: string; fields: string },
  ): Promise<DrivePermissionResource> {
    const res = await this.drive.permissions.create({
      fileId: id,
      requestBody: body,
      fields: options.fields,
      supportsAllDrives: true,
      ...(options.sendNotificationEmail !== undefined
        ? { sendNotificationEmail: options.sendNotificationEmail }
        : {}),
      ...(options.emailMessage ? { emailMessage: options.emailMessage } : {}),
    });
    return res.data as DrivePermissionResource;
  }

  async updatePermission(
    id: string,
    permissionId: string,
    body: { role: string },
    fields: string,
  ): Promise<DrivePermissionResource> {
    const res = await this.drive.permissions.update({
      fileId: id,
      permissionId,
      requestBody: body,
      fields,
      supportsAllDrives: true,
    });
    return res.data as DrivePermissionResource;
  }

  async deletePermission(id: string, permissionId: string): Promise<void> {
    await this.drive.permissions.delete({ fileId: id, permissionId, supportsAllDrives: true });
  }

  async startDownload(
    id: string,
    params: { mimeType?: string; revisionId?: string; resourceKey?: string },
  ): Promise<DriveOperation> {
    const headers = resourceKeyHeader(id, params.resourceKey);
    const res = await this.drive.files.download(
      {
        fileId: id,
        ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        ...(params.revisionId ? { revisionId: params.revisionId } : {}),
      },
      headers ? { headers } : {},
    );
    return res.data as DriveOperation;
  }

  async getOperation(name: string): Promise<DriveOperation> {
    const res = await this.drive.operations.get({ name });
    return res.data as DriveOperation;
  }

  async fetchAuthorized(
    url: string,
    init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    assertGoogleUrl(url);
    const { token } = await this.auth.getAccessToken();
    return fetch(url, {
      headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: 'follow',
      ...(init.signal ? { signal: init.signal } : {}),
    });
  }

  async about(): Promise<AboutInfo> {
    const res = await this.drive.about.get({
      fields: 'user(displayName,emailAddress),storageQuota(limit,usage)',
    });
    return res.data as AboutInfo;
  }

  async listRevisions(id: string, fields: string): Promise<DriveRevisionResource[]> {
    const out: DriveRevisionResource[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.revisions.list({
        fileId: id,
        fields: `nextPageToken,revisions(${fields})`,
        pageSize: 200,
        ...(pageToken ? { pageToken } : {}),
      });
      out.push(...((res.data.revisions ?? []) as DriveRevisionResource[]));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async listComments(id: string, fields: string): Promise<DriveCommentResource[]> {
    const out: DriveCommentResource[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.comments.list({
        fileId: id,
        fields: `nextPageToken,comments(${fields})`,
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      out.push(...((res.data.comments ?? []) as DriveCommentResource[]));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async createComment(id: string, body: { content: string }, fields: string): Promise<DriveCommentResource> {
    const res = await this.drive.comments.create({ fileId: id, requestBody: body, fields });
    return res.data as DriveCommentResource;
  }

  async createReply(
    id: string,
    commentId: string,
    body: { content?: string; action?: 'resolve' | 'reopen' },
    fields: string,
  ): Promise<DriveReplyResource> {
    const res = await this.drive.replies.create({ fileId: id, commentId, requestBody: body, fields });
    return res.data as DriveReplyResource;
  }
}
