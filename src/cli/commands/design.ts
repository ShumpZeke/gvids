import { Argument, InvalidArgumentError, Option, type Command } from 'commander';
import { UsageError } from '../../errors/errors.js';
import {
  ANIMATED_BY,
  DIRECTIONS,
  LOOP_ANIMATIONS,
  OBJECT_ANIMATIONS,
  SCENE_ANIMATIONS,
  TRANSITION_TYPES,
  type TransitionType,
} from '../../browser/selectors/design.js';
import type { ObjectFormat } from '../../browser/pages/design.js';
import { parsePositiveInt } from '../../utils/input.js';
import { parseVidId } from '../../vids/urls.js';
import { withAutomation } from '../automation.js';
import { action, type Kit } from '../kit.js';

/** Commander argument parser for a number in [min, max]. */
export function numberIn(label: string, min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (value.trim() === '' || !Number.isFinite(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${label} must be a number from ${min} to ${max}.`);
    }
    return n;
  };
}

const anyNumber = (label: string): ((value: string) => number) => numberIn(label, -1e7, 1e7);

/** `gvids scene transition` (registered on the scene group). */
export function addTransitionCommand(scene: Command, kit: Kit): void {
  scene
    .command('transition')
    .description('Set the transition into a scene from the one before it (Scene > Transition)')
    .argument('<id>', 'video ID or URL')
    .argument('<scene>', 'scene number (2 or later)')
    .addArgument(new Argument('<type>', 'transition type').choices([...TRANSITION_TYPES]))
    .addOption(
      new Option('--duration <seconds>', 'length, 0.05 to 2.5 s').argParser(
        numberIn('--duration', 0.05, 2.5),
      ),
    )
    .addOption(new Option('--direction <dir>', 'push/slide direction').choices([...DIRECTIONS]))
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          n: string,
          type: TransitionType,
          flags: { duration?: number; direction?: string },
        ) => {
          const id = parseVidId(idArg);
          const sceneNo = parsePositiveInt(n, 'scene');
          if (sceneNo < 2)
            throw new UsageError('Transitions go into a scene from the previous one: use scene 2 or later.');
          const r = await withAutomation(ctx, 'Setting the transition', (auto) =>
            auto.transition(id, sceneNo, type, {
              ...(flags.duration !== undefined ? { duration: flags.duration } : {}),
              ...(flags.direction ? { direction: flags.direction } : {}),
            }),
          );
          ctx.out.result({ id, ...r }, (d) =>
            d.type === 'none'
              ? `Removed the transition into scene ${d.scene}.`
              : `Scene ${d.scene} now starts with a ${d.type} transition${d.duration ? ` (${d.duration}s)` : ''}.`,
          );
        },
      ),
    );
}

export function registerDesignCommands(program: Command, kit: Kit): void {
  const allTypes = [...new Set([...OBJECT_ANIMATIONS, ...LOOP_ANIMATIONS, ...SCENE_ANIMATIONS])];
  program
    .command('animate')
    .description('Animate a whole scene, or one object with --object (Format > Animation)')
    .argument('<id>', 'video ID or URL')
    .argument('<type>', 'animation type (see the note in `gvids commands animate --full`)')
    .requiredOption('--scene <n>', 'scene number')
    .option('--object <object-id>', 'animate this object (from `gvids text list`) instead of the whole scene')
    .option('--loop', 'object loop animation instead of enter & exit')
    .addOption(
      new Option('--duration <seconds>', 'length, 0.05 to 2.5 s').argParser(
        numberIn('--duration', 0.05, 2.5),
      ),
    )
    .addOption(new Option('--direction <dir>', 'direction, where the type has one').choices([...DIRECTIONS]))
    .addOption(
      new Option('--by <unit>', 'text: animate the whole box, or by paragraph, word or character').choices([
        ...ANIMATED_BY,
      ]),
    )
    .addHelpText(
      'after',
      `\nScene: ${SCENE_ANIMATIONS.join(', ')}\nObject enter & exit: ${OBJECT_ANIMATIONS.join(', ')}\nObject --loop: ${LOOP_ANIMATIONS.join(', ')}\n\nExamples:\n  gvids animate <id> playful --scene 1\n  gvids animate <id> rise --scene 2 --object <object-id> --by word --duration 1.2\n  gvids animate <id> pulse --scene 2 --object <object-id> --loop`,
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          rawType: string,
          flags: {
            scene: string;
            object?: string;
            loop?: boolean;
            duration?: number;
            direction?: string;
            by?: string;
          },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const type = rawType.trim().toLowerCase();
          const allowed: readonly string[] = flags.object
            ? flags.loop
              ? LOOP_ANIMATIONS
              : OBJECT_ANIMATIONS
            : SCENE_ANIMATIONS;
          if (!allowed.includes(type)) {
            throw new UsageError(
              `"${rawType}" is not a ${flags.object ? (flags.loop ? 'loop' : 'object') : 'scene'} animation. Choose one of: ${allowed.join(', ')}.`,
              { details: { all: allTypes } },
            );
          }
          if (flags.loop && !flags.object)
            throw new UsageError('--loop applies to objects: pass --object <object-id>.');
          const r = await withAutomation(ctx, 'Setting the animation', (auto) =>
            auto.animate(id, {
              scene,
              type,
              ...(flags.object ? { objectId: flags.object } : {}),
              ...(flags.loop ? { loop: true } : {}),
              ...(flags.duration !== undefined ? { duration: flags.duration } : {}),
              ...(flags.direction ? { direction: flags.direction } : {}),
              ...(flags.by ? { by: flags.by } : {}),
            }),
          );
          ctx.out.result({ id, ...r }, (d) =>
            d.type === 'none'
              ? `Removed the ${d.objectId ? 'object' : 'scene'} animation on scene ${d.scene}.`
              : `Scene ${d.scene}${d.objectId ? `, object ${d.objectId}` : ''}: ${d.type}${d.loop ? ' (loop)' : ''}.`,
          );
        },
      ),
    );

  const captions = program
    .command('captions')
    .description('Animated captions transcribed from the speech in a video (Insert > Captions)');

  captions
    .command('styles')
    .description('List the caption styles (numbered for --style)')
    .argument('<id>', 'video ID or URL (the captions panel is opened there)')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const styles = await withAutomation(ctx, 'Reading caption styles', (auto) => auto.captionStyles(id));
        ctx.out.result({ id, count: styles.length, styles }, (d) =>
          d.styles.map((s) => `${String(s.index).padStart(2)}. ${s.description}`).join('\n'),
        );
      }),
    );

  captions
    .command('add')
    .description('Add captions to every scene (or one with --scene); needs speech in the video')
    .argument('<id>', 'video ID or URL')
    .option('--scene <n>', 'only this scene')
    .option('--style <n>', 'caption style number (see: gvids captions styles <id>)', '1')
    .action(
      action(kit, async (ctx, idArg: string, flags: { scene?: string; style: string }) => {
        const id = parseVidId(idArg);
        const scene = flags.scene ? parsePositiveInt(flags.scene, '--scene') : undefined;
        const style = parsePositiveInt(flags.style, '--style');
        const r = await withAutomation(ctx, 'Adding captions', (auto) =>
          auto.addCaptions(id, { ...(scene ? { scene } : {}), style, timeoutMs: ctx.timeoutMs(2 * 60_000) }),
        );
        ctx.out.result(
          { id, ...(scene ? { scene } : {}), ...r },
          (d) =>
            `Captions added (${d.scope === 'all' ? 'all scenes' : `scene ${scene}`}): ${d.style.description}.`,
        );
      }),
    );

  captions
    .command('remove')
    .description('Delete all captions (More > Delete all captions)')
    .argument('<id>', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string) => {
        const id = parseVidId(idArg);
        const removed = await withAutomation(ctx, 'Removing captions', async (auto, control) => {
          const title = await (await auto.editor(id)).title();
          await control.confirm(`Delete all captions in "${title}"?`, `delete all captions in "${title}"`);
          return auto.removeCaptions(id);
        });
        ctx.out.result({ id, removed }, (d) =>
          d.removed ? 'Deleted all captions.' : 'The video had no captions.',
        );
      }),
    );

  const object = program
    .command('object')
    .description('Exact size, rotation and position of objects (Format > Format options)');

  object
    .command('get')
    .description('Read an object’s size, rotation and position (pixels, from the top left)')
    .argument('<id>', 'video ID or URL')
    .argument('<object-id>', 'object ID from `gvids text list`')
    .requiredOption('--scene <n>', 'scene number')
    .action(
      action(kit, async (ctx, idArg: string, objectId: string, flags: { scene: string }) => {
        const id = parseVidId(idArg);
        const scene = parsePositiveInt(flags.scene, '--scene');
        const format = await withAutomation(ctx, 'Reading the object layout', (auto) =>
          auto.objectFormat(id, scene, objectId),
        );
        ctx.out.result(
          { id, scene, objectId, ...format },
          (d) =>
            `x ${d.x ?? '?'} y ${d.y ?? '?'}  ${d.width ?? '?'} x ${d.height ?? '?'} px  rotation ${d.rotation ?? 0}°`,
        );
      }),
    );

  object
    .command('set')
    .description('Set an object’s size, rotation, position or drop shadow exactly')
    .argument('<id>', 'video ID or URL')
    .argument('<object-id>', 'object ID from `gvids text list`')
    .requiredOption('--scene <n>', 'scene number')
    .addOption(new Option('--x <px>', 'left edge, from the scene’s left').argParser(anyNumber('--x')))
    .addOption(new Option('--y <px>', 'top edge, from the scene’s top').argParser(anyNumber('--y')))
    .addOption(new Option('--width <px>', 'width in pixels').argParser(numberIn('--width', 1, 1e7)))
    .addOption(new Option('--height <px>', 'height in pixels').argParser(numberIn('--height', 1, 1e7)))
    .addOption(new Option('--rotation <deg>', 'rotation in degrees').argParser(anyNumber('--rotation')))
    .addOption(new Option('--flip <axis>', 'flip once').choices(['horizontal', 'vertical']))
    .option('--lock-aspect', 'keep the aspect ratio when resizing')
    .option('--no-lock-aspect', 'allow width and height to change independently')
    .option('--shadow', 'turn the drop shadow on')
    .option('--no-shadow', 'turn the drop shadow off')
    .addHelpText(
      'after',
      '\nExample:\n  gvids object set <id> <object-id> --scene 2 --x 100 --y 80 --width 640',
    )
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string,
          objectId: string,
          flags: ObjectFormat & { scene: string; flip?: 'horizontal' | 'vertical' },
        ) => {
          const id = parseVidId(idArg);
          const scene = parsePositiveInt(flags.scene, '--scene');
          const want: ObjectFormat & { flip?: 'horizontal' | 'vertical' } = {};
          for (const k of [
            'x',
            'y',
            'width',
            'height',
            'rotation',
            'lockAspect',
            'shadow',
            'flip',
          ] as const) {
            if (flags[k] !== undefined) (want as Record<string, unknown>)[k] = flags[k];
          }
          if (Object.keys(want).length === 0) {
            throw new UsageError(
              'Nothing to change: pass --x, --y, --width, --height, --rotation, --flip or --shadow.',
            );
          }
          const after = await withAutomation(ctx, 'Changing the object layout', (auto) =>
            auto.setObjectFormat(id, scene, objectId, want),
          );
          ctx.out.result(
            { id, scene, objectId, ...after },
            (d) =>
              `Object ${d.objectId}: x ${d.x ?? '?'} y ${d.y ?? '?'}  ${d.width ?? '?'} x ${d.height ?? '?'} px  rotation ${d.rotation ?? 0}°`,
          );
        },
      ),
    );
}
