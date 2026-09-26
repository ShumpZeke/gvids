import type { Page } from 'playwright';
import type { GvidsConfig } from '../../config/config.js';
import type { Logger } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';
import type { Capability, CapabilityState } from '../../vids/capabilities.js';
import { extractVidIdFromEditorUrl } from '../../vids/urls.js';
import { detectSignIn } from '../pages/account.js';
import { VidsEditor, type EditorOptions } from '../pages/editor-page.js';
import { AiVideoPanel, AvatarPanel, VoiceoverPanel } from '../pages/panels.js';
import { EDITOR_LABELS } from '../selectors/editor.js';
import type { BrowserSession } from '../session.js';

export interface UiProbe {
  signedIn: boolean;
  email?: string;
  vidsAccess: boolean;
  vidsBuild?: string;
  probeVideo?: string;
  ui: Capability[];
  ai?: { models: string[]; aspectRatios: string[]; defaultModel?: string };
  voices?: number;
  avatars?: number;
}

/** gvids automation maturity per UI feature (independent of what the account offers). */
const AUTOMATION_NOTES: Record<string, string> = {
  storyboard: 'landscape videos only',
  sceneDuration: 'gvids: experimental (timeline drag)',
  slidesConversion: 'gvids: experimental',
  avatars: 'gvids: experimental',
  aiVideo: 'gvids: experimental (uses your generation quota)',
  aiEditing: 'gvids: experimental (uses your generation quota)',
  aiAnimate: 'gvids: experimental (uses your generation quota)',
  gifExport: 'gvids: experimental',
  musicGeneration: 'not automated by gvids yet',
  imageGeneration: 'not automated by gvids yet',
  recording: 'needs a camera/screen; not automated',
  captions: 'not automated by gvids yet',
  exportToDrive: 'not automated by gvids yet',
  youtubeExport: 'not automated by gvids (publishing is left to you)',
};

function cap(key: string, label: string, present: boolean | undefined, extraNote?: string): Capability {
  const state: CapabilityState = present === undefined ? 'unknown' : present ? 'available' : 'unavailable';
  const note = [AUTOMATION_NOTES[key], extraNote].filter(Boolean).join('; ');
  return { key, label, state, via: 'browser', ...(note ? { note } : {}) };
}

async function readMenu(editor: VidsEditor, top: string): Promise<Map<string, boolean>> {
  const items = new Map<string, boolean>();
  await editor.showMenus();
  const page = editor.page;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.getByRole('menubar').getByRole('menuitem', { name: top, exact: true }).click();
    await sleep(600);
    const found = await page
      .getByRole('menuitem')
      .filter({ visible: true })
      .evaluateAll((els) =>
        els
          .filter((e) => !e.closest('[role=menubar]'))
          .map((e) => ({
            text: ((e as HTMLElement).innerText ?? '')
              .split('\n')[0]!
              .replace(/\s+/g, ' ')
              .replace(/[►▸]/g, '')
              .trim(),
            enabled: e.getAttribute('aria-disabled') !== 'true',
          })),
      );
    if (found.length > 0) {
      for (const f of found)
        if (f.text)
          items.set(
            f.text
              .replace(/\s+(Ctrl|⌘).*$/, '')
              .replace(/\s+New$/, '')
              .trim(),
            f.enabled,
          );
      break;
    }
  }
  await page.keyboard.press('Escape').catch(() => undefined);
  return items;
}

async function downloadFormats(editor: VidsEditor): Promise<string[]> {
  try {
    await editor.showMenus();
    await editor.page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
    await sleep(500);
    await editor.page
      .getByRole('menuitem', { name: EDITOR_LABELS.menuItems.download })
      .filter({ visible: true })
      .first()
      .hover();
    await sleep(700);
    const texts = await editor.page
      .getByRole('menuitem')
      .filter({ visible: true })
      .evaluateAll((els) => els.map((e) => ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()));
    return texts.filter((t) => /\((\.mp4|\.gif)\)/.test(t));
  } catch {
    return [];
  } finally {
    await editor.page.keyboard.press('Escape').catch(() => undefined);
    await editor.page.keyboard.press('Escape').catch(() => undefined);
  }
}

async function openFirstRecentVideo(page: Page): Promise<string | undefined> {
  // Recent videos render after the account chrome; give the grid time to appear.
  const items = page.locator('.docs-homescreen-grid-item').filter({ visible: true });
  await items
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  const count = await items.count();
  for (let i = 0; i < Math.min(count, 5); i++) {
    const item = items.nth(i);
    const text = (await item.innerText().catch(() => '')).trim();
    if (!text) continue;
    await item.click();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const id = extractVidIdFromEditorUrl(page.url());
      if (id) return id;
      await sleep(300);
    }
  }
  return undefined;
}

/**
 * Inspects the live UI with the signed-in browser profile. Opens an existing
 * video (never creates one) and reads toolbars, menus and the AI panel.
 */
export async function probeUi(
  session: BrowserSession,
  config: GvidsConfig,
  logger: Logger,
  options: { vid?: string; deep: boolean },
): Promise<UiProbe> {
  const page = await session.firstPage();
  const signIn = await detectSignIn(page, { hl: config.browser.locale, authuser: config.browser.authuser });
  const base: UiProbe = {
    signedIn: signIn.signedIn,
    vidsAccess: signIn.vidsAccess,
    ...(signIn.email ? { email: signIn.email } : {}),
    ui: [],
  };
  if (!signIn.signedIn || !signIn.vidsAccess) {
    const why = !signIn.signedIn
      ? 'browser profile not signed in (gvids browser login)'
      : 'Vids not available to this account';
    base.ui = [cap('createVid', 'create Vid', signIn.signedIn ? false : undefined, why)];
    return base;
  }
  const opts: EditorOptions = {
    hl: config.browser.locale,
    authuser: config.browser.authuser,
    timeoutMs: config.browser.timeout,
    diagnostics: session.diagnostics,
    logger,
  };
  const newVideoTile = await page.getByRole('option').filter({ visible: true }).count();
  let editor: VidsEditor;
  if (options.vid) {
    editor = await VidsEditor.open(page, options.vid, opts);
  } else {
    const id = await openFirstRecentVideo(page);
    if (!id) {
      base.ui = [
        cap('createVid', 'create Vid', newVideoTile > 0),
        ...['storyboard', 'templates', 'voiceovers', 'aiVideo'].map((k) =>
          cap(k, k, undefined, 'no existing video to inspect; pass --vid'),
        ),
      ];
      return base;
    }
    editor = await VidsEditor.attach(page, opts);
  }
  base.probeVideo = editor.id;
  base.vidsBuild = await page
    .evaluate(() => {
      const src = [...document.scripts].map((s) => s.src).find((s) => /\/static\/|\/_\/js\//.test(s)) ?? '';
      const m = /\/k=([^/]+)|\/static\/[^/]+\/([^/]+)\//.exec(src);
      return (m?.[1] ?? m?.[2] ?? src.split('/').slice(3, 7).join('/')).slice(0, 80) || undefined;
    })
    .catch(() => undefined);

  const toolbar = new Set(
    await page
      .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.insertion })
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '')),
  );
  const has = (label: string): boolean => toolbar.has(label);
  const file = await readMenu(editor, 'File');
  const scene = await readMenu(editor, 'Scene');
  const insert = await readMenu(editor, 'Insert');
  const formats = await downloadFormats(editor);
  const menuHas = (m: Map<string, boolean>, re: RegExp): boolean | undefined => {
    for (const [k] of m) if (re.test(k)) return true;
    return m.size > 0 ? false : undefined;
  };
  const menuEnabled = (m: Map<string, boolean>, re: RegExp): boolean | undefined => {
    for (const [k, v] of m) if (re.test(k)) return v;
    return m.size > 0 ? false : undefined;
  };

  let tabs: { edit: boolean; animate: boolean; create: boolean } | undefined;
  if (has(EDITOR_LABELS.insertion.aiVideo)) {
    try {
      const panel = await AiVideoPanel.open(editor);
      const tabNames = await page
        .getByRole('tab')
        .filter({ visible: true })
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()));
      tabs = {
        create: tabNames.includes('Create'),
        edit: tabNames.includes('Edit'),
        animate: tabNames.includes('Animate'),
      };
      await panel.setPrompt('create', '');
      const models = await panel.models('create');
      const aspects = await panel.aspectRatios('create');
      base.ai = {
        models: models.items,
        aspectRatios: aspects.items,
        ...(models.selected ? { defaultModel: models.selected } : {}),
      };
    } catch (err) {
      logger.debug({ err: String(err) }, 'AI panel probe failed');
    }
    await editor.closeSidePanels();
  }
  if (options.deep) {
    try {
      base.voices = (await (await VoiceoverPanel.open(editor, 1)).listVoices()).length;
      await editor.closeSidePanels();
    } catch (err) {
      logger.debug({ err: String(err) }, 'voice probe failed');
    }
    try {
      base.avatars = (await (await AvatarPanel.open(editor, 1)).listAvatars()).length;
      await editor.closeSidePanels();
    } catch (err) {
      logger.debug({ err: String(err) }, 'avatar probe failed');
    }
  }
  await editor.restoreUi();

  base.ui = [
    cap('createVid', 'create Vid', true),
    cap('templates', 'templates', has(EDITOR_LABELS.insertion.templates)),
    cap('storyboard', 'storyboard (Help me create)', menuHas(file, /^Storyboard/)),
    cap('sceneManipulation', 'scene add/duplicate/delete/move', menuHas(scene, /^Duplicate scenes?/)),
    cap('sceneBackground', 'scene background', menuHas(scene, /^Background/)),
    cap('sceneDuration', 'scene duration', menuHas(scene, /^Duplicate scenes?/)),
    cap('text', 'text boxes', has(EDITOR_LABELS.insertion.text)),
    cap('mediaInsertion', 'media insertion (upload)', menuHas(insert, /^Upload/)),
    cap('scripts', 'scripts', has(EDITOR_LABELS.insertion.voiceover)),
    cap('voiceovers', 'voiceovers', has(EDITOR_LABELS.insertion.voiceover)),
    cap('aiVideo', 'AI video generation', has(EDITOR_LABELS.insertion.aiVideo) && (tabs?.create ?? true)),
    cap('aiEditing', 'AI video editing', tabs ? tabs.edit : undefined),
    cap('aiAnimate', 'AI image animation', tabs ? tabs.animate : undefined),
    cap('avatars', 'avatars', has(EDITOR_LABELS.insertion.avatar)),
    cap('slidesConversion', 'slides conversion', menuEnabled(file, /^Slides to video/)),
    cap('docsToVideo', 'docs to video', menuEnabled(file, /^Docs to video/)),
    cap('videoSize', 'aspect ratio (video size)', menuHas(file, /^Video size/)),
    cap(
      'mp4Ui',
      'MP4 download in editor',
      formats.length ? formats.some((f) => f.includes('.mp4')) : undefined,
    ),
    cap('gifExport', 'GIF export', formats.length ? formats.some((f) => f.includes('.gif')) : undefined),
    cap('musicGeneration', 'music generation', has(EDITOR_LABELS.insertion.music)),
    cap('imageGeneration', 'image generation', has(EDITOR_LABELS.insertion.image)),
    cap('recording', 'recording', has(EDITOR_LABELS.insertion.record)),
    cap('captions', 'captions', has(EDITOR_LABELS.insertion.captions)),
    cap('exportToDrive', 'export MP4 to Drive', menuHas(file, /^Export to Drive/)),
    cap('youtubeExport', 'export to YouTube', menuHas(file, /^Export to YouTube/)),
  ];
  return base;
}
