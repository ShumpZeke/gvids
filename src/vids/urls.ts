import { UsageError } from '../errors/errors.js';

/** MIME type Google Drive uses for Google Vids files. */
export const VIDS_MIME_TYPE = 'application/vnd.google-apps.vid';
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SLIDES_MIME_TYPE = 'application/vnd.google-apps.presentation';
export const DOCS_MIME_TYPE = 'application/vnd.google-apps.document';
export const SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';

export const VIDS_ORIGIN = 'https://docs.google.com';
export const VIDS_HOME_PATH = '/videos/';

export type ResourceKind = 'vid' | 'folder' | 'presentation' | 'document' | 'file' | 'unknown';

export interface ParsedResource {
  id: string;
  kind: ResourceKind;
  resourceKey?: string;
  /** The original input, for error messages. */
  input: string;
}

// Drive IDs are URL-safe base64-ish strings. Real ones are 19–44+ characters.
const ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

const PATH_RULES: Array<{ pattern: RegExp; kind: ResourceKind }> = [
  { pattern: /\/videos\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/, kind: 'vid' },
  { pattern: /\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/, kind: 'presentation' },
  { pattern: /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/, kind: 'document' },
  { pattern: /\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/, kind: 'folder' },
  { pattern: /\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/, kind: 'file' },
  { pattern: /\/(?:[a-z]+\/)?(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/, kind: 'unknown' },
];

const GOOGLE_HOSTS = /(^|\.)google\.com$|(^|\.)googleusercontent\.com$/i;

/**
 * Extracts a Drive file ID from a bare ID or any common Google URL form:
 *   https://docs.google.com/videos/d/<id>/edit
 *   https://docs.google.com/videos/u/1/d/<id>/edit?usp=sharing
 *   https://drive.google.com/file/d/<id>/view
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/drive/folders/<id>
 *   https://docs.google.com/presentation/d/<id>/edit
 */
export function parseResource(input: string): ParsedResource {
  const raw = input.trim();
  if (raw === '') throw new UsageError('Expected a Google Vids ID or URL, got an empty value.');
  if (ID_PATTERN.test(raw)) return { id: raw, kind: 'unknown', input };
  if (!/[./:]/.test(raw)) {
    // Neither an ID (10+ of A-Z a-z 0-9 _ -) nor anything URL-like.
    throw new UsageError(`Not a valid Google Vids file ID or URL: ${input}`, {
      hint: [
        'File IDs are 10 or more letters, digits, "-" or "_" (e.g. from docs.google.com/videos/d/<id>/edit).',
        'Find IDs with: gvids list',
      ],
    });
  }

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new UsageError(`Not a valid Google Vids ID or URL: ${input}`);
  }
  if (!GOOGLE_HOSTS.test(url.hostname)) {
    throw new UsageError(`Not a Google URL: ${input}`, {
      hint: 'Pass a file ID or a docs.google.com / drive.google.com / vids.google.com link.',
    });
  }
  const resourceKey = url.searchParams.get('resourcekey') ?? undefined;
  for (const rule of PATH_RULES) {
    const match = rule.pattern.exec(url.pathname);
    if (match?.[1]) {
      return { id: match[1], kind: rule.kind, input, ...(resourceKey ? { resourceKey } : {}) };
    }
  }
  const idParam = url.searchParams.get('id');
  if (idParam && ID_PATTERN.test(idParam)) {
    return { id: idParam, kind: 'unknown', input, ...(resourceKey ? { resourceKey } : {}) };
  }
  throw new UsageError(`Could not find a file ID in URL: ${input}`);
}

export function parseVidId(input: string): string {
  const parsed = parseResource(input);
  if (parsed.kind === 'folder' || parsed.kind === 'presentation' || parsed.kind === 'document') {
    throw new UsageError(`Expected a Google Vids file but got a ${parsed.kind} URL: ${input}`);
  }
  return parsed.id;
}

export function parseFolderId(input: string): string {
  if (input.trim() === 'root') return 'root';
  const parsed = parseResource(input);
  if (parsed.kind === 'vid' || parsed.kind === 'presentation' || parsed.kind === 'document') {
    throw new UsageError(`Expected a Drive folder but got a ${parsed.kind} URL: ${input}`);
  }
  return parsed.id;
}

export function parsePresentationId(input: string): string {
  const parsed = parseResource(input);
  if (parsed.kind === 'vid' || parsed.kind === 'folder') {
    throw new UsageError(`Expected a Google Slides presentation but got a ${parsed.kind} URL: ${input}`);
  }
  return parsed.id;
}

export function parseDocumentId(input: string): string {
  const parsed = parseResource(input);
  if (parsed.kind === 'vid' || parsed.kind === 'folder' || parsed.kind === 'presentation') {
    throw new UsageError(`Expected a Google Doc but got a ${parsed.kind} URL: ${input}`);
  }
  return parsed.id;
}

export interface VidsUrlOptions {
  /** UI language to force (automation depends on English labels). */
  hl?: string;
  /** Google account index for multi-account browsers. */
  authuser?: number;
}

function withParams(url: URL, options: VidsUrlOptions): string {
  if (options.hl) url.searchParams.set('hl', options.hl);
  if (options.authuser !== undefined && options.authuser > 0) {
    url.searchParams.set('authuser', String(options.authuser));
  }
  return url.toString();
}

export function vidEditUrl(id: string, options: VidsUrlOptions = {}): string {
  return withParams(new URL(`/videos/d/${encodeURIComponent(id)}/edit`, VIDS_ORIGIN), options);
}

export function vidsHomeUrl(options: VidsUrlOptions = {}): string {
  return withParams(new URL('/videos/', VIDS_ORIGIN), options);
}

/** Opening this URL creates a brand-new Vid in the signed-in account. */
export function vidsCreateUrl(options: VidsUrlOptions = {}): string {
  return withParams(new URL('/videos/create', VIDS_ORIGIN), options);
}

export function driveFolderUrl(id: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

export function isVidsEditorUrl(url: string): boolean {
  return /^https:\/\/docs\.google\.com\/videos\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]+/.test(url);
}

export function isVidsHomeUrl(url: string): boolean {
  return /^https:\/\/docs\.google\.com\/videos\/(?:u\/\d+\/)?(?:\?|#|$)/.test(url);
}

export function isGoogleSignInUrl(url: string): boolean {
  return /^https:\/\/accounts\.google\.com\//.test(url);
}

export function extractVidIdFromEditorUrl(url: string): string | undefined {
  return /\/videos\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/.exec(url)?.[1];
}
