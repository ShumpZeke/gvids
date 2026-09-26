# Workflows (batch mode) and jobs

Describe a whole video in YAML or JSON and let gvids build it:

```bash
gvids run video.yaml
gvids run video.yaml --dry-run          # validate and print the plan, touch nothing
gvids run video.yaml --headless --detach   # background; then: gvids wait <task-id>
```

A workflow that shares the video publicly (`share: [{ anyone: true }]` or a
`domain`) needs `--yes`, exactly like `gvids share --anyone`: without it `run`
fails with `CONFIRMATION_REQUIRED` before anything is created, and `--dry-run`
marks the plan with `requiresUserApproval`. `job resume` asks again when public
sharing steps remain.

Every run is a **job**, persisted after each step under `~/.gvids/jobs/`. If a
step fails (UI change, network, quota, Ctrl+C), the error envelope names the job
(`error.details.jobId`, `error.next: ["gvids job resume <job-id>", …]`). Fix the
cause and resume:

```bash
gvids jobs                       # recent jobs with progress
gvids job status <job-id>
gvids job resume <job-id>        # continues from the failed step
gvids job resume <job-id> --force   # even if the workflow file changed
gvids job cancel <job-id>        # a running job stops before its next step
```

## Example

```yaml
name: Spanish Weather Forecast # video title (required)
format: landscape # landscape | portrait | square

storyboard: # optional Gemini draft (new videos only)
  prompt: |
    Create a short Spanish weather report for El Salvador.
  design: 1

scenes: # applied to scenes 1..N (added if missing)
  - title: Introduction
    script: |
      Hola. Hoy vamos a hablar del tiempo.
  - title: San Salvador
    media:
      - san-salvador.jpg # relative to the workflow file
    script: |
      En San Salvador hace calor.

voiceover:
  enabled: true # turn every scene script into narration
  voice: Nyla

export:
  format: mp4
  path: ./weather.mp4
```

## Schema

Top level:

| Key          | Type                                                            | Notes                                                                   |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `name`       | string, required                                                | title of the video                                                      |
| `id`         | string                                                          | work on an existing video instead of creating one                       |
| `format`     | `landscape` \| `portrait` \| `square`                           | new videos default to landscape; existing videos keep theirs unless set |
| `template`   | string or `{ name, scenes: [1,3] }`                             | start from a template (new videos only)                                 |
| `slides`     | presentation ID/URL or `{ id, ai, slides, narration }`          | convert Google Slides (new videos only); `ai: false` for plain slides   |
| `upload`     | file path                                                       | start from a local media file (new videos only)                         |
| `folder`     | Drive folder ID                                                 | move the video there (Drive API)                                        |
| `storyboard` | `{ prompt \| promptFile, design?, outline?: [..] }`             | Gemini storyboard draft                                                 |
| `scenes`     | list of scene objects                                           | see below                                                               |
| `voiceover`  | `{ enabled, voice? }`                                           | narrate every scene that has a `script`                                 |
| `ai`         | list of `{ prompt, scene?, images?, aspect?, model? }`          | AI clips (uses your quota)                                              |
| `share`      | list of `{ email \| group \| domain \| anyone, role, notify? }` | Drive API                                                               |
| `export`     | `{ format: mp4 \| gif, path, overwrite? }`                      | MP4 via Drive API when signed in, else via the editor                   |

Scene objects (all optional):

| Key          | Notes                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| `title`      | adds a title text box                                                                     |
| `text`       | a string, an object `{ text, kind, bold, italic, size, align, color }`, or a list of them |
| `media`      | list of local files to insert                                                             |
| `background` | `#rrggbb` or a palette name                                                               |
| `duration`   | seconds (experimental)                                                                    |
| `script`     | the scene's script; narrated when voiceover is enabled                                    |
| `voiceover`  | `true`, `false`, or `{ script?, voice? }` to override per scene                           |
| `avatar`     | `{ name?, script? }` — avatar presenter (uses the scene script if none)                   |
| `ai`         | `{ prompt, images?, aspect?, model? }` — AI clip in this scene                            |

Validation is strict: unknown keys, conflicting sources (`template` + `upload`),
or `template`/`slides`/`upload` together with `id` are rejected with the exact
path of each problem.

## How it runs

`gvids run` compiles the file into ordered steps with stable IDs
(`create`, `storyboard`, `scene-2.text-1`, `scene-3.voiceover`, `share-1`,
`export`, …). Drive steps use the API; editor steps share one browser session
and one editor tab for the whole run.

Rules that keep runs safe to resume:

- The video ID is recorded as soon as `create` finishes; a resumed `create` is
  skipped.
- `text.add` skips when identical text already exists on that scene.
- `voiceover` skips when that scene already has narration starting with the same words.
- `share` is idempotent (same role → unchanged).
- `export` skips when the target exists (unless `overwrite: true`).
- The job file stores the workflow hash; resuming after editing the file needs `--force`.
- A lock (PID + host) prevents two processes from running one job.
- Ctrl+C, SIGTERM or `gvids task cancel` mark the job `cancelled`; `job resume`
  continues it.

## Running many videos

A workflow describes one video. For batches, loop in your shell:

```powershell
Get-ChildItem .\projects\*.yaml | ForEach-Object { gvids run $_.FullName --headless }
```

```bash
for f in projects/*.yaml; do gvids run "$f" --headless || echo "failed: $f"; done
```

See `examples/` for complete files: `simple-video.yaml`, `ai-video.yaml`,
`slides-to-video.yaml`, `narrated-video.yaml`, `batch-project.yaml`.
