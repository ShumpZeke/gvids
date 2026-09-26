import type { Locator } from 'playwright';
import { UsageError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { EDITOR_LABELS } from '../selectors/editor.js';
import { DESIGN_LABELS, type TransitionType } from '../selectors/design.js';
import { timeoutError, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

const exact = (label: string): RegExp => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/** "elastic slide" -> "Elastic slide" (radio labels are sentence case). */
const labelOf = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

async function panel(editor: VidsEditor, name: RegExp): Promise<Locator> {
  const side = editor.page.getByRole('complementary', { name }).filter({ visible: true }).first();
  await uiStep(editor.ui, `The "${String(name)}" panel`, () =>
    side.waitFor({ state: 'visible', timeout: 15_000 }),
  );
  return side;
}

async function pickRadio(editor: VidsEditor, scope: Locator, group: RegExp, value: string): Promise<void> {
  const radio = scope
    .getByRole('radiogroup', { name: group })
    .getByRole('radio', { name: exact(labelOf(value)) });
  if ((await radio.count()) === 0) {
    const offered = await scope
      .getByRole('radiogroup', { name: group })
      .getByRole('radio')
      .evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()));
    throw new UsageError(
      `"${value}" is not offered here. Choose one of: ${offered.join(', ').toLowerCase()}.`,
    );
  }
  if (
    !(await radio
      .first()
      .isChecked()
      .catch(() => false))
  ) {
    await uiStep(editor.ui, `The "${value}" option`, () => radio.first().click());
  }
}

/** Sets a numeric spin box and checks the value the editor accepted. */
async function setSpin(
  editor: VidsEditor,
  scope: Locator,
  name: RegExp,
  value: number,
  what: string,
): Promise<number> {
  const box = scope.getByRole('spinbutton', { name }).first();
  await uiStep(editor.ui, `The ${what} box`, async () => {
    await box.click({ clickCount: 3 });
    await box.fill(String(value));
    await box.press('Enter');
  });
  await sleep(300);
  const accepted = Number((await box.inputValue().catch(() => '')) || NaN);
  if (!Number.isFinite(accepted) || Math.abs(accepted - value) > Math.max(0.051, Math.abs(value) * 0.001)) {
    throw new UsageError(`The editor did not accept ${what} ${value} (it shows ${accepted}).`, {
      hint: 'Check the allowed range in the error of `gvids <command> --help`, or the editor.',
    });
  }
  return accepted;
}

async function readSpin(scope: Locator, name: RegExp): Promise<number | undefined> {
  const v = Number(
    await scope
      .getByRole('spinbutton', { name })
      .first()
      .inputValue()
      .catch(() => ''),
  );
  return Number.isFinite(v) ? v : undefined;
}

// ----------------------------------------------------------------------------- transitions

/** Sets the transition into scene `n` (from scene n-1). */
export async function setTransition(
  editor: VidsEditor,
  n: number,
  type: TransitionType,
  options: { duration?: number; direction?: string } = {},
): Promise<{ scene: number; type: TransitionType; duration?: number; direction?: string }> {
  if (n < 2)
    throw new UsageError('Transitions go into a scene from the one before it: use scene 2 or later.');
  await editor.selectScene(n);
  await uiStep(editor.ui, 'The Transition button', () =>
    editor.page.getByRole('button', { name: DESIGN_LABELS.transitionButton }).first().click(),
  );
  const side = await panel(editor, DESIGN_LABELS.transitionPanel);
  try {
    await pickRadio(editor, side, DESIGN_LABELS.typeGroup, type);
    let duration: number | undefined;
    if (type !== 'none') {
      await sleep(400);
      if (options.duration !== undefined)
        duration = await setSpin(editor, side, DESIGN_LABELS.duration, options.duration, 'duration');
      else duration = await readSpin(side, DESIGN_LABELS.duration);
      if (options.direction) await pickRadio(editor, side, DESIGN_LABELS.directionGroup, options.direction);
    }
    return {
      scene: n,
      type,
      ...(duration !== undefined ? { duration } : {}),
      ...(options.direction ? { direction: options.direction } : {}),
    };
  } finally {
    await editor.closeSidePanels();
  }
}

// ------------------------------------------------------------------------------- animations

export interface AnimationRequest {
  scene: number;
  /** Omit for a whole-scene animation. */
  objectId?: string;
  type: string;
  /** Object loop animation instead of enter & exit. */
  loop?: boolean;
  duration?: number;
  direction?: string;
  /** Text: animate the whole box, or by paragraph, word or character. */
  by?: string;
}

export async function animate(editor: VidsEditor, req: AnimationRequest): Promise<AnimationRequest> {
  if (req.objectId) await editor.selectObject(req.scene, req.objectId);
  else await editor.selectScene(req.scene);
  await uiStep(editor.ui, 'The Animation button', () =>
    editor.page.getByRole('button', { name: DESIGN_LABELS.animationButton }).first().click(),
  );
  const side = await panel(editor, DESIGN_LABELS.animationPanel);
  try {
    const tab = (name: RegExp): Promise<void> =>
      uiStep(editor.ui, `The "${String(name)}" tab`, async () => {
        const t = side.getByRole('tab', { name }).first();
        if ((await t.getAttribute('aria-selected')) !== 'true') await t.click();
      });
    if (req.objectId) {
      await tab(DESIGN_LABELS.tabs.object);
      await tab(req.loop ? DESIGN_LABELS.tabs.loop : DESIGN_LABELS.tabs.enterExit);
    } else {
      if (req.loop) throw new UsageError('--loop applies to objects: pass --object <object-id>.');
      await tab(DESIGN_LABELS.tabs.scene);
    }
    await pickRadio(editor, side, DESIGN_LABELS.typeGroup, req.type);
    let duration = req.duration;
    if (req.type !== 'none') {
      await sleep(400);
      if (req.duration !== undefined)
        duration = await setSpin(editor, side, DESIGN_LABELS.duration, req.duration, 'duration');
      if (req.direction) await pickRadio(editor, side, DESIGN_LABELS.directionGroup, req.direction);
      if (req.by) await pickRadio(editor, side, DESIGN_LABELS.animatedByGroup, req.by);
    }
    return { ...req, ...(duration !== undefined ? { duration } : {}) };
  } finally {
    await editor.closeSidePanels();
  }
}

// --------------------------------------------------------------------------- format options

export interface ObjectFormat {
  width?: number;
  height?: number;
  rotation?: number;
  x?: number;
  y?: number;
  lockAspect?: boolean;
  shadow?: boolean;
}

async function openFormatOptions(editor: VidsEditor, n: number, objectId: string): Promise<Locator> {
  await editor.selectObject(n, objectId);
  await editor.menu([EDITOR_LABELS.topMenus.format, /^Format options/], { keepSelection: true });
  const side = await panel(editor, DESIGN_LABELS.formatPanel);
  for (const section of [DESIGN_LABELS.format.sizeSection, DESIGN_LABELS.format.positionSection]) {
    const button = side.getByRole('button', { name: section }).first();
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click().catch(() => undefined);
  }
  await sleep(300);
  return side;
}

async function readFormat(side: Locator): Promise<ObjectFormat> {
  const f = DESIGN_LABELS.format;
  const checked = (name: RegExp): Promise<boolean | undefined> =>
    side
      .getByRole('checkbox', { name })
      .first()
      .isChecked()
      .catch(() => undefined);
  const out: ObjectFormat = {};
  const put = <K extends keyof ObjectFormat>(k: K, v: ObjectFormat[K] | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  put('width', await readSpin(side, f.width));
  put('height', await readSpin(side, f.height));
  put('rotation', await readSpin(side, f.angle));
  put('x', await readSpin(side, f.x));
  put('y', await readSpin(side, f.y));
  put('lockAspect', await checked(f.lockAspect));
  put('shadow', await checked(f.shadow));
  return out;
}

/** Reads an object's size, rotation and position (Format options, pixels from the top left). */
export async function getObjectFormat(
  editor: VidsEditor,
  n: number,
  objectId: string,
): Promise<ObjectFormat> {
  const side = await openFormatOptions(editor, n, objectId);
  try {
    return await readFormat(side);
  } finally {
    await editor.closeSidePanels();
  }
}

/** Sets an object's size, rotation, position and shadow exactly; returns the values afterwards. */
export async function setObjectFormat(
  editor: VidsEditor,
  n: number,
  objectId: string,
  want: ObjectFormat & { flip?: 'horizontal' | 'vertical' },
): Promise<ObjectFormat> {
  const side = await openFormatOptions(editor, n, objectId);
  const f = DESIGN_LABELS.format;
  try {
    const setCheck = async (name: RegExp, on: boolean | undefined, what: string): Promise<void> => {
      if (on === undefined) return;
      const box = side.getByRole('checkbox', { name }).first();
      if ((await box.isChecked().catch(() => !on)) !== on)
        await uiStep(editor.ui, `The ${what} checkbox`, () => box.click());
    };
    // Unlock the aspect ratio before changing one side only, or the other side follows.
    const oneSide = (want.width === undefined) !== (want.height === undefined);
    await setCheck(
      f.lockAspect,
      want.lockAspect ?? (oneSide ? undefined : want.width !== undefined ? false : undefined),
      'aspect ratio',
    );
    if (want.width !== undefined) await setSpin(editor, side, f.width, want.width, 'width');
    if (want.height !== undefined) await setSpin(editor, side, f.height, want.height, 'height');
    if (want.rotation !== undefined)
      await setSpin(editor, side, f.angle, ((want.rotation % 360) + 360) % 360, 'angle');
    if (want.x !== undefined) await setSpin(editor, side, f.x, want.x, 'x position');
    if (want.y !== undefined) await setSpin(editor, side, f.y, want.y, 'y position');
    if (want.flip) {
      await uiStep(editor.ui, 'The flip button', () =>
        side
          .getByRole('button', { name: want.flip === 'horizontal' ? f.flipH : f.flipV })
          .first()
          .click(),
      );
    }
    await setCheck(f.shadow, want.shadow, 'drop shadow');
    await sleep(300);
    return await readFormat(side);
  } finally {
    await editor.closeSidePanels();
  }
}

// ------------------------------------------------------------------------- find and replace

/** Edit > Find and replace across the whole video. `replace` undefined only counts matches. */
export async function findReplace(
  editor: VidsEditor,
  find: string,
  replace: string | undefined,
  options: { matchCase?: boolean; regex?: boolean } = {},
): Promise<{ matches: number; replaced: number }> {
  const L = DESIGN_LABELS.findReplace;
  await editor.menu([EDITOR_LABELS.topMenus.edit, EDITOR_LABELS.menuItems.findAndReplace]);
  const dialog = editor.page.getByRole('dialog', { name: L.dialog }).first();
  await uiStep(editor.ui, 'The "Find and replace" dialog', () =>
    dialog.waitFor({ state: 'visible', timeout: 15_000 }),
  );
  const count = async (): Promise<number | undefined> => {
    const text = await dialog.innerText().catch(() => '');
    const m = /(\d+)\s+of\s+(\d+)/.exec(text);
    return m ? Number(m[2]) : undefined;
  };
  try {
    for (const [name, on] of [
      [L.matchCase, Boolean(options.matchCase)],
      [L.regex, Boolean(options.regex)],
    ] as const) {
      const box = dialog.getByRole('checkbox', { name }).first();
      if ((await box.isChecked().catch(() => false)) !== on) await box.click();
    }
    await dialog.getByRole('textbox', { name: L.find }).fill(find);
    let matches: number | undefined;
    const deadline = Date.now() + 5_000;
    while ((matches = await count()) === undefined && Date.now() < deadline) await sleep(200);
    matches ??= 0;
    if (replace === undefined || matches === 0) return { matches, replaced: 0 };
    await dialog.getByRole('textbox', { name: L.replaceWith }).fill(replace);
    await uiStep(editor.ui, 'The "Replace all" button', () =>
      dialog.getByRole('button', { name: L.replaceAll }).click(),
    );
    // "Replace all" replaces every match; wait until the dialog reflects it.
    const settle = Date.now() + 10_000;
    const replacementMatches =
      options.regex ||
      !(options.matchCase ? replace.includes(find) : replace.toLowerCase().includes(find.toLowerCase()));
    while (Date.now() < settle) {
      const now = await count();
      if (now === undefined || now < matches || !replacementMatches) break;
      await sleep(250);
    }
    await editor.waitForSaved(20_000).catch(() => false);
    return { matches, replaced: matches };
  } finally {
    await dialog
      .getByRole('button', { name: L.close })
      .first()
      .click()
      .catch(() => undefined);
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {
      throw timeoutError('The "Find and replace" dialog did not close.');
    });
  }
}
