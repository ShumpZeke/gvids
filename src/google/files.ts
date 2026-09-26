import { UsageError } from '../errors/errors.js';
import type { VidFile, VidPermission } from '../vids/types.js';
import { VIDS_MIME_TYPE, vidEditUrl } from '../vids/urls.js';

/** Fields requested for every file. Keeping one list keeps output stable. */
export const FILE_FIELDS = [
  'id',
  'name',
  'mimeType',
  'webViewLink',
  'createdTime',
  'modifiedTime',
  'viewedByMeTime',
  'owners(displayName,emailAddress,me)',
  'lastModifyingUser(displayName,emailAddress)',
  'parents',
  'starred',
  'trashed',
  'shared',
  'size',
  'thumbnailLink',
  'driveId',
  'resourceKey',
  'shortcutDetails(targetId,targetMimeType)',
  'videoMediaMetadata(durationMillis,width,height)',
  'capabilities(canEdit,canShare,canDownload,canCopy,canTrash,canDelete,canRename,canMoveItemWithinDrive)',
].join(',');

export const PERMISSION_FIELDS =
  'id,type,role,emailAddress,domain,displayName,allowFileDiscovery,expirationTime,deleted,pendingOwner';

/** Escapes a value for use inside a single-quoted Drive query string literal. */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export interface VidQuery {
  /** Substring match on the title. */
  name?: string;
  /** Full-text search (title, description, indexed content). */
  fullText?: string;
  folderId?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  createdAfter?: string;
  /** "me" or an e-mail address. */
  owner?: string;
  sharedWithMe?: boolean;
  starred?: boolean;
  /** Only trashed files (default: only non-trashed). */
  trashed?: boolean;
}

/** Builds a Drive `q` expression that always restricts results to Google Vids files. */
export function buildVidsQuery(query: VidQuery = {}): string {
  const clauses = [`mimeType='${VIDS_MIME_TYPE}'`, `trashed=${query.trashed ? 'true' : 'false'}`];
  if (query.name) clauses.push(`name contains '${escapeQueryValue(query.name)}'`);
  if (query.fullText) clauses.push(`fullText contains '${escapeQueryValue(query.fullText)}'`);
  if (query.folderId) clauses.push(`'${escapeQueryValue(query.folderId)}' in parents`);
  if (query.modifiedAfter) clauses.push(`modifiedTime > '${query.modifiedAfter}'`);
  if (query.modifiedBefore) clauses.push(`modifiedTime < '${query.modifiedBefore}'`);
  if (query.createdAfter) clauses.push(`createdTime > '${query.createdAfter}'`);
  if (query.owner) {
    const owner = query.owner.trim();
    if (owner !== 'me' && !/^[^@\s]+@[^@\s]+$/.test(owner)) {
      throw new UsageError(`--owner expects "me" or an e-mail address, got "${query.owner}".`);
    }
    clauses.push(`'${escapeQueryValue(owner)}' in owners`);
  }
  if (query.sharedWithMe) clauses.push('sharedWithMe=true');
  if (query.starred) clauses.push('starred=true');
  return clauses.join(' and ');
}

export const ORDER_BY_VALUES = ['modifiedTime', 'createdTime', 'name', 'viewedByMeTime'] as const;
export type OrderBy = (typeof ORDER_BY_VALUES)[number];

export function buildOrderBy(orderBy: OrderBy = 'modifiedTime', ascending = false): string {
  const dir = ascending ? '' : ' desc';
  return orderBy === 'name' ? `name${ascending ? '' : ' desc'}` : `${orderBy}${dir}`;
}

/** Shape of the Drive API file resource fields gvids reads. */
export interface DriveFileResource {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  webViewLink?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  viewedByMeTime?: string | null;
  owners?: Array<{ displayName?: string | null; emailAddress?: string | null; me?: boolean | null }> | null;
  lastModifyingUser?: { displayName?: string | null; emailAddress?: string | null } | null;
  parents?: string[] | null;
  starred?: boolean | null;
  trashed?: boolean | null;
  shared?: boolean | null;
  size?: string | null;
  thumbnailLink?: string | null;
  driveId?: string | null;
  resourceKey?: string | null;
  shortcutDetails?: { targetId?: string | null; targetMimeType?: string | null } | null;
  videoMediaMetadata?: {
    durationMillis?: string | null;
    width?: number | null;
    height?: number | null;
  } | null;
  capabilities?: Record<string, boolean | null | undefined> | null;
}

function opt<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

export function normalizeFile(file: DriveFileResource): VidFile {
  if (!file.id) throw new Error('Drive returned a file without an id');
  const caps = file.capabilities ?? undefined;
  const out: VidFile = {
    id: file.id,
    name: file.name ?? '(untitled)',
    mimeType: file.mimeType ?? 'unknown',
    url: file.webViewLink ?? vidEditUrl(file.id),
    owners: (file.owners ?? []).map((o) => ({
      ...(o.displayName ? { name: o.displayName } : {}),
      ...(o.emailAddress ? { email: o.emailAddress } : {}),
      ...(o.me ? { me: true } : {}),
    })),
    parents: file.parents ?? [],
    starred: file.starred ?? false,
    trashed: file.trashed ?? false,
    shared: file.shared ?? false,
  };
  if (file.createdTime) out.createdTime = file.createdTime;
  if (file.modifiedTime) out.modifiedTime = file.modifiedTime;
  if (file.viewedByMeTime) out.viewedByMeTime = file.viewedByMeTime;
  if (file.lastModifyingUser) {
    out.lastModifyingUser = {
      ...(file.lastModifyingUser.displayName ? { name: file.lastModifyingUser.displayName } : {}),
      ...(file.lastModifyingUser.emailAddress ? { email: file.lastModifyingUser.emailAddress } : {}),
    };
  }
  if (file.size) out.size = Number(file.size);
  if (file.thumbnailLink) out.thumbnailLink = file.thumbnailLink;
  if (file.driveId) out.driveId = file.driveId;
  if (file.resourceKey) out.resourceKey = file.resourceKey;
  if (caps) {
    out.capabilities = Object.fromEntries(
      Object.entries(caps)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k, v]) => [k, v as boolean]),
    );
  }
  const video = file.videoMediaMetadata;
  if (video && (video.durationMillis || video.width || video.height)) {
    out.video = {
      ...(video.durationMillis ? { durationMillis: Number(video.durationMillis) } : {}),
      ...(opt(video.width) ? { width: opt(video.width) as number } : {}),
      ...(opt(video.height) ? { height: opt(video.height) as number } : {}),
    };
  }
  return out;
}

export interface DrivePermissionResource {
  id?: string | null;
  type?: string | null;
  role?: string | null;
  emailAddress?: string | null;
  domain?: string | null;
  displayName?: string | null;
  allowFileDiscovery?: boolean | null;
  expirationTime?: string | null;
  deleted?: boolean | null;
  pendingOwner?: boolean | null;
}

export function normalizePermission(p: DrivePermissionResource): VidPermission {
  return {
    id: p.id ?? '',
    type: p.type ?? 'unknown',
    role: p.role ?? 'unknown',
    ...(p.emailAddress ? { emailAddress: p.emailAddress } : {}),
    ...(p.domain ? { domain: p.domain } : {}),
    ...(p.displayName ? { displayName: p.displayName } : {}),
    ...(typeof p.allowFileDiscovery === 'boolean' ? { allowFileDiscovery: p.allowFileDiscovery } : {}),
    ...(p.expirationTime ? { expirationTime: p.expirationTime } : {}),
    ...(p.deleted ? { deleted: true } : {}),
    ...(p.pendingOwner ? { pendingOwner: true } : {}),
  };
}
