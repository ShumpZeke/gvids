export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type ScopeProfile = 'full' | 'readonly';

export interface ScopeInfo {
  scope: string;
  purpose: string;
  sensitivity: 'restricted' | 'sensitive' | 'non-sensitive';
}

/**
 * gvids requests exactly one Drive scope. Google Vids has no dedicated API
 * scope; every official operation (list, metadata, sharing, MP4 download) goes
 * through Drive.
 *
 * - `drive` is needed to rename, move, copy, share, trash and delete files the
 *   app did not create itself. `drive.file` would only cover files created or
 *   opened through gvids, which excludes most existing videos.
 * - `drive.readonly` is enough for list/search/info/permissions/download.
 */
export const SCOPE_PROFILES: Record<ScopeProfile, ScopeInfo[]> = {
  full: [
    {
      scope: DRIVE_SCOPE,
      purpose:
        'List, search, rename, move, copy, share, trash, delete and download (MP4) Google Vids files in Drive.',
      sensitivity: 'restricted',
    },
  ],
  readonly: [
    {
      scope: DRIVE_READONLY_SCOPE,
      purpose: 'List, search, inspect permissions of, and download (MP4) Google Vids files. No changes.',
      sensitivity: 'restricted',
    },
  ],
};

export function scopesFor(profile: ScopeProfile): string[] {
  return SCOPE_PROFILES[profile].map((s) => s.scope);
}

/** Which operations a granted scope set allows. */
export function scopeAllowsWrite(granted: string[]): boolean {
  return granted.includes(DRIVE_SCOPE);
}

export function scopeAllowsRead(granted: string[]): boolean {
  return granted.some((s) => s === DRIVE_SCOPE || s === DRIVE_READONLY_SCOPE || s === DRIVE_FILE_SCOPE);
}
