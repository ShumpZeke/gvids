import fs from 'node:fs/promises';
import path from 'node:path';
import { Option, type Command } from 'commander';
import { AuthError, UsageError } from '../../errors/errors.js';
import { downloadThumbnail } from '../../google/downloads.js';
import { ORDER_BY_VALUES, type OrderBy } from '../../google/files.js';
import type { DriveService, ListOptions } from '../../google/drive.js';
import { pathExists, sanitizeFileName } from '../../utils/fs.js';
import { parsePositiveInt } from '../../utils/input.js';
import { parseDateFilter } from '../../utils/time.js';
import type { VidFile } from '../../vids/types.js';
import { parseFolderId, parseResource, parseVidId, vidEditUrl } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { fallbackWarning } from '../fallback.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { formatBytes, formatDate, renderTable } from '../output/format.js';

interface ListFlags {
  limit?: string;
  all?: boolean;
  folder?: string;
  orderBy?: OrderBy;
  asc?: boolean;
  sharedWithMe?: boolean;
  starred?: boolean;
  trashed?: boolean;
  owner?: string;
  drive?: string;
  ids?: boolean;
}

interface SearchFlags extends ListFlags {
  fullText?: boolean;
  modifiedAfter?: string;
  modifiedBefore?: string;
  createdAfter?: string;
}

function ownerLabel(file: VidFile): string {
  const owner = file.owners[0];
  if (!owner) return file.driveId ? '(shared drive)' : '-';
  return owner.me ? 'me' : (owner.email ?? owner.name ?? '-');
}

function renderFileTable(files: VidFile[], truncated: boolean): string {
  if (files.length === 0) return 'No Google Vids files found.';
  const table = renderTable(files, [
    { header: 'ID', value: (f) => f.id },
    { header: 'NAME', value: (f) => f.name, maxWidth: 48 },
    { header: 'MODIFIED', value: (f) => formatDate(f.modifiedTime) },
    { header: 'OWNER', value: ownerLabel, maxWidth: 32 },
  ]);
  const footer = truncated ? `\n(${files.length} shown; more exist — use --limit or --all)` : '';
  return `${table}${footer}`;
}

export function renderFileDetails(file: VidFile): string {
  const rows: Array<[string, string | undefined]> = [
    ['Name', file.name],
    ['ID', file.id],
    ['URL', file.url],
    ['Type', file.mimeType],
    [
      'Owner',
      file.owners.map((o) => (o.me ? `me (${o.email ?? ''})` : (o.email ?? o.name))).join(', ') || undefined,
    ],
    ['Created', formatDate(file.createdTime)],
    ['Modified', formatDate(file.modifiedTime)],
    ['Last modified by', file.lastModifyingUser?.email ?? file.lastModifyingUser?.name],
    ['Viewed by me', file.viewedByMeTime ? formatDate(file.viewedByMeTime) : undefined],
    ['Parents', file.parents.join(', ') || undefined],
    ['Shared drive', file.driveId],
    ['Shared', file.shared ? 'yes' : 'no'],
    ['Starred', file.starred ? 'yes' : undefined],
    ['Trashed', file.trashed ? 'yes' : undefined],
    ['Size', file.size !== undefined ? formatBytes(file.size) : undefined],
    [
      'Duration',
      file.video?.durationMillis !== undefined
        ? `${(file.video.durationMillis / 1000).toFixed(1)}s`
        : undefined,
    ],
    [
      'Can',
      file.capabilities
        ? Object.entries(file.capabilities)
            .filter(([, v]) => v)
            .map(([k]) =>
              k
                .replace(/^can/, '')
                .replace(/ItemWithinDrive$/, '')
                .toLowerCase(),
            )
            .join(', ')
        : undefined,
    ],
  ];
  const width = Math.max(...rows.filter(([, v]) => v).map(([k]) => k.length));
  return rows
    .filter(([, v]) => v !== undefined && v !== '' && v !== '-')
    .map(([k, v]) => `${k.padEnd(width)}  ${v}`)
    .join('\n');
}

function listOptionsFrom(flags: ListFlags): ListOptions {
  return {
    ...(flags.limit ? { limit: parsePositiveInt(flags.limit, '--limit') } : {}),
    ...(flags.all ? { all: true } : {}),
    ...(flags.folder ? { folderId: parseFolderId(flags.folder) } : {}),
    ...(flags.orderBy ? { orderBy: flags.orderBy } : {}),
    ...(flags.asc ? { ascending: true } : {}),
    ...(flags.sharedWithMe ? { sharedWithMe: true } : {}),
    ...(flags.starred ? { starred: true } : {}),
    ...(flags.trashed ? { trashed: true } : {}),
    ...(flags.owner ? { owner: flags.owner } : {}),
    ...(flags.drive ? { driveId: flags.drive } : {}),
  };
}

function addListFlags(cmd: Command): Command {
  return cmd
    .option('-n, --limit <n>', 'maximum number of results', '30')
    .option('--all', 'fetch every page of results')
    .option('--folder <id|url>', 'only videos directly inside this Drive folder')
    .addOption(new Option('--order-by <field>', 'sort field').choices([...ORDER_BY_VALUES]))
    .option('--asc', 'ascending sort (default is newest first)')
    .option('--shared-with-me', 'only videos shared with you')
    .option('--starred', 'only starred videos')
    .option('--trashed', 'show videos in the trash instead')
    .option('--owner <me|email>', 'only videos owned by this user')
    .option('--drive <shared-drive-id>', 'search a specific shared drive')
    .option('--ids', 'return only file IDs (data.ids)');
}

/** List/search flags only the Drive API can honour. */
function apiOnlyFlags(flags: ListFlags & Partial<SearchFlags>): string[] {
  const names: Array<[unknown, string]> = [
    [flags.all, '--all'],
    [flags.folder, '--folder'],
    [flags.orderBy, '--order-by'],
    [flags.asc, '--asc'],
    [flags.sharedWithMe, '--shared-with-me'],
    [flags.starred, '--starred'],
    [flags.trashed, '--trashed'],
    [flags.owner, '--owner'],
    [flags.drive, '--drive'],
    [flags.fullText, '--full-text'],
    [flags.modifiedAfter, '--modified-after'],
    [flags.modifiedBefore, '--modified-before'],
    [flags.createdAfter, '--created-after'],
  ];
  return names.filter(([v]) => v).map(([, name]) => name);
}

async function runList(
  ctx: CommandContext,
  options: ListOptions,
  idsOnly: boolean,
  fallback: { query?: string; apiOnly: string[] },
): Promise<void> {
  const viaApi = async (drive: DriveService): Promise<void> => {
    const spinner = ctx.out.spinner('Listing Google Vids…');
    const result = await drive.list(options).finally(() => spinner.stop());
    if (idsOnly) {
      const ids = result.files.map((f) => f.id);
      ctx.out.result({ count: ids.length, truncated: result.truncated, method: 'drive-api', ids }, (d) =>
        d.ids.join('\n'),
      );
      return;
    }
    ctx.out.result(
      {
        count: result.files.length,
        truncated: result.truncated,
        query: result.query,
        method: 'drive-api',
        files: result.files,
      },
      (d) => renderFileTable(d.files, d.truncated),
    );
  };
  if (fallback.apiOnly.length > 0) {
    // These filters exist only in the Drive API: no fallback.
    try {
      await viaApi(await ctx.drive());
    } catch (err) {
      if (!(err instanceof AuthError)) throw err;
      throw new AuthError(`${fallback.apiOnly.join(', ')} need the Drive API: ${err.message}`, {
        code: err.code,
        hint: [...err.hint, 'Without it, list shows recent videos and search matches titles.'],
        next: err.next,
      });
    }
    return;
  }
  await viaDriveOrBrowser(ctx, fallback.query ? 'searching' : 'listing videos', viaApi, () =>
    listFromHome(ctx, options, idsOnly, fallback.query),
  );
}

/** list/search through the Vids home page (no Drive API). */
async function listFromHome(
  ctx: CommandContext,
  options: ListOptions,
  idsOnly: boolean,
  query: string | undefined,
): Promise<void> {
  const limit = options.limit ?? 30;
  const files = await withAutomation(ctx, 'Reading the Vids home page', (auto) => auto.home(query, limit));
  if (idsOnly) {
    const ids = files.map((f) => f.id);
    ctx.out.result({ count: ids.length, truncated: ids.length >= limit, method: 'browser', ids }, (d) =>
      d.ids.join('\n'),
    );
    return;
  }
  if (!query) {
    ctx.out.warn(
      'Without the Drive API only videos shown on the Vids home page are listed; use search to find others.',
    );
  }
  ctx.out.result(
    {
      count: files.length,
      truncated: files.length >= limit,
      method: 'browser',
      source: query ? 'vids-home-search' : 'vids-home-recent',
      files,
    },
    (d) =>
      d.files.length === 0
        ? 'No Google Vids found.'
        : renderTable(d.files, [
            { header: 'ID', value: (f) => f.id },
            { header: 'NAME', value: (f) => f.name, maxWidth: 48 },
            { header: 'LAST OPENED', value: (f) => f.lastOpened ?? '-' },
          ]),
  );
}

/**
 * Runs `api` with the Drive API. When the OAuth login is the problem (none,
 * expired or revoked, missing scopes), warns and runs `browser` instead, the
 * equivalent through the Vids web app. Other errors propagate.
 */
export async function viaDriveOrBrowser<T>(
  ctx: CommandContext,
  doing: string,
  api: (drive: DriveService) => Promise<T>,
  browser: () => Promise<T>,
): Promise<T> {
  try {
    return await api(await ctx.drive());
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    ctx.out.warn(fallbackWarning(err, doing));
    return browser();
  }
}

export function registerFileCommands(program: Command, kit: Kit): void {
  addListFlags(
    program
      .command('list')
      .alias('ls')
      .description(
        'List your Google Vids (Drive API; without an OAuth login, recent videos from the Vids home page)',
      )
      .addHelpText(
        'after',
        '\nExamples:\n  gvids list\n  gvids ls --limit 50 --json\n  gvids list --folder <folder-id>',
      ),
  ).action(
    action(kit, async (ctx, flags: ListFlags) => {
      await runList(ctx, listOptionsFrom(flags), Boolean(flags.ids), { apiOnly: apiOnlyFlags(flags) });
    }),
  );

  addListFlags(
    program
      .command('search')
      .description(
        'Search Google Vids by title, content, date or owner (Drive API; without an OAuth login, the Vids home search by title)',
      )
      .argument('[text]', 'text to look for in the title (or content with --full-text)')
      .option('--full-text', 'match content and description as well as the title')
      .option('--modified-after <date>', 'modified after YYYY-MM-DD')
      .option('--modified-before <date>', 'modified before YYYY-MM-DD')
      .option('--created-after <date>', 'created after YYYY-MM-DD')
      .addHelpText(
        'after',
        '\nExamples:\n  gvids search "biology"\n  gvids search --modified-after 2026-09-01\n  gvids search --owner me --starred',
      ),
  ).action(
    action(kit, async (ctx, text: string | undefined, flags: SearchFlags) => {
      const options: ListOptions = listOptionsFrom(flags);
      if (text) {
        if (flags.fullText) options.fullText = text;
        else options.name = text;
      }
      if (flags.modifiedAfter)
        options.modifiedAfter = parseDateFilter(flags.modifiedAfter, '--modified-after');
      if (flags.modifiedBefore)
        options.modifiedBefore = parseDateFilter(flags.modifiedBefore, '--modified-before');
      if (flags.createdAfter) options.createdAfter = parseDateFilter(flags.createdAfter, '--created-after');
      const apiOnly = apiOnlyFlags(flags);
      if (!text && apiOnly.length === 0)
        throw new UsageError('Give search text, or filters such as --modified-after.');
      await runList(ctx, options, Boolean(flags.ids), { ...(text ? { query: text } : {}), apiOnly });
    }),
  );

  program
    .command('info')
    .description(
      'Show metadata for a video (Drive API; without an OAuth login, title, scenes, duration and format from the editor)',
    )
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const parsed = parseResource(idArg);
        await viaDriveOrBrowser(
          ctx,
          'reading the video',
          async (drive) => {
            const file = await drive.get(parsed.id, {
              requireVid: false,
              ...(parsed.resourceKey ? { resourceKey: parsed.resourceKey } : {}),
            });
            if (file.mimeType !== 'application/vnd.google-apps.vid') {
              ctx.out.warn(`${file.id} is not a Google Vids file (${file.mimeType}).`);
            }
            ctx.out.result(file, renderFileDetails);
          },
          async () => {
            const info = await withAutomation(ctx, 'Reading the video', (auto) => auto.info(parsed.id));
            const { title, ...rest } = info;
            ctx.out.result({ ...rest, name: title, method: 'browser' }, (d) =>
              [
                `Name      ${d.name}`,
                `ID        ${d.id}`,
                `URL       ${d.url}`,
                `Scenes    ${d.scenes}`,
                `Duration  ${d.durationSeconds}s`,
                `Format    ${d.formatLabel}`,
              ].join('\n'),
            );
          },
        );
      }),
    );

  program
    .command('url')
    .description('Print the editor URL for a video')
    .argument('<id>', 'video ID or URL')
    .option('--check', 'verify the file exists via the Drive API')
    .action(
      action(kit, async (ctx, idArg: string, flags: { check?: boolean }) => {
        const id = parseVidId(idArg);
        let url = vidEditUrl(id);
        if (flags.check) url = (await (await ctx.drive()).get(id)).url;
        ctx.out.result({ id, url }, (d) => d.url);
      }),
    );

  program
    .command('open')
    .description('Open a video (or Vids home) in your default browser')
    .argument('[id]', 'video ID or URL (omit for the Vids home page)')
    .option('--gvids-browser', 'open in the gvids automation browser profile instead')
    .action(
      action(kit, async (ctx, idArg: string | undefined, flags: { gvidsBrowser?: boolean }) => {
        const url = idArg ? vidEditUrl(parseVidId(idArg)) : 'https://docs.google.com/videos/';
        if (flags.gvidsBrowser) {
          const session = await ctx.browserSession({ forceHeaded: true, keepOpen: true });
          const page = await session.firstPage();
          await page.goto(url);
          await session.close({ keepOpen: true, keepPages: true });
        } else {
          await ctx.openUrl(url);
        }
        ctx.out.result({ opened: url }, (d) => `Opened ${d.opened}`);
      }),
    );

  program
    .command('rename')
    .description('Rename a video (Drive API; falls back to the editor without an OAuth login)')
    .argument('<id>', 'video ID or URL')
    .argument('<name>', 'new title')
    .action(
      action(kit, async (ctx, idArg: string, rawName: string) => {
        const id = parseVidId(idArg);
        const name = rawName.trim();
        if (!name) throw new UsageError('The new name must not be empty.');
        await viaDriveOrBrowser(
          ctx,
          'renaming',
          async (drive) => {
            const file = await drive.rename(id, name);
            ctx.out.result({ ...file, method: 'drive-api' }, (f) => `Renamed to "${f.name}"\n${f.url}`);
          },
          async () => {
            const summary = await withAutomation(ctx, 'Renaming', (auto) => auto.rename(id, name));
            ctx.out.result(
              { ...summary, name: summary.title, method: 'browser' },
              (s) => `Renamed to "${s.title}"\n${s.url}`,
            );
          },
        );
      }),
    );

  program
    .command('copy')
    .alias('cp')
    .description(
      'Make a copy of a video (Drive API; falls back to File > Make a copy without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .option('--name <name>', 'title for the copy (default "Copy of …")')
    .option('--folder <id|url>', 'put the copy in this folder')
    .option(
      '--folder-name <name>',
      'put the copy in the folder with this exact name ("My Drive" for the top level)',
    )
    .action(
      action(
        kit,
        async (ctx, idArg: string, flags: { name?: string; folder?: string; folderName?: string }) => {
          const id = parseVidId(idArg);
          if (flags.folder && flags.folderName)
            throw new UsageError('Pass either --folder or --folder-name, not both.');
          await viaDriveOrBrowser(
            ctx,
            'copying',
            async (drive) => {
              const folderId = flags.folder
                ? parseFolderId(flags.folder)
                : flags.folderName
                  ? await drive.folderIdByName(flags.folderName)
                  : undefined;
              const spinner = ctx.out.spinner('Copying…');
              const copy = await drive
                .copy(id, {
                  ...(flags.name ? { name: flags.name } : {}),
                  ...(folderId ? { folderId } : {}),
                })
                .finally(() => spinner.stop());
              ctx.out.result(
                { ...copy, method: 'drive-api' },
                (f) => `Created "${f.name}" (${f.id})\n${f.url}`,
              );
            },
            async () => {
              if (flags.folder && parseFolderId(flags.folder) !== 'root') {
                throw new UsageError(
                  'Without a Drive API login, name the destination folder instead of its ID.',
                  {
                    hint: [
                      'Use --folder-name "<folder name>",',
                      'or sign in to the Drive API: gvids auth login',
                    ],
                  },
                );
              }
              const folderName = flags.folderName ?? (flags.folder ? 'My Drive' : undefined);
              const copy = await withAutomation(ctx, 'Copying', (auto) =>
                auto.copy(id, {
                  ...(flags.name ? { name: flags.name } : {}),
                  ...(folderName ? { folderName } : {}),
                }),
              );
              ctx.out.result(
                { ...copy, method: 'browser' },
                (f) => `Created "${f.name}" (${f.id})\n${f.url}`,
              );
            },
          );
        },
      ),
    );

  program
    .command('move')
    .alias('mv')
    .description(
      'Move a video to another Drive folder (Drive API; falls back to File > Move without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('[folder]', 'destination folder ID or URL ("root" for My Drive)')
    .option('--folder-name <name>', 'destination folder by its exact name ("My Drive" for the top level)')
    .action(
      action(
        kit,
        async (ctx, idArg: string, folderArg: string | undefined, flags: { folderName?: string }) => {
          const id = parseVidId(idArg);
          if (Boolean(folderArg) === Boolean(flags.folderName)) {
            throw new UsageError(
              'Give the destination as a folder ID/URL or with --folder-name (exactly one).',
            );
          }
          await viaDriveOrBrowser(
            ctx,
            'moving',
            async (drive) => {
              const folderId = folderArg
                ? parseFolderId(folderArg)
                : await drive.folderIdByName(flags.folderName!);
              const file = await drive.move(id, folderId);
              ctx.out.result(
                { ...file, method: 'drive-api' },
                (f) => `Moved "${f.name}" to folder ${f.parents.join(', ')}`,
              );
            },
            async () => {
              const folderName =
                flags.folderName ?? (parseFolderId(folderArg!) === 'root' ? 'My Drive' : undefined);
              if (!folderName) {
                throw new UsageError(
                  'Without a Drive API login, name the destination folder instead of its ID.',
                  {
                    hint: [
                      'Use --folder-name "<folder name>",',
                      'or sign in to the Drive API: gvids auth login',
                    ],
                  },
                );
              }
              const summary = await withAutomation(ctx, 'Moving', (auto) => auto.move(id, folderName));
              ctx.out.result(
                { ...summary, name: summary.title, folder: folderName, method: 'browser' },
                (s) => `Moved "${s.title}" to "${s.folder}".`,
              );
            },
          );
        },
      ),
    );

  program
    .command('trash')
    .alias('rm')
    .description(
      'Move a video to the trash, recoverable for 30 days (Drive API; falls back to the editor without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        await viaDriveOrBrowser(
          ctx,
          'moving it to the trash',
          async (drive) => {
            const current = await drive.get(id);
            await ctx.confirm(`Move "${current.name}" to the trash?`, `trash "${current.name}"`);
            const file = await drive.setTrashed(id, true);
            ctx.out.result(
              { ...file, method: 'drive-api' },
              (f) => `Moved "${f.name}" to the trash. Undo with: gvids restore ${f.id}`,
            );
          },
          async () => {
            const result = await withAutomation(ctx, 'Moving to trash', async (auto, control) => {
              const editor = await auto.editor(id, { allowTrashed: true });
              const title = await editor.title();
              await control.confirm(`Move "${title}" to the trash?`, `trash "${title}"`);
              return auto.trash(id);
            });
            ctx.out.result({ ...result, name: result.title, method: 'browser' }, (r) =>
              !r.savedToDrive
                ? `"${r.title}" was never saved to Drive (Vids saves a new video at its first edit): there is nothing to trash.`
                : r.changed
                  ? `Moved "${r.title}" to the trash. Undo with: gvids restore ${r.id}`
                  : `"${r.title}" was already in the trash.`,
            );
          },
        );
      }),
    );

  program
    .command('restore')
    .description(
      'Restore a video from the trash (Drive API; falls back to the editor without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        await viaDriveOrBrowser(
          ctx,
          'restoring it',
          async (drive) => {
            const file = await drive.setTrashed(id, false);
            ctx.out.result({ ...file, method: 'drive-api' }, (f) => `Restored "${f.name}".`);
          },
          async () => {
            const result = await withAutomation(ctx, 'Restoring', (auto) => auto.restore(id));
            ctx.out.result({ ...result, name: result.title, method: 'browser' }, (r) =>
              r.changed ? `Restored "${r.title}".` : `"${r.title}" is not in the trash.`,
            );
          },
        );
      }),
    );

  program
    .command('delete')
    .description('Permanently delete a video (cannot be undone; prefer `gvids trash`)')
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const drive = await ctx.drive();
        const id = parseVidId(idArg);
        const current = await drive.get(id);
        await ctx.confirm(
          `Permanently delete "${current.name}"? This cannot be undone.`,
          `permanently delete "${current.name}"`,
        );
        const deleted = await drive.deletePermanently(id);
        ctx.out.result(
          { deleted: true, id: deleted.id, name: deleted.name },
          (d) => `Permanently deleted "${d.name}".`,
        );
      }),
    );

  program
    .command('thumbnail')
    .description(
      'Save a video thumbnail: the Drive thumbnail (Drive API), or a scene as the editor draws it (--scene, or without an OAuth login)',
    )
    .argument('<id>', 'video ID or URL')
    .argument('[output]', 'output file (default: <title>.png)')
    .option('--size <px>', 'longest edge in pixels (e.g. 1280)')
    .option('--scene <n>', 'capture this scene from the editor (1-based) instead of the Drive thumbnail')
    .option('--overwrite', 'replace an existing file')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          output: string | undefined,
          flags: { size?: string; scene?: string; overwrite?: boolean },
        ) => {
          const id = parseVidId(idArg);
          const size = flags.size ? parsePositiveInt(flags.size, '--size') : undefined;
          const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
          const capture = async (): Promise<void> => {
            const r = await withAutomation(ctx, `Capturing scene ${scene ?? 1}`, async (auto) => {
              const title = await (await auto.editor(id)).title();
              const target = path.resolve(ctx.io.cwd, output ?? `${sanitizeFileName(title)}.png`);
              if (!flags.overwrite && (await pathExists(target))) {
                throw new UsageError(`${target} already exists.`, {
                  hint: 'Pass --overwrite to replace it.',
                });
              }
              const png = await auto.sceneImage(id, scene ?? 1, size);
              await fs.mkdir(path.dirname(target), { recursive: true });
              await fs.writeFile(target, png);
              return { path: target, bytes: png.length, scene: scene ?? 1 };
            });
            ctx.out.result(
              { id, ...r, method: 'browser' },
              (d) => `Saved: ${d.path} (${formatBytes(d.bytes)})`,
            );
          };
          if (scene !== undefined) return capture();
          await viaDriveOrBrowser(
            ctx,
            'capturing the first scene',
            async (drive) => {
              const file = await drive.get(id);
              if (!file.thumbnailLink) {
                throw new UsageError('Drive has no thumbnail for this video yet.', {
                  hint: [
                    'Thumbnails appear after the video has content and has been saved.',
                    `Or capture a scene from the editor: gvids thumbnail ${id} --scene 1`,
                  ],
                });
              }
              const target = output ?? `${sanitizeFileName(file.name)}.png`;
              const result = await downloadThumbnail(
                drive.transport,
                file.thumbnailLink,
                path.resolve(ctx.io.cwd, target),
                {
                  ...(size ? { size } : {}),
                  ...(flags.overwrite ? { overwrite: true } : {}),
                },
              );
              ctx.out.result(
                { ...result, method: 'drive-api' },
                (res) => `Saved: ${res.path} (${formatBytes(res.bytes)})`,
              );
            },
            capture,
          );
        },
      ),
    );
}
