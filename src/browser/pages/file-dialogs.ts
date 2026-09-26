import type { Page } from 'playwright';
import { UiChangedError } from '../../errors/errors.js';
import { sleep } from '../../utils/time.js';
import { extractVidIdFromEditorUrl, vidEditUrl } from '../../vids/urls.js';
import { EDITOR_LABELS } from '../selectors/editor.js';
import { FILE_DIALOG_LABELS } from '../selectors/sharing.js';
import { armed, timeoutError, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

const { file } = EDITOR_LABELS.topMenus;

/** File > Make a copy > Entire video. Returns the copy (its tab is closed again). */
export async function copyInEditor(
  editor: VidsEditor,
  options: { name?: string; samePeople?: boolean; comments?: boolean },
): Promise<{ id: string; url: string; name: string }> {
  const page = editor.page;
  await editor.menu([file, EDITOR_LABELS.menuItems.makeCopy, EDITOR_LABELS.menuItems.entireVideo]);
  const dialog = page.getByRole('dialog', { name: FILE_DIALOG_LABELS.copyDialog });
  await uiStep(editor.ui, 'The "Copy document" dialog', () =>
    dialog.waitFor({ state: 'visible', timeout: 20_000 }),
  );
  const nameBox = dialog.getByRole('textbox', { name: FILE_DIALOG_LABELS.copyName }).first();
  if (options.name) await nameBox.fill(options.name);
  const name = (await nameBox.inputValue().catch(() => options.name ?? '')).trim();
  const setBox = async (label: RegExp, on: boolean | undefined): Promise<void> => {
    if (on === undefined) return;
    const box = dialog.getByRole('checkbox', { name: label }).first();
    if ((await box.isChecked().catch(() => false)) !== on) await box.click();
  };
  await setBox(FILE_DIALOG_LABELS.copyShareSamePeople, options.samePeople);
  await setBox(FILE_DIALOG_LABELS.copyComments, options.comments);
  const opened = armed(page.context().waitForEvent('page', { timeout: 90_000 }));
  await uiStep(editor.ui, 'The "Make a copy" button', () =>
    dialog.getByRole('button', { name: FILE_DIALOG_LABELS.makeCopy }).click(),
  );
  const copyTab = await opened;
  try {
    await copyTab.waitForURL(/\/videos\/d\/[^/]+/, { timeout: 90_000 });
    const id = extractVidIdFromEditorUrl(copyTab.url());
    if (!id) throw new UiChangedError('The editor address of the new copy');
    return { id, url: vidEditUrl(id), name };
  } finally {
    await copyTab.close().catch(() => undefined);
  }
}

/** File > Move: picks a folder by name (or My Drive) in Google's folder picker. */
export async function moveInEditor(editor: VidsEditor, folderName: string): Promise<void> {
  const page = editor.page;
  await editor.menu([file, EDITOR_LABELS.menuItems.move]);
  const picker = page.locator(FILE_DIALOG_LABELS.pickerFrame).last().contentFrame();
  const dialog = picker.getByRole('dialog').first();
  await uiStep(editor.ui, 'The folder picker', () => dialog.waitFor({ state: 'visible', timeout: 30_000 }));
  const root = /^(root|my drive)$/i.test(folderName.trim());
  await uiStep(editor.ui, `The folder "${folderName}" in the picker`, async () => {
    if (root) {
      await picker.getByRole('tab', { name: FILE_DIALOG_LABELS.pickerAllLocations }).click();
      await picker
        .getByRole('gridcell', { name: FILE_DIALOG_LABELS.pickerMyDrive })
        .or(picker.getByRole('row', { name: FILE_DIALOG_LABELS.pickerMyDrive }))
        .first()
        .click();
    } else {
      await picker.getByRole('button', { name: FILE_DIALOG_LABELS.pickerSearch }).first().click();
      await page.keyboard.type(folderName, { delay: 15 });
      await page.keyboard.press('Enter');
      const exact = new RegExp(`^${folderName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      const cell = picker.getByRole('gridcell', { name: exact }).first();
      await cell.waitFor({ state: 'visible', timeout: 20_000 });
      await cell.click();
    }
    const move = picker.getByRole('button', { name: FILE_DIALOG_LABELS.pickerMove, exact: false }).last();
    const deadline = Date.now() + 10_000;
    while ((await move.isDisabled().catch(() => true)) && Date.now() < deadline) await sleep(250);
    await move.click();
  });
  // Moving a shared file asks for confirmation ("Move" / "Change access?").
  const confirm = picker.getByRole('button', { name: /^Move$/ }).last();
  await sleep(800);
  if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
  await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {
    throw timeoutError('The folder picker did not close after "Move".');
  });
}

/** File > Export to Drive: renders an MP4 into My Drive. Returns the new file's ID. */
export async function exportToDriveInEditor(
  editor: VidsEditor,
  timeoutMs: number,
): Promise<{ fileId: string; url: string }> {
  const page: Page = editor.page;
  await editor.menu([file, EDITOR_LABELS.menuItems.exportToDrive]);
  const done = page.getByRole('dialog', { name: FILE_DIALOG_LABELS.exportComplete }).first();
  await done.waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => {
    throw timeoutError(`The export to Drive did not finish within ${Math.round(timeoutMs / 1000)} s.`);
  });
  const opened = armed(page.context().waitForEvent('page', { timeout: 30_000 }));
  await uiStep(editor.ui, 'The "Open now" link', () =>
    done.getByRole('link', { name: FILE_DIALOG_LABELS.exportOpen }).click(),
  );
  const tab = await opened;
  try {
    await tab.waitForURL(/\/file\/d\/[^/?#]+/, { timeout: 30_000 }).catch(() => undefined);
    const fileId = /\/file\/d\/([^/?#]+)/.exec(tab.url())?.[1];
    if (!fileId) throw new UiChangedError('The Drive address of the exported file');
    return { fileId, url: `https://drive.google.com/file/d/${fileId}/view` };
  } finally {
    await tab.close().catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
  }
}

/** File > Version history > Name current version. */
export async function nameVersionInEditor(editor: VidsEditor, name: string): Promise<void> {
  const page = editor.page;
  await editor.menu([
    file,
    EDITOR_LABELS.menuItems.versionHistory,
    EDITOR_LABELS.menuItems.nameCurrentVersion,
  ]);
  const dialog = page.getByRole('dialog', { name: FILE_DIALOG_LABELS.nameVersionDialog }).first();
  await uiStep(editor.ui, 'The "Name current version" dialog', async () => {
    await dialog.waitFor({ state: 'visible', timeout: 15_000 });
    await dialog.getByRole('textbox').first().fill(name);
    await dialog
      .getByRole('button', { name: /^(Save|Name|OK)$/ })
      .first()
      .click();
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
  });
}
