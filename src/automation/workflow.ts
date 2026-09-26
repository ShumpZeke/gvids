import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { WorkflowError } from '../errors/errors.js';

const TextItemSchema = z.union([
  z.string().min(1),
  z.object({
    text: z.string().min(1),
    kind: z.enum(['title', 'subtitle', 'body']).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    size: z.number().int().positive().optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
    color: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/)
      .optional(),
  }),
]);

const AiClipSchema = z.object({
  prompt: z.string().min(1),
  scene: z.number().int().positive().optional(),
  images: z.array(z.string()).optional(),
  aspect: z.string().optional(),
  model: z.string().optional(),
  /** Where the finished clip goes; default: that scene for per-scene clips, else a new scene. */
  insert: z.enum(['new-scene', 'current-scene', 'none']).optional(),
});

const SceneSchema = z
  .object({
    title: z.string().optional(),
    text: z.union([TextItemSchema, z.array(TextItemSchema)]).optional(),
    script: z.string().optional(),
    media: z.array(z.string()).optional(),
    background: z.string().optional(),
    duration: z.number().positive().optional(),
    voiceover: z
      .union([z.boolean(), z.object({ script: z.string().optional(), voice: z.string().optional() })])
      .optional(),
    avatar: z.object({ name: z.string().optional(), script: z.string().optional() }).optional(),
    ai: AiClipSchema.omit({ scene: true }).optional(),
  })
  .strict();

const ShareSchema = z
  .object({
    email: z.string().email().optional(),
    group: z.string().email().optional(),
    domain: z.string().optional(),
    anyone: z.boolean().optional(),
    role: z.enum(['reader', 'commenter', 'writer']).default('reader'),
    notify: z.boolean().optional(),
  })
  .refine((s) => [s.email, s.group, s.domain, s.anyone].filter(Boolean).length === 1, {
    message: 'each share entry needs exactly one of email, group, domain, anyone',
  });

export const WorkflowSchema = z
  .object({
    version: z.literal(1).optional(),
    name: z.string().min(1),
    /** Operate on an existing video instead of creating a new one. */
    id: z.string().optional(),
    /** Omit to keep an existing video's format (new videos default to landscape). */
    format: z.enum(['landscape', 'portrait', 'square']).optional(),
    template: z
      .union([
        z.string(),
        z.object({ name: z.string(), scenes: z.array(z.number().int().positive()).optional() }),
      ])
      .optional(),
    slides: z
      .union([
        z.string(),
        z.object({
          id: z.string(),
          /** Gemini script + AI narration, music and animation (default true, like Vids). */
          ai: z.boolean().optional(),
          /** Only these slides (1-based). */
          slides: z.array(z.number().int().positive()).optional(),
          narration: z.enum(['voiceover', 'avatar']).optional(),
        }),
      ])
      .optional(),
    /** Google Doc to video (Gemini script + AI voiceover). */
    doc: z
      .union([
        z.string(),
        z.object({
          id: z.string(),
          voice: z.string().optional(),
          /** Replace the drafted scene scripts, in order. */
          script: z.array(z.string().min(1).max(800)).optional(),
        }),
      ])
      .optional(),
    upload: z.string().optional(),
    folder: z.string().optional(),
    storyboard: z
      .object({
        prompt: z.string().optional(),
        promptFile: z.string().optional(),
        design: z.number().int().positive().optional(),
        outline: z.array(z.string().min(1)).optional(),
      })
      .refine((s) => Boolean(s.prompt) !== Boolean(s.promptFile), {
        message: 'storyboard needs exactly one of prompt, promptFile',
      })
      .optional(),
    scenes: z.array(SceneSchema).optional(),
    voiceover: z.object({ enabled: z.boolean().default(false), voice: z.string().optional() }).optional(),
    ai: z.array(AiClipSchema).optional(),
    share: z.array(ShareSchema).optional(),
    export: z
      .object({
        format: z.enum(['mp4', 'gif']).default('mp4'),
        path: z.string().min(1),
        overwrite: z.boolean().default(false),
      })
      .optional(),
  })
  .strict()
  .refine((w) => [w.template, w.slides, w.doc, w.upload].filter(Boolean).length <= 1, {
    message: 'use at most one of template, slides, doc, upload',
  })
  .refine((w) => !(w.id && (w.template || w.slides || w.doc || w.upload)), {
    message: 'template/slides/doc/upload only apply when creating a new video (remove id)',
  });

export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowScene = z.infer<typeof SceneSchema>;
export type TextItem = z.infer<typeof TextItemSchema>;

export interface StepPlan {
  id: string;
  type:
    | 'create'
    | 'open'
    | 'rename'
    | 'format'
    | 'storyboard'
    | 'scene.ensure'
    | 'scene.background'
    | 'scene.duration'
    | 'text.add'
    | 'media.add'
    | 'script.set'
    | 'voiceover'
    | 'avatar'
    | 'ai.generate'
    | 'move'
    | 'share'
    | 'export';
  description: string;
  /** Needs the Vids editor (browser) rather than only the Drive API. */
  browser: boolean;
  params: Record<string, unknown>;
}

function issueText(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function parseWorkflowText(text: string, fileName: string): Workflow {
  let data: unknown;
  try {
    data = /\.json$/i.test(fileName) ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    throw new WorkflowError(
      `${fileName} is not valid ${/\.json$/i.test(fileName) ? 'JSON' : 'YAML'}: ${(err as Error).message}`,
    );
  }
  const result = WorkflowSchema.safeParse(data);
  if (!result.success) {
    throw new WorkflowError(`Invalid workflow ${fileName}:\n${issueText(result.error)}`, {
      hint: 'See docs/workflows.md and examples/*.yaml',
    });
  }
  return result.data;
}

export async function loadWorkflow(
  file: string,
): Promise<{ workflow: Workflow; text: string; hash: string; path: string }> {
  const resolved = path.resolve(file);
  let text: string;
  try {
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    throw new WorkflowError(`Workflow file not found: ${resolved}`);
  }
  const workflow = parseWorkflowText(text, resolved);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  return { workflow, text, hash, path: resolved };
}

function textItems(scene: WorkflowScene): TextItem[] {
  if (!scene.text) return [];
  return Array.isArray(scene.text) ? scene.text : [scene.text];
}

/** Compiles a workflow into an ordered, stable list of steps. Step IDs never depend on runtime state. */
export function planWorkflow(workflow: Workflow): StepPlan[] {
  const steps: StepPlan[] = [];
  const add = (step: StepPlan): void => {
    steps.push(step);
  };
  // Storyboard, templates and Slides conversion are landscape-only in Vids: create landscape, convert after.
  const createsLandscapeFirst = Boolean(
    workflow.template || workflow.slides || workflow.doc || workflow.storyboard,
  );
  const format = workflow.format ?? 'landscape';
  if (workflow.id) {
    add({
      id: 'open',
      type: 'open',
      description: `Open existing video ${workflow.id}`,
      browser: false,
      params: { id: workflow.id },
    });
    add({
      id: 'rename',
      type: 'rename',
      description: `Rename to "${workflow.name}"`,
      browser: false,
      params: { name: workflow.name },
    });
  } else {
    const mode = workflow.template
      ? {
          kind: 'template',
          template: typeof workflow.template === 'string' ? workflow.template : workflow.template.name,
          ...(typeof workflow.template === 'object' && workflow.template.scenes
            ? { scenes: workflow.template.scenes }
            : {}),
        }
      : workflow.slides
        ? typeof workflow.slides === 'string'
          ? { kind: 'slides', presentation: workflow.slides }
          : {
              kind: 'slides',
              presentation: workflow.slides.id,
              ...(workflow.slides.ai !== undefined ? { ai: workflow.slides.ai } : {}),
              ...(workflow.slides.slides ? { slides: workflow.slides.slides } : {}),
              ...(workflow.slides.narration ? { narration: workflow.slides.narration } : {}),
            }
        : workflow.doc
          ? typeof workflow.doc === 'string'
            ? { kind: 'docs', document: workflow.doc }
            : {
                kind: 'docs',
                document: workflow.doc.id,
                ...(workflow.doc.voice ? { voice: workflow.doc.voice } : {}),
                ...(workflow.doc.script ? { script: workflow.doc.script } : {}),
              }
          : workflow.upload
            ? { kind: 'upload', file: workflow.upload }
            : { kind: 'blank' };
    add({
      id: 'create',
      type: 'create',
      description: `Create "${workflow.name}" (${mode.kind})`,
      browser: true,
      params: { name: workflow.name, format: createsLandscapeFirst ? 'landscape' : format, mode },
    });
  }
  if (workflow.storyboard) {
    add({
      id: 'storyboard',
      type: 'storyboard',
      description: 'Generate AI storyboard draft',
      browser: true,
      params: { ...workflow.storyboard },
    });
  }
  if ((createsLandscapeFirst && !workflow.id && format !== 'landscape') || (workflow.id && workflow.format)) {
    add({
      id: 'format',
      type: 'format',
      description: `Set format to ${format}`,
      browser: true,
      params: { format },
    });
  }
  const globalVoice = workflow.voiceover?.enabled ? workflow.voiceover : undefined;
  (workflow.scenes ?? []).forEach((scene, i) => {
    const n = i + 1;
    const sid = `scene-${n}`;
    add({
      id: `${sid}.ensure`,
      type: 'scene.ensure',
      description: `Ensure scene ${n} exists`,
      browser: true,
      params: { scene: n },
    });
    if (scene.background) {
      add({
        id: `${sid}.background`,
        type: 'scene.background',
        description: `Scene ${n}: background ${scene.background}`,
        browser: true,
        params: { scene: n, color: scene.background },
      });
    }
    if (scene.title) {
      add({
        id: `${sid}.title`,
        type: 'text.add',
        description: `Scene ${n}: title "${scene.title}"`,
        browser: true,
        params: { scene: n, text: scene.title, kind: 'title' },
      });
    }
    textItems(scene).forEach((item, j) => {
      const t = typeof item === 'string' ? { text: item } : item;
      add({
        id: `${sid}.text-${j + 1}`,
        type: 'text.add',
        description: `Scene ${n}: text "${t.text.slice(0, 40)}"`,
        browser: true,
        params: { scene: n, kind: 'body', ...t },
      });
    });
    (scene.media ?? []).forEach((file, j) => {
      add({
        id: `${sid}.media-${j + 1}`,
        type: 'media.add',
        description: `Scene ${n}: insert ${path.basename(file)}`,
        browser: true,
        params: { scene: n, file },
      });
    });
    if (scene.duration) {
      add({
        id: `${sid}.duration`,
        type: 'scene.duration',
        description: `Scene ${n}: ${scene.duration}s`,
        browser: true,
        params: { scene: n, seconds: scene.duration },
      });
    }
    const voice =
      scene.voiceover === false
        ? undefined
        : scene.voiceover === true
          ? {}
          : (scene.voiceover ?? (globalVoice ? {} : undefined));
    const voiceScript = (typeof voice === 'object' && voice?.script) || scene.script;
    if (voice && voiceScript) {
      add({
        id: `${sid}.voiceover`,
        type: 'voiceover',
        description: `Scene ${n}: voiceover`,
        browser: true,
        params: {
          scene: n,
          script: voiceScript,
          voice: (typeof voice === 'object' && voice.voice) || globalVoice?.voice,
        },
      });
    } else if (scene.script) {
      add({
        id: `${sid}.script`,
        type: 'script.set',
        description: `Scene ${n}: script`,
        browser: true,
        params: { scene: n, script: scene.script },
      });
    }
    if (scene.avatar) {
      const script = scene.avatar.script ?? scene.script;
      if (!script)
        throw new WorkflowError(`scenes[${i}].avatar needs a script (avatar.script or scene script).`);
      add({
        id: `${sid}.avatar`,
        type: 'avatar',
        description: `Scene ${n}: avatar`,
        browser: true,
        params: { scene: n, script, avatar: scene.avatar.name },
      });
    }
    if (scene.ai) {
      add({
        id: `${sid}.ai`,
        type: 'ai.generate',
        description: `Scene ${n}: AI clip`,
        browser: true,
        params: { ...scene.ai, scene: n },
      });
    }
  });
  (workflow.ai ?? []).forEach((clip, k) => {
    add({
      id: `ai-${k + 1}`,
      type: 'ai.generate',
      description: `AI clip ${k + 1}: ${clip.prompt.slice(0, 40)}`,
      browser: true,
      params: { ...clip },
    });
  });
  if (workflow.folder) {
    add({
      id: 'move',
      type: 'move',
      description: `Move to folder ${workflow.folder}`,
      browser: false,
      params: { folder: workflow.folder },
    });
  }
  (workflow.share ?? []).forEach((share, k) => {
    add({
      id: `share-${k + 1}`,
      type: 'share',
      description: `Share with ${share.email ?? share.group ?? share.domain ?? 'anyone with the link'} (${share.role})`,
      browser: false,
      params: { ...share },
    });
  });
  if (workflow.export) {
    add({
      id: 'export',
      type: 'export',
      description: `Export ${workflow.export.format.toUpperCase()} to ${workflow.export.path}`,
      browser: workflow.export.format === 'gif',
      params: { ...workflow.export },
    });
  }
  return steps;
}
