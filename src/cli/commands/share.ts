import type { Command } from 'commander';
import { NotFoundError, UsageError } from '../../errors/errors.js';
import {
  assertEmail,
  describeTarget,
  parseRole,
  type ShareRole,
  type ShareTarget,
} from '../../google/permissions.js';
import type { VidPermission } from '../../vids/types.js';
import { parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { action, type Kit } from '../kit.js';
import { renderTable } from '../output/format.js';
import { viaDriveOrBrowser } from './files.js';

function renderPermissions(perms: VidPermission[]): string {
  if (perms.length === 0) return 'No permissions (only the owner has access).';
  return renderTable(perms, [
    { header: 'ROLE', value: (p) => p.role },
    { header: 'TYPE', value: (p) => p.type },
    {
      header: 'WHO',
      value: (p) =>
        p.type === 'anyone'
          ? 'anyone with the link'
          : p.type === 'domain'
            ? `everyone at ${p.domain ?? '?'}`
            : (p.emailAddress ?? p.displayName ?? '-'),
      maxWidth: 48,
    },
    { header: 'PERMISSION ID', value: (p) => p.id },
  ]);
}

interface ShareFlags {
  role: string;
  anyone?: string | boolean;
  domain?: string;
  group?: boolean;
  notify: boolean;
  message?: string;
  discoverable?: boolean;
}

function resolveTarget(
  email: string | undefined,
  flags: ShareFlags,
): { target: ShareTarget; role: ShareRole } {
  const roleFromAnyone = typeof flags.anyone === 'string' ? flags.anyone : undefined;
  const role = parseRole(roleFromAnyone ?? flags.role);
  const kinds = [email ? 1 : 0, flags.anyone ? 1 : 0, flags.domain ? 1 : 0].reduce((a, b) => a + b, 0);
  if (kinds !== 1) {
    throw new UsageError('Specify exactly one of: an e-mail address, --anyone [role], or --domain <domain>.');
  }
  if (flags.anyone) return { target: { kind: 'anyone' }, role };
  if (flags.domain) return { target: { kind: 'domain', domain: flags.domain.trim() }, role };
  return { target: { kind: flags.group ? 'group' : 'user', email: assertEmail(email!) }, role };
}

/** Permission ids from the share dialog ("ui:…", as `permissions` prints them without the Drive API). */
function targetFromUiId(permissionId: string): ShareTarget | undefined {
  if (permissionId === 'ui:anyone') return { kind: 'anyone' };
  if (permissionId.startsWith('ui:domain:')) return { kind: 'domain', domain: permissionId.slice(10) };
  if (permissionId.startsWith('ui:') && permissionId.includes('@'))
    return { kind: 'user', email: permissionId.slice(3) };
  return undefined;
}

export function registerShareCommands(program: Command, kit: Kit): void {
  program
    .command('permissions')
    .description(
      'List who can access a video (Drive API; falls back to the share dialog without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        await viaDriveOrBrowser(
          ctx,
          'reading who has access',
          async () => {
            const perms = await (await ctx.permissions()).list(id);
            ctx.out.result({ id, permissions: perms, method: 'drive-api' }, (d) =>
              renderPermissions(d.permissions),
            );
          },
          async () => {
            const perms = await withAutomation(ctx, 'Reading who has access', (auto) => auto.sharing(id));
            ctx.out.result({ id, permissions: perms, method: 'browser' }, (d) =>
              renderPermissions(d.permissions),
            );
          },
        );
      }),
    );

  program
    .command('share')
    .description(
      'Share a video with a person, group, domain or anyone with the link (Drive API; falls back to the share dialog without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('[email]', 'e-mail address of the person or group')
    .option('--role <role>', 'reader | commenter | writer', 'reader')
    .option('--anyone [role]', 'share with anyone who has the link (requires confirmation)')
    .option('--domain <domain>', 'share with everyone in a Google Workspace domain')
    .option('--group', 'the e-mail address is a Google Group')
    .option('--no-notify', 'do not send a notification e-mail')
    .option('--message <text>', 'message to include in the notification e-mail')
    .option('--discoverable', 'let people find the file in search (anyone/domain only; Drive API)')
    .addHelpText(
      'after',
      '\nExamples:\n  gvids share <id> person@example.com --role writer\n  gvids share <id> --anyone reader --yes\n  gvids share <id> team@example.com --group --role commenter',
    )
    .action(
      action(kit, async (ctx, idArg: string, email: string | undefined, flags: ShareFlags) => {
        const id = parseVidId(idArg);
        const { target, role } = resolveTarget(email, flags);
        const isPublic = target.kind === 'anyone' || target.kind === 'domain';
        const render = (d: {
          action: string;
          target: string;
          name: string;
          permission: VidPermission;
        }): string => {
          if (d.action === 'unchanged')
            return `${d.target} already has ${d.permission.role} access to "${d.name}".`;
          return `${d.action === 'created' ? 'Shared' : 'Updated'} "${d.name}" with ${d.target} as ${d.permission.role}.`;
        };
        await viaDriveOrBrowser(
          ctx,
          'sharing',
          async (drive) => {
            const file = await drive.get(id);
            if (isPublic) {
              await ctx.confirm(
                `Make "${file.name}" accessible to ${describeTarget(target)} as ${role}?`,
                `share "${file.name}" with ${describeTarget(target)}`,
              );
            }
            const result = await (
              await ctx.permissions()
            ).share(id, target, role, {
              notify: flags.notify,
              ...(flags.message ? { message: flags.message } : {}),
              ...(flags.discoverable ? { discoverable: true } : {}),
            });
            ctx.out.result(
              { id, name: file.name, target: describeTarget(target), ...result, method: 'drive-api' },
              render,
            );
          },
          async () => {
            if (flags.discoverable)
              ctx.out.warn('--discoverable needs the Drive API; the link is not discoverable.');
            const r = await withAutomation(ctx, 'Sharing', async (auto, control) => {
              const name = await (await auto.editor(id)).title();
              if (isPublic) {
                await control.confirm(
                  `Make "${name}" accessible to ${describeTarget(target)} as ${role}?`,
                  `share "${name}" with ${describeTarget(target)}`,
                );
              }
              const result = await auto.share(id, target, role, {
                notify: flags.notify,
                ...(flags.message ? { message: flags.message } : {}),
              });
              return { name, ...result };
            });
            ctx.out.result({ id, target: describeTarget(target), ...r, method: 'browser' }, render);
          },
        );
      }),
    );

  program
    .command('unshare')
    .description(
      'Remove access for a person, group, domain or link sharing (Drive API; falls back to the share dialog without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('[email]', 'e-mail address to remove')
    .option('--anyone', 'turn off "anyone with the link" access')
    .option('--domain <domain>', 'remove domain-wide access')
    .option('--permission-id <id>', 'remove a specific permission by ID')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          email: string | undefined,
          flags: { anyone?: boolean; domain?: string; permissionId?: string },
        ) => {
          const id = parseVidId(idArg);
          const chosen = [email, flags.anyone, flags.domain, flags.permissionId].filter(Boolean).length;
          if (chosen !== 1) {
            throw new UsageError(
              'Specify exactly one of: an e-mail address, --anyone, --domain, --permission-id.',
            );
          }
          const uiTarget = flags.permissionId ? targetFromUiId(flags.permissionId) : undefined;
          const target = uiTarget
            ? uiTarget
            : flags.permissionId
              ? ({ kind: 'id', permissionId: flags.permissionId } as const)
              : flags.anyone
                ? ({ kind: 'anyone' } as const)
                : flags.domain
                  ? ({ kind: 'domain', domain: flags.domain } as const)
                  : ({ kind: 'user', email: assertEmail(email!) } as const);
          const label =
            target.kind === 'id'
              ? `permission ${target.permissionId}`
              : target.kind === 'anyone'
                ? 'anyone with the link'
                : target.kind === 'domain'
                  ? `everyone at ${target.domain}`
                  : target.email;
          const render = (d: { removed: VidPermission[] }): string =>
            d.removed.length === 0
              ? `Nothing to remove: ${label} has no access.`
              : d.removed
                  .map(
                    (p) =>
                      `Removed ${p.role} access for ${p.emailAddress ?? p.domain ?? (p.type === 'anyone' ? 'anyone with the link' : p.id)}.`,
                  )
                  .join('\n');
          await viaDriveOrBrowser(
            ctx,
            'removing access',
            async () => {
              const perms = await ctx.permissions();
              await ctx.confirm(`Remove access for ${label}?`, `remove access for ${label}`);
              const removed = await perms.unshare(id, target);
              ctx.out.result({ id, removed, method: 'drive-api' }, render);
            },
            async () => {
              if (target.kind === 'id') {
                throw new UsageError('Removing a permission by its Drive ID needs the Drive API.', {
                  hint: [
                    'Pass the e-mail address, --anyone or --domain instead,',
                    'or the "ui:…" ID that `gvids permissions` prints without the Drive API.',
                    'Or sign in to the Drive API: gvids auth login',
                  ],
                });
              }
              const removed = await withAutomation(ctx, 'Removing access', async (auto, control) => {
                await control.confirm(`Remove access for ${label}?`, `remove access for ${label}`);
                return auto.unshare(id, target);
              });
              if (removed.length === 0) {
                throw new NotFoundError(`No permission found for ${label} on this file.`, {
                  hint: `Inspect current access with: gvids permissions ${id}`,
                });
              }
              ctx.out.result({ id, removed, method: 'browser' }, render);
            },
          );
        },
      ),
    );
}
