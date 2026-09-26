import type { Locator } from 'playwright';
import { FeatureUnavailableError, UsageError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { accessibleName, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

/**
 * Insert > Captions: animated captions transcribed from the speech in the video
 * (voiceovers, avatars, recordings). Picking a style adds them; "More" offers
 * "Edit transcript" and "Delete all captions". Observed on 2026-09-24 with hl=en.
 */
const PANEL = /^Captions$/;
const USED = /^Used in this vid/;

export interface CaptionStyle {
  index: number;
  group: string;
  description: string;
}

async function openPanel(editor: VidsEditor): Promise<Locator> {
  await editor.openInsertion('captions');
  const panel = editor.page.getByRole('complementary', { name: PANEL }).first();
  await uiStep(editor.ui, 'The "Captions" panel', () =>
    panel.getByRole('radiogroup', { name: /^Apply to$/ }).waitFor({ timeout: 20_000 }),
  );
  return panel;
}

/** The style buttons, in panel order, without the "Used in this vid" shortcut list. */
async function styleButtons(panel: Locator): Promise<Array<{ button: Locator; group: string }>> {
  const out: Array<{ button: Locator; group: string }> = [];
  const lists = panel.getByRole('list');
  for (let i = 0; i < (await lists.count()); i++) {
    const list = lists.nth(i);
    const group = await accessibleName(list).catch(() => '');
    if (USED.test(group)) continue;
    const buttons = list.getByRole('button');
    for (let j = 0; j < (await buttons.count()); j++) out.push({ button: buttons.nth(j), group });
  }
  return out;
}

export async function listCaptionStyles(editor: VidsEditor): Promise<CaptionStyle[]> {
  const panel = await openPanel(editor);
  try {
    const styles = await styleButtons(panel);
    const out: CaptionStyle[] = [];
    for (const [i, s] of styles.entries()) {
      out.push({
        index: i + 1,
        group: s.group,
        description: (await accessibleName(s.button)).replace(/\.$/, ''),
      });
    }
    return out;
  } finally {
    await editor.closeSidePanels();
  }
}

/** Adds captions to every scene, or only scene `scene`, in style `style` (1-based). */
export async function addCaptions(
  editor: VidsEditor,
  options: { scene?: number; style: number; timeoutMs: number },
): Promise<{ style: CaptionStyle; scope: 'all' | 'scene' }> {
  await editor.selectScene(options.scene ?? 1);
  const panel = await openPanel(editor);
  try {
    await uiStep(editor.ui, 'The captions scope', () =>
      panel.getByRole('radio', { name: options.scene ? /^Current scene$/ : /^All scenes$/ }).click(),
    );
    const styles = await styleButtons(panel);
    const chosen = styles[options.style - 1];
    if (!chosen) {
      throw new UsageError(
        `There are ${styles.length} caption styles; --style ${options.style} is out of range.`,
        {
          hint: 'List them with: gvids captions styles <id>',
        },
      );
    }
    const style: CaptionStyle = {
      index: options.style,
      group: chosen.group,
      description: (await accessibleName(chosen.button)).replace(/\.$/, ''),
    };
    const before = (await editor.objects()).length;
    await uiStep(editor.ui, 'The caption style', () => chosen.button.click());
    // Transcription runs in Google's backend; captions appear as objects and a caption track.
    const used = panel.getByRole('heading', { name: USED });
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      if ((await editor.objects().catch(() => [])).length > before) break;
      if (await used.isVisible().catch(() => false)) break;
      await sleep(1000);
    }
    if (Date.now() >= deadline) {
      throw new FeatureUnavailableError('No captions were added.', {
        hint: 'Captions are transcribed from speech: add a voiceover, an avatar or recorded audio first.',
      });
    }
    return { style, scope: options.scene ? 'scene' : 'all' };
  } finally {
    await editor.closeSidePanels();
  }
}

/** More > Delete all captions. Returns false when the video had none. */
export async function removeCaptions(editor: VidsEditor): Promise<boolean> {
  const panel = await openPanel(editor);
  try {
    if (
      !(await panel
        .getByRole('heading', { name: USED })
        .isVisible()
        .catch(() => false))
    )
      return false;
    await uiStep(editor.ui, 'The captions "Delete all captions" item', async () => {
      await panel.getByRole('button', { name: /^More$/ }).click();
      await editor.page
        .getByRole('menuitem', { name: /^Delete all captions/ })
        .filter({ visible: true })
        .first()
        .click();
    });
    const deadline = Date.now() + 15_000;
    while (
      Date.now() < deadline &&
      (await panel
        .getByRole('heading', { name: USED })
        .isVisible()
        .catch(() => false))
    )
      await sleep(400);
    return true;
  } finally {
    await editor.closeSidePanels();
  }
}
