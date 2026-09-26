/** A Google Vids file as reported by the Drive API (normalized, stable field names). */
export interface VidFile {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  createdTime?: string;
  modifiedTime?: string;
  viewedByMeTime?: string;
  owners: Array<{ name?: string; email?: string; me?: boolean }>;
  lastModifyingUser?: { name?: string; email?: string };
  parents: string[];
  starred: boolean;
  trashed: boolean;
  shared: boolean;
  size?: number;
  thumbnailLink?: string;
  driveId?: string;
  resourceKey?: string;
  capabilities?: {
    canEdit?: boolean;
    canShare?: boolean;
    canDownload?: boolean;
    canCopy?: boolean;
    canTrash?: boolean;
    canDelete?: boolean;
    canRename?: boolean;
    canMoveItemWithinDrive?: boolean;
  };
  video?: { durationMillis?: number; width?: number; height?: number };
}

export interface VidPermission {
  id: string;
  type: 'user' | 'group' | 'domain' | 'anyone' | string;
  role: 'owner' | 'organizer' | 'fileOrganizer' | 'writer' | 'commenter' | 'reader' | string;
  emailAddress?: string;
  domain?: string;
  displayName?: string;
  allowFileDiscovery?: boolean;
  expirationTime?: string;
  deleted?: boolean;
  pendingOwner?: boolean;
}

/** A scene as observed in the editor timeline. */
export interface SceneInfo {
  /** 1-based position in the video. */
  index: number;
  total: number;
  durationSeconds?: number;
  /** Text visible in the scene thumbnail (titles, captions). */
  text?: string;
  /** Transition into this scene, if any (e.g. "Slide"). */
  transitionIn?: string;
  /** Voiceover / avatar / audio clips that start in this scene. */
  clips: TimelineClip[];
}

export interface TimelineClip {
  label: string;
  kind: 'voiceover' | 'music' | 'audio' | 'video' | 'avatar' | 'object' | 'unknown';
  scene?: number;
  startSeconds?: number;
  durationSeconds?: number;
  /** The first words of the clip (voiceover scripts) or the clip title. */
  title?: string;
  speaker?: string;
}

export interface SceneObject {
  /** Object ID in the editor (stable across sessions for the same object). */
  id: string;
  text?: string;
  kind: 'text' | 'shape' | 'image' | 'video' | 'group' | 'unknown';
  bounds?: { x: number; y: number; width: number; height: number };
}

export type VideoFormat = 'landscape' | 'portrait' | 'square';

export const VIDEO_FORMATS: readonly VideoFormat[] = ['landscape', 'portrait', 'square'];

export interface TemplateInfo {
  /** Stable slug derived from the display name (e.g. "how-to-video"). */
  name: string;
  displayName: string;
  /** Where the template was seen: the Getting started dialog or the editor side panel. */
  source: 'start-dialog' | 'side-panel';
  /** Accessible name used to locate it in the UI. */
  locator: string;
  lastVerified: string;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
