import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Option, type Command } from 'commander';
import type { Page } from 'playwright';
import { UsageError } from '../../errors/errors.js';
import { redactHtml, redactPersonal } from '../../utils/redact.js';
import type { VidsEditor } from '../../browser/pages/editor-page.js';
import type { InsertionTool } from '../../browser/selectors/editor.js';
import { EDITOR_LABELS } from '../../browser/selectors/editor.js';
import { parseVidId, vidsHomeUrl } from '../../vids/urls.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';
import { renderTable } from '../output/format.js';

interface InspectedElement {
  role: string;
  name: string;
  tag: string;
  disabled?: boolean;
  pressed?: string;
  expanded?: string;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function debugDir(ctx: CommandContext): Promise<string> {
  const dir = ctx.debugDir;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Opens the editor (or Vids home) and runs `fn` with the page. */
async function withPage<T>(
  ctx: CommandContext,
  id: string | undefined,
  fn: (page: Page, editor: VidsEditor | undefined) => Promise<T>,
): Promise<T> {
  const session = await ctx.browserSession();
  try {
    const { VidsEditor: VidsEditorClass } = await import('../../browser/pages/editor-page.js');
    const page = await session.firstPage();
    const opts = {
      hl: ctx.config.browser.locale,
      authuser: ctx.config.browser.authuser,
      timeoutMs: ctx.config.browser.timeout,
      diagnostics: session.diagnostics,
      logger: ctx.logger,
    };
    let editor: VidsEditor | undefined;
    if (id) editor = await VidsEditorClass.open(page, id, opts);
    else
      await page.goto(vidsHomeUrl({ hl: opts.hl, authuser: opts.authuser }), {
        waitUntil: 'domcontentloaded',
      });
    const result = await fn(page, editor);
    await editor?.restoreUi().catch(() => undefined);
    return result;
  } finally {
    await session.close();
  }
}

async function collectInteractive(page: Page): Promise<InspectedElement[]> {
  const raw = await page.evaluate(() => {
    const roles = new Set([
      'button',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'textbox',
      'combobox',
      'listbox',
      'option',
      'dialog',
      'alertdialog',
      'toolbar',
      'menubar',
      'menu',
      'checkbox',
      'radio',
      'slider',
      'link',
      'complementary',
      'navigation',
      'form',
      'heading',
    ]);
    const out: Array<{
      role: string;
      name: string;
      tag: string;
      disabled?: boolean;
      pressed?: string;
      expanded?: string;
    }> = [];
    for (const el of document.querySelectorAll('[role], button, input, textarea, select, a[href]')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      const role =
        el.getAttribute('role') ??
        (
          {
            BUTTON: 'button',
            INPUT: 'textbox',
            TEXTAREA: 'textbox',
            SELECT: 'combobox',
            A: 'link',
          } as Record<string, string>
        )[el.tagName] ??
        '';
      if (!roles.has(role)) continue;
      const name = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      out.push({
        role,
        name,
        tag: el.tagName.toLowerCase(),
        ...(el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled
          ? { disabled: true }
          : {}),
        ...(el.getAttribute('aria-pressed') ? { pressed: el.getAttribute('aria-pressed')! } : {}),
        ...(el.getAttribute('aria-expanded') ? { expanded: el.getAttribute('aria-expanded')! } : {}),
      });
    }
    return out;
  });
  return raw.map((e) => ({ ...e, name: redactPersonal(e.name) }));
}

export function registerDebugCommands(program: Command, kit: Kit): void {
  const debug = program
    .command('debug')
    .description('Developer tools for inspecting the live Google Vids UI');

  debug
    .command('inspect')
    .description('List visible buttons, menus, dialogs, text boxes and tabs with their accessible names')
    .argument('[id]', 'video ID or URL (default: Vids home page)')
    .option('--menus', 'also open every menu and list its items')
    .addOption(
      new Option('--panel <tool>', 'open an insertion side panel first').choices(
        Object.keys(EDITOR_LABELS.insertion),
      ),
    )
    .option('--role <role>', 'only show elements with this role')
    .action(
      action(
        kit,
        async (
          ctx,
          idArg: string | undefined,
          flags: { menus?: boolean; panel?: InsertionTool; role?: string },
        ) => {
          const id = idArg ? parseVidId(idArg) : undefined;
          if ((flags.menus || flags.panel) && !id)
            throw new UsageError('--menus and --panel need a video ID.');
          const data = await withPage(ctx, id, async (page, editor) => {
            if (flags.panel && editor) await editor.openInsertion(flags.panel);
            const menus: Record<string, Array<{ text: string; enabled: boolean }>> = {};
            if (flags.menus && editor) {
              await editor.showMenus();
              for (const top of Object.values(EDITOR_LABELS.topMenus)) {
                await page.keyboard.press('Escape');
                await page.getByRole('menubar').getByRole('menuitem', { name: top, exact: true }).click();
                await page.waitForTimeout(600);
                menus[top] = await page
                  .getByRole('menuitem')
                  .filter({ visible: true })
                  .evaluateAll((els) =>
                    els
                      .filter((e) => !e.closest('[role=menubar]'))
                      .map((e) => ({
                        text: ((e as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim(),
                        enabled: e.getAttribute('aria-disabled') !== 'true',
                      })),
                  );
                await page.keyboard.press('Escape');
              }
            }
            const elements = (await collectInteractive(page)).filter(
              (e) => !flags.role || e.role === flags.role,
            );
            return {
              url: redactPersonal(page.url().replace(/\?.*$/, '')),
              title: redactPersonal(await page.title()),
              elements,
              menus,
            };
          });
          const file = path.join(await debugDir(ctx), `inspect-${stamp()}.json`);
          await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
          ctx.out.result({ ...data, savedTo: file }, (d) =>
            [
              `${d.title}  ${d.url}`,
              '',
              renderTable(d.elements, [
                { header: 'ROLE', value: (e) => e.role },
                { header: 'NAME', value: (e) => e.name, maxWidth: 70 },
                {
                  header: 'STATE',
                  value: (e) =>
                    [
                      e.disabled ? 'disabled' : '',
                      e.pressed ? `pressed=${e.pressed}` : '',
                      e.expanded ? `expanded=${e.expanded}` : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                },
              ]),
              ...Object.entries(d.menus).flatMap(([menu, items]) => [
                '',
                `${menu} menu:`,
                ...items.map((i) => `  ${i.enabled ? ' ' : '✗'} ${i.text}`),
              ]),
              '',
              `Saved: ${d.savedTo}`,
            ].join('\n'),
          );
        },
      ),
    );

  debug
    .command('screenshot')
    .description('Save a screenshot of the editor (or Vids home)')
    .argument('[id]', 'video ID or URL')
    .option('--out <file>', 'output PNG path')
    .option('--full', 'full page')
    .action(
      action(kit, async (ctx, idArg: string | undefined, flags: { out?: string; full?: boolean }) => {
        const file = flags.out
          ? path.resolve(ctx.io.cwd, flags.out)
          : path.join(await debugDir(ctx), `screenshot-${stamp()}.png`);
        await withPage(ctx, idArg ? parseVidId(idArg) : undefined, async (page) => {
          await page.screenshot({ path: file, fullPage: Boolean(flags.full) });
        });
        ctx.out.result({ path: file }, (d) => `Saved: ${d.path}`);
      }),
    );

  debug
    .command('page-html')
    .description('Save the page HTML (inline scripts removed; e-mail addresses and tokens redacted)')
    .argument('[id]', 'video ID or URL')
    .option('--out <file>', 'output path')
    .action(
      action(kit, async (ctx, idArg: string | undefined, flags: { out?: string }) => {
        const file = flags.out
          ? path.resolve(ctx.io.cwd, flags.out)
          : path.join(await debugDir(ctx), `page-${stamp()}.html`);
        const html = await withPage(ctx, idArg ? parseVidId(idArg) : undefined, (page) => page.content());
        await fs.writeFile(file, redactHtml(html), 'utf8');
        ctx.out.result({ path: file, bytes: html.length }, (d) => `Saved: ${d.path}`);
      }),
    );

  debug
    .command('aria')
    .description('Print the ARIA snapshot (accessibility tree) of the editor or home page')
    .argument('[id]', 'video ID or URL')
    .action(
      action(kit, async (ctx, idArg: string | undefined) => {
        const snapshot = await withPage(ctx, idArg ? parseVidId(idArg) : undefined, (page) =>
          page.locator('body').ariaSnapshot(),
        );
        const file = path.join(await debugDir(ctx), `aria-${stamp()}.yml`);
        await fs.writeFile(file, redactPersonal(snapshot), 'utf8');
        ctx.out.result(
          { path: file, snapshot: redactPersonal(snapshot) },
          (d) => `${d.snapshot}\n\nSaved: ${d.path}`,
        );
      }),
    );

  const trace = debug
    .command('trace')
    .description('Playwright traces recorded with --debug (or debug.trace=true)');

  trace
    .command('list')
    .description('List recorded traces')
    .action(
      action(kit, async (ctx) => {
        const dir = await debugDir(ctx);
        const files = (await fs.readdir(dir))
          .filter((f) => f.startsWith('trace-') && f.endsWith('.zip'))
          .sort()
          .reverse();
        const traces = await Promise.all(
          files.map(async (f) => ({
            file: path.join(dir, f),
            bytes: (await fs.stat(path.join(dir, f))).size,
          })),
        );
        ctx.out.result({ directory: dir, traces }, (d) =>
          d.traces.length === 0
            ? `No traces in ${d.directory}. Record one by adding --debug to a browser command.`
            : d.traces.map((t) => t.file).join('\n'),
        );
      }),
    );

  trace
    .command('show')
    .description('Open a trace in the Playwright trace viewer')
    .argument('[file]', 'trace zip (default: the newest)')
    .action(
      action(kit, async (ctx, file: string | undefined) => {
        const dir = await debugDir(ctx);
        let target = file ? path.resolve(ctx.io.cwd, file) : undefined;
        if (!target) {
          const newest = (await fs.readdir(dir))
            .filter((f) => f.startsWith('trace-') && f.endsWith('.zip'))
            .sort()
            .pop();
          if (!newest)
            throw new UsageError('No traces recorded yet. Add --debug to a browser command first.');
          target = path.join(dir, newest);
        }
        const child = spawn(process.execPath, [playwrightCli(), 'show-trace', target], { stdio: 'inherit' });
        await new Promise((resolve) => child.on('exit', resolve));
        ctx.out.result({ trace: target }, () => '');
      }),
    );
}

/** Path of the Playwright CLI script (shipped as cli.js next to its package.json). */
function playwrightCli(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
}
