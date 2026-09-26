import { NotAVidError, NotFoundError, PermissionError, UsageError } from '../errors/errors.js';
import { mapGoogleApiError } from '../errors/map.js';
import type { VidFile } from '../vids/types.js';
import { SHORTCUT_MIME_TYPE, VIDS_MIME_TYPE } from '../vids/urls.js';
import {
  buildOrderBy,
  buildVidsQuery,
  FILE_FIELDS,
  normalizeFile,
  type OrderBy,
  type VidQuery,
} from './files.js';
import type { DriveTransport } from './transport.js';

export interface ListOptions extends VidQuery {
  limit?: number;
  orderBy?: OrderBy;
  ascending?: boolean;
  driveId?: string;
  /** Fetch every page (ignores limit). */
  all?: boolean;
}

export interface ListResult {
  files: VidFile[];
  /** True when more results exist beyond the limit. */
  truncated: boolean;
  query: string;
}

/** High-level Drive operations on Google Vids files. All errors come back as GvidsError. */
export class DriveService {
  constructor(readonly transport: DriveTransport) {}

  async list(options: ListOptions = {}): Promise<ListResult> {
    const query = buildVidsQuery(options);
    const limit = options.all ? Number.POSITIVE_INFINITY : Math.max(1, options.limit ?? 30);
    const files: VidFile[] = [];
    let pageToken: string | undefined;
    let truncated = false;
    try {
      do {
        const pageSize = Math.min(1000, Number.isFinite(limit) ? Math.max(1, limit - files.length) : 1000);
        const res = await this.transport.listFiles({
          q: query,
          pageSize,
          orderBy: buildOrderBy(options.orderBy, options.ascending),
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          ...(pageToken ? { pageToken } : {}),
          ...(options.driveId ? { driveId: options.driveId } : {}),
        });
        for (const f of res.files) {
          if (files.length >= limit) {
            truncated = true;
            break;
          }
          files.push(normalizeFile(f));
        }
        pageToken = res.nextPageToken;
        if (files.length >= limit && pageToken) truncated = true;
      } while (pageToken && files.length < limit);
    } catch (err) {
      throw mapGoogleApiError(err, { action: 'list Google Vids files' });
    }
    return { files, truncated, query };
  }

  /** Fetches a file; resolves Drive shortcuts that point at a Vid. */
  async get(id: string, options: { requireVid?: boolean; resourceKey?: string } = {}): Promise<VidFile> {
    let file: VidFile;
    try {
      const raw = await this.transport.getFile(id, FILE_FIELDS, options.resourceKey);
      if (raw.mimeType === SHORTCUT_MIME_TYPE && raw.shortcutDetails?.targetId) {
        const target = await this.transport.getFile(raw.shortcutDetails.targetId, FILE_FIELDS);
        file = normalizeFile(target);
      } else {
        file = normalizeFile(raw);
      }
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'read file metadata' });
    }
    if (options.requireVid !== false && file.mimeType !== VIDS_MIME_TYPE) {
      throw new NotAVidError(id, file.mimeType);
    }
    return file;
  }

  async rename(id: string, name: string): Promise<VidFile> {
    const trimmed = name.trim();
    if (!trimmed) throw new UsageError('The new name must not be empty.');
    const current = await this.get(id);
    if (current.capabilities?.canRename === false) {
      throw new PermissionError(`You do not have permission to rename "${current.name}".`);
    }
    try {
      return normalizeFile(
        await this.transport.updateFile(current.id, { name: trimmed }, { fields: FILE_FIELDS }),
      );
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'rename the file' });
    }
  }

  async copy(id: string, options: { name?: string; folderId?: string } = {}): Promise<VidFile> {
    const current = await this.get(id);
    if (current.capabilities?.canCopy === false) {
      throw new PermissionError(`Copying "${current.name}" is not allowed for this account.`);
    }
    try {
      const copied = await this.transport.copyFile(
        current.id,
        {
          name: options.name?.trim() || `Copy of ${current.name}`,
          ...(options.folderId ? { parents: [options.folderId] } : {}),
        },
        FILE_FIELDS,
      );
      return normalizeFile(copied);
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'copy the file' });
    }
  }

  /** The ID of the Drive folder with exactly this name ("root" or "My Drive" for the top level). */
  async folderIdByName(name: string): Promise<string> {
    const wanted = name.trim();
    if (!wanted) throw new UsageError('The folder name must not be empty.');
    if (/^(root|my drive)$/i.test(wanted)) return 'root';
    const literal = wanted.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    let found: Array<{ id?: string | null; name?: string | null }>;
    try {
      found = (
        await this.transport.listFiles({
          q: `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${literal}'`,
          pageSize: 10,
          fields: 'files(id,name)',
        })
      ).files;
    } catch (err) {
      throw mapGoogleApiError(err, { action: `find the folder "${wanted}"` });
    }
    if (found.length === 0) {
      throw new NotFoundError(`No Drive folder is named "${wanted}".`, {
        hint: 'Check the spelling, or pass the folder ID or URL instead.',
      });
    }
    if (found.length > 1) {
      throw new UsageError(
        `${found.length} Drive folders are named "${wanted}"; pass the folder ID instead.`,
        {
          details: { folders: found.map((f) => f.id) },
        },
      );
    }
    return found[0]!.id!;
  }

  async move(id: string, folderId: string): Promise<VidFile> {
    const current = await this.get(id);
    try {
      const folder = await this.transport.getFile(folderId, 'id,name,mimeType');
      if (folder.mimeType !== 'application/vnd.google-apps.folder' && folderId !== 'root') {
        throw new UsageError(`${folderId} is not a Drive folder (mimeType ${folder.mimeType}).`);
      }
    } catch (err) {
      if (err instanceof UsageError) throw err;
      throw mapGoogleApiError(err, { action: `open destination folder ${folderId}` });
    }
    if (current.parents.includes(folderId)) return current;
    try {
      const moved = await this.transport.updateFile(
        current.id,
        {},
        {
          addParents: folderId,
          ...(current.parents.length > 0 ? { removeParents: current.parents.join(',') } : {}),
          fields: FILE_FIELDS,
        },
      );
      return normalizeFile(moved);
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'move the file' });
    }
  }

  async setTrashed(id: string, trashed: boolean): Promise<VidFile> {
    // Restoring must look up trashed files too, so skip the Vid check's trashed filter.
    const current = await this.get(id);
    try {
      return normalizeFile(await this.transport.updateFile(current.id, { trashed }, { fields: FILE_FIELDS }));
    } catch (err) {
      throw mapGoogleApiError(err, {
        fileId: id,
        action: trashed ? 'move the file to trash' : 'restore the file',
      });
    }
  }

  /** Permanently deletes a file (bypasses trash). Callers must confirm first. */
  async deletePermanently(id: string): Promise<VidFile> {
    const current = await this.get(id);
    try {
      await this.transport.deleteFile(current.id);
    } catch (err) {
      throw mapGoogleApiError(err, { fileId: id, action: 'delete the file' });
    }
    return current;
  }

  /**
   * Creates an empty Vids file through Drive files.create. Google does not
   * document this for Vids; `gvids capabilities` records whether it works.
   */
  async createEmpty(name: string, folderId?: string): Promise<VidFile> {
    try {
      const created = await this.transport.createFile(
        { name, mimeType: VIDS_MIME_TYPE, ...(folderId ? { parents: [folderId] } : {}) },
        FILE_FIELDS,
      );
      return normalizeFile(created);
    } catch (err) {
      throw mapGoogleApiError(err, { action: 'create a Vids file through the Drive API' });
    }
  }

  async about(): Promise<{ email?: string; name?: string; storageUsage?: number; storageLimit?: number }> {
    try {
      const info = await this.transport.about();
      return {
        ...(info.user?.emailAddress ? { email: info.user.emailAddress } : {}),
        ...(info.user?.displayName ? { name: info.user.displayName } : {}),
        ...(info.storageQuota?.usage ? { storageUsage: Number(info.storageQuota.usage) } : {}),
        ...(info.storageQuota?.limit ? { storageLimit: Number(info.storageQuota.limit) } : {}),
      };
    } catch (err) {
      throw mapGoogleApiError(err, { action: 'read account information' });
    }
  }
}
