import type { Page } from 'playwright';
import { BrowserLoginRequiredError, FeatureUnavailableError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { extractVidIdFromEditorUrl, isGoogleSignInUrl, vidEditUrl, vidsHomeUrl } from '../../vids/urls.js';
import { HOME_CSS, HOME_LABELS } from '../selectors/home.js';
import { detectAvailabilityProblem } from '../ui.js';
import type { EditorOptions } from './editor-page.js';

export interface HomeVideo {
  id: string;
  name: string;
  url: string;
  /** As shown by Vids, e.g. "11:42 AM" or "Sep 22, 2026". */
  lastOpened?: string;
}

interface RawItem {
  index: number;
  id?: string;
  name: string;
  lastOpened?: string;
  vids: boolean;
}

/**
 * The Vids home page: recent videos, or search results with `query` (the same
 * search box as the page, via its `q=` parameter). Used when there is no Drive
 * API login.
 */
export class VidsHome {
  private constructor(private readonly page: Page) {}

  static async open(page: Page, options: EditorOptions, query?: string): Promise<VidsHome> {
    const url = new URL(vidsHomeUrl({ hl: options.hl, authuser: options.authuser }));
    if (query) url.searchParams.set('q', query);
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    const home = new VidsHome(page);
    await home.waitForList();
    return home;
  }

  /** Waits for the first result, or gives up quietly when the list is empty. */
  private async waitForList(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isGoogleSignInUrl(this.page.url())) throw new BrowserLoginRequiredError();
      if ((await this.page.locator(HOME_CSS.item).count()) > 0) {
        await sleep(800);
        return;
      }
      const availability = await detectAvailabilityProblem(this.page);
      if (availability) throw new FeatureUnavailableError(availability.message, { code: availability.code });
      await sleep(300);
    }
  }

  private async readItems(): Promise<RawItem[]> {
    return this.page.locator(HOME_CSS.item).evaluateAll(
      (els, css) =>
        els.map((e, index) => {
          const style = e.querySelector(css.thumbnail)?.getAttribute('style') ?? '';
          const id = /\/d\/([A-Za-z0-9_-]{20,})=/.exec(style)?.[1];
          const title = e.querySelector(css.title);
          const time = e.querySelector(css.time)?.getAttribute('aria-label') ?? undefined;
          return {
            index,
            ...(id ? { id } : {}),
            name: title?.getAttribute('title') ?? title?.textContent?.trim() ?? '',
            ...(time ? { lastOpened: time } : {}),
            vids: e.querySelector(css.vidsIcon) !== null,
          };
        }),
      HOME_CSS,
    );
  }

  /** Looks up an item's ID through "More actions" › "Open in new tab" when its thumbnail has none. */
  private async idViaNewTab(index: number): Promise<string | undefined> {
    const item = this.page.locator(HOME_CSS.item).nth(index);
    try {
      await item.hover();
      await item.getByRole('button', { name: HOME_LABELS.moreActions }).click({ timeout: 5_000 });
      const popup = this.page.context().waitForEvent('page', { timeout: 15_000 });
      await this.page.getByRole('menuitem', { name: HOME_LABELS.openInNewTab }).click({ timeout: 5_000 });
      const tab = await popup;
      await tab.waitForURL(/\/videos\/d\//, { timeout: 15_000 }).catch(() => undefined);
      const id = extractVidIdFromEditorUrl(tab.url());
      await tab.close().catch(() => undefined);
      return id;
    } catch {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      return undefined;
    }
  }

  async videos(limit: number): Promise<HomeVideo[]> {
    // Thumbnails (which carry the IDs) load lazily; bring each item into view once.
    const count = await this.page.locator(HOME_CSS.item).count();
    for (let i = 0; i < count; i++) {
      await this.page
        .locator(HOME_CSS.item)
        .nth(i)
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
    }
    await sleep(500);
    const items = (await this.readItems()).filter((i) => i.vids);
    // Search shows some videos twice (top results + all results); one copy may lack a thumbnail.
    const namesWithId = new Set(items.filter((i) => i.id).map((i) => i.name));
    const out: HomeVideo[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (out.length >= limit) break;
      if (!item.id && namesWithId.has(item.name)) continue;
      const id = item.id ?? (await this.idViaNewTab(item.index));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: item.name,
        url: vidEditUrl(id),
        ...(item.lastOpened ? { lastOpened: item.lastOpened.replace(HOME_LABELS.lastOpenedPrefix, '') } : {}),
      });
    }
    return out;
  }
}
