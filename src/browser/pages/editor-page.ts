import type { Locator, Page } from 'playwright';
import {
  BrowserLoginRequiredError,
  FeatureUnavailableError,
  GenerationTimeoutError,
  GvidsError,
  NotFoundError,
  PermissionError,
  UiChangedError,
  UsageError,
  VidsNotFoundError,
} from '../../errors/errors.js';
import type { Logger } from '../../utils/logger.js';
import { sleep } from '../../utils/time.js';
import type { SceneInfo, SceneObject, TimelineClip, VideoFormat } from '../../vids/types.js';
import { extractVidIdFromEditorUrl, isGoogleSignInUrl, vidEditUrl } from '../../vids/urls.js';
import type { Diagnostics } from '../diagnostics/diagnostics.js';
import { EDITOR_CSS, EDITOR_LABELS, START_LABELS, type InsertionTool } from '../selectors/editor.js';
import { appears, armed, timeoutError, uiStep, type UiContext } from '../ui.js';

export interface EditorOptions {
  hl: string;
  authuser: number;
  /** Default timeout for individual UI steps. */
  timeoutMs: number;
  diagnostics: Diagnostics;
  logger: Logger;
}

type MenuMatcher = string | RegExp;

const HEX = /^#?([0-9a-f]{6})$/i;
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|avi|mkv|wmv|mpe?g|3gp|ogv)$/i;

/** "1 minute 2 seconds" -> 62. */
function clipSeconds(s: string): number | undefined {
  let total = 0;
  let found = false;
  for (const part of s.matchAll(/(\d+(?:\.\d+)?) (hour|minute|second)s?/g)) {
    found = true;
    const n = Number(part[1]);
    total += part[2] === 'hour' ? n * 3600 : part[2] === 'minute' ? n * 60 : n;
  }
  return found ? total : undefined;
}

/** Parses a timeline clip label such as "Welcome to the - Elio starting in scene 1 at 0 seconds with duration 3 seconds". */
export function parseClipLabel(label: string): TimelineClip {
  const m = /^(.*?) - (.+?) starting in scene (\d+) at (.+?) with duration (.+)$/.exec(label);
  if (!m) {
    // Uploaded audio/video files have no speaker: "tone.mp3 starting in scene 1 at 2 seconds with duration 3 seconds".
    const plain = /^(.+?) starting in scene (\d+) at (.+?) with duration (.+)$/.exec(label);
    if (!plain) return { label, kind: 'unknown' };
    const start = clipSeconds(plain[3]!);
    const duration = clipSeconds(plain[4]!);
    return {
      label,
      kind: /\.(mp4|m4v|mov|webm|avi|mkv)$/i.test(plain[1]!)
        ? 'video'
        : /Shutterstock|music|song/i.test(plain[1]!)
          ? 'music'
          : 'audio',
      scene: Number(plain[2]),
      ...(start !== undefined ? { startSeconds: start } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      title: plain[1]!,
    };
  }
  const speaker = m[2]!;
  const kind: TimelineClip['kind'] = /Shutterstock|music|song/i.test(label)
    ? 'music'
    : /avatar/i.test(speaker)
      ? 'avatar'
      : 'voiceover';
  const start = clipSeconds(m[4]!);
  const duration = clipSeconds(m[5]!);
  return {
    label,
    kind,
    scene: Number(m[3]),
    ...(start !== undefined ? { startSeconds: start } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    title: m[1]!,
    speaker,
  };
}

/** One timeline scene tile as read from the page. */
interface RawSceneTile {
  index: number;
  total: number;
  /** The thumbnail content is drawn (long timelines draw off-screen tiles lazily). */
  rendered: boolean;
  duration?: number;
  text: string;
  transition?: string;
}

/**
 * Page object for the Google Vids editor. Every UI assumption about the
 * editor lives here or in ../selectors; commands never touch raw locators.
 */
export class VidsEditor {
  private menusShownByUs = false;

  private constructor(
    readonly page: Page,
    readonly options: EditorOptions,
  ) {}

  get ui(): UiContext {
    return { page: this.page, diagnostics: this.options.diagnostics };
  }

  /** Opens an existing Vid and waits until the editor is interactive. */
  static async open(
    page: Page,
    id: string,
    options: EditorOptions,
    open: { allowTrashed?: boolean } = {},
  ): Promise<VidsEditor> {
    const editor = new VidsEditor(page, options);
    await page.goto(vidEditUrl(id, { hl: options.hl, authuser: options.authuser }), {
      waitUntil: 'domcontentloaded',
    });
    await editor.waitReady(id);
    if (!open.allowTrashed && (await editor.isInTrash(250))) {
      throw new NotFoundError(`Video ${id} is in the trash.`, {
        code: 'VIDEO_IN_TRASH',
        hint: `Restore it first: gvids restore ${id}`,
        details: { id },
      });
    }
    return editor;
  }

  /** Takes over an idle editor tab from an earlier command (no reload). */
  static async resume(
    page: Page,
    id: string,
    options: EditorOptions,
    open: { allowTrashed?: boolean } = {},
  ): Promise<VidsEditor> {
    const editor = new VidsEditor(page, options);
    // Leave any text-edit mode, open menu or dialog the tab may still be in (an interrupted command
    // can leave one behind). If one stays open, the caller reloads the tab instead.
    const leftOpen = page.locator('[role=dialog][aria-modal=true], [role=menu]').filter({ visible: true });
    for (let round = 0; ; round++) {
      await page.keyboard.press('Escape').catch(() => undefined);
      if ((await leftOpen.count().catch(() => 0)) === 0) break;
      if (round === 2) throw new Error('A dialog or menu is still open in the reused tab.');
      await sleep(150);
    }
    await editor.waitReady(id);
    if (!open.allowTrashed && (await editor.isInTrash())) {
      throw new NotFoundError(`Video ${id} is in the trash.`, {
        code: 'VIDEO_IN_TRASH',
        hint: `Restore it first: gvids restore ${id}`,
        details: { id },
      });
    }
    return editor;
  }

  /** Wraps a page that already shows the editor (e.g. right after creation). */
  static async attach(page: Page, options: EditorOptions): Promise<VidsEditor> {
    const editor = new VidsEditor(page, options);
    await editor.waitReady(extractVidIdFromEditorUrl(page.url()) ?? 'unknown');
    return editor;
  }

  get id(): string {
    const id = extractVidIdFromEditorUrl(this.page.url());
    if (!id) throw new UsageError(`Not a Google Vids editor URL: ${this.page.url()}`);
    return id;
  }

  async title(): Promise<string> {
    return (await this.page.title()).replace(/ - Google Vids$/, '');
  }

  /** Waits for the editor chrome; detects sign-in redirects and missing/forbidden files. */
  async waitReady(id: string, timeoutMs = 90_000): Promise<void> {
    const insertion = this.page.getByRole('toolbar', { name: EDITOR_LABELS.toolbars.insertion });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const url = this.page.url();
      if (isGoogleSignInUrl(url)) throw new BrowserLoginRequiredError();
      if (await insertion.isVisible().catch(() => false)) {
        // The document model (scene thumbnails, trash state, popups) lands a moment later.
        await this.waitForThumbnails();
        await this.dismissPopups();
        return;
      }
      // A trashed video can show its modal "File is in trash" dialog before the toolbar
      // appears; the editor behind it is then aria-hidden. Callers check isInTrash().
      const trashed = await this.trashDialog()
        .isVisible()
        .catch(() => false);
      if (trashed) return;
      // A never-edited video reopens its modal "Getting started" dialog; closing it
      // leaves the blank video (what the dialog's own Close button does).
      const start = this.page.getByRole('dialog', { name: START_LABELS.dialog });
      if (await start.isVisible().catch(() => false)) {
        this.options.logger.debug('closing the "Getting started" dialog of an unedited video');
        await start
          .getByRole('button', { name: EDITOR_LABELS.dismissible.close })
          .last()
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      }
      const bodyText = await this.page
        .evaluate(() => document.body?.innerText.slice(0, 2000) ?? '')
        .catch(() => '');
      if (/file you have requested does not exist|Sorry, unable to open the file/i.test(bodyText)) {
        throw new VidsNotFoundError(id);
      }
      if (/You need access|Request access/i.test(bodyText) && !(await insertion.count())) {
        throw new PermissionError(`The signed-in browser account cannot open video ${id}.`, {
          hint: 'Ask the owner to share it, or sign the gvids browser in with another account (gvids browser login).',
        });
      }
      await sleep(250);
    }
    await uiStep(this.ui, 'Google Vids editor toolbar', async () => {
      await insertion.waitFor({ state: 'visible', timeout: 1000 });
    });
  }

  /**
   * Closes coach marks ("Got it"), the aspect-ratio toast and rating prompts.
   * Only ever presses "Got it"/"Close" — never feedback buttons.
   */
  async dismissPopups(): Promise<void> {
    const page = this.page;
    for (let round = 0; round < 3; round++) {
      let dismissed = false;
      const gotIt = page
        .getByRole('dialog')
        .filter({ visible: true })
        .getByRole('button', { name: EDITOR_LABELS.dismissible.gotIt });
      if ((await gotIt.count()) > 0) {
        await gotIt
          .first()
          .click({ timeout: 3000 })
          .catch(() => undefined);
        dismissed = true;
      }
      const toasts = page
        .getByRole('dialog', { name: /Aspect ratio changed/i })
        .filter({ visible: true })
        .getByRole('button', { name: EDITOR_LABELS.dismissible.close });
      if ((await toasts.count()) > 0) {
        await toasts
          .first()
          .click({ timeout: 3000 })
          .catch(() => undefined);
        dismissed = true;
      }
      const ratings = page
        .getByRole('alert')
        .filter({ hasText: /How would you rate|Did this .* help/i })
        .filter({ visible: true })
        .getByRole('button', { name: EDITOR_LABELS.dismissible.close });
      if ((await ratings.count()) > 0) {
        await ratings
          .first()
          .click({ timeout: 3000 })
          .catch(() => undefined);
        dismissed = true;
      }
      if (!dismissed) return;
      await sleep(250);
    }
  }

  // ----------------------------------------------------------------- trash

  /** The alert dialog Vids shows over a trashed video. */
  private trashDialog(): Locator {
    return this.page
      .getByRole('alertdialog')
      .filter({ has: this.page.getByRole('button', { name: EDITOR_LABELS.trash.restore }) })
      .filter({ visible: true })
      .first();
  }

  /**
   * The dialog shows up well before the editor toolbar, so after waitReady() a
   * plain visibility check is enough; pass `waitMs` right after an action.
   */
  async isInTrash(waitMs = 0): Promise<boolean> {
    if (waitMs <= 0)
      return this.trashDialog()
        .isVisible()
        .catch(() => false);
    return appears(this.trashDialog(), waitMs);
  }

  /**
   * File > Move to trash: "already" when the video was in the trash, "unsaved"
   * when Vids never saved it to Drive (then there is nothing to trash).
   */
  async moveToTrash(): Promise<'trashed' | 'already' | 'unsaved'> {
    if (await this.isInTrash(1_500)) return 'already';
    try {
      await this.menu([EDITOR_LABELS.topMenus.file, EDITOR_LABELS.menuItems.moveToTrash]);
    } catch (err) {
      if (!(err instanceof FeatureUnavailableError)) throw err;
      if (!(await this.isSavedToDrive().catch(() => true))) return 'unsaved';
      throw new FeatureUnavailableError('Vids does not offer "Move to trash" for this video.', {
        hint: `Trash it in Google Drive, or with the Drive API: gvids auth login, then gvids trash ${this.id} --yes`,
        cause: err,
      });
    }
    await uiStep(this.ui, 'The "File moved to trash" confirmation', async () => {
      await this.trashDialog().waitFor({ state: 'visible', timeout: 20_000 });
    });
    return 'trashed';
  }

  /** Opens a menubar menu, reads whether each of `items` is disabled, and closes it. */
  async menuItemsDisabled(top: string, items: MenuMatcher[]): Promise<boolean[]> {
    await this.dismissPopups();
    await this.showMenus();
    await uiStep(this.ui, `The "${top}" menu`, async () => {
      await this.page
        .getByRole('menubar')
        .getByRole('menuitem', { name: top, exact: true })
        .click({ timeout: this.options.timeoutMs });
      await this.visibleMenuItem(items[0]!).waitFor({ state: 'visible', timeout: 10_000 });
    });
    const out: boolean[] = [];
    for (const item of items) {
      const disabled = await this.visibleMenuItem(item)
        .getAttribute('aria-disabled', { timeout: 5_000 })
        .catch(() => null);
      out.push(disabled === 'true');
    }
    await this.page.keyboard.press('Escape').catch(() => undefined);
    return out;
  }

  /**
   * Vids saves a new video to Drive at its first edit. Until then File > Move to
   * trash, Version history and Details are disabled, and the Drive API answers
   * "File not found" for its ID (observed 2026-09-25).
   */
  async isSavedToDrive(): Promise<boolean> {
    const [history] = await this.menuItemsDisabled(EDITOR_LABELS.topMenus.file, [
      EDITOR_LABELS.menuItems.versionHistory,
    ]);
    return !history;
  }

  /** Presses "Take out of trash". Returns false when the video was not in the trash. */
  async restoreFromTrash(): Promise<boolean> {
    if (!(await this.isInTrash(1_500))) return false;
    await uiStep(this.ui, 'The "Take out of trash" button', async () => {
      const dialog = this.trashDialog();
      await dialog.getByRole('button', { name: EDITOR_LABELS.trash.restore }).click({ timeout: 10_000 });
      await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
    });
    return true;
  }

  /** The menus are hidden by default in Vids ("compact controls"); show them while automating. */
  async showMenus(): Promise<void> {
    const menubar = this.page.getByRole('menubar');
    if (await menubar.isVisible().catch(() => false)) return;
    await uiStep(this.ui, 'The "Show the menus" button', async () => {
      await this.page
        .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.modeAndView })
        .getByRole('button', { name: EDITOR_LABELS.showMenus })
        .click({ timeout: this.options.timeoutMs });
      await menubar.waitFor({ state: 'visible', timeout: this.options.timeoutMs });
    });
    this.menusShownByUs = true;
  }

  /** Puts the user's UI preferences back (hides menus again if gvids showed them). */
  async restoreUi(): Promise<void> {
    await this.closeSidePanels().catch(() => undefined);
    if (!this.menusShownByUs || this.page.isClosed()) return;
    const hide = this.page
      .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.modeAndView })
      .getByRole('button', { name: EDITOR_LABELS.hideMenus });
    if (await hide.isVisible().catch(() => false)) await hide.click({ timeout: 5000 }).catch(() => undefined);
    this.menusShownByUs = false;
  }

  private visibleMenuItem(matcher: MenuMatcher): Locator {
    return this.page.getByRole('menuitem', { name: matcher }).filter({ visible: true }).last();
  }

  /**
   * Clicks through a menu path, e.g. ['Scene', /^Move scene/, /^Move scene left/].
   * The first element is a menubar item; middle elements open submenus.
   */
  async menu(path: MenuMatcher[], opts: { keepSelection?: boolean } = {}): Promise<void> {
    if (path.length < 2) throw new UsageError('A menu path needs at least a menu and an item.');
    await this.dismissPopups();
    await this.showMenus();
    // Escape closes a stray menu, but with nothing open it deselects the current object,
    // which disables object menus (Format > Video …): only press it when a menu is open.
    const escape = async (): Promise<void> => {
      if (
        opts.keepSelection &&
        (await this.page
          .getByRole('menu')
          .filter({ visible: true })
          .count()
          .catch(() => 0)) === 0
      )
        return;
      await this.page.keyboard.press('Escape').catch(() => undefined);
    };
    const [top, ...rest] = path;
    const topItem = this.page
      .getByRole('menubar')
      .getByRole('menuitem', { name: top!, exact: typeof top === 'string' });
    // The menubar can ignore clicks while the editor is initializing, and popups
    // (e.g. the "Download started" bubble) can take focus and close an open menu.
    // So the whole path is retried; only the last attempt reports a UI failure
    // (with diagnostics). The final item is never clicked twice.
    const attempts = 4;
    for (let attempt = 1; ; attempt++) {
      const final = attempt === attempts;
      const step = <T>(what: string, fn: () => Promise<T>): Promise<T> =>
        final ? uiStep(this.ui, what, fn) : fn();
      const waitMs = final ? 10_000 : 2_500;
      let committed = false;
      try {
        await step(`The "${String(top)}" menu`, async () => {
          await escape();
          await topItem.click({ timeout: this.options.timeoutMs });
          await this.visibleMenuItem(rest[0]!).waitFor({ state: 'visible', timeout: waitMs });
        });
        for (let i = 0; i < rest.length; i++) {
          const matcher = rest[i]!;
          await step(`The menu item "${String(matcher)}"`, async () => {
            const item = this.visibleMenuItem(matcher);
            await item.waitFor({ state: 'visible', timeout: waitMs });
            if ((await item.getAttribute('aria-disabled')) === 'true') {
              await this.page.keyboard.press('Escape');
              throw new FeatureUnavailableError(
                `The menu item "${String(matcher)}" is disabled for this video.`,
                { hint: 'Some Vids features only work for landscape videos or with a scene selected.' },
              );
            }
            if (i === rest.length - 1) {
              // Never guess: a pattern that matches two items of the open menu (e.g. "Move" and
              // "Move to trash") would click the wrong one.
              const siblings = await this.page
                .getByRole('menu')
                .filter({ visible: true })
                .last()
                .getByRole('menuitem', { name: matcher })
                .count()
                .catch(() => 1);
              if (siblings > 1) {
                await this.page.keyboard.press('Escape');
                throw new UiChangedError(
                  `A single menu item matching ${String(matcher)} (found ${siblings})`,
                );
              }
              committed = true;
              await item.click({ timeout: waitMs });
            } else {
              await item.hover({ timeout: waitMs });
              await sleep(400);
            }
          });
        }
        return;
      } catch (err) {
        if (final || committed || err instanceof GvidsError) throw err;
        this.options.logger.debug({ attempt, err: String(err) }, 'menu path interrupted; retrying');
        await escape();
        await escape();
        await this.dismissPopups();
      }
    }
  }

  /**
   * Waits until Drive has saved. Reads the "Document status: …" button (present
   * even with menus hidden) and needs two "Saved" readings in a row, so an edit
   * made just before is not mistaken for saved; falls back to the menu caption.
   */
  async waitForSaved(timeoutMs = 45_000): Promise<boolean> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    let savedStreak = 0;
    while (Date.now() < deadline) {
      const { status, caption } = await this.page
        .evaluate((css) => {
          const status = [...document.querySelectorAll('[aria-label^="Document status"]')]
            .map((e) => e.getAttribute('aria-label') ?? '')
            .join(' ');
          const caption = [...document.querySelectorAll(css)].map((e) => e.textContent ?? '').join(' ');
          return { status, caption };
        }, EDITOR_CSS.saveIndicator)
        .catch(() => ({ status: '', caption: '' }));
      const text = `${status} ${caption}`;
      const saved = /Saved to Drive|All changes saved/i.test(text) && !/Saving/i.test(text);
      savedStreak = saved ? savedStreak + 1 : 0;
      if (savedStreak >= 2) return true;
      // Nothing to read at all (unusual editor state): give it a short grace period.
      if (!status && caption.trim() === '' && Date.now() - started > 2_000) return true;
      await sleep(400);
    }
    return false;
  }

  // ---------------------------------------------------------------- scenes

  async sceneCount(): Promise<number> {
    return this.page.getByRole('button', { name: EDITOR_LABELS.sceneButton }).count();
  }

  /**
   * Scene thumbnails render shortly after the timeline appears (a content <g>
   * is prepended to each tile). Wait for them so on-screen text can be read;
   * off-screen tiles may render lazily, so a stable partial count also ends the wait.
   */
  private async waitForThumbnails(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      const { total, rendered } = await this.page
        .evaluate(() => {
          const rects = [...document.querySelectorAll('[role=button][aria-label^="Scene "]')];
          const done = rects.filter((rect) => {
            const thumb = [...(rect.parentElement?.children ?? [])].find(
              (c) => c.tagName.toLowerCase() === 'g' && !c.getAttribute('class'),
            );
            return thumb?.firstElementChild?.tagName.toLowerCase() === 'g';
          });
          return { total: rects.length, rendered: done.length };
        })
        .catch(() => ({ total: 0, rendered: 0 }));
      if (total > 0 && rendered === total) return;
      if (rendered > 0 && rendered === last) return;
      last = rendered;
      await sleep(250);
    }
  }

  /** Reads the timeline's scene tiles (all of them, or only the given 1-based indexes). */
  private readSceneTiles(only?: number[]): Promise<RawSceneTile[]> {
    return this.page.evaluate((onlyIndexes: number[] | null) => {
      /**
       * Joins a thumbnail's text runs. Letter-spaced designs render one <text> per letter:
       * those are joined without spaces, and a gap clearly wider than the typical one
       * between letters marks a word break.
       */
      const joinRuns = (els: Element[]): string => {
        const items = els
          .map((el) => ({ t: (el.textContent ?? '').trim(), r: el.getBoundingClientRect() }))
          .filter((i) => i.t);
        // Lines in reading (DOM) order. Slanted text drifts vertically, so each run is
        // compared with the one before it rather than with the start of its line.
        const lines: Array<typeof items> = [];
        let line: typeof items = [];
        for (const it of items) {
          const prev = line[line.length - 1];
          const sameLine =
            prev !== undefined &&
            Math.abs(prev.r.top - it.r.top) <= Math.max(1, it.r.height * 0.4) &&
            it.r.left >= prev.r.left - it.r.height * 0.2;
          if (!sameLine && line.length > 0) {
            lines.push(line);
            line = [];
          }
          line.push(it);
        }
        if (line.length > 0) lines.push(line);
        return lines
          .map((ln) => {
            const singles = ln.filter((i) => i.t.length === 1).length;
            if (singles < 3 || singles < ln.length * 0.6) return ln.map((i) => i.t).join(' ');
            // Glyph boxes overlap by a constant amount inside a word; a space widens that gap.
            const gaps = ln.slice(1).map((it, k) => it.r.left - ln[k]!.r.right);
            const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
            let s = ln[0]!.t;
            ln.slice(1).forEach((it, k) => {
              const wordBreak = gaps[k]! - typical > Math.max(1, it.r.height * 0.08);
              s += (wordBreak ? ' ' : '') + it.t;
            });
            return s;
          })
          .join(' ');
      };
      const out: RawSceneTile[] = [];
      for (const rect of document.querySelectorAll('[role=button][aria-label^="Scene "]')) {
        const m = /^Scene (\d+) of (\d+)$/.exec(rect.getAttribute('aria-label') ?? '');
        if (!m) continue;
        if (onlyIndexes && !onlyIndexes.includes(Number(m[1]))) continue;
        const group = rect.parentElement;
        let duration: number | undefined;
        let text = '';
        let transition: string | undefined;
        let rendered = false;
        if (group) {
          for (const t of group.querySelectorAll('svg text')) {
            const v = (t.textContent ?? '').trim();
            if (/^\d+\.\d$/.test(v)) duration = Number(v);
          }
          // Thumbnail tiles repeat the scene content along its duration; keep one copy.
          const thumb = [...group.children].find(
            (c) => c.tagName.toLowerCase() === 'g' && !c.getAttribute('class'),
          );
          rendered = thumb?.firstElementChild?.tagName.toLowerCase() === 'g';
          if (thumb) {
            const els = [...thumb.querySelectorAll('text')].filter((t) => (t.textContent ?? '').trim());
            const words = els.map((t) => (t.textContent ?? '').trim());
            let unit = words.length;
            for (let p = 1; p <= words.length / 2; p++) {
              if (words.length % p === 0 && words.every((w, i) => w === words[i % p])) {
                unit = p;
                break;
              }
            }
            text = joinRuns(els.slice(0, unit));
          }
          const tr =
            group.querySelector('[role=button][aria-label*=" between scene "]')?.getAttribute('aria-label') ??
            '';
          const tm = /^(.+?) between scene \d+ and \d+$/.exec(tr);
          if (tm && !/^Add transition$/i.test(tm[1]!)) transition = tm[1];
        }
        out.push({
          index: Number(m[1]),
          total: Number(m[2]),
          rendered,
          ...(duration !== undefined ? { duration } : {}),
          text: text.replace(/\s+/g, ' ').trim(),
          ...(transition ? { transition } : {}),
        });
      }
      return out;
    }, only ?? null);
  }

  async scenes(): Promise<SceneInfo[]> {
    await this.waitForThumbnails();
    const raw = await this.readSceneTiles();
    // Long timelines render thumbnails lazily: bring each missing one into view and read it again.
    const missing = raw.filter((s) => !s.rendered).map((s) => s.index);
    if (missing.length > 0) {
      for (const n of missing) {
        await this.sceneButton(n)
          .scrollIntoViewIfNeeded({ timeout: 3000 })
          .catch(() => undefined);
        const deadline = Date.now() + 1500;
        let tile = (await this.readSceneTiles([n]))[0];
        while (tile && !tile.rendered && Date.now() < deadline) {
          await sleep(150);
          tile = (await this.readSceneTiles([n]))[0];
        }
        const at = raw.findIndex((s) => s.index === n);
        if (tile && at >= 0) raw[at] = tile;
      }
      await this.sceneButton(1)
        .scrollIntoViewIfNeeded({ timeout: 3000 })
        .catch(() => undefined);
    }
    const clipLabels = await this.page
      .locator('[aria-label*=" starting in scene "]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    const clips = clipLabels.map(parseClipLabel);
    // Vids' "Scene N of M" labels can carry a stale M; the number of scene buttons is authoritative.
    return raw.map((s) => ({
      index: s.index,
      total: raw.length,
      ...(s.duration !== undefined ? { durationSeconds: s.duration } : {}),
      ...(s.text ? { text: s.text } : {}),
      ...(s.transition ? { transitionIn: s.transition } : {}),
      clips: clips.filter((c) => c.scene === s.index),
    }));
  }

  private sceneButton(n: number): Locator {
    return this.page.getByRole('button', { name: new RegExp(`^Scene ${n} of \\d+$`) });
  }

  async assertScene(n: number): Promise<number> {
    const count = await this.sceneCount();
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new UsageError(
        `Scene ${n} does not exist (this video has ${count} scene${count === 1 ? '' : 's'}).`,
        {
          hint: 'List scenes with: gvids scene list <id>',
        },
      );
    }
    return count;
  }

  /** The editor URL tracks the current scene as ?scene=id.<pageId>. */
  currentScenePageId(): string | undefined {
    return /[?&#]scene=id\.([^&#]+)/.exec(this.page.url())?.[1];
  }

  async selectScene(n: number): Promise<void> {
    await this.assertScene(n);
    await uiStep(this.ui, `Scene ${n} in the timeline`, async () => {
      await this.page.keyboard.press('Escape').catch(() => undefined);
      await this.sceneButton(n).click({ timeout: this.options.timeoutMs });
      await sleep(300);
    });
  }

  private async waitForSceneCount(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.sceneCount()) === expected) return;
      await sleep(250);
    }
    await uiStep(this.ui, what, async () => {
      throw timeoutError(`scene count did not become ${expected}`);
    });
  }

  /** Adds a blank scene after `after` (default: at the end). Returns its 1-based index. */
  async addScene(after?: number): Promise<number> {
    const count = await this.sceneCount();
    const anchor = after ?? count;
    if (anchor < 1 || anchor > count) throw new UsageError(`--after must be between 1 and ${count}.`);
    await this.selectScene(anchor);
    await uiStep(this.ui, 'The "New scene" button', async () => {
      await this.page
        .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.main })
        .getByRole('button', { name: EDITOR_LABELS.newScene })
        .click({ timeout: this.options.timeoutMs });
    });
    await this.waitForSceneCount(count + 1, 'The newly added scene');
    return anchor + 1;
  }

  async duplicateScene(n: number): Promise<number> {
    const count = await this.assertScene(n);
    await this.selectScene(n);
    await this.menu([EDITOR_LABELS.topMenus.scene, EDITOR_LABELS.menuItems.duplicateScene]);
    await this.waitForSceneCount(count + 1, 'The duplicated scene');
    return n + 1;
  }

  async deleteScene(n: number): Promise<void> {
    const count = await this.assertScene(n);
    if (count === 1) throw new UsageError('A video must keep at least one scene.');
    await this.selectScene(n);
    await this.menu([EDITOR_LABELS.topMenus.scene, EDITOR_LABELS.menuItems.deleteScene]);
    await this.waitForSceneCount(count - 1, 'The scene deletion');
  }

  /** Moves scene `from` so it ends up at position `to` (both 1-based). */
  async moveScene(from: number, to: number): Promise<void> {
    const count = await this.assertScene(from);
    if (to < 1 || to > count) throw new UsageError(`Target position must be between 1 and ${count}.`);
    if (from === to) return;
    await this.selectScene(from);
    const movingPageId = this.currentScenePageId();
    const items = EDITOR_LABELS.menuItems;
    if (to === 1) {
      await this.menu([EDITOR_LABELS.topMenus.scene, items.moveScene, items.moveSceneToBeginning]);
    } else if (to === count) {
      await this.menu([EDITOR_LABELS.topMenus.scene, items.moveScene, items.moveSceneToEnd]);
    } else {
      const step = to < from ? items.moveSceneLeft : items.moveSceneRight;
      for (let i = 0; i < Math.abs(to - from); i++) {
        await this.menu([EDITOR_LABELS.topMenus.scene, items.moveScene, step]);
        await sleep(300);
      }
    }
    if (movingPageId) {
      await this.selectScene(to);
      const now = this.currentScenePageId();
      if (now && now !== movingPageId) {
        this.options.logger.warn({ expected: movingPageId, got: now }, 'scene move verification mismatch');
      }
    }
  }

  /** Sets a solid scene background: a palette name (e.g. "black") or a hex color. */
  async setSceneBackground(n: number, color: string): Promise<void> {
    await this.selectScene(n);
    await this.menu([EDITOR_LABELS.topMenus.scene, EDITOR_LABELS.menuItems.background]);
    const hex = HEX.exec(color.trim());
    if (!hex) {
      const swatches = this.page.getByRole('gridcell').filter({ visible: true });
      await uiStep(this.ui, 'The background color palette', async () => {
        await swatches.first().waitFor({ state: 'visible', timeout: this.options.timeoutMs });
      });
      const swatch = this.page
        .getByRole('gridcell', { name: color.trim(), exact: true })
        .filter({ visible: true });
      if ((await swatch.count()) === 0) {
        // A name that is not in the palette is an argument error, not a UI change.
        const names = (
          await swatches.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
        )
          .map((n) => n.trim())
          .filter(Boolean);
        await this.page.keyboard.press('Escape').catch(() => undefined);
        throw new UsageError(`"${color}" is not a palette color.`, {
          hint: 'Use a hex value like #1a73e8, or one of the palette names in details.available.',
          details: { available: [...new Set(names)] },
        });
      }
      await uiStep(this.ui, `The "${color}" color swatch`, async () => {
        await swatch.first().click({ timeout: this.options.timeoutMs });
      });
      return;
    }
    await this.applyCustomColor(hex[1]!);
  }

  /** Uses the palette's "Add a custom color" dialog (the palette must be open). */
  async applyCustomColor(hexDigits: string): Promise<void> {
    await uiStep(this.ui, 'The custom color dialog', async () => {
      await this.page
        .getByRole('button', { name: EDITOR_LABELS.color.addCustom })
        .filter({ visible: true })
        .first()
        .click({ timeout: this.options.timeoutMs });
      const input = this.page.getByRole('textbox', { name: EDITOR_LABELS.color.hex });
      await input.waitFor({ timeout: this.options.timeoutMs });
      await input.click({ clickCount: 3 });
      await this.page.keyboard.type(hexDigits, { delay: 20 });
      await this.page.keyboard.press('Tab');
      await this.page
        .getByRole('dialog')
        .filter({ has: input })
        .getByRole('button', { name: EDITOR_LABELS.color.ok, exact: true })
        .click({ timeout: this.options.timeoutMs });
      await input.waitFor({ state: 'hidden', timeout: this.options.timeoutMs });
    });
  }

  /**
   * Changes a scene's duration by dragging its timeline edge (Vids has no
   * numeric duration field). Verifies the result and corrects up to 3 times.
   */
  async setSceneDuration(n: number, seconds: number): Promise<number> {
    if (!(seconds > 0)) throw new UsageError('--seconds must be greater than 0.');
    // The timeline snaps scene lengths to 0.1 s.
    const target = Math.round(seconds * 10) / 10;
    await this.selectScene(n);
    let pixelsPerSecond: number | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const scene = (await this.scenes()).find((s) => s.index === n);
      const current = scene?.durationSeconds;
      if (current === undefined) {
        throw new FeatureUnavailableError('Could not read the scene duration from the timeline.', {
          hint: 'Show timing in the timeline (View > Show timing) and retry.',
        });
      }
      if (Math.abs(current - target) < 0.05) return current;
      const box = await this.sceneButton(n).boundingBox();
      if (!box) throw new FeatureUnavailableError('Scene thumbnail is not visible in the timeline.');
      pixelsPerSecond ??= box.width / current;
      const handle = await this.page.evaluate(
        ({ css, x, y, w, h }) => {
          const handles = [...document.querySelectorAll(css)].map((e) => e.getBoundingClientRect());
          const edge = x + w;
          const best = handles
            .filter((r) => r.width > 0 && r.top < y + h + 10 && r.bottom > y - 10)
            .sort((a, b) => Math.abs(a.x + a.width / 2 - edge) - Math.abs(b.x + b.width / 2 - edge))[0];
          return best ? { x: best.x + best.width / 2, y: best.y + best.height / 2 } : undefined;
        },
        { css: EDITOR_CSS.sceneHandle, x: box.x, y: box.y, w: box.width, h: box.height },
      );
      const start = handle ?? { x: box.x + box.width - 2, y: box.y + box.height / 2 };
      const dx = (target - current) * pixelsPerSecond;
      // Drags shorter than a few pixels are ignored, so go past the target and come back.
      const overshoot = Math.sign(dx) * 30;
      await this.page.mouse.move(start.x, start.y);
      await this.page.mouse.down();
      await this.page.mouse.move(start.x + dx + overshoot, start.y, { steps: 8 });
      await this.page.mouse.move(start.x + dx, start.y, { steps: 6 });
      await this.page.mouse.up();
      await sleep(600);
      // Learn the real scale from larger moves (small ones are dominated by the 0.1 s snapping).
      const after = (await this.scenes()).find((s) => s.index === n)?.durationSeconds;
      if (after !== undefined && Math.abs(after - current) >= 0.5) {
        pixelsPerSecond = Math.abs(dx / (after - current));
      }
    }
    const final = (await this.scenes()).find((s) => s.index === n)?.durationSeconds;
    if (final === undefined || Math.abs(final - target) > 0.15) {
      throw new FeatureUnavailableError(`Could not set scene ${n} to ${target}s (now ${final ?? '?'}s).`, {
        hint: 'Scene length may be limited by media in the scene (e.g. a video clip).',
      });
    }
    return final;
  }

  // -------------------------------------------------------------- objects

  private visibleCanvas(): Locator {
    return this.page.locator(EDITOR_CSS.canvasSvg).filter({ visible: true }).first();
  }

  /**
   * A PNG of scene `n` as drawn on the canvas (nothing selected). `maxEdge` scales it
   * down so its longer side is at most that many pixels.
   */
  async sceneImage(n: number, maxEdge?: number): Promise<Buffer> {
    await this.selectScene(n);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    // A background tab produces no frames, so a screenshot would wait forever.
    await this.page.bringToFront().catch(() => undefined);
    // Hover toolbars (e.g. over a video) follow the mouse: park it outside the canvas.
    await this.page.mouse.move(1, 1).catch(() => undefined);
    await sleep(700);
    // Clip to the scene itself (its background group), not the whole canvas area,
    // so suggestion cards and panels next to it stay out of the picture.
    const pageId = this.currentScenePageId();
    const rect = await this.visibleCanvas()
      .evaluate((svg, id) => {
        const bg =
          (id ? svg.querySelector(`g[id="editor-${id}-bg"]`) : null) ?? svg.querySelector('g[id$="-bg"]');
        const r = (bg ?? svg).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }, pageId)
      .catch(() => undefined);
    // Editor overlays drawn above the canvas (placeholder chips, hover toolbars) are hidden
    // for the capture and restored afterwards.
    await this.visibleCanvas()
      .evaluate((svg) => {
        const r = svg.getBoundingClientRect();
        const hidden: HTMLElement[] = [];
        for (let i = 1; i < 10; i++) {
          for (let j = 1; j < 6; j++) {
            const x = r.x + (r.width * i) / 10;
            const y = r.y + (r.height * j) / 6;
            for (const el of document.elementsFromPoint(x, y)) {
              if (el === svg || svg.contains(el)) break;
              if (el instanceof HTMLElement && !hidden.includes(el) && !el.contains(svg)) {
                el.dataset.gvidsVisibility = el.style.visibility;
                el.style.visibility = 'hidden';
                hidden.push(el);
              }
            }
          }
        }
      })
      .catch(() => undefined);
    const shoot = (): Promise<Buffer> =>
      rect && rect.width > 10 && rect.height > 10
        ? this.page.screenshot({ clip: rect, type: 'png', animations: 'disabled', timeout: 15_000 })
        : this.visibleCanvas().screenshot({ type: 'png', animations: 'disabled', timeout: 15_000 });
    let png: Buffer;
    try {
      png = await uiStep(this.ui, 'The scene canvas', () =>
        shoot().catch(async () => {
          await sleep(1000);
          return shoot();
        }),
      );
    } finally {
      await this.page
        .evaluate(() => {
          for (const el of document.querySelectorAll<HTMLElement>('[data-gvids-visibility]')) {
            el.style.visibility = el.dataset.gvidsVisibility ?? '';
            delete el.dataset.gvidsVisibility;
          }
        })
        .catch(() => undefined);
    }
    if (!maxEdge) return png;
    const scaled = await this.page.evaluate(
      async ({ data, edge }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const k = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/png').split(',')[1]!;
      },
      { data: png.toString('base64'), edge: maxEdge },
    );
    return Buffer.from(scaled, 'base64');
  }

  /** Video format from the canvas proportions (no dialog; custom sizes read as the nearest). */
  async canvasFormat(): Promise<{ format: VideoFormat; label: string }> {
    const box = await this.visibleCanvas().boundingBox();
    const ratio = box && box.height > 0 ? box.width / box.height : 16 / 9;
    if (ratio > 1.25) return { format: 'landscape', label: 'Landscape 16:9' };
    if (ratio < 0.8) return { format: 'portrait', label: 'Portrait 9:16' };
    return { format: 'square', label: 'Square 1:1' };
  }

  /** Top-level objects (text boxes, images, shapes, videos) on the current scene. */
  async objects(): Promise<SceneObject[]> {
    const pageId = this.currentScenePageId();
    return this.visibleCanvas().evaluate((svg, currentPage) => {
      const groups = [...svg.querySelectorAll('g[id^="editor-"]')] as SVGGElement[];
      const pageIds = new Set(
        groups.filter((g) => g.id.endsWith('-bg')).map((g) => g.id.replace(/^editor-|-bg$/g, '')),
      );
      if (currentPage) pageIds.add(currentPage);
      const isObject = (g: Element): boolean => {
        const id = g.id.replace(/^editor-/, '');
        return !/-(bg|paragraph-\d+)$/.test(g.id) && !pageIds.has(id);
      };
      const out: Array<{
        id: string;
        text?: string;
        kind: string;
        bounds: { x: number; y: number; width: number; height: number };
      }> = [];
      for (const g of groups) {
        if (!isObject(g)) continue;
        let parent = g.parentElement;
        let nested = false;
        while (parent && parent !== svg) {
          if (parent.id?.startsWith('editor-') && isObject(parent)) {
            nested = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (nested) continue;
        // Text animated by character renders one <text> per letter: join those runs by
        // position (same rule as the timeline thumbnails in readSceneTiles).
        const runs = [...g.querySelectorAll('text')]
          .map((el) => ({ t: (el.textContent ?? '').trim(), r: el.getBoundingClientRect() }))
          .filter((i) => i.t);
        const singles = runs.filter((i) => i.t.length === 1).length;
        let text: string;
        if (singles < 3 || singles < runs.length * 0.6) {
          text = runs.map((i) => i.t).join(' ');
        } else {
          const lines: Array<typeof runs> = [];
          let line: typeof runs = [];
          for (const it of runs) {
            const prev = line[line.length - 1];
            const same =
              prev !== undefined &&
              Math.abs(prev.r.top - it.r.top) <= Math.max(1, it.r.height * 0.4) &&
              it.r.left >= prev.r.left - it.r.height * 0.2;
            if (!same && line.length > 0) {
              lines.push(line);
              line = [];
            }
            line.push(it);
          }
          if (line.length > 0) lines.push(line);
          text = lines
            .map((ln) => {
              const gaps = ln.slice(1).map((it, k) => it.r.left - ln[k]!.r.right);
              const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
              let s = ln[0]!.t;
              ln.slice(1).forEach((it, k) => {
                s += (gaps[k]! - typical > Math.max(1, it.r.height * 0.08) ? ' ' : '') + it.t;
              });
              return s;
            })
            .join(' ');
        }
        text = text.replace(/\s+/g, ' ').trim();
        const hasParagraph = !!g.querySelector('g[id*="-paragraph-"]');
        // Video objects render as foreignObject > video (briefly an <image> poster while loading).
        const kind = g.querySelector('video, foreignObject')
          ? 'video'
          : g.querySelector('image')
            ? 'image'
            : hasParagraph || text
              ? 'text'
              : g.querySelector('g[id^="editor-"]')
                ? 'group'
                : 'shape';
        const r = g.getBoundingClientRect();
        out.push({
          id: g.id.replace(/^editor-/, ''),
          ...(text ? { text } : {}),
          kind,
          bounds: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        });
      }
      return out;
    }, pageId) as Promise<SceneObject[]>;
  }

  /**
   * A point inside the object where it is the topmost element (checked with
   * elementFromPoint), so clicks select this object and not one overlapping it.
   */
  private async objectCenter(objectId: string): Promise<{ x: number; y: number }> {
    const obj = (await this.objects()).find((o) => o.id === objectId);
    if (!obj?.bounds) {
      throw new UsageError(`Object ${objectId} is not on this scene.`, {
        hint: 'List objects with: gvids text list <id> --scene <n>',
      });
    }
    const point = await this.page.evaluate(
      ({ id, b }) => {
        const target = document.getElementById(`editor-${id}`);
        if (!target) return undefined;
        const candidates: Array<[number, number]> = [[0.5, 0.5]];
        for (const fx of [0.3, 0.5, 0.7, 0.15, 0.85])
          for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) candidates.push([fx, fy]);
        for (const [fx, fy] of candidates) {
          const x = b.x + b.width * fx;
          const y = b.y + b.height * fy;
          const el = document.elementFromPoint(x, y);
          if (el && target.contains(el)) return { x, y };
        }
        return undefined;
      },
      { id: objectId, b: obj.bounds },
    );
    return point ?? { x: obj.bounds.x + obj.bounds.width / 2, y: obj.bounds.y + obj.bounds.height / 2 };
  }

  /** Selects one object on scene `n` (a single click on a point where it is topmost). */
  async selectObject(n: number, objectId: string): Promise<void> {
    await this.selectScene(n);
    const center = await this.objectCenter(objectId);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.keyboard.press('Escape').catch(() => undefined);
    await this.page.mouse.click(center.x, center.y);
    await sleep(350);
  }

  async openInsertion(tool: InsertionTool): Promise<Locator> {
    const name = EDITOR_LABELS.insertion[tool];
    await this.dismissPopups();
    await uiStep(this.ui, `The "${name}" tool`, async () => {
      const button = this.page
        .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.insertion })
        .getByRole('button', { name, exact: true });
      // Rail buttons toggle their side sheet; only click when it is not already open.
      if ((await button.getAttribute('aria-pressed', { timeout: this.options.timeoutMs })) !== 'true') {
        await button.click({ timeout: this.options.timeoutMs });
      }
    });
    return this.page.getByRole('complementary').filter({ visible: true }).last();
  }

  async closeSidePanels(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const close = this.page
        .getByRole('complementary')
        .filter({ visible: true })
        .getByRole('button', { name: /^(Close side sheet|Close)$/ });
      if ((await close.count()) === 0) return;
      await close
        .first()
        .click({ timeout: 3000 })
        .catch(() => undefined);
      await sleep(200);
    }
  }

  /** Types text replacing the current selection, preserving line breaks. */
  async typeText(text: string): Promise<void> {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await this.page.keyboard.type(lines[i]!, { delay: 5 });
      if (i < lines.length - 1) await this.page.keyboard.press('Enter');
    }
  }

  /** Adds a text box ("title" | "subtitle" | "body") to scene `n` and sets its text. */
  async addText(
    n: number,
    text: string,
    kind: 'title' | 'subtitle' | 'body' = 'title',
  ): Promise<SceneObject> {
    if (!text.trim()) throw new UsageError('--text must not be empty.');
    await this.selectScene(n);
    const before = new Set((await this.objects()).map((o) => o.id));
    const label = kind === 'title' ? 'Add a title' : kind === 'subtitle' ? 'Add a subtitle' : 'Add body text';
    await this.openInsertion('text');
    await uiStep(this.ui, `The "${label}" button`, async () => {
      await this.page
        .getByRole('button', { name: label, exact: true })
        .click({ timeout: this.options.timeoutMs });
    });
    const created = await this.waitForNewObject(before, 'The inserted text box');
    // The new box opens in edit mode with placeholder text ("Title"); give the
    // editor a moment to place the caret, then replace everything.
    await sleep(700);
    await this.page.keyboard.press('Control+A');
    await this.typeText(text);
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
    await this.closeSidePanels();
    await sleep(300);
    const normalized = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
    const now = (await this.objects()).find((o) => o.id === created.id) ?? created;
    if (normalized(now.text) !== normalized(text)) {
      // Fall back to explicit editing (double-click, select all, retype).
      return this.editText(n, created.id, text);
    }
    return now;
  }

  async waitForNewObject(
    before: Set<string>,
    what: string,
    timeoutMs = this.options.timeoutMs,
  ): Promise<SceneObject> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const added = (await this.objects()).filter((o) => !before.has(o.id));
      if (added.length > 0) return added[added.length - 1]!;
      await sleep(300);
    }
    return uiStep(this.ui, what, async () => {
      throw timeoutError('no new object appeared');
    });
  }

  async editText(n: number, objectId: string, text: string): Promise<SceneObject> {
    await this.selectScene(n);
    const center = await this.objectCenter(objectId);
    await this.page.keyboard.press('Escape');
    await this.page.mouse.dblclick(center.x, center.y);
    await sleep(300);
    await this.page.keyboard.press('Control+A');
    await this.typeText(text);
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
    await sleep(300);
    const updated = (await this.objects()).find((o) => o.id === objectId);
    if (!updated || (updated.text ?? '').replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim()) {
      throw new FeatureUnavailableError(`Editing text of object ${objectId} did not take effect.`, {
        hint: 'The object may not be a text box. Check with: gvids text list <id> --scene <n>',
      });
    }
    return updated;
  }

  /** Applies character/paragraph formatting to all text in a text box. */
  async styleText(
    n: number,
    objectId: string,
    style: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      size?: number;
      align?: 'left' | 'center' | 'right' | 'justify';
      color?: string;
    },
  ): Promise<void> {
    await this.selectScene(n);
    const center = await this.objectCenter(objectId);
    await this.page.keyboard.press('Escape');
    await this.page.mouse.dblclick(center.x, center.y);
    await sleep(300);
    await this.page.keyboard.press('Control+A');
    const toggle = async (key: string, want: boolean | undefined, name: RegExp): Promise<void> => {
      if (want === undefined) return;
      const button = this.page
        .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.main })
        .getByRole('button', { name });
      const pressed = (await button.getAttribute('aria-pressed').catch(() => null)) === 'true';
      if (pressed !== want) await this.page.keyboard.press(key);
    };
    await toggle('Control+B', style.bold, /^Bold/);
    await toggle('Control+I', style.italic, /^Italic/);
    await toggle('Control+U', style.underline, /^Underline/);
    if (style.align) {
      const keys = {
        left: 'Control+Shift+L',
        center: 'Control+Shift+E',
        right: 'Control+Shift+R',
        justify: 'Control+Shift+J',
      };
      await this.page.keyboard.press(keys[style.align]);
    }
    if (style.size !== undefined) {
      await uiStep(this.ui, 'The font size field', async () => {
        const field = this.page.getByRole('textbox', { name: 'Font size' });
        await field.click({ clickCount: 3, timeout: this.options.timeoutMs });
        await this.page.keyboard.type(String(style.size));
        await this.page.keyboard.press('Enter');
      });
    }
    if (style.color) {
      const hex = HEX.exec(style.color.trim());
      if (!hex) throw new UsageError('--color expects a hex value like #ff8800.');
      await uiStep(this.ui, 'The "Text color" button', async () => {
        await this.page
          .getByRole('toolbar', { name: EDITOR_LABELS.toolbars.main })
          .getByRole('button', { name: /^Text color/ })
          .click({ timeout: this.options.timeoutMs });
      });
      await this.applyCustomColor(hex[1]!);
    }
    await this.page.keyboard.press('Escape');
    await this.page.keyboard.press('Escape');
  }

  async deleteObject(n: number, objectId: string): Promise<void> {
    await this.selectScene(n);
    for (let attempt = 0; attempt < 3; attempt++) {
      const center = await this.objectCenter(objectId);
      await this.page.keyboard.press('Escape');
      await this.page.keyboard.press('Escape');
      await this.page.mouse.click(center.x, center.y);
      await sleep(350);
      await this.page.keyboard.press('Delete');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (!(await this.objects()).some((o) => o.id === objectId)) return;
        await sleep(250);
      }
    }
    throw new FeatureUnavailableError(`Object ${objectId} could not be deleted.`);
  }

  // ---------------------------------------------------------- video size

  private async openVideoSizeDialog(): Promise<Locator> {
    await this.menu([EDITOR_LABELS.topMenus.file, EDITOR_LABELS.menuItems.videoSize]);
    const combo = this.page.getByRole('combobox', { name: EDITOR_LABELS.videoSize.combobox });
    await uiStep(this.ui, 'The "Video size" dialog', async () => {
      await combo.waitFor({ timeout: this.options.timeoutMs });
    });
    return combo;
  }

  async getVideoSize(): Promise<{ format: VideoFormat | 'custom'; label: string; available: string[] }> {
    const combo = await this.openVideoSizeDialog();
    const label = (await combo.innerText()).trim();
    await combo.click();
    const available = (
      await this.page
        .getByRole('option')
        .filter({ visible: true })
        .evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.trim()))
    ).filter(Boolean);
    await this.page.keyboard.press('Escape');
    await this.page
      .getByRole('dialog')
      .filter({ has: combo })
      .getByRole('button', { name: EDITOR_LABELS.videoSize.cancel })
      .click({ timeout: 5000 })
      .catch(() => this.page.keyboard.press('Escape'));
    return { format: formatFromLabel(label), label, available };
  }

  async setVideoSize(format: VideoFormat): Promise<string> {
    const combo = await this.openVideoSizeDialog();
    const option = EDITOR_LABELS.videoSize.options[format];
    await uiStep(this.ui, `The "${format}" video size option`, async () => {
      await combo.click();
      await this.page.getByRole('option', { name: option }).filter({ visible: true }).first().click();
      await this.page
        .getByRole('dialog')
        .filter({ has: combo })
        .getByRole('button', { name: EDITOR_LABELS.videoSize.apply })
        .click();
      await combo.waitFor({ state: 'hidden', timeout: this.options.timeoutMs });
    });
    await this.dismissPopups();
    const after = await this.getVideoSize();
    if (after.format !== format) {
      throw new FeatureUnavailableError(
        `Video size is still "${after.label}" after trying to set ${format}.`,
      );
    }
    return after.label;
  }

  // -------------------------------------------------------------- rename

  async rename(title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new UsageError('The new title must not be empty.');
    await this.showMenus();
    await uiStep(this.ui, 'The title field', async () => {
      const input = this.page.locator(EDITOR_CSS.titleInput);
      await input.click({ timeout: this.options.timeoutMs });
      await input.fill(trimmed);
      await input.press('Enter');
      await this.page.waitForFunction((t) => document.title.startsWith(t), trimmed, {
        timeout: this.options.timeoutMs,
      });
    });
  }

  // -------------------------------------------------------------- media

  private async clipLabels(): Promise<string[]> {
    return this.page
      .locator('[aria-label*=" in scene "]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  }

  /**
   * Selects scene `n`, runs `insert` (which starts a media insertion) and waits
   * for the new canvas object or timeline clip it produces. `insert` gets a
   * probe that reports whether something was inserted already.
   */
  async insertMedia(
    n: number,
    what: string,
    timeoutMs: number,
    insert: (inserted: () => Promise<boolean>) => Promise<void>,
    /** The inserted file is a video: wait until its player replaces the poster image. */
    expectVideo = false,
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    await this.selectScene(n);
    const beforeObjects = new Set((await this.objects()).map((o) => o.id));
    const beforeClips = new Set(await this.clipLabels());
    const detect = async (): Promise<{ object?: SceneObject; clip?: TimelineClip } | undefined> => {
      const added = (await this.objects().catch(() => [])).filter((o) => !beforeObjects.has(o.id));
      if (added.length > 0) return { object: added[added.length - 1]! };
      const newClip = (await this.clipLabels().catch(() => [])).find((c) => !beforeClips.has(c));
      return newClip ? { clip: parseClipLabel(newClip) } : undefined;
    };
    await insert(async () => (await detect()) !== undefined);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.dismissPopups();
      const found = await detect();
      if (found) return expectVideo && found.object ? this.untilVideo(found.object, deadline) : found;
      await sleep(1000);
    }
    throw new GenerationTimeoutError(what, timeoutMs);
  }

  /**
   * A video object shows its poster <image> until the player loads; wait for the player
   * (at most 30 s) so the result, and the next `text list`, report it as a video.
   */
  private async untilVideo(object: SceneObject, deadline: number): Promise<{ object: SceneObject }> {
    const until = Math.min(deadline, Date.now() + 30_000);
    let current = object;
    while (current.kind !== 'video' && Date.now() < until) {
      await sleep(500);
      current = (await this.objects().catch(() => [])).find((o) => o.id === object.id) ?? current;
    }
    return { object: current };
  }

  /** Inserts a local file via Insert > Upload into scene `n`. */
  async uploadMedia(
    n: number,
    file: string,
    timeoutMs: number,
  ): Promise<{ object?: SceneObject; clip?: TimelineClip }> {
    const expectVideo = VIDEO_FILE.test(file);
    return this.insertMedia(
      n,
      'Uploading the media file',
      timeoutMs,
      async () => {
        const chooser = armed(this.page.waitForEvent('filechooser', { timeout: this.options.timeoutMs }));
        await this.menu([EDITOR_LABELS.topMenus.insert, EDITOR_LABELS.menuItems.upload]);
        const fc = await uiStep(this.ui, 'The upload file chooser', () => chooser);
        await fc.setFiles(file);
      },
      expectVideo,
    );
  }
}

export function formatFromLabel(label: string): VideoFormat | 'custom' {
  if (/^Landscape/i.test(label)) return 'landscape';
  if (/^Portrait/i.test(label)) return 'portrait';
  if (/^Square/i.test(label)) return 'square';
  return 'custom';
}

/** Awaits `appears` for a locator and returns the locator (small helper for panels). */
export async function ensureVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  return appears(locator, timeoutMs);
}
