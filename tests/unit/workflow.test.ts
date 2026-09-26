import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JobStore, newJobId, type JobRecord, type StepRecord } from '../../src/automation/job.js';
import { prepareResume, runJob, type StepExecutor, type StepResult } from '../../src/automation/runner.js';
import { loadWorkflow, parseWorkflowText, planWorkflow } from '../../src/automation/workflow.js';
import { GvidsError } from '../../src/errors/errors.js';
import { tempHome } from '../helpers/cli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'fixtures', 'workflows');
const examples = path.join(here, '..', '..', 'examples');

describe('workflow parsing', () => {
  it('parses the weather example', async () => {
    const { workflow, hash } = await loadWorkflow(path.join(fixtures, 'weather.yaml'));
    expect(workflow.name).toBe('Spanish Weather Forecast');
    expect(workflow.scenes).toHaveLength(2);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports every validation problem with its path', async () => {
    await expect(loadWorkflow(path.join(fixtures, 'invalid.yaml'))).rejects.toThrow(
      /name[\s\S]*format[\s\S]*scenes\.0/,
    );
  });

  it('accepts JSON workflows', () => {
    const wf = parseWorkflowText(JSON.stringify({ name: 'J', scenes: [{ title: 'Hi' }] }), 'w.json');
    expect(wf.scenes?.[0]?.title).toBe('Hi');
  });

  it('rejects conflicting sources', () => {
    expect(() => parseWorkflowText('name: x\ntemplate: Tutorial\nupload: a.mp4\n', 'w.yaml')).toThrow(
      /at most one/,
    );
    expect(() => parseWorkflowText('name: x\nid: abc\ntemplate: Tutorial\n', 'w.yaml')).toThrow(
      /only apply when creating/,
    );
    expect(() => parseWorkflowText('name: x\nstoryboard: {}\n', 'w.yaml')).toThrow(
      /exactly one of prompt, promptFile/,
    );
    expect(() => parseWorkflowText('name: x\nshare:\n  - role: reader\n', 'w.yaml')).toThrow(
      /exactly one of email/,
    );
  });

  it('every shipped example validates', async () => {
    const files = fs.readdirSync(examples).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const { workflow } = await loadWorkflow(path.join(examples, f));
      expect(planWorkflow(workflow).length, f).toBeGreaterThan(0);
    }
  });
});

describe('planWorkflow', () => {
  it('compiles the weather workflow into ordered steps', () => {
    const wf = parseWorkflowText(
      fs.readFileSync(path.join(fixtures, 'weather.yaml'), 'utf8'),
      'weather.yaml',
    );
    const steps = planWorkflow(wf);
    expect(steps.map((s) => s.id)).toEqual([
      'create',
      'storyboard',
      'scene-1.ensure',
      'scene-1.title',
      'scene-1.voiceover',
      'scene-2.ensure',
      'scene-2.title',
      'scene-2.media-1',
      'scene-2.voiceover',
      'export',
    ]);
    expect(steps[0]!.params).toMatchObject({
      name: 'Spanish Weather Forecast',
      format: 'landscape',
      mode: { kind: 'blank' },
    });
    expect(steps.find((s) => s.id === 'export')!.browser).toBe(false);
  });

  it('creates landscape first and converts afterwards for storyboard/template flows', () => {
    const steps = planWorkflow(
      parseWorkflowText('name: x\nformat: portrait\ntemplate: Tutorial\n', 'w.yaml'),
    );
    expect(steps[0]!.params).toMatchObject({
      format: 'landscape',
      mode: { kind: 'template', template: 'Tutorial' },
    });
    expect(steps.map((s) => s.id)).toContain('format');
  });

  it('passes Slides import options through to the create step', () => {
    const plain = planWorkflow(parseWorkflowText('name: x\nslides: https://example.com/deck\n', 'w.yaml'));
    expect(plain[0]!.params).toMatchObject({
      mode: { kind: 'slides', presentation: 'https://example.com/deck' },
    });
    const steps = planWorkflow(
      parseWorkflowText(
        'name: x\nslides:\n  id: 1HeSZYa-5AylrHHzuI_PqU_U6d-M7jwgaxMsUEw5ldJ8\n  ai: false\n  slides: [1, 3]\n',
        'w.yaml',
      ),
    );
    expect(steps[0]!.params).toMatchObject({
      format: 'landscape',
      mode: {
        kind: 'slides',
        presentation: '1HeSZYa-5AylrHHzuI_PqU_U6d-M7jwgaxMsUEw5ldJ8',
        ai: false,
        slides: [1, 3],
      },
    });
    expect(() => parseWorkflowText('name: x\nslides:\n  id: abc\n  narration: robot\n', 'w.yaml')).toThrow();
  });

  it('keeps an existing video format unless asked', () => {
    const steps = planWorkflow(parseWorkflowText('name: x\nid: abcdefghijklmnop\n', 'w.yaml'));
    expect(steps.map((s) => s.id)).toEqual(['open', 'rename']);
  });

  it('sets scripts without voiceover and supports per-scene voices', () => {
    const steps = planWorkflow(
      parseWorkflowText(
        'name: x\nscenes:\n  - script: plain script\n  - script: spoken\n    voiceover:\n      voice: Knox\n  - voiceover: false\n    script: silent\n',
        'w.yaml',
      ),
    );
    expect(steps.filter((s) => s.type === 'script.set').map((s) => s.params.scene)).toEqual([1, 3]);
    expect(steps.find((s) => s.type === 'voiceover')!.params).toMatchObject({
      scene: 2,
      script: 'spoken',
      voice: 'Knox',
    });
  });

  it('requires a script for avatars', () => {
    expect(() =>
      planWorkflow(parseWorkflowText('name: x\nscenes:\n  - avatar:\n      name: Finley\n', 'w.yaml')),
    ).toThrow(/avatar needs a script/);
  });
});

class FakeExecutor implements StepExecutor {
  executed: string[] = [];
  failOn: string | undefined;
  closed = 0;
  async execute(step: StepRecord, job: JobRecord): Promise<StepResult> {
    if (step.id === this.failOn) {
      this.failOn = undefined;
      throw new GvidsError(`boom at ${step.id}`, { code: 'UI_CHANGED' });
    }
    if (step.type === 'text.add' && job.vidId === 'VID123' && step.params.text === 'dup')
      return { skipped: true };
    this.executed.push(step.id);
    if (step.type === 'create')
      return { vidId: 'VID123', vidUrl: 'https://example/VID123', output: { ok: true } };
    return { output: step.id };
  }
  async close(): Promise<void> {
    this.closed++;
  }
}

describe('jobs', () => {
  const workflow = parseWorkflowText('name: Job test\nscenes:\n  - title: One\n  - title: dup\n', 'w.yaml');

  it('generates sortable IDs', () => {
    expect(newJobId(new Date('2026-09-22T10:11:12Z'))).toMatch(/^job_20260922101112_[0-9a-f]{6}$/);
  });

  it('runs to completion and persists state', async () => {
    const store = new JobStore(path.join(tempHome(), 'jobs'));
    const job = await store.create({
      name: workflow.name,
      workflowFile: 'w.yaml',
      workflowHash: 'h',
      steps: planWorkflow(workflow),
    });
    const exec = new FakeExecutor();
    const done = await runJob(store, job, exec);
    expect(done.status).toBe('completed');
    expect(done.vidId).toBe('VID123');
    expect(exec.executed).toEqual(['create', 'scene-1.ensure', 'scene-1.title', 'scene-2.ensure']);
    expect(done.steps.find((s) => s.id === 'scene-2.title')!.status).toBe('skipped');
    expect(exec.closed).toBe(1);
    const reloaded = await store.get(job.id);
    expect(reloaded.status).toBe('completed');
    expect(reloaded.owner).toBeUndefined();
    expect((await store.list()).map((j) => j.id)).toEqual([job.id]);
  });

  it('stops on failure and resumes from the failed step without redoing finished ones', async () => {
    const store = new JobStore(path.join(tempHome(), 'jobs'));
    const job = await store.create({
      name: workflow.name,
      workflowFile: 'w.yaml',
      workflowHash: 'h',
      steps: planWorkflow(workflow),
    });
    const exec = new FakeExecutor();
    exec.failOn = 'scene-1.title';
    await expect(runJob(store, job, exec)).rejects.toThrow(/boom at scene-1.title/);
    const failed = await store.get(job.id);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('UI_CHANGED');
    expect(failed.steps.find((s) => s.id === 'scene-1.title')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(failed.vidId).toBe('VID123');

    expect(prepareResume(failed)).toBe(3);
    const resumed = await runJob(store, failed, exec);
    expect(resumed.status).toBe('completed');
    expect(exec.executed.filter((s) => s === 'create')).toHaveLength(1);
    expect(resumed.steps.find((s) => s.id === 'scene-1.title')!.attempts).toBe(2);
  });

  it('honours cancellation between steps', async () => {
    const store = new JobStore(path.join(tempHome(), 'jobs'));
    const job = await store.create({
      name: workflow.name,
      workflowFile: 'w.yaml',
      workflowHash: 'h',
      steps: planWorkflow(workflow),
    });
    const controller = new AbortController();
    const exec = new FakeExecutor();
    const original = exec.execute.bind(exec);
    exec.execute = async (step, j) => {
      const r = await original(step, j);
      if (step.id === 'create') controller.abort();
      return r;
    };
    await expect(runJob(store, job, exec, {}, controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect((await store.get(job.id)).status).toBe('cancelled');
  });

  it('cancels a job that is not running immediately', async () => {
    const store = new JobStore(path.join(tempHome(), 'jobs'));
    const job = await store.create({ name: 'x', workflowFile: 'w.yaml', workflowHash: 'h', steps: [] });
    expect((await store.requestCancel(job.id)).status).toBe('cancelled');
  });

  it('refuses unknown or malformed job IDs', async () => {
    const store = new JobStore(path.join(tempHome(), 'jobs'));
    await expect(store.get('job_20260101000000_abcdef')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
    await expect(store.get('../../etc/passwd')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});
