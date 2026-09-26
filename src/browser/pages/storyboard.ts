import type { Locator } from 'playwright';
import {
  FeatureUnavailableError,
  GenerationFailedError,
  GenerationTimeoutError,
  UsageError,
} from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { EDITOR_LABELS } from '../selectors/editor.js';
import { STORYBOARD_LABELS } from '../selectors/storyboard.js';
import { detectAvailabilityProblem, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

export interface DesignOption {
  index: number;
  description: string;
}

/**
 * Gemini "Help me create" storyboard flow (File > Storyboard):
 * prompt → outline → design → draft video.
 */
export class StoryboardFlow {
  constructor(private readonly editor: VidsEditor) {}

  private get page() {
    return this.editor.page;
  }

  private get dialog(): Locator {
    return this.page.getByRole('dialog', { name: STORYBOARD_LABELS.dialog });
  }

  private get timeoutMs(): number {
    return this.editor.options.timeoutMs;
  }

  async open(): Promise<void> {
    const prompt = this.dialog.getByRole('combobox', { name: STORYBOARD_LABELS.prompt });
    if (await prompt.isVisible().catch(() => false)) return;
    try {
      await this.editor.menu([EDITOR_LABELS.topMenus.file, /^Storyboard/]);
    } catch (err) {
      if (err instanceof FeatureUnavailableError) {
        throw new FeatureUnavailableError(
          'Google Vids only offers the AI storyboard on new, unedited videos.',
          {
            hint: [
              'Vids disables File > Storyboard once a video has been edited or renamed, and for videos made with create --via-api.',
              'Create a new video from a prompt instead: gvids create "Title" --prompt "…"',
              'Or create an untitled one (gvids create, no title) and run the storyboard command on it before any other change.',
            ],
            cause: err,
          },
        );
      }
      throw err;
    }
    await uiStep(this.editor.ui, 'The storyboard prompt box', async () => {
      await prompt.waitFor({ state: 'visible', timeout: this.timeoutMs });
    });
  }

  async setPrompt(text: string): Promise<void> {
    if (!text.trim()) throw new UsageError('The storyboard prompt must not be empty.');
    if (text.length > STORYBOARD_LABELS.maxPromptLength) {
      throw new UsageError(
        `The prompt is ${text.length} characters; Vids accepts up to ${STORYBOARD_LABELS.maxPromptLength}.`,
      );
    }
    const prompt = this.dialog.getByRole('combobox', { name: STORYBOARD_LABELS.prompt });
    await uiStep(this.editor.ui, 'The storyboard prompt box', async () => {
      await prompt.click({ timeout: this.timeoutMs });
      await this.page.keyboard.press('Control+A');
      await this.page.keyboard.press('Delete');
      await prompt.fill(text.replace(/\r\n/g, '\n'));
    });
    const typed = (await prompt.innerText()).trim();
    if (!typed) throw new GenerationFailedError('The storyboard prompt could not be entered.');
  }

  /**
   * Mentions a Drive file in the prompt via "@" (context file). Picks the
   * first suggestion whose text contains `name`. Experimental.
   */
  async mentionFile(name: string): Promise<void> {
    const prompt = this.dialog.getByRole('combobox', { name: STORYBOARD_LABELS.prompt });
    await prompt.click();
    await this.page.keyboard.press('End');
    await this.page.keyboard.type(` @${name}`, { delay: 30 });
    await uiStep(this.editor.ui, `The "@${name}" file suggestion`, async () => {
      const option = this.page.getByRole('option', {
        name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      });
      await option.filter({ visible: true }).first().click({ timeout: this.timeoutMs });
    });
  }

  private async clickVisibleButton(name: string | RegExp, what: string): Promise<void> {
    await uiStep(this.editor.ui, what, async () => {
      const button = this.dialog.getByRole('button', { name }).filter({ visible: true }).last();
      await button.click({ timeout: this.timeoutMs });
    });
  }

  /** Submits the prompt and waits for Gemini's outline. */
  async generateOutline(timeoutMs: number): Promise<string[]> {
    await this.clickVisibleButton(STORYBOARD_LABELS.next, 'The storyboard "Next" button');
    const heading = this.dialog.getByRole('heading', { name: STORYBOARD_LABELS.outlineHeading });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await heading.isVisible().catch(() => false)) && (await this.outlineBoxes().count()) > 0) {
        return this.readOutline();
      }
      await this.throwIfFailed('Outline generation');
      await sleep(750);
    }
    throw new GenerationTimeoutError('Storyboard outline generation', timeoutMs);
  }

  /** Asks Gemini for a different outline ("Try again") and waits for it. */
  async retryOutline(timeoutMs: number): Promise<string[]> {
    const before = (await this.readOutline()).join('|');
    await this.clickVisibleButton(STORYBOARD_LABELS.tryAgain, 'The storyboard "Try again" button');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      const now = await this.readOutline().catch(() => [] as string[]);
      if (now.length > 0 && now.join('|') !== before) return now;
      await this.throwIfFailed('Outline regeneration');
    }
    throw new GenerationTimeoutError('Regenerating the storyboard outline', timeoutMs);
  }

  private outlineBoxes(): Locator {
    return this.dialog.getByRole('listbox').filter({ visible: true }).last().getByRole('textbox');
  }

  async readOutline(): Promise<string[]> {
    return this.outlineBoxes().evaluateAll((els) =>
      els.map((e) => ((e as HTMLInputElement).value ?? (e as HTMLElement).innerText ?? '').trim()),
    );
  }

  /** Replaces the outline with `topics` (adds/removes scenes as needed). */
  async setOutline(topics: string[]): Promise<void> {
    if (topics.length === 0) throw new UsageError('The outline needs at least one scene.');
    for (const t of topics) {
      if (t.length > STORYBOARD_LABELS.maxTopicLength) {
        throw new UsageError(`Outline topics are limited to ${STORYBOARD_LABELS.maxTopicLength} characters.`);
      }
    }
    const listbox = this.dialog.getByRole('listbox').filter({ visible: true }).last();
    let count = await this.outlineBoxes().count();
    while (count > topics.length) {
      await listbox.getByRole('button', { name: STORYBOARD_LABELS.removeScene }).last().click();
      await sleep(200);
      count = await this.outlineBoxes().count();
    }
    while (count < topics.length) {
      await listbox.getByRole('button', { name: STORYBOARD_LABELS.addScene }).last().click();
      await sleep(200);
      const next = await this.outlineBoxes().count();
      if (next === count) throw new FeatureUnavailableError('Could not add a scene to the outline.');
      count = next;
    }
    for (let i = 0; i < topics.length; i++) {
      const box = this.outlineBoxes().nth(i);
      await box.click();
      await box.fill(topics[i]!);
    }
  }

  async acceptOutline(): Promise<DesignOption[]> {
    await this.clickVisibleButton(STORYBOARD_LABELS.next, 'The outline "Next" button');
    const group = this.dialog.getByRole('radiogroup', { name: STORYBOARD_LABELS.designGroup });
    await uiStep(this.editor.ui, 'The design choices', async () => {
      await group.getByRole('button').first().waitFor({ state: 'visible', timeout: this.timeoutMs });
    });
    const labels = await group
      .getByRole('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    return labels.map((description, i) => ({
      index: i + 1,
      description: description.replace(/\s*\(\d+ of \d+\)$/, ''),
    }));
  }

  /** Picks design `index` (1-based), creates the draft and waits for it. */
  async createDraft(index: number, timeoutMs: number): Promise<void> {
    const group = this.dialog.getByRole('radiogroup', { name: STORYBOARD_LABELS.designGroup });
    const count = await group.getByRole('button').count();
    if (index < 1 || index > count) throw new UsageError(`--design must be between 1 and ${count}.`);
    await uiStep(this.editor.ui, `Design ${index}`, async () => {
      await group
        .getByRole('button')
        .nth(index - 1)
        .click({ timeout: this.timeoutMs });
    });
    await this.clickVisibleButton(STORYBOARD_LABELS.createDraft, 'The "Create the draft video" button');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.dialog.isVisible().catch(() => false))) {
        await this.editor.dismissPopups();
        return;
      }
      await this.throwIfFailed('Draft video creation');
      await sleep(1000);
    }
    throw new GenerationTimeoutError('Creating the draft video', timeoutMs);
  }

  private async throwIfFailed(what: string): Promise<void> {
    const alert = this.dialog
      .getByRole('alert')
      .filter({ visible: true })
      .filter({ hasText: /went wrong|try again later|couldn['’]t/i });
    if ((await alert.count()) > 0) {
      const text = (await alert.first().innerText()).replace(/\s+/g, ' ').trim();
      throw new GenerationFailedError(`${what} failed: ${text}`);
    }
    const availability = await detectAvailabilityProblem(this.page);
    if (availability)
      throw new FeatureUnavailableError(`${what}: ${availability.message}`, { code: availability.code });
  }

  async cancel(): Promise<void> {
    const close = this.dialog.getByRole('button', { name: /^Close$/ }).filter({ visible: true });
    if ((await close.count()) > 0)
      await close
        .last()
        .click()
        .catch(() => undefined);
  }
}
