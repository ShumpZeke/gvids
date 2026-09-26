import { NotFoundError, UsageError } from '../errors/errors.js';
import { mapGoogleApiError } from '../errors/map.js';
import type { VidPermission } from '../vids/types.js';
import { normalizePermission, PERMISSION_FIELDS } from './files.js';
import type { DriveTransport } from './transport.js';

export const SHARE_ROLES = ['reader', 'commenter', 'writer'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];

export type ShareTarget =
  | { kind: 'user'; email: string }
  | { kind: 'group'; email: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'anyone' };

export function parseRole(value: string): ShareRole {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, ShareRole> = {
    reader: 'reader',
    viewer: 'reader',
    view: 'reader',
    commenter: 'commenter',
    comment: 'commenter',
    writer: 'writer',
    editor: 'writer',
    edit: 'writer',
  };
  const role = aliases[normalized];
  if (!role) throw new UsageError(`Unknown role "${value}". Use one of: reader, commenter, writer.`);
  return role;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function assertEmail(value: string): string {
  const trimmed = value.trim();
  if (!EMAIL.test(trimmed)) throw new UsageError(`"${value}" is not a valid e-mail address.`);
  return trimmed;
}

export function describeTarget(target: ShareTarget): string {
  switch (target.kind) {
    case 'anyone':
      return 'anyone with the link';
    case 'domain':
      return `everyone at ${target.domain}`;
    default:
      return target.email;
  }
}

function matches(p: VidPermission, target: ShareTarget): boolean {
  switch (target.kind) {
    case 'anyone':
      return p.type === 'anyone';
    case 'domain':
      return p.type === 'domain' && p.domain?.toLowerCase() === target.domain.toLowerCase();
    default:
      return (
        (p.type === 'user' || p.type === 'group') &&
        p.emailAddress?.toLowerCase() === target.email.toLowerCase()
      );
  }
}

export class PermissionsService {
  constructor(private readonly transport: DriveTransport) {}

  async list(fileId: string): Promise<VidPermission[]> {
    try {
      return (await this.transport.listPermissions(fileId, PERMISSION_FIELDS)).map(normalizePermission);
    } catch (err) {
      throw mapGoogleApiError(err, { fileId, action: 'list permissions' });
    }
  }

  /**
   * Grants access. If the target already has a permission, its role is
   * updated instead of creating a duplicate (so the command is idempotent).
   */
  async share(
    fileId: string,
    target: ShareTarget,
    role: ShareRole,
    options: { notify?: boolean; message?: string; discoverable?: boolean } = {},
  ): Promise<{ permission: VidPermission; action: 'created' | 'updated' | 'unchanged' }> {
    const existing = (await this.list(fileId)).find((p) => matches(p, target));
    if (existing) {
      if (existing.role === 'owner') {
        return { permission: existing, action: 'unchanged' };
      }
      if (existing.role === role) return { permission: existing, action: 'unchanged' };
      try {
        const updated = await this.transport.updatePermission(
          fileId,
          existing.id,
          { role },
          PERMISSION_FIELDS,
        );
        return { permission: normalizePermission(updated), action: 'updated' };
      } catch (err) {
        throw mapGoogleApiError(err, { fileId, action: 'update sharing' });
      }
    }
    const body: {
      type: string;
      role: string;
      emailAddress?: string;
      domain?: string;
      allowFileDiscovery?: boolean;
    } =
      target.kind === 'anyone'
        ? { type: 'anyone', role, allowFileDiscovery: options.discoverable ?? false }
        : target.kind === 'domain'
          ? { type: 'domain', role, domain: target.domain, allowFileDiscovery: options.discoverable ?? false }
          : { type: target.kind, role, emailAddress: target.email };
    const isPerson = target.kind === 'user' || target.kind === 'group';
    try {
      const created = await this.transport.createPermission(fileId, body, {
        fields: PERMISSION_FIELDS,
        ...(isPerson && options.notify !== undefined ? { sendNotificationEmail: options.notify } : {}),
        ...(isPerson && options.message ? { emailMessage: options.message } : {}),
      });
      return { permission: normalizePermission(created), action: 'created' };
    } catch (err) {
      throw mapGoogleApiError(err, { fileId, action: 'share the file' });
    }
  }

  async unshare(
    fileId: string,
    target: ShareTarget | { kind: 'id'; permissionId: string },
  ): Promise<VidPermission[]> {
    const permissions = await this.list(fileId);
    const toRemove =
      target.kind === 'id'
        ? permissions.filter((p) => p.id === target.permissionId)
        : permissions.filter((p) => matches(p, target));
    if (toRemove.length === 0) {
      const label = target.kind === 'id' ? `permission ${target.permissionId}` : describeTarget(target);
      throw new NotFoundError(`No permission found for ${label} on this file.`, {
        hint: `Inspect current access with: gvids permissions ${fileId}`,
      });
    }
    for (const p of toRemove) {
      if (p.role === 'owner') {
        throw new UsageError('The owner permission cannot be removed. Transfer ownership in Drive first.');
      }
    }
    for (const p of toRemove) {
      try {
        await this.transport.deletePermission(fileId, p.id);
      } catch (err) {
        throw mapGoogleApiError(err, { fileId, action: 'remove sharing' });
      }
    }
    return toRemove;
  }
}
