import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { WorkflowError } from '../errors/errors.js';
import { WorkflowSchema, planWorkflow, type Workflow, type StepPlan } from '../automation/workflow.js';

export const CAMERA_MOVES = {
  static: 'A locked-off, stable camera with deliberate composition.',
  'dolly-in': 'A smooth cinematic dolly-in toward the subject, with natural parallax.',
  'dolly-out': 'A smooth dolly-out revealing the surrounding environment.',
  orbit: 'A controlled orbital camera move around the main subject.',
  tracking: 'A lateral tracking shot following the subject at a constant distance.',
  'crane-up': 'A rising crane move that gradually reveals the wider scene.',
  'crane-down': 'A descending crane move that settles on the subject.',
  handheld: 'Subtle, intentional handheld camera motion, natural but not chaotic.',
  'push-in': 'A slow dramatic camera push-in that builds emphasis.',
  'pull-back': 'A measured pull-back revealing the context of the scene.',
  'top-down': 'A clean overhead top-down composition with minimal perspective drift.',
  'low-angle': 'A dramatic low-angle camera viewpoint emphasizing scale.',
} as const;

export const LOOK_PRESETS = {
  cinematic: 'Cinematic photography, natural texture, controlled contrast and filmic color.',
  commercial: 'Premium product commercial, precise highlights, crisp details and elegant art direction.',
  noir: 'Film noir, deep shadow, directional lighting and monochromatic contrast.',
  documentary: 'Observational documentary realism, available light and authentic textures.',
  anime: 'Expressive anime-inspired visual direction with cinematic composition.',
  dreamscape: 'Surreal dreamlike atmosphere, ethereal volumetric light and imaginative locations.',
  'retro-game': 'Stylized low-poly retro console look, consistent geometry and deliberate pixel texture.',
} as const;

const ShotSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    kind: z.enum(['video', 'image']).default('video'),
    camera: z.enum(Object.keys(CAMERA_MOVES) as [keyof typeof CAMERA_MOVES, ...Array<keyof typeof CAMERA_MOVES>]).default('static'),
    framing: z.enum(['extreme-wide', 'wide', 'medium', 'close-up', 'macro']).optional(),
    movement: z.string().trim().max(400).optional(),
    lighting: z.string().trim().max(400).optional(),
    style: z.string().trim().max(400).optional(),
    avoid: z.string().trim().max(400).optional(),
    references: z.array(z.string().min(1)).max(4).optional(),
    caption: z.string().trim().max(250).optional(),
    narration: z.string().trim().max(800).optional(),
    duration: z.number().min(1).max(120).optional(),
    music: z.string().trim().max(800).optional(),
  })
  .strict();

export const StudioProjectSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().trim().min(1).max(150),
    format: z.enum(['landscape', 'portrait', 'square']).default('landscape'),
    look: z.enum(Object.keys(LOOK_PRESETS) as [keyof typeof LOOK_PRESETS, ...Array<keyof typeof LOOK_PRESETS>]).default('cinematic'),
    style: z.string().trim().max(500).optional(),
    lighting: z.string().trim().max(500).optional(),
    negative: z.string().trim().max(500).optional(),
    model: z.string().trim().min(1).optional(),
    voice: z.string().trim().min(1).optional(),
    shots: z.array(ShotSchema).min(1).max(30),
    export: z
      .object({
        path: z.string().trim().min(1),
        format: z.enum(['mp4', 'gif']).default('mp4'),
        overwrite: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StudioProject = z.infer<typeof StudioProjectSchema>;

function promptFor(project: StudioProject, shot: StudioProject['shots'][number]): string {
  const parts = [
    shot.prompt,
    'Visual direction: ' + LOOK_PRESETS[project.look],
    project.style || '',
    shot.style || '',
    'Camera: ' + CAMERA_MOVES[shot.camera],
    shot.framing ? 'Framing: ' + shot.framing + '.' : '',
    shot.movement ? 'Subject movement: ' + shot.movement : '',
    shot.lighting || project.lighting ? 'Lighting: ' + (shot.lighting || project.lighting) : '',
    shot.avoid || project.negative ? 'Avoid: ' + [project.negative, shot.avoid].filter(Boolean).join('; ') : '',
    'Maintain subject, wardrobe and environmental continuity with adjacent shots.',
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * Pure compile step: a creative brief becomes the existing validated Vids workflow.
 * Camera moves and looks are prompt directions, not proprietary camera APIs.
 * Local assets and exports are absolute so job snapshots remain resumable.
 */
export function compileStudioProject(project: StudioProject, baseDir: string): Workflow {
  const scenes = project.shots.map((shot) => {
    const common = {
      ...(shot.caption ? { text: { text: shot.caption, kind: 'subtitle' as const } } : {}),
      ...(shot.duration ? { duration: shot.duration } : {}),
      ...(shot.narration
        ? {
            script: shot.narration,
            voiceover: project.voice ? { voice: project.voice } : true,
          }
        : {}),
      ...(shot.music ? { music: { prompt: shot.music } } : {}),
    };
    if (shot.kind === 'image') {
      return { ...common, image: { prompt: promptFor(project, shot) } };
    }
    return {
      ...common,
      ai: {
        prompt: promptFor(project, shot),
        ...(shot.references?.length ? { images: shot.references.map((f) => path.resolve(baseDir, f)) } : {}),
        ...(project.model ? { model: project.model } : {}),
        ...(project.format !== 'square' ? { aspect: project.format } : {}),
        insert: 'current-scene' as const,
      },
    };
  });
  const candidate = {
    name: project.name,
    format: project.format,
    scenes,
    ...(project.export
      ? {
          export: {
            ...project.export,
            path: path.resolve(baseDir, project.export.path),
          },
        }
      : {}),
  };
  return WorkflowSchema.parse(candidate);
}

export function studioPlan(project: StudioProject, baseDir: string): {
  workflow: Workflow;
  steps: StepPlan[];
  warnings: string[];
} {
  const workflow = compileStudioProject(project, baseDir);
  const steps = planWorkflow(workflow);
  return {
    workflow,
    steps,
    warnings: [
      'Camera moves and looks are prompt guidance, not deterministic controls.',
      'AI availability, model names, generation limits and costs depend on your Google account.',
      'Generated clips may require manual review for visual continuity and timing.',
      ...(project.format === 'square'
        ? ['Square project format does not force square AI-generation aspect; check generated assets.']
        : []),
    ],
  };
}

export async function readStudioProject(file: string): Promise<{
  path: string;
  project: StudioProject;
  plan: ReturnType<typeof studioPlan>;
  hash: string;
}> {
  const absolute = path.resolve(file);
  let content: string;
  try {
    content = await fs.readFile(absolute, 'utf8');
  } catch {
    throw new WorkflowError('Studio brief not found: ' + absolute);
  }
  let data: unknown;
  try {
    data = /\.json$/i.test(absolute) ? JSON.parse(content) : YAML.parse(content);
  } catch (err) {
    throw new WorkflowError('Invalid studio brief: ' + (err as Error).message);
  }
  const parsed = StudioProjectSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => (issue.path.join('.') || '(root)') + ': ' + issue.message)
      .join('; ');
    throw new WorkflowError('Invalid studio brief: ' + issues);
  }
  return {
    path: absolute,
    project: parsed.data,
    plan: studioPlan(parsed.data, path.dirname(absolute)),
    hash: crypto.createHash('sha256').update(absolute).update('\n').update(content).digest('hex').slice(0, 20),
  };
}
