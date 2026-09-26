import type { FrameLocator } from 'playwright';
import { UsageError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import type { SceneObject, TimelineClip } from '../../vids/types.js';
import { accessibleName, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

/**
 * Insert > Stock & web: Google's picker (an iframe) that searches Getty Images
 * videos and photos, Shutterstock music, and stickers. Clicking a result inserts
 * it into the selected scene. Observed on 2026-09-24 with hl=en.
 */
export const STOCK_TYPES = ['video', 'image', 'music', 'sticker'] as const;
export type StockType = (typeof STOCK_TYPES)[number];

/** Only the search-result grids: the picker first shows suggestion grids with similar names. */
const RESULT_LISTS: Record<StockType, RegExp> = {
  video: /^Grid of videos for search results/i,
  image: /^Grid of (stock )?images for search results/i,
  music: /^Grid of music( tracks)? for search results/i,
  sticker: /^Grid of (stickers|GIFs) for search results/i,
};

async function openPicker(editor: VidsEditor): Promise<FrameLocator> {
  await editor.openInsertion('stock');
  const frame = editor.page.locator('iframe[src*="/picker/"]').last().contentFrame();
  await uiStep(editor.ui, 'The "Stock & web" search box', () =>
    frame.getByRole('combobox', { name: /^Search$/ }).waitFor({ state: 'visible', timeout: 30_000 }),
  );
  return frame;
}

async function search(
  editor: VidsEditor,
  frame: FrameLocator,
  query: string,
  type: StockType,
): Promise<void> {
  const box = frame.getByRole('combobox', { name: /^Search$/ }).first();
  await box.click();
  await box.fill(query);
  await box.press('Enter');
  // Results replace the suggestions progressively; wait for this type's result grid.
  const results = frame.getByRole('listbox', { name: RESULT_LISTS[type] }).first();
  const found = await results
    .getByRole('option')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!found) {
    // The grid may be absent when there are no results of this type.
    await uiStep(editor.ui, `Stock results for "${query}"`, () =>
      frame.getByRole('listbox').getByRole('option').first().waitFor({ state: 'visible', timeout: 5_000 }),
    );
  }
  await sleep(500);
}

export interface StockResult {
  index: number;
  title: string;
  provider?: string;
}

function describe(label: string, index: number): StockResult {
  const m = /^(.*?)\s*\(Provided by ([^)]+)\)\s*$/.exec(label);
  return { index, title: (m ? m[1]! : label).trim(), ...(m ? { provider: m[2]! } : {}) };
}

/** Lists stock results of one type without inserting anything. */
export async function searchStock(
  editor: VidsEditor,
  query: string,
  type: StockType,
  limit: number,
): Promise<StockResult[]> {
  const frame = await openPicker(editor);
  try {
    await search(editor, frame, query, type);
    const options = frame.getByRole('listbox', { name: RESULT_LISTS[type] }).first().getByRole('option');
    const out: StockResult[] = [];
    const count = Math.min(limit, await options.count());
    for (let i = 0; i < count; i++) out.push(describe(await accessibleName(options.nth(i)), i + 1));
    return out;
  } finally {
    await editor.closeSidePanels();
  }
}

/** Searches stock media and inserts result `pick` (1-based) of `type` into scene `n`. */
export async function insertStock(
  editor: VidsEditor,
  n: number,
  query: string,
  type: StockType,
  pick: number,
  timeoutMs: number,
): Promise<StockResult & { object?: SceneObject; clip?: TimelineClip }> {
  let chosen: StockResult | undefined;
  const inserted = await editor.insertMedia(
    n,
    'Inserting the stock item',
    timeoutMs,
    async () => {
      const frame = await openPicker(editor);
      await search(editor, frame, query, type);
      const options = frame.getByRole('listbox', { name: RESULT_LISTS[type] }).first().getByRole('option');
      const count = await options.count();
      if (count < pick) {
        await editor.closeSidePanels();
        throw new UsageError(
          count === 0
            ? `No stock ${type} results for "${query}".`
            : `Only ${count} stock ${type} results for "${query}"; --pick ${pick} is out of range.`,
          { hint: `See the results first: gvids media stock-search <id> "${query}" --type ${type}` },
        );
      }
      const option = options.nth(pick - 1);
      chosen = describe(await accessibleName(option), pick);
      // A music row is mostly its player (Play button, waveform): click its title to insert it.
      const target = type === 'music' ? option.getByText(/\S/).first() : option;
      await uiStep(editor.ui, `Stock result ${pick}`, () => target.click());
    },
    type === 'video',
  );
  await editor.closeSidePanels();
  return { ...chosen!, ...inserted };
}
