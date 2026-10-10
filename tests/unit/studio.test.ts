import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { CAMERA_MOVES, compileStudioProject, StudioProjectSchema, studioPlan } from '../../src/studio/project.js';

describe('cinematic studio', () => {
  const project = StudioProjectSchema.parse({
    name: 'Demo', format: 'portrait', shots: [
      { prompt: 'A running hero', camera: 'tracking', references: ['./ref.png'], music: 'Atmospheric score' },
      { prompt: 'A final illustration', kind: 'image' },
    ],
    export: { path: './out.mp4' },
  });
  it('has camera presets', () => expect(Object.keys(CAMERA_MOVES).length).toBeGreaterThan(8));
  it('compiles AI images, music and reference images into workflow steps', () => {
    const base = path.resolve('/tmp/studio-test');
    const workflow = compileStudioProject(project, base);
    expect(workflow.scenes?.[0]?.ai?.images).toEqual([path.resolve(base, 'ref.png')]);
    expect(workflow.scenes?.[1]?.image?.prompt).toContain('final illustration');
    const steps = studioPlan(project, base).steps;
    expect(steps.map(s => s.type)).toContain('image.generate');
    expect(steps.map(s => s.type)).toContain('music.generate');
  });
  it('rejects unknown camera names', () => {
    expect(() => StudioProjectSchema.parse({name:'Bad',shots:[{prompt:'Shot',camera:'teleport'}]})).toThrow();
  });
  it('returns JSON presets offline', async () => {
    const r = await cli(['studio','presets']);
    expect(r.json?.ok).toBe(true);
    expect(r.json?.data.cameras.orbit).toContain('camera');
  });
});
