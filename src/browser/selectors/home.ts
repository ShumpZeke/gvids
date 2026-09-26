/** The Vids home page (docs.google.com/videos/), verified 2026-09-23. */
export const HOME_CSS = {
  item: '.docs-homescreen-grid-item',
  /** Its style is `background-image: url(https://lh3.google.com/u/0/d/<file id>=w208-h117-…)`. */
  thumbnail: '.docs-homescreen-grid-item-thumbnail',
  /** `title` attribute holds the full video title. */
  title: '.docs-homescreen-grid-item-title',
  /** `aria-label` like "Last opened by me 11:42 AM". */
  time: '.docs-homescreen-grid-item-time',
  /** Icon class naming the file type (search also returns Slides). */
  vidsIcon: '[class*="docs-homescreen-vids-type"]',
} as const;

export const HOME_LABELS = {
  moreActions: /^More actions/,
  openInNewTab: 'Open in new tab',
  lastOpenedPrefix: /^Last opened by me\s*/,
} as const;

/** Extracts the file ID from a home thumbnail style attribute. */
export function idFromThumbnailStyle(style: string | null | undefined): string | undefined {
  return /\/d\/([A-Za-z0-9_-]{20,})=/.exec(style ?? '')?.[1];
}
