import type { Command } from 'commander';
import { CONFIG_KEYS } from '../../config/config.js';
import { action, type Kit } from '../kit.js';
import { renderTable } from '../output/format.js';

function getPath(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function registerConfigCommands(program: Command, kit: Kit): void {
  const config = program
    .command('config')
    .description('View and change gvids settings (~/.gvids/config.json)');

  config
    .command('list')
    .description('Show every setting with its effective value')
    .action(
      action(kit, async (ctx) => {
        const effective = ctx.configStore.effective();
        const explicit = new Set(ctx.configStore.explicitKeys());
        const rows = Object.entries(CONFIG_KEYS).map(([key, info]) => ({
          key,
          value: getPath(effective, key) ?? null,
          source: explicit.has(key)
            ? 'config'
            : info.env && ctx.io.env[info.env]
              ? `env ${info.env}`
              : 'default',
          description: info.description,
        }));
        ctx.out.result({ file: ctx.configStore.file, settings: rows }, (d) =>
          [
            renderTable(d.settings, [
              { header: 'KEY', value: (r) => r.key },
              { header: 'VALUE', value: (r) => (r.value === null ? '-' : String(r.value)), maxWidth: 40 },
              { header: 'SOURCE', value: (r) => r.source },
            ]),
            '',
            `File: ${d.file}`,
          ].join('\n'),
        );
      }),
    );

  config
    .command('get')
    .description('Print one setting')
    .argument('<key>', 'dotted key, e.g. browser.headless')
    .action(
      action(kit, async (ctx, key: string) => {
        const value = ctx.configStore.get(key);
        ctx.out.result({ key, value: value ?? null }, (d) => (d.value === null ? '' : String(d.value)));
      }),
    );

  config
    .command('set')
    .description('Change a setting')
    .argument('<key>', 'dotted key, e.g. browser.headless')
    .argument('<value>', 'new value')
    .action(
      action(kit, async (ctx, key: string, value: string) => {
        const stored = await ctx.configStore.set(key, value);
        ctx.out.result({ key, value: stored }, (d) => `${d.key} = ${String(d.value)}`);
      }),
    );

  config
    .command('unset')
    .description('Remove a setting (reverts to the default)')
    .argument('<key>', 'dotted key')
    .action(
      action(kit, async (ctx, key: string) => {
        const removed = await ctx.configStore.unset(key);
        ctx.out.result({ key, removed }, (d) =>
          d.removed ? `${d.key} reset to default` : `${d.key} was not set`,
        );
      }),
    );

  config
    .command('reset')
    .description('Delete all settings')
    .action(
      action(kit, async (ctx) => {
        await ctx.confirm('Reset all gvids settings to defaults?', 'reset all settings');
        await ctx.configStore.reset();
        ctx.out.result({ reset: true }, () => 'All settings reset to defaults.');
      }),
    );

  config
    .command('path')
    .description('Print the configuration directory and file paths')
    .action(
      action(kit, async (ctx) => {
        const p = ctx.paths;
        ctx.out.result(
          {
            home: p.home,
            config: p.configFile,
            browserProfile: p.browserProfileDir,
            jobs: p.jobsDir,
            tasks: p.tasksDir,
            cache: p.cacheDir,
            debug: ctx.debugDir,
          },
          (d) =>
            Object.entries(d)
              .map(([k, v]) => `${k.padEnd(15)} ${v}`)
              .join('\n'),
        );
      }),
    );
}
