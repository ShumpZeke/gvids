import type { FrameLocator, Locator } from 'playwright';
import { FeatureUnavailableError, UsageError } from '../../errors/errors.js';
import type { ShareRole, ShareTarget } from '../../google/permissions.js';
import { sleep } from '../../utils/time.js';
import type { VidPermission } from '../../vids/types.js';
import { SHARE_LABELS } from '../selectors/sharing.js';
import { accessibleName, timeoutError, uiStep } from '../ui.js';
import type { VidsEditor } from './editor-page.js';

const ROLE_FROM_UI: Record<string, VidPermission['role']> = {
  owner: 'owner',
  editor: 'writer',
  commenter: 'commenter',
  viewer: 'reader',
};

export interface GeneralAccess {
  access: 'restricted' | 'anyone' | 'domain';
  domain?: string;
  role?: ShareRole;
}

function roleFromUi(label: string): ShareRole | undefined {
  const m = /\b(Editor|Commenter|Viewer)\b/i.exec(label);
  return m ? (ROLE_FROM_UI[m[1]!.toLowerCase()] as ShareRole) : undefined;
}

/** "Name Name. person@example.com. Editor." (a person row of the people list). */
export function parsePersonRow(label: string): VidPermission | undefined {
  const email = /[^\s()<>]+@[^\s()<>]+\.[a-z]{2,}/i.exec(label)?.[0]?.replace(/\.$/, '');
  if (!email) return undefined;
  const role =
    /\b(Owner|Editor|Commenter|Viewer)\b\.?\s*$/i.exec(label.trim())?.[1] ??
    /\b(Owner|Editor|Commenter|Viewer)\b/i.exec(label)?.[1];
  let name = (label.split(/\.\s/)[0] ?? '').trim();
  // The row repeats the name ("Ann Lee Ann Lee"): keep one copy.
  const half = (name.length - 1) / 2;
  if (Number.isInteger(half) && name.slice(0, half) === name.slice(half + 1)) name = name.slice(0, half);
  return {
    id: `ui:${email.toLowerCase()}`,
    type: 'user',
    role: role ? (ROLE_FROM_UI[role.toLowerCase()] ?? role.toLowerCase()) : 'unknown',
    emailAddress: email,
    ...(name && name !== email ? { displayName: name.replace(/\s*\(you\)$/, '') } : {}),
  };
}

/**
 * Google's share dialog (the `drivesharing` iframe), opened from the editor's Share
 * button. Used when there is no Drive API login: listing, granting and removing access.
 */
export class SharePanel {
  private constructor(
    private readonly editor: VidsEditor,
    private readonly frame: FrameLocator,
  ) {}

  static async open(editor: VidsEditor): Promise<SharePanel> {
    const page = editor.page;
    await editor.dismissPopups();
    await uiStep(editor.ui, 'The Share button', () =>
      page
        .getByRole('button', { name: SHARE_LABELS.openButton })
        .first()
        .click({ timeout: editor.options.timeoutMs }),
    );
    const frame = page.locator(SHARE_LABELS.frame).last().contentFrame();
    const panel = new SharePanel(editor, frame);
    await uiStep(editor.ui, 'The share dialog', () =>
      frame
        .getByRole('heading', { name: SHARE_LABELS.dialog })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 }),
    );
    return panel;
  }

  private button(name: RegExp): Locator {
    return this.frame.getByRole('button', { name }).first();
  }

  /** People with access, plus link or domain access, in the Drive API's shape (ids are synthetic). */
  async permissions(): Promise<VidPermission[]> {
    const rows = this.frame.getByRole('menu', { name: SHARE_LABELS.peopleList }).getByRole('menuitem');
    const out: VidPermission[] = [];
    for (let i = 0; i < (await rows.count()); i++) {
      const person = parsePersonRow(await accessibleName(rows.nth(i)));
      if (person) out.push(person);
    }
    const general = await this.generalAccess();
    if (general.access === 'anyone')
      out.push({ id: 'ui:anyone', type: 'anyone', role: general.role ?? 'reader' });
    if (general.access === 'domain')
      out.push({
        id: `ui:domain:${general.domain ?? ''}`,
        type: 'domain',
        role: general.role ?? 'reader',
        ...(general.domain ? { domain: general.domain } : {}),
      });
    return out;
  }

  async generalAccess(): Promise<GeneralAccess> {
    const what = (await accessibleName(this.button(SHARE_LABELS.generalAccess)))
      .replace(/\s*change general access$/i, '')
      .trim();
    if (/^Restricted$/i.test(what)) return { access: 'restricted' };
    const roleLabel = await accessibleName(this.button(SHARE_LABELS.linkRole)).catch(() => '');
    const role = roleFromUi(roleLabel);
    if (/^Anyone with the link$/i.test(what)) return { access: 'anyone', ...(role ? { role } : {}) };
    return { access: 'domain', domain: what, ...(role ? { role } : {}) };
  }

  /** Sets "General access" (and the link role). Changes apply immediately. */
  async setGeneralAccess(
    target: 'restricted' | 'anyone' | { domain: string },
    role?: ShareRole,
  ): Promise<void> {
    const option =
      target === 'restricted'
        ? SHARE_LABELS.access.restricted
        : target === 'anyone'
          ? SHARE_LABELS.access.anyone
          : new RegExp(`^${target.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const current = await this.generalAccess();
    const wanted = target === 'restricted' ? 'restricted' : target === 'anyone' ? 'anyone' : 'domain';
    if (
      current.access !== wanted ||
      (wanted === 'domain' && typeof target === 'object' && current.domain !== target.domain)
    ) {
      await uiStep(this.editor.ui, 'The general access menu', async () => {
        await this.button(SHARE_LABELS.generalAccess).click();
        const item = this.frame.getByRole('menuitemradio', { name: option }).first();
        if (!(await item.isVisible().catch(() => false)) && typeof target === 'object') {
          await this.editor.page.keyboard.press('Escape');
          throw new FeatureUnavailableError(
            `Sharing with the domain ${target.domain} is not offered for this video.`,
            {
              hint: 'Domain sharing is only available to Google Workspace accounts of that domain.',
            },
          );
        }
        await item.click();
      });
      await this.until(
        async () => (await this.generalAccess()).access === wanted,
        'the general access change',
      );
    }
    if (role && wanted !== 'restricted' && (await this.generalAccess()).role !== role) {
      await uiStep(this.editor.ui, 'The link role menu', async () => {
        await this.button(SHARE_LABELS.linkRole).click();
        await this.frame.getByRole('menuitemradio', { name: SHARE_LABELS.roles[role] }).first().click();
      });
      await this.until(async () => (await this.generalAccess()).role === role, 'the link role change');
    }
  }

  /** Adds a person or group by e-mail with a role (sends Google's invitation e-mail when notify). */
  async addPerson(
    email: string,
    role: ShareRole,
    options: { notify: boolean; message?: string },
  ): Promise<void> {
    const page = this.editor.page;
    await uiStep(this.editor.ui, 'The "Add people" box', async () => {
      // The input stays zero-sized until focused, so focus it instead of clicking it.
      await this.frame.getByRole('combobox', { name: SHARE_LABELS.addPeople }).first().focus();
      await page.keyboard.type(email, { delay: 15 });
      await sleep(900);
      await page.keyboard.press('Enter');
      await this.button(SHARE_LABELS.personRole).waitFor({ state: 'visible', timeout: 15_000 });
    });
    if (roleFromUi(await accessibleName(this.button(SHARE_LABELS.personRole))) !== role) {
      await uiStep(this.editor.ui, 'The role menu for new people', async () => {
        await this.button(SHARE_LABELS.personRole).click();
        await this.frame.getByRole('menuitemradio', { name: SHARE_LABELS.roles[role] }).first().click();
      });
    }
    const notify = this.frame.getByRole('checkbox', { name: SHARE_LABELS.notify }).first();
    if ((await notify.isChecked().catch(() => true)) !== options.notify) await notify.click();
    if (options.notify && options.message) {
      await this.frame.getByRole('textbox', { name: SHARE_LABELS.message }).first().fill(options.message);
    }
    await uiStep(this.editor.ui, 'The Send button', () => this.button(SHARE_LABELS.send).click());
    // Google may ask to confirm sharing with an address that has no Google account.
    const anyway = this.frame.getByRole('button', { name: /^(Share anyway|Send anyway|Yes)$/ }).first();
    if (await anyway.isVisible({ timeout: 3_000 }).catch(() => false)) await anyway.click();
    await this.until(
      async () =>
        (await this.permissions()).some((p) => p.emailAddress?.toLowerCase() === email.toLowerCase()),
      `sharing with ${email}`,
    );
  }

  /** Removes a person's access (the change is saved before returning). */
  async removePerson(email: string): Promise<boolean> {
    const row = this.frame
      .getByRole('menu', { name: SHARE_LABELS.peopleList })
      .getByRole('menuitem')
      .filter({ hasText: email })
      .first();
    if (!(await row.isVisible().catch(() => false))) return false;
    await uiStep(this.editor.ui, `The role menu of ${email}`, async () => {
      await row.getByRole('button').first().click();
      await this.frame
        .getByRole('menuitem', { name: SHARE_LABELS.removeAccess })
        .or(this.frame.getByRole('menuitemradio', { name: SHARE_LABELS.removeAccess }))
        .first()
        .click();
    });
    const save = this.button(SHARE_LABELS.save);
    if (await save.isVisible({ timeout: 3_000 }).catch(() => false)) await save.click();
    await this.until(
      async () =>
        !(await this.permissions()).some((p) => p.emailAddress?.toLowerCase() === email.toLowerCase()),
      `removing ${email}`,
    );
    return true;
  }

  /** Closes the dialog (saving pending changes). */
  async close(): Promise<void> {
    const save = this.button(SHARE_LABELS.save);
    if (await save.isVisible().catch(() => false)) await save.click().catch(() => undefined);
    const done = this.button(SHARE_LABELS.done);
    if (await done.isVisible().catch(() => false)) await done.click().catch(() => undefined);
    await this.frame
      .getByRole('heading', { name: SHARE_LABELS.dialog })
      .first()
      .waitFor({ state: 'hidden', timeout: 10_000 })
      .catch(() => undefined);
  }

  private async until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check().catch(() => false)) return;
      await sleep(400);
    }
    throw timeoutError(`The share dialog did not confirm ${what}.`);
  }
}

/** Grants access through the share dialog; returns what the dialog shows afterwards. */
export async function shareInDialog(
  editor: VidsEditor,
  target: ShareTarget,
  role: ShareRole,
  options: { notify: boolean; message?: string },
): Promise<{ permission: VidPermission; action: 'created' | 'updated' | 'unchanged' }> {
  const panel = await SharePanel.open(editor);
  try {
    const before = await panel.permissions();
    const find = (list: VidPermission[]): VidPermission | undefined =>
      list.find((p) =>
        target.kind === 'anyone'
          ? p.type === 'anyone'
          : target.kind === 'domain'
            ? p.type === 'domain' && p.domain?.toLowerCase() === target.domain.toLowerCase()
            : p.emailAddress?.toLowerCase() === target.email.toLowerCase(),
      );
    const existing = find(before);
    if (existing && (existing.role === role || existing.role === 'owner'))
      return { permission: existing, action: 'unchanged' };
    if (target.kind === 'anyone') await panel.setGeneralAccess('anyone', role);
    else if (target.kind === 'domain') await panel.setGeneralAccess({ domain: target.domain }, role);
    else if (existing) {
      throw new UsageError(
        `${target.email} already has ${existing.role} access; changing a person's role needs the Drive API.`,
        {
          hint: [
            'Sign in to the Drive API: gvids auth login',
            `Or remove and re-add: gvids unshare <id> ${target.email} --yes`,
          ],
        },
      );
    } else await panel.addPerson(target.email, role, options);
    const after = find(await panel.permissions());
    if (!after) throw timeoutError('The share dialog does not show the new access.');
    return { permission: after, action: existing ? 'updated' : 'created' };
  } finally {
    await panel.close();
  }
}

/** Removes access through the share dialog; returns the removed entries. */
export async function unshareInDialog(editor: VidsEditor, target: ShareTarget): Promise<VidPermission[]> {
  const panel = await SharePanel.open(editor);
  try {
    const before = await panel.permissions();
    if (target.kind === 'anyone' || target.kind === 'domain') {
      const removed = before.filter((p) =>
        target.kind === 'anyone'
          ? p.type === 'anyone'
          : p.type === 'domain' && p.domain?.toLowerCase() === target.domain.toLowerCase(),
      );
      if (removed.length > 0) await panel.setGeneralAccess('restricted');
      return removed;
    }
    const person = before.find((p) => p.emailAddress?.toLowerCase() === target.email.toLowerCase());
    if (!person) return [];
    if (person.role === 'owner') throw new UsageError('The owner cannot be removed.');
    await panel.removePerson(target.email);
    return [person];
  } finally {
    await panel.close();
  }
}
