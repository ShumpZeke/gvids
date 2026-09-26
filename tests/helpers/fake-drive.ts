import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriveFileResource, DrivePermissionResource } from '../../src/google/files.js';
import type {
  AboutInfo,
  DriveCommentResource,
  DriveOperation,
  DriveReplyResource,
  DriveRevisionResource,
  DriveTransport,
  ListFilesParams,
} from '../../src/google/transport.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(here, '..', 'fixtures', name), 'utf8')) as T;
}

export class ApiError extends Error {
  response: { status: number; data: unknown };
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.response = { status, data: { error: { code: status, message, errors: [{ reason, message }] } } };
  }
}

/**
 * In-memory Drive used by unit tests. Implements just enough of the query
 * language (mimeType / trashed / name contains / parents / owners) to exercise
 * the service layer, and records every call for assertions.
 */
export class FakeDriveTransport implements DriveTransport {
  files: DriveFileResource[];
  permissions = new Map<string, DrivePermissionResource[]>();
  calls: Array<{ method: string; args: unknown[] }> = [];
  pageSize = 2;
  /** Sequence of operations returned by startDownload/getOperation. */
  operations: DriveOperation[] = [];
  downloadBody = Buffer.from('fake mp4 bytes');
  failNext: Error | undefined;

  constructor() {
    this.files = fixture<DriveFileResource[]>('drive/files.json');
    this.permissions.set(this.files[0]!.id!, fixture<DrivePermissionResource[]>('drive/permissions.json'));
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
  }

  private find(id: string): DriveFileResource {
    const f = this.files.find((x) => x.id === id);
    if (!f) throw new ApiError(404, 'notFound', `File not found: ${id}.`);
    return f;
  }

  private matches(file: DriveFileResource, q: string): boolean {
    const mime = /mimeType='([^']+)'/.exec(q)?.[1];
    if (mime && file.mimeType !== mime) return false;
    const trashed = /trashed=(true|false)/.exec(q)?.[1];
    if (trashed && Boolean(file.trashed) !== (trashed === 'true')) return false;
    const name = /name contains '((?:\\'|[^'])+)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
    if (name && !file.name?.toLowerCase().includes(name.toLowerCase())) return false;
    const exactName = /(?:^|\s)name='((?:\\'|[^'])+)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
    if (exactName !== undefined && file.name !== exactName) return false;
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    if (parent && !(file.parents ?? []).includes(parent)) return false;
    const owner = /'([^']+)' in owners/.exec(q)?.[1];
    if (owner === 'me' && !file.owners?.some((o) => o.me)) return false;
    if (owner && owner !== 'me' && !file.owners?.some((o) => o.emailAddress === owner)) return false;
    if (/starred=true/.test(q) && !file.starred) return false;
    return true;
  }

  async listFiles(params: ListFilesParams): Promise<{ files: DriveFileResource[]; nextPageToken?: string }> {
    this.record('listFiles', params);
    const all = this.files.filter((f) => this.matches(f, params.q));
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const size = Math.min(params.pageSize, this.pageSize);
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;
    return { files: structuredClone(page), ...(next ? { nextPageToken: next } : {}) };
  }

  async getFile(id: string): Promise<DriveFileResource> {
    this.record('getFile', id);
    return structuredClone(this.find(id));
  }

  async createFile(body: { name: string; mimeType: string; parents?: string[] }): Promise<DriveFileResource> {
    this.record('createFile', body);
    const file: DriveFileResource = {
      id: `1Created${this.files.length}CreatedCreatedCreated0000`,
      name: body.name,
      mimeType: body.mimeType,
      parents: body.parents ?? ['root'],
      owners: [{ me: true, emailAddress: 'owner@example.com' }],
    };
    this.files.push(file);
    return structuredClone(file);
  }

  async updateFile(
    id: string,
    body: { name?: string; trashed?: boolean; starred?: boolean },
    params: { addParents?: string; removeParents?: string; fields: string },
  ): Promise<DriveFileResource> {
    this.record('updateFile', id, body, params);
    const f = this.find(id);
    if (body.name !== undefined) f.name = body.name;
    if (body.trashed !== undefined) f.trashed = body.trashed;
    if (params.removeParents)
      f.parents = (f.parents ?? []).filter((p) => !params.removeParents!.split(',').includes(p));
    if (params.addParents) f.parents = [...(f.parents ?? []), params.addParents];
    return structuredClone(f);
  }

  async copyFile(id: string, body: { name?: string; parents?: string[] }): Promise<DriveFileResource> {
    this.record('copyFile', id, body);
    const src = this.find(id);
    const copy: DriveFileResource = {
      ...structuredClone(src),
      id: `1Copy${this.files.length}CopyCopyCopyCopyCopyCopy00`,
      name: body.name ?? `Copy of ${src.name}`,
      parents: body.parents ?? src.parents ?? null,
    };
    this.files.push(copy);
    return structuredClone(copy);
  }

  async deleteFile(id: string): Promise<void> {
    this.record('deleteFile', id);
    this.find(id);
    this.files = this.files.filter((f) => f.id !== id);
  }

  async listPermissions(id: string): Promise<DrivePermissionResource[]> {
    this.record('listPermissions', id);
    this.find(id);
    return structuredClone(this.permissions.get(id) ?? []);
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
    this.record('createPermission', id, body, options);
    const perm: DrivePermissionResource = { id: `perm-${Math.random().toString(36).slice(2, 8)}`, ...body };
    this.permissions.set(id, [...(this.permissions.get(id) ?? []), perm]);
    return structuredClone(perm);
  }

  async updatePermission(
    id: string,
    permissionId: string,
    body: { role: string },
  ): Promise<DrivePermissionResource> {
    this.record('updatePermission', id, permissionId, body);
    const perm = (this.permissions.get(id) ?? []).find((p) => p.id === permissionId);
    if (!perm) throw new ApiError(404, 'notFound', 'Permission not found');
    perm.role = body.role;
    return structuredClone(perm);
  }

  async deletePermission(id: string, permissionId: string): Promise<void> {
    this.record('deletePermission', id, permissionId);
    this.permissions.set(
      id,
      (this.permissions.get(id) ?? []).filter((p) => p.id !== permissionId),
    );
  }

  async startDownload(
    id: string,
    params: { mimeType?: string; revisionId?: string },
  ): Promise<DriveOperation> {
    this.record('startDownload', id, params);
    this.find(id);
    return structuredClone(this.operations.shift() ?? fixture<DriveOperation>('drive/operation-done.json'));
  }

  async getOperation(name: string): Promise<DriveOperation> {
    this.record('getOperation', name);
    return structuredClone(this.operations.shift() ?? fixture<DriveOperation>('drive/operation-done.json'));
  }

  async fetchAuthorized(url: string): Promise<Response> {
    this.record('fetchAuthorized', url);
    if (url.includes('thumb'))
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    return new Response(this.downloadBody, {
      headers: { 'content-length': String(this.downloadBody.length) },
    });
  }

  async about(): Promise<AboutInfo> {
    this.record('about');
    return {
      user: { emailAddress: 'owner@example.com', displayName: 'Test User' },
      storageQuota: { usage: '100', limit: '1000' },
    };
  }

  revisions = new Map<string, DriveRevisionResource[]>();
  comments = new Map<string, DriveCommentResource[]>();

  async listRevisions(id: string): Promise<DriveRevisionResource[]> {
    this.record('listRevisions', id);
    this.find(id);
    return structuredClone(this.revisions.get(id) ?? []);
  }

  async listComments(id: string): Promise<DriveCommentResource[]> {
    this.record('listComments', id);
    this.find(id);
    return structuredClone(this.comments.get(id) ?? []);
  }

  async createComment(id: string, body: { content: string }): Promise<DriveCommentResource> {
    this.record('createComment', id, body);
    this.find(id);
    const c: DriveCommentResource = {
      id: `c${(this.comments.get(id) ?? []).length + 1}`,
      content: body.content,
      resolved: false,
      createdTime: '2026-09-24T00:00:00.000Z',
      author: { displayName: 'Test User' },
      replies: [],
    };
    this.comments.set(id, [...(this.comments.get(id) ?? []), c]);
    return structuredClone(c);
  }

  async createReply(
    id: string,
    commentId: string,
    body: { content?: string; action?: 'resolve' | 'reopen' },
  ): Promise<DriveReplyResource> {
    this.record('createReply', id, commentId, body);
    const c = (this.comments.get(id) ?? []).find((x) => x.id === commentId);
    if (!c) throw new ApiError(404, 'notFound', 'Comment not found');
    const r: DriveReplyResource = {
      id: `${commentId}-r${(c.replies ?? []).length + 1}`,
      content: body.content ?? '',
      ...(body.action ? { action: body.action } : {}),
    };
    c.replies = [...(c.replies ?? []), r];
    if (body.action) c.resolved = body.action === 'resolve';
    return structuredClone(r);
  }
}
