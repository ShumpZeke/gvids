import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import YAML from 'yaml';
import { JobStore } from '../../automation/job.js';
import { planWorkflow, loadWorkflow } from '../../automation/workflow.js';
import { UsageError } from '../../errors/errors.js';
import { readStudioProject, CAMERA_MOVES, LOOK_PRESETS } from '../../studio/project.js';
import { executeJob, renderJob } from './jobs.js';
import { action, type Kit } from '../kit.js';

export function registerStudioCommands(program: Command, kit: Kit): void {
  const studio = program.command('studio').description('Cinematic shot-based AI video and image workflows');
  studio.command('presets').description('List creative camera and visual directions')
    .action(action(kit, async (ctx) => ctx.out.result({ cameras: CAMERA_MOVES, looks: LOOK_PRESETS })));
  studio.command('plan').description('Validate creative brief without Google requests').argument('<file>')
    .action(action(kit, async (ctx, file: string) => {
      const loaded = await readStudioProject(path.resolve(ctx.io.cwd, file));
      ctx.out.result({ name: loaded.project.name, shots: loaded.project.shots.length,
        workflow: loaded.plan.workflow, steps: loaded.plan.steps, warnings: loaded.plan.warnings });
    }));
  studio.command('compile').description('Compile brief into standard gvids YAML workflow').argument('<file>')
    .option('-o, --output <file>', 'output workflow file')
    .action(action(kit, async (ctx, file: string, flags: { output?: string }) => {
      const loaded = await readStudioProject(path.resolve(ctx.io.cwd, file));
      const yaml = YAML.stringify(loaded.plan.workflow);
      if (!flags.output) { ctx.out.result({ yaml, workflow: loaded.plan.workflow }); return; }
      const target = path.resolve(ctx.io.cwd, flags.output);
      if (target === loaded.path) throw new UsageError('Output cannot overwrite the creative brief.');
      const exists = await fs.stat(target).then(() => true).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      if (exists) await ctx.confirm('Overwrite existing workflow?', 'overwrite ' + target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, yaml, { encoding: 'utf8', flag: exists ? 'w' : 'wx' });
      ctx.out.result({ path: target, steps: loaded.plan.steps.length });
    }));
  studio.command('run').description('Run a creative brief as a resumable job').argument('<file>')
    .action(action(kit, async (ctx, file: string) => {
      const loaded = await readStudioProject(path.resolve(ctx.io.cwd, file));
      if (ctx.globals.dryRun) {
        ctx.out.result({ dryRun: true, name: loaded.project.name, steps: loaded.plan.steps,
          warnings: loaded.plan.warnings });
        return;
      }
      const dir = path.join(ctx.paths.jobsDir, 'studio-workflows');
      await fs.mkdir(dir, { recursive: true });
      const snapshot = path.join(dir, loaded.hash + '.yaml');
      const yaml = YAML.stringify(loaded.plan.workflow);
      try { await fs.writeFile(snapshot, yaml, { flag: 'wx' }); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if ((await fs.readFile(snapshot, 'utf8')) !== yaml)
          throw new UsageError('Studio workflow snapshot collision.');
      }
      const saved = await loadWorkflow(snapshot);
      const store = new JobStore(ctx.paths.jobsDir);
      const job = await store.create({
        name: saved.workflow.name, workflowFile: saved.path, workflowHash: saved.hash,
        steps: planWorkflow(saved.workflow),
      });
      ctx.out.info('Studio job ' + job.id + ' started.');
      try { ctx.out.result(await executeJob(ctx, store, job), renderJob); }
      catch (err) { ctx.out.info('Resume with: gvids job resume ' + job.id); throw err; }
    }));
}
