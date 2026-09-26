import type { FrameLocator, Locator, Page } from 'playwright';
import {
  FeatureUnavailableError,
  GenerationFailedError,
  GenerationTimeoutError,
  UsageError,
} from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import type { SceneObject, TimelineClip } from '../../vids/types.js';
import {
  AI_VIDEO_LABELS,
  AVATAR_LABELS,
  PICKER_LABELS,
  VOICEOVER_LABELS,
  type AiInsertTarget,
} from '../selectors/ai.js';
import { TEMPLATE_LABELS } from '../selectors/templates.js';
import { armed, detectAvailabilityProblem, timeoutError, uiStep, type UiContext } from '../ui.js';
import { parseClipLabel, type VidsEditor } from './editor-page.js';
import { findTemplateName, insertTemplateScenes } from './start-dialog.js';

export interface VoiceInfo {
  name: string;
  description: string;
  group?: string;
}

export interface AvatarInfo {
  name: string;
  description: string;
  category: string;
  tags: string[];
}

async function clipLabels(page: Page): Promise<string[]> {
  return page
    .locator('[aria-label*=" in scene "]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** Types into a canvas-rendered script editor (the form is drawn in SVG; keys go to the hidden text target). */
async function replaceScript(editor: VidsEditor, form: Locator, text: string): Promise<void> {
  await uiStep(editor.ui, 'The script editor', async () => {
    await form.click({ timeout: editor.options.timeoutMs });
  });
  await editor.page.keyboard.press('Control+A');
  await editor.page.keyboard.press('Delete');
  await editor.typeText(text);
}

async function readForm(form: Locator): Promise<string> {
  const text = await form.evaluate((f) => {
    const paragraphs = [...f.querySelectorAll('text')].map((t) => t.textContent ?? '');
    return paragraphs.join(' ').replace(/\s+/g, ' ').trim();
  });
  // An empty script box shows a placeholder drawn like real text.
  return VOICEOVER_LABELS.scriptPlaceholder.test(text) ? '' : text;
}

// ------------------------------------------------------------ voiceover

/** Waits for the "Select a voice" dialog (voiceover panel, Docs to video). */
export async function voiceDialog(ui: UiContext, timeoutMs: number): Promise<Locator> {
  const dialog = ui.page.getByRole('dialog', { name: VOICEOVER_LABELS.voiceDialog });
  await uiStep(ui, 'The "Select a voice" dialog', async () => {
    await dialog.getByRole('menuitem').first().waitFor({ timeout: timeoutMs });
  });
  return dialog;
}

export async function readVoices(dialog: Locator): Promise<VoiceInfo[]> {
  const raw = await dialog.getByRole('menuitem').evaluateAll((els) =>
    els.map((e) => ({
      label: e.getAttribute('aria-label') ?? '',
      group: e.closest('[role=group]')?.querySelector('h1,h2,h3,[role=heading]')?.textContent?.trim() ?? '',
    })),
  );
  const voices: VoiceInfo[] = [];
  for (const { label, group } of raw) {
    const m = VOICEOVER_LABELS.voiceItem.exec(label);
    if (m) voices.push({ name: m[3]!, description: m[4]!, ...(group ? { group } : {}) });
  }
  return voices;
}

/** Picks `name` in the open voice dialog and confirms; returns the name as Vids shows it. */
export async function chooseVoice(
  ui: UiContext,
  dialog: Locator,
  name: string,
  timeoutMs: number,
): Promise<string> {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const item = dialog.getByRole('menuitem', { name: new RegExp(`voices\\. ${escaped} voice that`, 'i') });
  if ((await item.count()) === 0) {
    const available = (await readVoices(dialog)).map((v) => v.name);
    // "Back" returns to the dialog that opened the list (Docs to video); otherwise close it.
    const back = dialog.getByRole('button', { name: /^Back$/ });
    await ((await back.isVisible().catch(() => false))
      ? back.click()
      : dialog.getByRole('button', { name: /^Close dialog$/ }).click()
    ).catch(() => undefined);
    throw new UsageError(`Voice "${name}" is not available.`, {
      hint: 'List voices with: gvids voiceover voices <id>',
      details: { available },
    });
  }
  const shown = VOICEOVER_LABELS.voiceItem.exec((await item.first().getAttribute('aria-label')) ?? '')?.[3];
  await uiStep(ui, `The "${name}" voice`, async () => {
    await item
      .first()
      .getByText(new RegExp(`^${escaped}$`, 'i'))
      .first()
      .click({ timeout: timeoutMs });
    await dialog.getByRole('button', { name: VOICEOVER_LABELS.select }).click({ timeout: timeoutMs });
    await dialog.waitFor({ state: 'hidden', timeout: timeoutMs });
  });
  return shown ?? name.trim();
}

export class VoiceoverPanel {
  private constructor(
    private readonly editor: VidsEditor,
    readonly root: Locator,
  ) {}

  static async open(editor: VidsEditor, scene: number): Promise<VoiceoverPanel> {
    await editor.selectScene(scene);
    await editor.openInsertion('voiceover');
    const root = editor.page.getByRole('complementary', { name: VOICEOVER_LABELS.panel });
    await uiStep(editor.ui, 'The "AI voiceover" panel', async () => {
      await root.waitFor({ state: 'visible', timeout: editor.options.timeoutMs });
    });
    const current = root.getByRole('tab', { name: VOICEOVER_LABELS.tabs.current });
    if ((await current.getAttribute('aria-selected')) !== 'true') await current.click();
    return new VoiceoverPanel(editor, root);
  }

  private form(): Locator {
    return this.root.getByRole('form', { name: VOICEOVER_LABELS.scripts });
  }

  async readScript(): Promise<string> {
    return readForm(this.form());
  }

  async setScript(text: string): Promise<void> {
    await replaceScript(this.editor, this.form(), text);
  }

  async currentVoice(): Promise<string | undefined> {
    const snapshot = await this.root.ariaSnapshot();
    const line = snapshot.split('\n').find((l) => /^\s*- text: [A-Z][a-z]+ [A-Z][a-z-]+,/.test(l));
    return line?.replace(/^\s*- text: /, '').split(' ')[0];
  }

  private async openVoiceDialog(): Promise<Locator> {
    await uiStep(this.editor.ui, 'The "Change the voice" button', async () => {
      await this.root
        .getByRole('button', { name: VOICEOVER_LABELS.changeVoice })
        .click({ timeout: this.editor.options.timeoutMs });
    });
    return voiceDialog(this.editor.ui, this.editor.options.timeoutMs);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const dialog = await this.openVoiceDialog();
    const voices = await readVoices(dialog);
    await dialog
      .getByRole('button', { name: /^Close dialog$/ })
      .click()
      .catch(() => this.editor.page.keyboard.press('Escape'));
    return voices;
  }

  async selectVoice(name: string): Promise<string> {
    return chooseVoice(this.editor.ui, await this.openVoiceDialog(), name, this.editor.options.timeoutMs);
  }

  /** Clicks Insert/Update voiceover and waits for the scene's narration clip. */
  async insert(scene: number, timeoutMs: number): Promise<TimelineClip> {
    const before = new Set(await clipLabels(this.editor.page));
    const button = this.root.getByRole('button', {
      name: new RegExp(`^(${VOICEOVER_LABELS.insert}|${VOICEOVER_LABELS.update})$`),
    });
    await uiStep(this.editor.ui, 'The "Insert voiceover" button', async () => {
      await button.first().waitFor({ timeout: this.editor.options.timeoutMs });
    });
    if (!(await button.first().isEnabled())) {
      throw new UsageError('The voiceover script is empty or unchanged.');
    }
    await button.first().click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const labels = await clipLabels(this.editor.page);
      const fresh = labels.find((l) => !before.has(l) && parseClipLabel(l).scene === scene);
      if (fresh) {
        await this.editor.dismissPopups();
        return parseClipLabel(fresh);
      }
      const availability = await detectAvailabilityProblem(this.editor.page);
      if (availability)
        throw new FeatureUnavailableError(`Voiceover: ${availability.message}`, { code: availability.code });
      await sleep(750);
    }
    throw new GenerationTimeoutError('Voiceover generation', timeoutMs);
  }
}

/** Removes voiceover clips that start in `scene` (selects each clip and presses Delete). */
export async function removeVoiceovers(editor: VidsEditor, scene: number): Promise<TimelineClip[]> {
  const removed: TimelineClip[] = [];
  for (let i = 0; i < 20; i++) {
    const labels = await clipLabels(editor.page);
    const target = labels.map(parseClipLabel).find((c) => c.scene === scene && c.kind === 'voiceover');
    if (!target) break;
    await uiStep(editor.ui, `The voiceover clip "${target.title ?? ''}"`, async () => {
      const clip = editor.page.locator(`[aria-label="${target.label.replace(/"/g, '\\"')}"]`).first();
      await clip.click({ timeout: editor.options.timeoutMs, position: { x: 8, y: 8 } });
      await editor.page.keyboard.press('Delete');
    });
    await sleep(600);
    if ((await clipLabels(editor.page)).includes(target.label)) {
      throw new FeatureUnavailableError('The voiceover clip could not be deleted.');
    }
    removed.push(target);
  }
  return removed;
}

// ---------------------------------------------------------------- avatar

export class AvatarPanel {
  private constructor(
    private readonly editor: VidsEditor,
    readonly root: Locator,
  ) {}

  static async open(editor: VidsEditor, scene: number): Promise<AvatarPanel> {
    await editor.selectScene(scene);
    await editor.openInsertion('avatar');
    const root = editor.page.getByRole('complementary', { name: AVATAR_LABELS.panel });
    await uiStep(editor.ui, 'The "AI avatar" panel', async () => {
      await root.waitFor({ state: 'visible', timeout: editor.options.timeoutMs });
    });
    return new AvatarPanel(editor, root);
  }

  private async openDialog(): Promise<Locator> {
    await uiStep(this.editor.ui, 'The "Change the avatar" button', async () => {
      await this.root
        .getByRole('button', { name: AVATAR_LABELS.changeAvatar })
        .click({ timeout: this.editor.options.timeoutMs });
    });
    const dialog = this.editor.page
      .getByRole('dialog')
      .filter({ has: this.editor.page.getByRole('heading', { name: AVATAR_LABELS.dialogHeading }) });
    await uiStep(this.editor.ui, 'The "Avatars" dialog', async () => {
      await dialog.getByRole('radio').first().waitFor({ timeout: this.editor.options.timeoutMs });
    });
    return dialog;
  }

  async listAvatars(): Promise<AvatarInfo[]> {
    const dialog = await this.openDialog();
    const raw = await dialog.getByRole('radio').evaluateAll((els) =>
      els.map((e) => ({
        label: e.getAttribute('aria-label') ?? '',
        category: (() => {
          const group = e.closest('[role=radiogroup]');
          if (!group) return '';
          const label = group.getAttribute('aria-label');
          if (label) return label;
          const ids = (group.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
          return ids
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ')
            .trim();
        })(),
      })),
    );
    await dialog
      .getByRole('button', { name: /^Close$/ })
      .first()
      .click()
      .catch(() => this.editor.page.keyboard.press('Escape'));
    const out: AvatarInfo[] = [];
    for (const { label, category } of raw) {
      const m = AVATAR_LABELS.avatarRadio.exec(label);
      if (!m) continue;
      out.push({
        name: m[1]!,
        description: m[2]!,
        category,
        tags: m[3]!
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
    }
    return out;
  }

  async selectAvatar(name: string): Promise<void> {
    const dialog = await this.openDialog();
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const radio = dialog.getByRole('radio', { name: new RegExp(`^${escaped}:`, 'i') });
    if ((await radio.count()) === 0) {
      await dialog
        .getByRole('button', { name: /^Close$/ })
        .first()
        .click()
        .catch(() => undefined);
      throw new UsageError(`Avatar "${name}" is not available.`, {
        hint: 'List avatars with: gvids avatar list <id>',
      });
    }
    await uiStep(this.editor.ui, `The "${name}" avatar`, async () => {
      await radio.first().click({ timeout: this.editor.options.timeoutMs });
      await dialog
        .getByRole('button', { name: AVATAR_LABELS.select, exact: true })
        .click({ timeout: this.editor.options.timeoutMs });
      await dialog.waitFor({ state: 'hidden', timeout: this.editor.options.timeoutMs });
    });
  }

  async setScript(text: string): Promise<void> {
    await replaceScript(this.editor, this.root.getByRole('form', { name: AVATAR_LABELS.scripts }), text);
  }

  /** Generates the avatar clip for the current scene and waits for it to land in the timeline/canvas. */
  async generate(scene: number, timeoutMs: number): Promise<{ clip?: TimelineClip; object?: SceneObject }> {
    const beforeClips = new Set(await clipLabels(this.editor.page));
    const beforeObjects = new Set((await this.editor.objects()).map((o) => o.id));
    const button = this.root.getByRole('button', { name: AVATAR_LABELS.insert }).filter({ visible: true });
    const preview = this.root
      .getByRole('button', { name: AVATAR_LABELS.preview, exact: true })
      .filter({ visible: true });
    await uiStep(this.editor.ui, 'The avatar "Generate" button', async () => {
      await button.or(preview).first().waitFor({ timeout: this.editor.options.timeoutMs });
      // Current panels render a short preview first; "Generate" appears under it.
      if (
        !(await button
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        if (!(await preview.first().isEnabled()))
          throw new UsageError('Type a script before generating the avatar.');
        await preview.first().click();
        await button.first().waitFor({ timeout: 120_000 });
      }
    });
    if (!(await button.first().isEnabled()))
      throw new UsageError('Type a script before generating the avatar.');
    await button.first().click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = (await clipLabels(this.editor.page)).find((l) => !beforeClips.has(l));
      if (fresh) return { clip: parseClipLabel(fresh) };
      const objects = (await this.editor.objects()).filter((o) => !beforeObjects.has(o.id));
      if (objects.length > 0) return { object: objects[0]! };
      const availability = await detectAvailabilityProblem(this.editor.page);
      if (availability)
        throw new FeatureUnavailableError(`Avatar: ${availability.message}`, { code: availability.code });
      await sleep(1500);
    }
    throw new GenerationTimeoutError(`Avatar generation for scene ${scene}`, timeoutMs);
  }
}

// -------------------------------------------------------------- AI video

export type AiVideoMode = 'create' | 'edit' | 'animate';

export class AiVideoPanel {
  private constructor(private readonly editor: VidsEditor) {}

  /**
   * The AI video side sheet renders its prompt area outside the ARIA
   * "complementary" region, so controls are located page-wide and scoped to
   * the tab panel that contains the active prompt box.
   */
  static async open(editor: VidsEditor): Promise<AiVideoPanel> {
    await editor.openInsertion('aiVideo');
    const panel = new AiVideoPanel(editor);
    await uiStep(editor.ui, 'The "AI video clip" panel', async () => {
      await panel.tab('create').waitFor({ state: 'visible', timeout: editor.options.timeoutMs });
    });
    return panel;
  }

  private get page(): Page {
    return this.editor.page;
  }

  private tab(mode: AiVideoMode): Locator {
    return this.page
      .getByRole('tab', { name: AI_VIDEO_LABELS.tabs[mode], exact: true })
      .filter({ visible: true })
      .first();
  }

  private promptBox(mode: AiVideoMode): Locator {
    return this.page
      .getByRole('textbox', { name: AI_VIDEO_LABELS.prompts[mode] })
      .filter({ visible: true })
      .first();
  }

  /**
   * The innermost element containing both the prompt box and the Generate
   * button (ancestors precede descendants in document order, hence last()).
   * Model/aspect pickers and attachment buttons live inside it.
   */
  private tabpanel(mode: AiVideoMode): Locator {
    return this.page
      .locator('div')
      .filter({ has: this.page.getByRole('textbox', { name: AI_VIDEO_LABELS.prompts[mode] }) })
      .filter({ has: this.page.getByRole('button', { name: AI_VIDEO_LABELS.generate, exact: true }) })
      .last();
  }

  async selectTab(mode: AiVideoMode): Promise<void> {
    await uiStep(this.editor.ui, `The AI video "${AI_VIDEO_LABELS.tabs[mode]}" tab`, async () => {
      await this.tab(mode).click({ timeout: this.editor.options.timeoutMs });
      await this.promptBox(mode).waitFor({ state: 'visible', timeout: this.editor.options.timeoutMs });
    });
  }

  /** The Create tab starts collapsed (gallery shown); expanding reveals the pickers and Generate. */
  private async expand(): Promise<void> {
    const expand = this.page
      .getByRole('button', { name: AI_VIDEO_LABELS.expand, exact: true })
      .filter({ visible: true });
    if ((await expand.count()) > 0) {
      await expand.first().click({ timeout: this.editor.options.timeoutMs });
      await sleep(500);
    }
  }

  async setPrompt(mode: AiVideoMode, text: string): Promise<void> {
    await this.expand();
    const box = this.promptBox(mode);
    await uiStep(this.editor.ui, 'The AI video prompt box', async () => {
      // A placeholder overlay intercepts pointer events, so focus the editable directly.
      await box.waitFor({ state: 'visible', timeout: this.editor.options.timeoutMs });
      await box.focus();
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Delete');
      if (text) await box.fill(text);
    });
  }

  /** The model and aspect-ratio pickers are the tab panel's expandable buttons (in that order). */
  private async pickerButton(mode: AiVideoMode, which: 'model' | 'aspect'): Promise<Locator> {
    await this.expand();
    const buttons = this.tabpanel(mode).locator('button[aria-expanded]').filter({ visible: true });
    const count = await buttons.count();
    if (count < 2)
      throw new FeatureUnavailableError('This account does not offer model/aspect choices for AI video.');
    return buttons.nth(which === 'model' ? count - 2 : count - 1);
  }

  private menu(which: 'model' | 'aspect'): Locator {
    return this.page
      .getByRole('menu', { name: which === 'model' ? AI_VIDEO_LABELS.modelMenu : AI_VIDEO_LABELS.aspectMenu })
      .filter({ visible: true })
      .first();
  }

  private async readMenu(
    mode: AiVideoMode,
    which: 'model' | 'aspect',
  ): Promise<{ items: string[]; selected?: string }> {
    const button = await this.pickerButton(mode, which);
    await button.click();
    const menu = this.menu(which);
    await uiStep(this.editor.ui, `The AI video ${which} menu`, async () => {
      await menu.waitFor({ timeout: this.editor.options.timeoutMs });
    });
    const items = await menu
      .locator('[role=menuitem],[role=menuitemradio],[role=option]')
      .evaluateAll((els) =>
        els.map((e) => ({
          text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
          selected: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true',
        })),
      );
    await this.page.keyboard.press('Escape');
    const selected = items.find((i) => i.selected)?.text;
    return { items: items.map((i) => i.text).filter(Boolean), ...(selected ? { selected } : {}) };
  }

  async models(mode: AiVideoMode = 'create'): Promise<{ items: string[]; selected?: string }> {
    return this.readMenu(mode, 'model');
  }

  async aspectRatios(mode: AiVideoMode = 'create'): Promise<{ items: string[]; selected?: string }> {
    return this.readMenu(mode, 'aspect');
  }

  private async choose(mode: AiVideoMode, which: 'model' | 'aspect', wanted: string): Promise<string> {
    const { items } = await this.readMenu(mode, which);
    const lower = wanted.toLowerCase();
    const match =
      items.find((i) => i.toLowerCase() === lower) ??
      items.find((i) => i.toLowerCase().startsWith(lower)) ??
      items.find((i) => i.toLowerCase().includes(lower));
    if (!match) {
      throw new FeatureUnavailableError(
        `${which === 'model' ? 'Model' : 'Aspect ratio'} "${wanted}" is not offered.`,
        {
          details: { available: items },
          hint: `Available: ${items.join(', ')}`,
        },
      );
    }
    await (await this.pickerButton(mode, which)).click();
    await uiStep(this.editor.ui, `The "${match}" option`, async () => {
      await this.menu(which)
        .locator('[role=menuitem],[role=menuitemradio],[role=option]')
        .filter({ hasText: match })
        .first()
        .click({ timeout: this.editor.options.timeoutMs });
    });
    return match;
  }

  async selectModel(mode: AiVideoMode, name: string): Promise<string> {
    return this.choose(mode, 'model', name);
  }

  async selectAspect(mode: AiVideoMode, name: string): Promise<string> {
    return this.choose(mode, 'aspect', name);
  }

  /** Attaches local files via a tab-panel button (Ingredients / Add video / Add image). */
  async attachFiles(mode: AiVideoMode, buttonName: string | RegExp, files: string[]): Promise<void> {
    for (const file of files) {
      const chooser = armed(
        this.page.waitForEvent('filechooser', { timeout: this.editor.options.timeoutMs }),
      );
      await uiStep(this.editor.ui, `The "${String(buttonName)}" button`, async () => {
        await this.tabpanel(mode)
          .getByRole('button', { name: buttonName })
          .filter({ visible: true })
          .first()
          .click({ timeout: this.editor.options.timeoutMs });
      });
      // Some variants open a small menu first ("Upload from computer").
      const upload = this.page.getByRole('menuitem', { name: /upload|computer/i }).filter({ visible: true });
      if ((await upload.count()) > 0) await upload.first().click();
      const fc = await uiStep(this.editor.ui, 'The file chooser', () => chooser);
      await fc.setFiles(file);
      await sleep(1500);
    }
  }

  /**
   * Starts a generation and waits for the result. A finished clip appears in
   * the side sheet with an Insert button; Insert previews it on the canvas with
   * "Insert in new scene" (default) or, under "More options", "Insert in current
   * scene". `insert: 'none'` stops once the clip is ready (it stays in the AI
   * gallery).
   */
  async generate(
    mode: AiVideoMode,
    timeoutMs: number,
    insert: AiInsertTarget = 'new-scene',
  ): Promise<{ clip?: TimelineClip; object?: SceneObject; inserted: boolean }> {
    const beforeClips = new Set(await clipLabels(this.page));
    const beforeObjects = new Set((await this.editor.objects()).map((o) => o.id));
    const generate = this.tabpanel(mode).getByRole('button', { name: AI_VIDEO_LABELS.generate, exact: true });
    await uiStep(this.editor.ui, 'The AI video "Generate" button', async () => {
      await generate.waitFor({ timeout: this.editor.options.timeoutMs });
    });
    if (!(await generate.isEnabled())) {
      throw new UsageError('Generate is disabled: add a prompt (and a source video/image for edit/animate).');
    }
    await generate.click();
    const resultInsert = this.page
      .getByRole('complementary')
      .getByRole('button', { name: AI_VIDEO_LABELS.resultInsert })
      .filter({ visible: true });
    const previewNew = this.page
      .getByRole('button', { name: AI_VIDEO_LABELS.preview.newScene, exact: true })
      .filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let insertClicked = false;
    let previewHandled = false;
    while (Date.now() < deadline) {
      const fresh = (await clipLabels(this.page)).find((l) => !beforeClips.has(l));
      if (fresh) return { clip: parseClipLabel(fresh), inserted: true };
      const objects = (await this.editor.objects().catch(() => [])).filter((o) => !beforeObjects.has(o.id));
      if (objects.length > 0) return { object: objects[0]!, inserted: true };
      if (!previewHandled && (await previewNew.count()) > 0) {
        await this.insertPreview(insert === 'current-scene' ? 'current-scene' : 'new-scene');
        previewHandled = true;
      } else if (
        !insertClicked &&
        (await resultInsert.count()) > 0 &&
        (await resultInsert.first().isEnabled())
      ) {
        if (insert === 'none') return { inserted: false };
        await resultInsert.first().click();
        insertClicked = true;
      }
      const availability = await detectAvailabilityProblem(this.page);
      if (availability) {
        throw new FeatureUnavailableError(`AI video: ${availability.message}`, { code: availability.code });
      }
      const failure = this.page
        .getByText(/something went wrong|couldn['’]t generate|violates|try a different prompt/i)
        .filter({ visible: true });
      if ((await failure.count()) > 0) {
        throw new GenerationFailedError(
          `AI video generation failed: ${(await failure.first().innerText()).trim()}`,
        );
      }
      await sleep(2000);
    }
    throw new GenerationTimeoutError('AI video generation', timeoutMs);
  }

  /** Answers the canvas preview of a generated clip. */
  private async insertPreview(target: 'new-scene' | 'current-scene'): Promise<void> {
    const primary = this.page
      .getByRole('button', { name: AI_VIDEO_LABELS.preview.newScene, exact: true })
      .filter({ visible: true })
      .first();
    await uiStep(this.editor.ui, `The "${AI_VIDEO_LABELS.preview.newScene}" preview`, async () => {
      if (target === 'new-scene') {
        await primary.click({ timeout: this.editor.options.timeoutMs });
        return;
      }
      // The dropdown toggle is the "More options" button on the same row, right of the primary button.
      const box = await primary.boundingBox();
      const toggles = this.page
        .getByRole('button', { name: AI_VIDEO_LABELS.preview.more, exact: true })
        .filter({ visible: true });
      let index = -1;
      for (let i = 0; i < (await toggles.count()); i++) {
        const b = await toggles.nth(i).boundingBox();
        if (box && b && Math.abs(b.y + b.height / 2 - (box.y + box.height / 2)) < 20 && b.x >= box.x)
          index = i;
      }
      if (index < 0) throw timeoutError('The insert options toggle next to the preview was not found.');
      await toggles.nth(index).click({ timeout: this.editor.options.timeoutMs });
      await this.page
        .getByRole('menuitem', { name: AI_VIDEO_LABELS.preview.currentScene })
        .click({ timeout: this.editor.options.timeoutMs });
    });
  }
}

// ------------------------------------------------------------- templates

export async function listPanelTemplates(editor: VidsEditor): Promise<string[]> {
  await editor.openInsertion('templates');
  const listbox = editor.page.getByRole('listbox', { name: TEMPLATE_LABELS.sidebar });
  const back = editor.page
    .getByRole('complementary', { name: TEMPLATE_LABELS.panel })
    .getByRole('button', { name: TEMPLATE_LABELS.back, exact: true });
  await uiStep(editor.ui, 'The templates side panel', async () => {
    const deadline = Date.now() + editor.options.timeoutMs;
    while (Date.now() < deadline) {
      if (
        await listbox
          .getByRole('option')
          .first()
          .isVisible()
          .catch(() => false)
      )
        return;
      // The panel can reopen on the last template's scene list; go back to the gallery.
      if (await back.isVisible().catch(() => false))
        await back.click({ timeout: 5_000 }).catch(() => undefined);
      await sleep(300);
    }
    throw timeoutError('The template gallery did not appear.');
  });
  return listbox
    .getByRole('option')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? '').trim()));
}

export async function applyPanelTemplate(
  editor: VidsEditor,
  displayName: string,
  afterScene: number | undefined,
  sceneNumbers?: number[],
): Promise<number> {
  const count = await editor.sceneCount();
  await editor.selectScene(afterScene ?? count);
  const names = await listPanelTemplates(editor);
  const match = findTemplateName(names, displayName);
  if (!match)
    throw new UsageError(`Template "${displayName}" was not found.`, {
      hint: 'List templates with: gvids template list',
      details: { available: names },
    });
  const listbox = editor.page.getByRole('listbox', { name: TEMPLATE_LABELS.sidebar });
  await uiStep(editor.ui, `The "${match}" template`, async () => {
    await listbox
      .getByRole('option', { name: match, exact: true })
      .click({ timeout: editor.options.timeoutMs });
  });
  const panel = editor.page
    .getByRole('complementary')
    .filter({ has: editor.page.getByRole('button', { name: TEMPLATE_LABELS.insertAll }) });
  await uiStep(editor.ui, 'The template scene list', async () => {
    await panel.waitFor({ state: 'visible', timeout: editor.options.timeoutMs });
  });
  // Each click inserts right after the selected scene and the selection stays put,
  // so insert in reverse to keep the requested order.
  const order = sceneNumbers ? [...sceneNumbers].reverse() : undefined;
  await insertTemplateScenes(panel, editor.ui, editor.options.timeoutMs, match, order);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && (await editor.sceneCount()) === count) await sleep(300);
  await editor.closeSidePanels();
  return (await editor.sceneCount()) - count;
}

// ---------------------------------------------------------------- picker

/**
 * Drives the Google Drive picker iframe: pastes a file URL into its search
 * box and selects the result. Used by Slides import.
 */
export async function pickDriveFileByUrl(
  ui: UiContext,
  url: string,
  timeoutMs: number,
  /** Reports whether the pick already took effect (the side-panel picker inserts on Enter). */
  picked?: () => Promise<boolean>,
): Promise<void> {
  // Earlier pickers can linger hidden in the page; use the visible one.
  const frame: FrameLocator = ui.page
    .locator(PICKER_LABELS.frame)
    .filter({ visible: true })
    .last()
    .contentFrame();
  const settle = async (ms: number): Promise<boolean> => {
    if (!picked) return false;
    const until = Date.now() + ms;
    do {
      if (await picked()) return true;
      await sleep(500);
    } while (Date.now() < until);
    return false;
  };
  await uiStep(ui, 'The Google Drive file picker', async () => {
    const search = frame.getByRole('combobox', { name: PICKER_LABELS.search });
    // Some pickers ("Drive & Photos") only show the box after pressing "Search".
    const openSearch = frame.getByRole('button', { name: PICKER_LABELS.openSearch, exact: true });
    const deadline = Date.now() + timeoutMs;
    while (!(await search.isVisible().catch(() => false))) {
      if (Date.now() > deadline) throw timeoutError('The Drive picker search box did not appear.');
      if (await openSearch.isVisible().catch(() => false)) await openSearch.click().catch(() => undefined);
      await sleep(300);
    }
    await search.fill(url);
    await search.press('Enter');
  });
  if (await settle(5_000)) return;
  await uiStep(ui, 'The picked file in the Drive picker', async () => {
    // Skip the left-nav options ("Google Drive", "Upload", …) some pickers show.
    const results = frame.getByRole('option').filter({ hasNotText: PICKER_LABELS.navOption });
    await results.first().waitFor({ timeout: timeoutMs });
    // A pasted URL's match is usually pre-selected; clicking it again would toggle it off.
    if ((await results.first().getAttribute('aria-selected')) !== 'true') await results.first().click();
  });
  if (await settle(3_000)) return;
  const select = frame.getByRole('button', { name: PICKER_LABELS.select }).filter({ visible: true }).first();
  if (picked && !(await select.isVisible().catch(() => false))) return; // the caller keeps waiting
  await uiStep(ui, 'The Drive picker "Select" button', async () => {
    await select.click({ timeout: timeoutMs });
  });
}
