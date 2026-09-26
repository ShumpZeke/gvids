import { Argument, type Command } from 'commander';
import { UsageError } from '../../errors/errors.js';
import { parsePositiveInt } from '../../utils/input.js';
import { VIDEO_FORMATS, type SceneInfo, type VideoFormat } from '../../vids/types.js';
import { parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { action, type Kit } from '../kit.js';
import { addTransitionCommand } from './design.js';
import { renderTable } from '../output/format.js';

export function renderScenes(scenes: SceneInfo[]): string {
  if (scenes.length === 0) return 'No scenes.';
  return renderTable(scenes, [
    { header: '#', value: (s) => String(s.index), align: 'right' },
    {
      header: 'SECS',
      value: (s) => (s.durationSeconds !== undefined ? s.durationSeconds.toFixed(1) : '-'),
      align: 'right',
    },
    { header: 'TRANSITION', value: (s) => s.transitionIn ?? '-' },
    { header: 'TEXT', value: (s) => s.text ?? '', maxWidth: 50 },
    {
      header: 'AUDIO',
      value: (s) => s.clips.map((c) => `${c.speaker ?? c.kind}: ${c.title ?? ''}`).join('; '),
      maxWidth: 40,
    },
  ]);
}

export function registerSceneCommands(program: Command, kit: Kit): void {
  const scene = program.command('scene').description('List and edit scenes in a video (browser)');

  scene
    .command('list')
    .alias('ls')
    .description('List scenes with duration, transition, on-screen text and narration')
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const scenes = await withAutomation(ctx, 'Reading scenes', (auto) => auto.scenes(id));
        ctx.out.result({ id, count: scenes.length, scenes }, (d) => renderScenes(d.scenes));
      }),
    );

  scene
    .command('add')
    .description('Add a blank scene (at the end, or after scene N)')
    .argument('<id>', 'video ID or URL')
    .option('--after <n>', 'insert after this scene')
    .action(
      action(kit, async (ctx, idArg: string, flags: { after?: string }) => {
        const id = parseVidId(idArg);
        const after = flags.after ? parsePositiveInt(flags.after, '--after') : undefined;
        const r = await withAutomation(ctx, 'Adding scene', (auto) => auto.addScene(id, after));
        ctx.out.result({ id, ...r }, (d) => `Added scene ${d.index} (now ${d.scenes} scenes).`);
      }),
    );

  scene
    .command('duplicate')
    .description('Duplicate a scene (the copy goes right after it)')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number')
    .action(
      action(kit, async (ctx, idArg: string, n: string) => {
        const id = parseVidId(idArg);
        const r = await withAutomation(ctx, 'Duplicating scene', (auto) =>
          auto.duplicateScene(id, parsePositiveInt(n, 'scene')),
        );
        ctx.out.result(
          { id, ...r },
          (d) => `Duplicated scene ${n} → scene ${d.index} (now ${d.scenes} scenes).`,
        );
      }),
    );

  scene
    .command('delete')
    .description('Delete a scene')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number')
    .action(
      action(kit, async (ctx, idArg: string, n: string) => {
        const id = parseVidId(idArg);
        const sceneNo = parsePositiveInt(n, 'scene');
        await ctx.confirm(
          `Delete scene ${sceneNo}? (Undo is available in the Vids editor history.)`,
          `delete scene ${sceneNo}`,
        );
        const r = await withAutomation(ctx, 'Deleting scene', (auto) => auto.deleteScene(id, sceneNo));
        ctx.out.result({ id, ...r }, (d) => `Deleted scene ${d.deleted} (now ${d.scenes} scenes).`);
      }),
    );

  scene
    .command('move')
    .description('Move a scene to a new position')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number to move')
    .option('--before <n>', 'place it before this scene')
    .option('--after <n>', 'place it after this scene')
    .option('--to <n>', 'final position (1-based)')
    .action(
      action(
        kit,
        async (ctx, idArg: string, n: string, flags: { before?: string; after?: string; to?: string }) => {
          const id = parseVidId(idArg);
          const from = parsePositiveInt(n, 'scene');
          const given = [flags.before, flags.after, flags.to].filter(Boolean).length;
          if (given !== 1) throw new UsageError('Specify exactly one of --before, --after, --to.');
          let to: number;
          if (flags.to) to = parsePositiveInt(flags.to, '--to');
          else if (flags.before) {
            const b = parsePositiveInt(flags.before, '--before');
            to = from < b ? b - 1 : b;
          } else {
            const a = parsePositiveInt(flags.after!, '--after');
            to = from > a ? a + 1 : a;
          }
          const r = await withAutomation(ctx, 'Moving scene', (auto) => auto.moveScene(id, from, to));
          ctx.out.result({ id, ...r }, (d) => `Moved scene ${d.from} to position ${d.to}.`);
        },
      ),
    );

  scene
    .command('duration')
    .description('Set a scene’s length by dragging its timeline edge (experimental)')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number')
    .requiredOption('--seconds <n>', 'new length in seconds, e.g. 8 or 6.5')
    .action(
      action(kit, async (ctx, idArg: string, n: string, flags: { seconds: string }) => {
        const id = parseVidId(idArg);
        const seconds = Number(flags.seconds);
        if (!Number.isFinite(seconds) || seconds <= 0)
          throw new UsageError('--seconds must be a positive number.');
        const r = await withAutomation(ctx, 'Changing scene duration', (auto) =>
          auto.sceneDuration(id, parsePositiveInt(n, 'scene'), seconds),
        );
        ctx.out.result({ id, ...r }, (d) => `Scene ${d.scene} is now ${d.seconds.toFixed(1)}s.`);
      }),
    );

  scene
    .command('background')
    .description('Set a scene’s solid background color')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number')
    .requiredOption('--color <hex|name>', 'hex like "#101010" or a palette name like "black"')
    .action(
      action(kit, async (ctx, idArg: string, n: string, flags: { color: string }) => {
        const id = parseVidId(idArg);
        const r = await withAutomation(ctx, 'Setting background', (auto) =>
          auto.sceneBackground(id, parsePositiveInt(n, 'scene'), flags.color),
        );
        ctx.out.result({ id, ...r }, (d) => `Scene ${d.scene} background set to ${d.color}.`);
      }),
    );

  addTransitionCommand(scene, kit);

  program
    .command('format')
    .description('Show or change the video format (landscape 16:9, portrait 9:16, square 1:1)')
    .argument('<id>', 'video ID or URL')
    .addArgument(new Argument('[format]', 'new format').choices([...VIDEO_FORMATS]))
    .action(
      action(kit, async (ctx, idArg: string, format: VideoFormat | undefined) => {
        const id = parseVidId(idArg);
        if (!format) {
          const r = await withAutomation(ctx, 'Reading format', (auto) => auto.getFormat(id));
          ctx.out.result({ id, ...r }, (d) => `${d.label}  (available: ${d.available.join(', ')})`);
          return;
        }
        const r = await withAutomation(ctx, 'Changing format', (auto) => auto.setFormat(id, format));
        ctx.out.result({ id, ...r }, (d) => `Video size is now ${d.label}.`);
      }),
    );
}
