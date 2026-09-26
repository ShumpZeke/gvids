import type { Command } from 'commander';
import { UsageError } from '../../errors/errors.js';
import type { VidComment } from '../../google/collaboration.js';
import { readTextInput } from '../../utils/input.js';
import { parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { action, type Kit } from '../kit.js';
import { formatDate, renderTable } from '../output/format.js';

function renderComments(comments: VidComment[]): string {
  if (comments.length === 0) return 'No open comments.';
  return comments
    .map((c) => {
      const head = `[${c.id}]${c.resolved ? ' (resolved)' : ''} ${c.author ?? '?'}, ${formatDate(c.createdTime)}`;
      const quote = c.quotedText ? `\n  > ${c.quotedText}` : '';
      const replies = c.replies
        .filter((r) => r.content)
        .map((r) => `\n  ↳ ${r.author ?? '?'}: ${r.content}`)
        .join('');
      return `${head}${quote}\n  ${c.content}${replies}`;
    })
    .join('\n\n');
}

export function registerHistoryCommands(program: Command, kit: Kit): void {
  const versions = program
    .command('versions')
    .description('Version history of a video (list: Drive API; name: editor)');

  versions
    .command('list')
    .alias('ls')
    .description('List saved versions (Drive revisions), oldest first')
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const list = await (await ctx.collaboration()).revisions(id);
        ctx.out.result(
          {
            id,
            count: list.length,
            versions: list,
            next: [`gvids download ${id} <file.mp4> --revision <id>`],
          },
          (d) =>
            d.versions.length === 0
              ? 'No versions.'
              : renderTable(d.versions, [
                  { header: 'VERSION', value: (v) => v.id },
                  { header: 'SAVED', value: (v) => formatDate(v.modifiedTime) },
                  { header: 'BY', value: (v) => v.modifiedBy ?? '-', maxWidth: 32 },
                ]),
        );
      }),
    );

  versions
    .command('name')
    .description('Name the current version (File > Version history > Name current version)')
    .argument('<id>', 'video ID or URL')
    .argument('<name>', 'version name')
    .action(
      action(kit, async (ctx, idArg: string, rawName: string) => {
        const id = parseVidId(idArg);
        const name = rawName.trim();
        if (!name) throw new UsageError('The version name must not be empty.');
        const summary = await withAutomation(ctx, 'Naming the current version', (auto) =>
          auto.nameVersion(id, name),
        );
        ctx.out.result(
          { ...summary, version: name, method: 'browser' },
          (d) => `Named the current version of "${d.title}": ${d.version}`,
        );
      }),
    );

  const comments = program.command('comments').description('Read and write comments on a video (Drive API)');

  comments
    .command('list')
    .alias('ls')
    .description('List open comments with their replies')
    .argument('<id>', 'video ID or URL')
    .option('--all', 'include resolved comments')
    .action(
      action(kit, async (ctx, idArg: string, flags: { all?: boolean }) => {
        const id = parseVidId(idArg);
        const list = await (await ctx.collaboration()).comments(id, { includeResolved: Boolean(flags.all) });
        ctx.out.result({ id, count: list.length, comments: list }, (d) => renderComments(d.comments));
      }),
    );

  comments
    .command('add')
    .description('Add a comment to the video (file-level; Vids shows it in the comments panel)')
    .argument('<id>', 'video ID or URL')
    .argument('<text>', 'comment text ("-" reads stdin)')
    .action(
      action(kit, async (ctx, idArg: string, text: string) => {
        const id = parseVidId(idArg);
        const content = await readTextInput(text, {
          cwd: ctx.io.cwd,
          stdin: ctx.io.stdin,
          label: 'text',
          fields: ['text', 'content'],
        });
        const added = await (await ctx.collaboration()).add(id, content);
        ctx.out.result({ id, comment: added }, (d) => `Added comment ${d.comment.id}.`);
      }),
    );

  comments
    .command('reply')
    .description('Reply to a comment')
    .argument('<id>', 'video ID or URL')
    .argument('<comment-id>', 'comment ID (from comments list)')
    .argument('<text>', 'reply text ("-" reads stdin)')
    .action(
      action(kit, async (ctx, idArg: string, commentId: string, text: string) => {
        const id = parseVidId(idArg);
        const content = await readTextInput(text, {
          cwd: ctx.io.cwd,
          stdin: ctx.io.stdin,
          label: 'text',
          fields: ['text', 'content'],
        });
        const reply = await (await ctx.collaboration()).reply(id, commentId, content);
        ctx.out.result({ id, commentId, reply }, (d) => `Replied to comment ${d.commentId}.`);
      }),
    );

  comments
    .command('resolve')
    .description('Mark a comment as resolved (or --reopen it)')
    .argument('<id>', 'video ID or URL')
    .argument('<comment-id>', 'comment ID (from comments list)')
    .option('--reopen', 'reopen a resolved comment instead')
    .option('--note <text>', 'closing note added as a reply')
    .action(
      action(
        kit,
        async (ctx, idArg: string, commentId: string, flags: { reopen?: boolean; note?: string }) => {
          const id = parseVidId(idArg);
          const r = await (await ctx.collaboration()).setResolved(id, commentId, !flags.reopen, flags.note);
          ctx.out.result({ id, ...r }, (d) =>
            d.changed
              ? `${d.comment.resolved ? 'Resolved' : 'Reopened'} comment ${d.comment.id}.`
              : `Comment ${d.comment.id} was already ${d.comment.resolved ? 'resolved' : 'open'}.`,
          );
        },
      ),
    );
}
