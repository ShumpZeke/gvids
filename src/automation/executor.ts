import fs from 'node:fs/promises';
import path from 'node:path';
import type { VidsAutomation, CreateMode } from '../browser/operations/automation.js';
import type { BrowserSession } from '../browser/session.js';
import type { GvidsConfig } from '../config/config.js';
import { AuthError, UsageError, WorkflowError } from '../errors/errors.js';
import type { DriveService } from '../google/drive.js';
import { downloadRendered } from '../google/downloads.js';
import type { PermissionsService, ShareTarget } from '../google/permissions.js';
import { pathExists } from '../utils/fs.js';
import type { Logger } from '../utils/logger.js';
import type { VideoFormat } from '../vids/types.js';
import { parseDocumentId, parseFolderId, parsePresentationId, parseVidId, vidEditUrl } from '../vids/urls.js';
import type { JobRecord, StepRecord } from './job.js';
import type { StepExecutor, StepResult } from './runner.js';

/** What the executor needs from its host (the CLI's CommandContext satisfies this). */
export interface ServiceAccess {
  config: GvidsConfig;
  logger: Logger;
  drive(): Promise<DriveService>;
  permissions(): Promise<PermissionsService>;
  browserSession(): Promise<BrowserSession>;
  timeoutMs(defaultMs: number): number;
}

type P = Record<string, unknown>;
const str = (p: P, k: string): string => {
  const v = p[k];
  if (typeof v !== 'string' || !v) throw new WorkflowError(`Step parameter "${k}" is missing.`);
  return v;
};
const num = (p: P, k: string): number => {
  const v = p[k];
  if (typeof v !== 'number') throw new WorkflowError(`Step parameter "${k}" must be a number.`);
  return v;
};
const opt = (p: P, k: string): string | undefined =>
  typeof p[k] === 'string' && p[k] ? (p[k] as string) : undefined;

/**
 * Executes workflow steps against Google: Drive steps through the API,
 * editor steps through one shared browser session (started lazily).
 */
export class LiveExecutor implements StepExecutor {
  private session: BrowserSession | undefined;
  private automation: VidsAutomation | undefined;

  constructor(
    private readonly services: ServiceAccess,
    /** Directory relative paths in the workflow are resolved against. */
    private readonly baseDir: string,
  ) {}

  private file(p: string): string {
    return path.resolve(this.baseDir, p);
  }

  private async auto(): Promise<VidsAutomation> {
    if (!this.automation) {
      this.session = await this.services.browserSession();
      const { VidsAutomation } = await import('../browser/operations/automation.js');
      this.automation = new VidsAutomation(this.session, this.services.config, this.services.logger, {
        label: 'Running a workflow',
        lockTimeoutMs: this.services.timeoutMs(10 * 60_000),
      });
    }
    return this.automation;
  }

  private vid(job: JobRecord): string {
    if (!job.vidId) throw new WorkflowError('No video yet: the create/open step has not completed.');
    return job.vidId;
  }

  /** Drive when OAuth is configured; otherwise undefined (callers fall back to the editor). */
  private async driveOrUndefined(): Promise<DriveService | undefined> {
    try {
      return await this.services.drive();
    } catch (err) {
      if (err instanceof AuthError) return undefined;
      throw err;
    }
  }

  async execute(step: StepRecord, job: JobRecord): Promise<StepResult> {
    const p = step.params;
    const ai = this.services.timeoutMs(this.services.config.ai.timeoutMs);
    switch (step.type) {
      case 'create': {
        if (job.vidId)
          return { skipped: true, output: { id: job.vidId, note: 'already created in an earlier run' } };
        const m = p.mode as P;
        const kind = str(m, 'kind');
        const mode: CreateMode =
          kind === 'template'
            ? {
                kind: 'template',
                template: str(m, 'template'),
                ...(Array.isArray(m.scenes) ? { scenes: m.scenes as number[] } : {}),
              }
            : kind === 'slides'
              ? {
                  kind: 'slides',
                  presentationId: parsePresentationId(str(m, 'presentation')),
                  ...(typeof m.ai === 'boolean' ? { ai: m.ai } : {}),
                  ...(Array.isArray(m.slides) ? { slides: m.slides as number[] } : {}),
                  ...(m.narration === 'voiceover' || m.narration === 'avatar'
                    ? { narration: m.narration }
                    : {}),
                }
              : kind === 'docs'
                ? {
                    kind: 'docs',
                    documentId: parseDocumentId(str(m, 'document')),
                    ...(typeof m.voice === 'string' ? { voice: m.voice } : {}),
                    ...(Array.isArray(m.script) ? { script: m.script as string[] } : {}),
                  }
                : kind === 'upload'
                  ? { kind: 'upload', file: this.file(str(m, 'file')) }
                  : { kind: 'blank' };
        const auto = await this.auto();
        const created = await auto.create({
          format: str(p, 'format') as VideoFormat,
          mode,
          title: str(p, 'name'),
        });
        return { vidId: created.id, vidUrl: created.url, output: created };
      }
      case 'open': {
        const id = parseVidId(str(p, 'id'));
        const drive = await this.driveOrUndefined();
        if (drive) {
          const file = await drive.get(id);
          return { vidId: file.id, vidUrl: file.url, output: { id: file.id, name: file.name } };
        }
        const editor = await (await this.auto()).editor(id);
        return { vidId: editor.id, vidUrl: vidEditUrl(editor.id), output: { id: editor.id } };
      }
      case 'rename': {
        const id = this.vid(job);
        const drive = await this.driveOrUndefined();
        if (drive) return { output: await drive.rename(id, str(p, 'name')) };
        return { output: await (await this.auto()).rename(id, str(p, 'name')) };
      }
      case 'format':
        return {
          output: await (await this.auto()).setFormat(this.vid(job), str(p, 'format') as VideoFormat),
        };
      case 'storyboard': {
        const promptFile = opt(p, 'prompt') ? undefined : this.file(str(p, 'promptFile'));
        const prompt =
          opt(p, 'prompt') ??
          (await fs.readFile(promptFile!, 'utf8').catch(() => {
            throw new WorkflowError(`storyboard.promptFile not found: ${promptFile}`);
          }));
        const result = await (
          await this.auto()
        ).storyboard(this.vid(job), {
          prompt,
          timeoutMs: ai,
          ...(typeof p.design === 'number' ? { design: p.design } : {}),
          ...(Array.isArray(p.outline) ? { outline: p.outline as string[] } : {}),
        });
        return { output: result };
      }
      case 'scene.ensure': {
        const auto = await this.auto();
        const id = this.vid(job);
        const n = num(p, 'scene');
        const editor = await auto.editor(id);
        let count = await editor.sceneCount();
        if (count >= n) return { skipped: true, output: { scenes: count } };
        while (count < n) {
          await auto.addScene(id);
          count = await editor.sceneCount();
        }
        return { output: { scenes: count } };
      }
      case 'scene.background':
        return {
          output: await (await this.auto()).sceneBackground(this.vid(job), num(p, 'scene'), str(p, 'color')),
        };
      case 'scene.duration':
        return {
          output: await (await this.auto()).sceneDuration(this.vid(job), num(p, 'scene'), num(p, 'seconds')),
        };
      case 'text.add': {
        const auto = await this.auto();
        const id = this.vid(job);
        const scene = num(p, 'scene');
        const text = str(p, 'text');
        const existing = await auto.objects(id, scene);
        const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
        if (existing.some((o) => norm(o.text ?? '') === norm(text))) {
          return { skipped: true, output: { note: 'text already present' } };
        }
        const style = {
          ...(typeof p.bold === 'boolean' ? { bold: p.bold } : {}),
          ...(typeof p.italic === 'boolean' ? { italic: p.italic } : {}),
          ...(typeof p.size === 'number' ? { size: p.size } : {}),
          ...(typeof p.align === 'string'
            ? { align: p.align as 'left' | 'center' | 'right' | 'justify' }
            : {}),
          ...(typeof p.color === 'string' ? { color: p.color } : {}),
        };
        const obj = await auto.addText(id, scene, text, {
          kind: (opt(p, 'kind') as 'title' | 'subtitle' | 'body' | undefined) ?? 'body',
          style,
        });
        return { output: obj };
      }
      case 'media.add': {
        const file = this.file(str(p, 'file'));
        if (!(await pathExists(file))) throw new UsageError(`Media file not found: ${file}`);
        return {
          output: await (
            await this.auto()
          ).addMedia(this.vid(job), num(p, 'scene'), file, this.services.timeoutMs(10 * 60_000)),
        };
      }
      case 'script.set':
        return {
          output: await (await this.auto()).setScript(this.vid(job), num(p, 'scene'), str(p, 'script')),
        };
      case 'voiceover': {
        const auto = await this.auto();
        const id = this.vid(job);
        const scene = num(p, 'scene');
        const script = str(p, 'script');
        const clips = (await auto.scenes(id)).find((s) => s.index === scene)?.clips ?? [];
        const firstWords = script.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
        if (
          clips.some((c) => c.kind === 'voiceover' && (c.title ?? '').toLowerCase().startsWith(firstWords))
        ) {
          return { skipped: true, output: { note: 'voiceover already present' } };
        }
        const voice = opt(p, 'voice');
        return {
          output: await auto.voiceover(id, scene, script, {
            timeoutMs: this.services.timeoutMs(3 * 60_000),
            ...(voice ? { voice } : {}),
          }),
        };
      }
      case 'avatar': {
        const avatar = opt(p, 'avatar');
        return {
          output: await (
            await this.auto()
          ).avatar(this.vid(job), num(p, 'scene'), str(p, 'script'), {
            timeoutMs: ai,
            ...(avatar ? { avatar } : {}),
          }),
        };
      }
      case 'ai.generate': {
        const images = Array.isArray(p.images) ? (p.images as string[]).map((f) => this.file(f)) : undefined;
        const aspect = opt(p, 'aspect');
        const model = opt(p, 'model');
        return {
          output: await (
            await this.auto()
          ).aiGenerate(this.vid(job), {
            mode: 'create',
            prompt: str(p, 'prompt'),
            timeoutMs: ai,
            ...(typeof p.scene === 'number' ? { scene: p.scene } : {}),
            ...(images ? { images } : {}),
            ...(aspect ? { aspect: aspect.charAt(0).toUpperCase() + aspect.slice(1) } : {}),
            ...(model ? { model } : {}),
            ...(p.insert === 'new-scene' || p.insert === 'current-scene' || p.insert === 'none'
              ? { insert: p.insert }
              : {}),
          }),
        };
      }
      case 'move': {
        const drive = await this.services.drive();
        return { output: await drive.move(this.vid(job), parseFolderId(str(p, 'folder'))) };
      }
      case 'share': {
        const perms = await this.services.permissions();
        const target: ShareTarget = p.anyone
          ? { kind: 'anyone' }
          : opt(p, 'domain')
            ? { kind: 'domain', domain: str(p, 'domain') }
            : opt(p, 'group')
              ? { kind: 'group', email: str(p, 'group') }
              : { kind: 'user', email: str(p, 'email') };
        const role = (opt(p, 'role') ?? 'reader') as 'reader' | 'commenter' | 'writer';
        const result = await perms.share(this.vid(job), target, role, {
          ...(typeof p.notify === 'boolean' ? { notify: p.notify } : {}),
        });
        return { output: result, skipped: result.action === 'unchanged' };
      }
      case 'export': {
        const format = (opt(p, 'format') ?? 'mp4') as 'mp4' | 'gif';
        const target = this.file(str(p, 'path'));
        const overwrite = p.overwrite === true;
        if (!overwrite && (await pathExists(target)))
          return { skipped: true, output: { path: target, note: 'already exists' } };
        if (format === 'mp4') {
          const drive = await this.driveOrUndefined();
          if (drive) {
            const result = await downloadRendered(drive.transport, this.vid(job), target, {
              pollIntervalMs: this.services.config.downloads.pollIntervalMs,
              timeoutMs: this.services.timeoutMs(this.services.config.downloads.timeoutMs),
              overwrite: true,
            });
            return { output: result };
          }
        }
        return {
          output: await (
            await this.auto()
          ).downloadViaUi(
            this.vid(job),
            format,
            target,
            this.services.timeoutMs(this.services.config.downloads.timeoutMs),
          ),
        };
      }
      default:
        throw new WorkflowError(`Unknown step type: ${String(step.type)}`);
    }
  }

  async close(): Promise<void> {
    if (this.automation) await this.automation.finish().catch(() => undefined);
    if (this.session) await this.session.close().catch(() => undefined);
    this.automation = undefined;
    this.session = undefined;
  }
}
