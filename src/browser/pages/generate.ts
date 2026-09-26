import type { Locator } from 'playwright';
import { FeatureUnavailableError, GenerationTimeoutError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import type { SceneObject, TimelineClip } from '../../vids/types.js';
import { detectAvailabilityProblem, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

/**
 * Insert > Generate an image (Imagen) and Insert > Generate music (Lyria).
 * Both spend Google AI allowance. Observed on 2026-09-24 with hl=en.
 */
export const IMAGE_ASPECTS = {
  square: /Square 1:1$/,
  landscape: /Landscape 16:9$/,
  portrait: /Portrait 9:16$/,
};
export type ImageAspect = keyof typeof IMAGE_ASPECTS;
export const IMAGE_STYLES = [
  'photography',
  'background',
  'vector-art',
  'sketch',
  'watercolor',
  'cyberpunk',
  'none',
] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number];

const STYLE_LABEL: Record<ImageStyle, string> = {
  photography: 'Photography',
  background: 'Background',
  'vector-art': 'Vector art',
  sketch: 'Sketch',
  watercolor: 'Watercolor',
  cyberpunk: 'Cyberpunk',
  none: 'No style',
};

/** Waits for `ready()` while watching for Google's quota/availability messages. */
async function waitGenerated<T>(
  editor: VidsEditor,
  what: string,
  timeoutMs: number,
  ready: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await ready().catch(() => undefined);
    if (done !== undefined) return done;
    const problem = await detectAvailabilityProblem(editor.page);
    if (problem) throw new FeatureUnavailableError(`${what}: ${problem.message}`, { code: problem.code });
    await sleep(1500);
  }
  throw new GenerationTimeoutError(what, timeoutMs);
}

export async function generateImage(
  editor: VidsEditor,
  n: number,
  options: { prompt: string; aspect?: ImageAspect; style?: ImageStyle; timeoutMs: number },
): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
  const page = editor.page;
  return editor.insertMedia(n, 'Inserting the generated image', options.timeoutMs, async () => {
    await editor.openInsertion('image');
    const panel = page.getByRole('complementary', { name: /^Generate an image$/ }).first();
    await uiStep(editor.ui, 'The "Generate an image" panel', () =>
      panel.getByRole('textbox', { name: /^Describe your idea/ }).waitFor({ timeout: 20_000 }),
    );
    await panel.getByRole('textbox', { name: /^Describe your idea/ }).fill(options.prompt);
    const choose = async (listbox: RegExp, option: RegExp, what: string): Promise<void> =>
      uiStep(editor.ui, `The image ${what} option`, async () => {
        await panel.getByRole('listbox', { name: listbox }).first().click();
        // Choices were options in a listbox; since 2026-09-26 they are menuitemradios in a menu.
        await page
          .getByRole('option', { name: option })
          .or(page.getByRole('menuitemradio', { name: option }))
          .filter({ visible: true })
          .last()
          .click({ timeout: 10_000 });
      });
    if (options.aspect) await choose(/^Aspect ratio$/, IMAGE_ASPECTS[options.aspect], 'aspect ratio');
    if (options.style) {
      await choose(/^Add a style$/, new RegExp(`: ${STYLE_LABEL[options.style]}$`, 'i'), 'style');
    }
    const results = panel.getByRole('menuitem', { name: /^Create image:/ });
    const before = await results.count();
    await uiStep(editor.ui, 'The image "Create" button', () =>
      panel
        .getByRole('button', { name: /^Create$/ })
        .first()
        .click(),
    );
    const result = await waitGenerated(editor, 'Image generation', options.timeoutMs, async () =>
      (await results.count()) > before ? results.first() : undefined,
    );
    await result.click();
    // The result opens a preview on the canvas with Insert / close.
    await uiStep(editor.ui, 'The image preview "Insert" button', () =>
      page
        .locator('[aria-label="Preview"]')
        .getByRole('button', { name: /^Insert$/ })
        .first()
        .click({ timeout: 20_000 }),
    );
  });
}

export async function generateMusic(
  editor: VidsEditor,
  n: number,
  options: { prompt: string; full: boolean; instrumental: boolean; timeoutMs: number },
): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
  const page = editor.page;
  return editor.insertMedia(n, 'Inserting the generated song', options.timeoutMs, async () => {
    await editor.openInsertion('music');
    const panel = page.getByRole('complementary', { name: /^Generate a song$/ }).first();
    const prompt = panel.getByRole('textbox', { name: /^Describe your song/ });
    await uiStep(editor.ui, 'The "Generate a song" panel', () => prompt.waitFor({ timeout: 20_000 }));
    await prompt.fill(options.prompt);
    await uiStep(editor.ui, 'The song settings', async () => {
      await panel.getByRole('button', { name: /•/ }).first().click();
      await panel.getByRole('radio', { name: options.full ? /^Full song$/ : /^30 second clip$/ }).click();
      const instrumental = panel.getByRole('switch', { name: /^Instrumental$/ });
      if ((await instrumental.isChecked()) !== options.instrumental) await instrumental.click();
      await page.keyboard.press('Escape');
    });
    const groups: Locator = panel
      .getByRole('group')
      .filter({ has: page.getByRole('button', { name: /^Insert$/ }) });
    const before = await groups.count();
    await uiStep(editor.ui, 'The song "Generate" button', () =>
      panel
        .getByRole('button', { name: /^Generate$/ })
        .first()
        .click(),
    );
    const result = await waitGenerated(editor, 'Song generation', options.timeoutMs, async () =>
      (await groups.count()) > before ? groups.first() : undefined,
    );
    await uiStep(editor.ui, 'The song "Insert" button', () =>
      result.getByRole('button', { name: /^Insert$/ }).click(),
    );
  });
}
