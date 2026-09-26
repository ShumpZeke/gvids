import type { Locator, Page } from 'playwright';
import { BrowserLoginRequiredError, FeatureUnavailableError, UsageError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { slugify, type VideoFormat } from '../../vids/types.js';
import { extractVidIdFromEditorUrl, isGoogleSignInUrl, vidsCreateUrl } from '../../vids/urls.js';
import { PICKER_LABELS } from '../selectors/ai.js';
import { START_LABELS } from '../selectors/editor.js';
import { TEMPLATE_LABELS } from '../selectors/templates.js';
import { armed, timeoutError, uiStep, type UiContext } from '../ui.js';
import type { EditorOptions } from './editor-page.js';
import { VidsEditor } from './editor-page.js';

/**
 * The "Getting started" dialog shown for a brand-new Vid (docs.google.com/videos/create).
 * Opening the create URL immediately creates the file in Drive.
 */
export class StartDialog {
  private constructor(
    readonly page: Page,
    readonly options: EditorOptions,
    readonly dialog: Locator,
  ) {}

  private get ui(): UiContext {
    return { page: this.page, diagnostics: this.options.diagnostics };
  }

  static async createNew(page: Page, options: EditorOptions): Promise<StartDialog> {
    await page.goto(vidsCreateUrl({ hl: options.hl, authuser: options.authuser }), {
      waitUntil: 'domcontentloaded',
    });
    const dialog = page.getByRole('dialog', { name: START_LABELS.dialog });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (isGoogleSignInUrl(page.url())) throw new BrowserLoginRequiredError();
      if (/workspace\.google\.com/.test(page.url())) {
        throw new FeatureUnavailableError('Google Vids is not available to the signed-in browser account.', {
          code: 'VIDS_ACCESS_REQUIRED',
        });
      }
      if (await dialog.isVisible().catch(() => false)) break;
      await sleep(250);
    }
    const start = new StartDialog(page, options, dialog);
    await uiStep(start.ui, 'The "Getting started" dialog for a new video', async () => {
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
    });
    return start;
  }

  get id(): string {
    const id = extractVidIdFromEditorUrl(this.page.url());
    if (!id) throw new UsageError('The new video has no ID yet.');
    return id;
  }

  async formats(): Promise<Array<{ format: VideoFormat; selected: boolean }>> {
    const out: Array<{ format: VideoFormat; selected: boolean }> = [];
    for (const [format, name] of Object.entries(START_LABELS.format) as Array<[VideoFormat, string]>) {
      const button = this.dialog.getByRole('button', { name, exact: true });
      if ((await button.count()) === 0) continue;
      out.push({ format, selected: (await button.getAttribute('aria-pressed')) === 'true' });
    }
    return out;
  }

  async setFormat(format: VideoFormat): Promise<void> {
    const name = START_LABELS.format[format];
    await uiStep(this.ui, `The "${name}" option`, async () => {
      const button = this.dialog.getByRole('button', { name, exact: true });
      await button.click({ timeout: this.options.timeoutMs });
      await this.page.waitForFunction(
        (el) => el?.getAttribute('aria-pressed') === 'true',
        await button.elementHandle(),
        { timeout: this.options.timeoutMs },
      );
    });
  }

  /** Creation options currently offered (they differ by format and account). */
  async creationOptions(): Promise<string[]> {
    const texts = await this.dialog
      .getByRole('listitem')
      .evaluateAll((els) => els.map((e) => ((e as HTMLElement).innerText.split('\n')[0] ?? '').trim()));
    return texts.filter(Boolean);
  }

  private option(name: string): Locator {
    return this.dialog
      .getByRole('listitem')
      .filter({ hasText: new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
      .getByRole('button')
      .first();
  }

  async choose(name: string): Promise<void> {
    const available = await this.creationOptions();
    if (!available.includes(name)) {
      throw new FeatureUnavailableError(`"${name}" is not offered for this video.`, {
        details: { available },
        hint:
          name === START_LABELS.options.templates || name === START_LABELS.options.slidesToVideo
            ? 'Some options are only offered for landscape videos.'
            : 'Run: gvids capabilities --refresh',
      });
    }
    await uiStep(this.ui, `The "${name}" creation option`, async () => {
      await this.option(name).click({ timeout: this.options.timeoutMs });
    });
  }

  /** Blank vid: closes the dialog and returns the editor. */
  async blank(): Promise<VidsEditor> {
    await this.choose(START_LABELS.options.blank);
    await uiStep(this.ui, 'Closing the "Getting started" dialog', async () => {
      await this.dialog.waitFor({ state: 'hidden', timeout: this.options.timeoutMs });
    });
    return VidsEditor.attach(this.page, this.options);
  }

  async templateNames(): Promise<string[]> {
    await this.choose(START_LABELS.options.templates);
    const listbox = this.dialog.getByRole('listbox', { name: TEMPLATE_LABELS.startDialog });
    await uiStep(this.ui, 'The template gallery', async () => {
      await listbox.getByRole('option').first().waitFor({ timeout: this.options.timeoutMs });
    });
    return listbox
      .getByRole('option')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('aria-label') ?? (e as HTMLElement).innerText.trim()),
      );
  }

  /** Picks a template (display name) and inserts all its scenes (or `sceneNumbers`). */
  async useTemplate(displayName: string, sceneNumbers?: number[]): Promise<VidsEditor> {
    const names = await this.templateNames();
    const match = findTemplateName(names, displayName);
    if (!match) {
      throw new UsageError(`Template "${displayName}" was not found.`, {
        hint: 'List templates with: gvids template list',
        details: { available: names },
      });
    }
    const listbox = this.dialog.getByRole('listbox', { name: TEMPLATE_LABELS.startDialog });
    await uiStep(this.ui, `The "${match}" template`, async () => {
      await listbox
        .getByRole('option', { name: match, exact: true })
        .click({ timeout: this.options.timeoutMs });
      await this.dialog
        .getByRole('button', { name: TEMPLATE_LABELS.insertAll })
        .waitFor({ timeout: this.options.timeoutMs });
    });
    await insertTemplateScenes(this.dialog, this.ui, this.options.timeoutMs, match, sceneNumbers);
    await uiStep(this.ui, 'Closing the template dialog', async () => {
      await this.dialog.waitFor({ state: 'hidden', timeout: 60_000 });
    });
    return VidsEditor.attach(this.page, this.options);
  }

  /**
   * Upload: pick a local media file. Vids shows either a "Browse computer"
   * button in the dialog or Google's "Open a file" picker, whose Upload pane
   * has a "Browse" button (seen 2026-09-23).
   */
  async upload(file: string): Promise<VidsEditor> {
    await this.choose(START_LABELS.options.upload);
    const timeoutMs = this.options.timeoutMs;
    const chooser = armed(this.page.waitForEvent('filechooser', { timeout: timeoutMs }));
    await uiStep(this.ui, 'The upload "Browse" button', async () => {
      const direct = this.dialog.getByRole('button', { name: START_LABELS.uploadBrowseComputer });
      const picker = this.page.frameLocator(PICKER_LABELS.frame);
      const uploadPane = picker.getByRole('option', { name: PICKER_LABELS.uploadPane, exact: true });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await direct.isVisible().catch(() => false)) {
          await direct.click({ timeout: timeoutMs });
          return;
        }
        if (await uploadPane.isVisible().catch(() => false)) {
          await uploadPane.click({ timeout: timeoutMs });
          await picker
            .getByRole('button', { name: PICKER_LABELS.browse, exact: true })
            .click({ timeout: timeoutMs });
          return;
        }
        await sleep(300);
      }
      throw timeoutError('Neither the "Browse computer" button nor the file picker appeared.');
    });
    const fc = await uiStep(this.ui, 'The upload file chooser', () => chooser);
    await fc.setFiles(file);
    await uiStep(this.ui, 'Closing the upload dialog', async () => {
      await this.dialog.waitFor({ state: 'hidden', timeout: 5 * 60_000 });
      await this.page.locator(PICKER_LABELS.frame).waitFor({ state: 'hidden', timeout: 5 * 60_000 });
    });
    return VidsEditor.attach(this.page, this.options);
  }

  /** Closes the dialog without choosing (leaves a blank video). */
  async close(): Promise<VidsEditor> {
    await uiStep(this.ui, 'The "Getting started" close button', async () => {
      await this.dialog
        .getByRole('button', { name: /^Close$/ })
        .last()
        .click({ timeout: this.options.timeoutMs });
      await this.dialog.waitFor({ state: 'hidden', timeout: this.options.timeoutMs });
    });
    return VidsEditor.attach(this.page, this.options);
  }
}

/**
 * Shared by the start dialog and the editor's Templates side panel: after a
 * template is opened, insert all scenes or only `sceneNumbers`. In the start
 * dialog a scene is selected and then "Insert selected scene" is pressed; in
 * the side panel clicking a scene card inserts it directly.
 */
/** Matches a template by display name (any case) or by its `gvids template list` slug. */
export function findTemplateName(names: string[], wanted: string): string | undefined {
  const lower = wanted.toLowerCase();
  const slug = slugify(wanted);
  return names.find((n) => n.toLowerCase() === lower) ?? names.find((n) => slugify(n) === slug);
}

export async function insertTemplateScenes(
  scope: Locator,
  ui: UiContext,
  timeoutMs: number,
  templateName: string,
  sceneNumbers?: number[],
): Promise<void> {
  if (!sceneNumbers || sceneNumbers.length === 0) {
    await uiStep(ui, 'The "Insert all scenes" button', async () => {
      await scope.getByRole('button', { name: TEMPLATE_LABELS.insertAll }).click({ timeout: timeoutMs });
    });
    return;
  }
  const options = scope.getByRole('listbox', { name: templateName, exact: true }).getByRole('option');
  await uiStep(ui, `The scenes of template "${templateName}"`, async () => {
    await options.first().waitFor({ state: 'visible', timeout: timeoutMs });
  });
  const count = await options.count();
  for (const n of sceneNumbers) {
    if (n < 1 || n > count)
      throw new UsageError(`Template "${templateName}" has ${count} scenes; ${n} is out of range.`);
  }
  for (const n of sceneNumbers) {
    await uiStep(ui, `Template scene ${n}`, async () => {
      await options.nth(n - 1).click({ timeout: timeoutMs });
      const insertSelected = scope.getByRole('button', { name: /^Insert selected scene/ });
      if (await insertSelected.isVisible().catch(() => false))
        await insertSelected.click({ timeout: timeoutMs });
    });
    await sleep(1000);
    if (!(await scope.isVisible().catch(() => false))) break;
  }
}
