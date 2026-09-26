import type { GvidsPaths } from '../config/paths.js';
import { readJsonFile, writeFileAtomic } from '../utils/fs.js';

export type CapabilityState = 'available' | 'unavailable' | 'unknown' | 'experimental';

export interface Capability {
  key: string;
  label: string;
  state: CapabilityState;
  via: 'drive-api' | 'browser' | 'none';
  note?: string;
}

/** Everything gvids knows about what this account/UI can do. */
export interface CapabilityReport {
  detectedAt: string;
  account: { drive?: string; browser?: string };
  /** Clue about the Vids web client build, to notice UI changes. */
  vidsBuild?: string;
  probeVideo?: string;
  drive: Capability[];
  ui: Capability[];
  unavailable: Capability[];
  ai?: { models: string[]; aspectRatios: string[]; defaultModel?: string };
  voices?: number;
  avatars?: number;
  cached?: boolean;
}

/** The fixed facts: things no public API offers, per research (docs/research.md). */
export const PERMANENTLY_UNAVAILABLE: Capability[] = [
  {
    key: 'publicEditingApi',
    label: 'direct public scene-editing API',
    state: 'unavailable',
    via: 'none',
    note: 'Google publishes no Vids editing API; editor features are automated through the browser.',
  },
  {
    key: 'apiExport',
    label: 'files.export for Vids',
    state: 'unavailable',
    via: 'none',
    note: 'Drive returns fileNotExportable; gvids uses files.download (MP4) instead.',
  },
  {
    key: 'apiGif',
    label: 'GIF export through the Drive API',
    state: 'unavailable',
    via: 'none',
    note: 'Only MP4 is offered by files.download; GIF export goes through the editor.',
  },
];

/** Drive capabilities derived from granted scopes (no calls needed). */
export function driveCapabilities(options: {
  authenticated: boolean;
  scopes: string[];
  listWorks?: boolean;
  problem?: string;
}): Capability[] {
  const write = options.scopes.includes('https://www.googleapis.com/auth/drive');
  const read =
    write ||
    options.scopes.includes('https://www.googleapis.com/auth/drive.readonly') ||
    options.scopes.includes('https://www.googleapis.com/auth/drive.file');
  const state = (ok: boolean): CapabilityState =>
    !options.authenticated ? 'unknown' : ok ? 'available' : 'unavailable';
  const readState = options.listWorks === false ? 'unavailable' : state(read);
  const note = options.authenticated ? undefined : (options.problem ?? 'Run gvids auth login to enable.');
  const writeNote =
    options.authenticated && !write ? 'Needs the full drive scope (gvids auth login --scopes full).' : note;
  const cap = (key: string, label: string, s: CapabilityState, n?: string): Capability => ({
    key,
    label,
    state: s,
    via: 'drive-api',
    ...(n ? { note: n } : {}),
  });
  return [
    cap('list', 'list vids', readState, note),
    cap('search', 'search vids', readState, note),
    cap('metadata', 'metadata / info', readState, note),
    cap('rename', 'rename', state(write), writeNote),
    cap('move', 'move', state(write), writeNote),
    cap('copy', 'copy', state(write), writeNote),
    cap('sharing', 'sharing', state(write), writeNote),
    cap('permissions', 'permissions', readState, note),
    cap('trash', 'trash / restore / delete', state(write), writeNote),
    cap('mp4Download', 'MP4 download (files.download)', readState, note),
    cap('thumbnails', 'thumbnails', readState, note),
    cap(
      'createViaApi',
      'create empty Vid via files.create',
      options.authenticated && write ? 'experimental' : 'unknown',
      'Not documented by Google for Vids.',
    ),
  ];
}

export async function readCapabilityCache(paths: GvidsPaths): Promise<CapabilityReport | undefined> {
  return readJsonFile<CapabilityReport>(paths.capabilitiesCacheFile).catch(() => undefined);
}

export async function writeCapabilityCache(paths: GvidsPaths, report: CapabilityReport): Promise<void> {
  await writeFileAtomic(
    paths.capabilitiesCacheFile,
    `${JSON.stringify({ ...report, cached: undefined }, null, 2)}\n`,
  );
}

export function isCacheFresh(report: CapabilityReport, ttlHours: number): boolean {
  const age = Date.now() - new Date(report.detectedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < ttlHours * 3_600_000;
}

const MARK: Record<CapabilityState, string> = {
  available: '✓',
  unavailable: '✗',
  unknown: '?',
  experimental: '~',
};

export function renderCapabilities(report: CapabilityReport): string {
  const line = (c: Capability): string => `${MARK[c.state]} ${c.label}${c.note ? `  — ${c.note}` : ''}`;
  const out: string[] = [];
  out.push('Google Drive API', ...report.drive.map(line), '');
  out.push('Google Vids UI', ...report.ui.map(line), '');
  if (report.ai?.models.length) {
    out.push(`AI video models: ${report.ai.models.join(', ')}`);
    out.push(`AI aspect ratios: ${report.ai.aspectRatios.join(', ')}`);
  }
  if (report.voices !== undefined) out.push(`Voiceover voices: ${report.voices}`);
  if (report.avatars !== undefined) out.push(`Avatars: ${report.avatars}`);
  if (report.ai?.models.length || report.voices !== undefined || report.avatars !== undefined) out.push('');
  out.push('Unavailable', ...report.unavailable.map(line), '');
  const who = [
    report.account.drive && `Drive: ${report.account.drive}`,
    report.account.browser && `browser: ${report.account.browser}`,
  ]
    .filter(Boolean)
    .join(', ');
  out.push(
    `${report.cached ? 'Cached' : 'Detected'} ${report.detectedAt}${who ? ` (${who})` : ''}${report.cached ? ' — refresh with --refresh' : ''}`,
  );
  out.push('Legend: ✓ available  ✗ unavailable  ~ experimental  ? unknown (not checked)');
  return out.join('\n');
}
