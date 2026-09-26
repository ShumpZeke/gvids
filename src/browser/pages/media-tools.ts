import type { Locator } from 'playwright';
import { UsageError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import type { SceneObject } from '../../vids/types.js';
import { EDITOR_LABELS } from '../selectors/editor.js';
import { armed, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

/**
 * Tools for an inserted video or image: trim and loop (Playback options), volume
 * and fades (Sound), replace by upload, and fill the scene / set as background
 * (Arrange). Observed on 2026-09-24 with hl=en.
 */

/** 5, "5.5", "1:02.5" -> seconds. */
export function parseClipTime(value: string, label: string): number {
  const v = value.trim();
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(v);
  if (!m)
    throw new UsageError(`${label} must be seconds (e.g. 4.5) or m:ss.s (e.g. 1:02.5), got "${value}".`);
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
}

/** Seconds -> "mm:ss.s" as the Playback panel shows it. */
export function formatClipTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

async function mediaObject(editor: VidsEditor, n: number, objectId: string): Promise<SceneObject> {
  await editor.selectScene(n);
  const obj = (await editor.objects()).find((o) => o.id === objectId);
  if (!obj) {
    throw new UsageError(`Object ${objectId} is not on scene ${n}.`, {
      hint: `List objects with: gvids text list <id> --scene ${n}`,
    });
  }
  if (obj.kind !== 'video' && obj.kind !== 'image') {
    throw new UsageError(
      `Object ${objectId} is ${obj.kind === 'text' ? 'a text box' : `a ${obj.kind}`}, not a video or image.`,
    );
  }
  await editor.selectObject(n, objectId);
  return obj;
}

async function sidePanel(editor: VidsEditor, button: RegExp, panel: RegExp): Promise<Locator> {
  await uiStep(editor.ui, `The "${String(button)}" button`, () =>
    editor.page.getByRole('button', { name: button }).filter({ visible: true }).first().click(),
  );
  const side = editor.page.getByRole('complementary', { name: panel }).filter({ visible: true }).first();
  await uiStep(editor.ui, `The "${String(panel)}" panel`, () => side.waitFor({ timeout: 15_000 }));
  return side;
}

async function setText(box: Locator, value: string): Promise<void> {
  await box.click({ clickCount: 3, timeout: 10_000 });
  await box.fill(value, { timeout: 10_000 });
  await box.press('Enter', { timeout: 10_000 });
  await sleep(300);
}

/** Playback options: trim a video's start/end (seconds into the clip) and loop it. */
export async function trimMedia(
  editor: VidsEditor,
  n: number,
  objectId: string,
  want: { start?: number; end?: number; loop?: boolean },
): Promise<{ start?: string; end?: string; loop?: boolean }> {
  const obj = await mediaObject(editor, n, objectId);
  if (obj.kind !== 'video') throw new UsageError('Only videos can be trimmed or looped.');
  const side = await sidePanel(editor, /^Playback options$/, /^Playback$/);
  try {
    const start = side.getByRole('textbox', { name: /^Start:?$/ }).first();
    const end = side.getByRole('textbox', { name: /^End:?$/ }).first();
    if (want.start !== undefined) await setText(start, formatClipTime(want.start));
    if (want.end !== undefined) await setText(end, formatClipTime(want.end));
    if (want.loop !== undefined) {
      const loop = side.getByRole('checkbox', { name: /^Loop video$/ }).first();
      if ((await loop.isChecked()) !== want.loop) {
        // The checkbox input is visually hidden; its label takes the click.
        await uiStep(editor.ui, 'The "Loop video" option', () =>
          side
            .getByText(/^Loop video$/)
            .first()
            .click({ timeout: 10_000 }),
        );
      }
    }
    const read = async (box: Locator): Promise<string | undefined> =>
      (await box.inputValue().catch(async () => (await box.textContent()) ?? '')).trim() || undefined;
    const loop = await side
      .getByRole('checkbox', { name: /^Loop video$/ })
      .first()
      .isChecked()
      .catch(() => undefined);
    const s = await read(start);
    const e = await read(end);
    return { ...(s ? { start: s } : {}), ...(e ? { end: e } : {}), ...(loop !== undefined ? { loop } : {}) };
  } finally {
    await editor.closeSidePanels();
  }
}

/** Sound: volume (0-100 %), mute, and audio fade in/out (seconds) of one track. */
export async function setSound(
  editor: VidsEditor,
  n: number,
  objectId: string,
  want: { volume?: number; mute?: boolean; fadeIn?: number; fadeOut?: number },
): Promise<{ volume?: number; mute?: boolean; fadeIn?: number; fadeOut?: number }> {
  await mediaObject(editor, n, objectId);
  const side = await sidePanel(editor, /^Sound$/, /^Sound$/);
  try {
    const tab = side.getByRole('tab', { name: /^This track$/ }).first();
    if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
    const spin = (name: RegExp): Locator => side.getByRole('spinbutton', { name }).first();
    if (want.volume !== undefined) await setText(spin(/^Volume$/), String(want.volume));
    if (want.fadeIn !== undefined) await setText(spin(/Fade in$/), String(want.fadeIn));
    if (want.fadeOut !== undefined) await setText(spin(/Fade out$/), String(want.fadeOut));
    if (want.mute !== undefined) {
      const mute = side.getByRole('checkbox', { name: /^Mute$/ }).first();
      if ((await mute.isChecked()) !== want.mute) {
        await uiStep(editor.ui, 'The "Mute" option', () =>
          mute.click({ timeout: 5_000 }).catch(() =>
            side
              .getByText(/^Mute$/)
              .first()
              .click({ timeout: 5_000 }),
          ),
        );
      }
    }
    const num = async (name: RegExp): Promise<number | undefined> => {
      const v = Number(
        await spin(name)
          .inputValue()
          .catch(() => ''),
      );
      return Number.isFinite(v) ? v : undefined;
    };
    const volume = await num(/^Volume$/);
    const fadeIn = await num(/Fade in$/);
    const fadeOut = await num(/Fade out$/);
    const mute = await side
      .getByRole('checkbox', { name: /^Mute$/ })
      .first()
      .isChecked()
      .catch(() => undefined);
    return {
      ...(volume !== undefined ? { volume } : {}),
      ...(mute !== undefined ? { mute } : {}),
      ...(fadeIn !== undefined ? { fadeIn } : {}),
      ...(fadeOut !== undefined ? { fadeOut } : {}),
    };
  } finally {
    await editor.closeSidePanels();
  }
}

/** Format > Video/Image > Replace > Upload: swaps the media, keeping position and size. */
export async function replaceMedia(
  editor: VidsEditor,
  n: number,
  objectId: string,
  file: string,
  timeoutMs: number,
): Promise<SceneObject | undefined> {
  const obj = await mediaObject(editor, n, objectId);
  const kind = obj.kind === 'video' ? 'Video' : 'Image';
  const signature = (): Promise<string> =>
    editor.page
      .evaluate((id) => {
        const g = document.getElementById(`editor-${id}`);
        if (!g) return 'gone';
        const media = g.querySelector('image, video, foreignObject');
        return (
          media?.getAttribute('href') ??
          media?.getAttribute('xlink:href') ??
          (media as HTMLVideoElement | null)?.currentSrc ??
          g.innerHTML.length.toString()
        );
      }, objectId)
      .catch(() => 'gone');
  const before = await signature();
  const chooser = armed(editor.page.waitForEvent('filechooser', { timeout: editor.options.timeoutMs }));
  await editor.menu(
    [
      EDITOR_LABELS.topMenus.format,
      new RegExp(`^${kind}\\b`),
      new RegExp(`^Replace ${kind.toLowerCase()}`),
      EDITOR_LABELS.menuItems.upload,
    ],
    { keepSelection: true },
  );
  const fc = await uiStep(editor.ui, 'The replace file chooser', () => chooser);
  await fc.setFiles(file);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await editor.dismissPopups();
    if ((await signature()) !== before) break;
    await sleep(1000);
  }
  const objects = await editor.objects();
  return objects.find((o) => o.id === objectId) ?? objects[objects.length - 1];
}

/** Arrange > Video/Image: "Expand … to fill the scene" or "Set … as background". */
export async function fillScene(
  editor: VidsEditor,
  n: number,
  objectId: string,
  mode: 'fill' | 'background',
): Promise<void> {
  const obj = await mediaObject(editor, n, objectId);
  const kind = obj.kind === 'video' ? 'video' : 'image';
  await editor.menu(
    [
      EDITOR_LABELS.topMenus.arrange,
      new RegExp(`^${kind.charAt(0).toUpperCase()}${kind.slice(1)}\\b`),
      mode === 'fill'
        ? new RegExp(`^Expand ${kind} to fill the scene`)
        : new RegExp(`^Set ${kind} as background`),
    ],
    { keepSelection: true },
  );
  await sleep(800);
}
