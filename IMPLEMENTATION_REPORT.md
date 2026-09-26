# gvids — implementation report

Status as of 2026-09-23. gvids 0.1.0: TypeScript, Node 22.12+ (tested on Node 24.19,
Windows 11), pnpm 12.

**Summary.** The CLI is complete and **designed for AI agents** (see the next
section). `pnpm check` (format, lint, typecheck, 241 unit tests, command docs) passes,
and so do the build, the MCP smoke test and an install from the packed tarball.
Everything that runs through the Vids **editor** was exercised against the live
product with a signed-in personal Google account (Google AI plan), including a real
AI video generation, real MP4/GIF exports, and parallel/background runs of the built
CLI. Everything that needs the **Drive API** is implemented and unit-tested against
a fake Drive transport, but was **not run against Google**: no OAuth client
(`client_secret.json`) exists on this machine, so the six live Drive tests report
SKIPPED (see "Not live-tested" for the exact steps). Where the editor or the Vids
home page can do the same job, gvids falls back to it, so `list`, `search`, `info`,
`rename`, `trash`, `restore`, `download`, `export` and `media add-drive` also work
without OAuth.

## Agent-first interface

| Feature                  | What it does                                                                                                                                                                     | Verified                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| JSON by default          | one compact envelope `{ok,data,error,warnings?}` per command on stdout; exit code 0 exactly when `ok`; `--pretty`, `--human`                                                     | unit + live                       |
| Quiet stderr             | nothing unless `--progress` (JSON-line events) or `--verbose`/`--debug` (JSON-line logs)                                                                                         | unit + live                       |
| Agent-ready errors       | `code`, `exitCode`, `retryable`, `needsUser`, `next` (commands to run), `hint`, `details` on every error                                                                         | unit                              |
| No prompts               | `CONFIRMATION_REQUIRED` returns the exact approved command (`next`, `details.retryArgs`); person-only commands return `USER_ACTION_REQUIRED` in batch/MCP                        | unit + live                       |
| Command catalog          | `gvids commands [prefix] [--full]`: effect, backend, confirm, AI quota, slow, person-only for all 96 commands; tests keep it complete and consistent                             | unit                              |
| JSON help                | `gvids <cmd> --help`, `gvids help <group>`, a bare group lists its commands, JSON overview with no arguments                                                                     | unit                              |
| `--dry-run`              | on any command: validates IDs, numbers, colors and local files, returns the effect and the command to run; never acts (wins over `--detach`)                                     | unit + MCP smoke                  |
| `--detach` / `wait`      | background worker per command with heartbeat; `wait` relays its envelope and exit code or `STILL_RUNNING` (exit 8, retryable); `tasks`, `task status`, cooperative `task cancel` | unit + live                       |
| `batch`                  | JSON list of commands in one call, per-command results, stop or `--keep-going`, same safeguards as single commands                                                               | unit + live                       |
| Parallel commands        | several processes share one browser (launch lock + leases), each in its own tab; the last one closes a one-off browser                                                           | unit + live (3 parallel commands) |
| Warm browser + tab reuse | `browser open --headless`; idle editor tabs are reused by the next command on the same video                                                                                     | live                              |
| Fallbacks                | without a usable OAuth login, Drive commands with an editor/home-page equivalent use the browser and say so in `warnings`                                                        | unit + live                       |
| Cancellation             | Ctrl+C, SIGTERM and `task cancel` close tabs, release the browser, mark jobs cancelled and print a `CANCELLED` envelope (exit 130)                                               | unit + live                       |
| `guide` / `AGENTS.md`    | contract, error handling, safety rules, recipes, timings, limits                                                                                                                 | unit                              |
| MCP                      | 30 tools incl. generic `gvids` (any command), `vids_commands`, `vids_wait`; annotations from the catalog; same safeguards as the CLI                                             | unit + stdio smoke (17 checks)    |

## Release-readiness pass (2026-09-23)

Every command was audited against the agent contract, the safety rules, background
tasks, browser sharing, MCP, config, packaging and the docs. Problems found and
fixed (each has a regression test unless marked "live"):

**Contract**

- A bare command group (`gvids scene`) printed nothing; it now returns the group's commands.
- `auth status`, `browser status` and `doctor` printed `ok:true` with a non-zero exit
  code. They now fail with a typed error (`LOGIN_REQUIRED`, `AUTH_REQUIRED`, …,
  `NOT_READY`) and keep the full status in `data`.
- `help nosuch` returned the overview; it is now `INVALID_ARGUMENT`.
- Parse errors were printed twice (Commander's text and the envelope); now only the
  envelope, with `details.usage` and `next: ["gvids <cmd> --help"]`. Usage errors
  raised by commands carry the same `next`.
- An invalid global `--timeout` was ignored unless the command used it; `tasks` /
  `jobs --status` and `--limit` were not validated.
- Ctrl+C printed plain text and exited after 5 s; SIGTERM was not handled; an
  unexpected crash printed plain text. All three now print an envelope, and signals
  run cleanups first (tabs closed, browser released, jobs marked cancelled).
- Raw Playwright errors (ANSI codes, call logs) are mapped to a retryable
  `BROWSER_SESSION_ERROR` with a clean message; timeouts exit 8 (were 1).
- `completion bash` printed a JSON envelope, which broke the documented install; it
  prints the raw script again (`--json` for the envelope).
- `info short` said "Not a Google URL" for a malformed ID.

**Validation before side effects** (all also run by `--dry-run`)

- Text colors/sizes and empty text, empty `rename` names, `create --upload` files (a
  failed upload used to leave an empty video behind), `ai edit/animate` source and
  `--image` files, `media add` files, `--outline-file` contents, batch files and
  workflow prompt files are checked before Google is touched.
- `create --design`/`--outline-file` without `--prompt` and `--template-scenes`
  without `--template` are usage errors; `download <id> <existing file>` fails before
  the editor opens.

**Safety**

- A workflow `share` step (anyone/domain) made the video public without `--yes`; it
  now needs `--yes`, the dry-run reports `publicSharing` and `requiresUserApproval`,
  and the MCP `vids_run_workflow` tool has a `confirm` parameter.
- `--dry-run --detach` started a real background worker; dry-run now always wins.
- Batch and MCP checked only the first argument: `["--yes","mcp"]` or
  `["--human","mcp"]` started a nested MCP server on the caller's stdio. The resolved
  command is checked now (batch refuses `batch`/`mcp`, MCP refuses `mcp`/`completion`),
  and person-only commands return `USER_ACTION_REQUIRED` with the command for the user.
- `auth logout` and `unshare` now need `--yes`.
- `--client-secret` values were echoed in dry-run output, task records, batch results
  and confirmation retries; they are masked now.
- The Drive transport would send the OAuth bearer token to any URL it was handed (for
  example a thumbnail link); it now only sends it to https Google hosts.
- Failure diagnostics (screenshots, page snapshots) went to `./.gvids-debug` in the
  caller's working directory; they now go to `~/.gvids/debug`.

**Background tasks**

- Race: the starter could overwrite a finished worker's result with "running"
  (results are now written once, by the worker, with an exclusive create).
- A `batch` inside a worker marked the task finished after its first item (nested runs
  inherited the task ID).
- A crashed worker whose PID was reused looked "running" forever; workers now write a
  heartbeat every 5 s and a task whose heartbeat is older than 60 s is reported failed.
- `task cancel` hard-killed the worker, orphaning its Chrome tabs. Cancellation is now
  cooperative (the worker closes its tabs and records `CANCELLED`), with a kill after 15 s.
- Found by the live suite: a cancelled task could be recorded as `failed` (exit 7)
  because closing the browser made the running step fail first. Errors raised during
  shutdown are now reported as `CANCELLED`.
- Finished tasks are pruned after 7 days; a corrupted task file is `TASK_NOT_FOUND`
  instead of a crash.

**Browser**

- Two commands started at the same time with no browser running both failed (each
  launcher removed the other's DevTools port file). Browser start is serialized with
  a lock file and commands hold leases on the shared browser: the last user closes a
  one-off browser, `browser close` refuses while others use it (`--force` overrides),
  stale leases of dead processes are ignored and an unresponsive browser is restarted.
  Live: three parallel commands succeed and the browser is closed afterwards.
- Signing in to Chrome in the gvids profile had synced the user's 15 extensions into
  it (358 MB, among them shopping, AI-assistant and cookie-editor extensions), and
  they ran inside the pages gvids automates. The automation browser now starts with
  `--disable-extensions` (the `browser login` window keeps them). Live: no extension
  targets in the browser, editor commands pass, and browser start plus the Vids home
  page load fell from 2.4 s to 1.5 s (medians of 4 interleaved runs).

**Workflows, MCP, config, packaging, tests**

- A failed `run` did not name its job; it now returns `details.jobId` and
  `next: ["gvids job resume <id>"]`; an interrupted run marks the job cancelled.
- MCP: `--json` was appended last (it broke after `--`); `--human`/`--pretty` are
  ignored; `vids_wait` waits 45 s per call by default (below common client
  timeouts). The smoke script printed results against the real `~/.gvids`; it now
  asserts 17 checks against a temporary home.
- An invalid config file blocked every command, even `config reset`. Reads now fall
  back to defaults with a warning and `config set/unset/reset` repair the file;
  unknown keys produce a notice; the legacy `output.json` key is migrated to
  `output.format`; `config path` lists the tasks and debug folders; `env` listed a
  stale `GVIDS_JSON`.
- `build` did not clean `dist/`, so a deleted module (`dist/cli/interactive.js`) was
  still shipped, and source maps were shipped without their sources. `build` and
  `prepack` clean first and emit no maps; `docs:check` and `check` scripts added.
- The live Drive test passed without OAuth (it checked nothing); it now reports
  SKIPPED. Unit-test runs left about 110 temporary folders each (3,540 had piled up)
  and live runs left their exported MP4/GIF files; every run now uses one temp folder
  that is removed at the end.

### Breaking changes (pre-release 0.1.0)

- `auth status`, `browser status` and `doctor` exit non-zero with `ok:false` when
  something is missing (the full report stays in `data`); `doctor`'s `ok` field is
  now `ready`.
- `auth logout`, `unshare` and workflows that share publicly need `--yes`.
- `completion` prints the raw script again (`--json` for an envelope).
- Timeouts exit 8 instead of 1.
- Debug artifacts moved from `./.gvids-debug` to `~/.gvids/debug`.
- The legacy `output.json` config key is migrated automatically (with a notice).

## Performance

Measured on this machine (idle), medians:

| Measurement                                              | Before                         | After                             |
| -------------------------------------------------------- | ------------------------------ | --------------------------------- |
| Loading the CLI modules (12 interleaved runs)            | 279 ms (eager Google/zod/yaml) | 87 ms                             |
| `gvids version` / `commands` / a `--dry-run`, end to end | 376 ms (eager imports)         | ~180 ms (bare `node -e 0`: 74 ms) |
| Two commands starting a browser at the same time         | both fail                      | both succeed (3 tested)           |
| Browser start + Vids home page load (4 interleaved runs) | 2.4 s (extensions loaded)      | 1.5 s (`--disable-extensions`)    |
| Editor command, cold (browser start + editor)            | ~6.5 s                         | ~4.9 s (one run)                  |
| Editor command with a warm browser, reused tab           | ~2.3-2.8 s                     | ~2.3-3 s (+~70 ms lock and lease) |

Google API, zod and yaml modules are now loaded only by the commands that need them.
Browser commands are bound by Chrome and the Vids editor; the shared-browser
coordination adds about 70 ms, and not loading extensions saves about 0.8 s per
browser start.

## Definition of done

| Requirement                             | Status                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `gvids auth login`                      | implemented (loopback + PKCE, keyring storage); **not run**: needs your OAuth client     |
| `gvids list`                            | ✅ live through the Vids home page (no OAuth); Drive API path unit-tested                |
| `gvids create "Test Video"`             | ✅ live                                                                                  |
| `gvids open`                            | ✅ live (`open`/`url` need no API)                                                       |
| `gvids info`                            | ✅ live through the editor (no OAuth); Drive API path unit-tested                        |
| `gvids rename`                          | ✅ live through the editor fallback; Drive API path unit-tested                          |
| `gvids capabilities`                    | ✅ live (25 UI features, models, 37 voices, 53 avatars)                                  |
| `gvids download test.mp4`               | ✅ live through the editor fallback (valid MP4); Drive `files.download` path unit-tested |
| `gvids doctor`                          | ✅ live                                                                                  |
| ≥1 real editor operation via automation | ✅ dozens (see below)                                                                    |

## What works — verified live

Headless Chrome with the gvids profile unless noted. Times are wall-clock for the
whole command, including browser start.

**Account and browser**

- `browser login` (plain Chrome window, you sign in; verified headlessly afterwards),
  `browser status`, `browser open`, `browser close` (and its refusal while another
  command uses the browser).
- `browser connect http://127.0.0.1:<port>` / `disconnect`; non-loopback endpoints are
  refused (exit 2) without `--allow-remote`.

**Creating videos**

- `create "Title"` blank (≈5 s), `--format portrait|square`.
- `create --prompt "…"`: Gemini storyboard, 13 scenes in 34 s.
- `create --template tutorial`, `--template personal-celebration --template-scenes 1,3,2`
  (order kept; slugs or display names).
- `create --upload clip.mp4` (Google's "Open a file" picker → Upload → Browse), 7 s.
- `create --slides <presentation>` (start dialog's Slides to video, AI narration), 18 s.

**Editing**

- Scenes: `list`, `add`, `duplicate`, `move`, `delete --yes`, `background` (hex and
  palette), `duration` (3, 4.2, 5, 6.5, 8 and 10 s all landed exactly), `format` get/set.
- Text: `list`, `add`, `edit`, `delete`, and styling, checked on a screenshot:
  `--bold --italic --size 60 --align center --color "#d93025"`.
- Media: `media add` PNG; `media add-drive` via the editor's Drive picker (no OAuth).
- Templates: `template list --refresh` (104), `template apply --after 1 --scenes 9,4`.
- Voiceover: `voices` (37), `generate --voice Knox`, `remove`; `script get`,
  `script set --file -` (stdin); empty scripts read as "".
- Avatars: `avatar list` (53).
- AI: `ai options` (Create/Edit/Animate models and aspect ratios). `ai generate`
  with the prompt "A slow cinematic pan across a calm ocean at sunrise" and
  `--scene 2` produced a 10 s clip in about 4.5 minutes, and gvids detected it in the
  scene (the preview's final "Insert" choice was automated after this run; see
  "Experimental").
- Slides: `slides import --no-ai`, `--slides 1`, AI narration (Gemini script +
  "Narrator" voiceover); out-of-range slides are rejected (exit 2).
- Trash: `trash --yes` / `restore` through the editor; editing a trashed video fails
  fast with `VIDEO_IN_TRASH` (exit 5); both are idempotent.

**Export**

- `export --via-browser` MP4: 1:50 video → 24 MB in 15 s; `download test.mp4` without
  OAuth → editor render (valid `ftyp`), `--overwrite` guard, title-based file names.
- `export --format gif`: 5 s video → GIF89a in 14 s. Videos over 30 s get Vids'
  "Can't download GIF" dialog; gvids reports `FEATURE_UNAVAILABLE` (exit 6) in 6 s.

**Processes, parallel work and background tasks** (`tests/live/processes.live.test.ts`,
the built CLI run as separate processes, the way an agent runs it)

- Three commands started at once with no browser running (`scene list`, `info`,
  `format`) all succeed on one shared browser, which is closed after the last one.
- A warm browser (`browser open`) and its idle tab are reused by the next command.
- `--detach` then `wait` relays the worker's envelope and exit code. While a
  background task uses the browser, `browser close` refuses; `task cancel` stops the
  worker, which records `CANCELLED` (exit 130) and releases the browser, after which
  `browser close` succeeds.
- A packaged install (`pnpm pack`, production dependencies only) ran `scene list`
  (4.3 s) and `--detach info` + `wait` against the live editor.

**Automation, agents, operations**

- Workflows: `gvids run examples/simple-video.yaml` — 12 steps (create, backgrounds,
  titles, subtitle, image, export) in 45 s; `jobs`, `job status`, `job resume` on a
  completed job.
- MCP: `gvids mcp` over stdio with the official SDK client: 30 tools with annotations;
  `vids_open`, `vids_capabilities`, `vids_commands`, the generic `gvids` tool,
  `vids_get` (error path) and `vids_scene_duration` (browser-backed) ran;
  destructive tools refuse without `confirm: true`.
- Agent interface: `list` (14 videos, 3.6 s) and `search` (4.1 s) through the Vids
  home page and `info` through the editor (2.2 s), all without OAuth; `--progress`
  events; `batch` of four reads in 5.2 s; `trash` without `--yes` returning the
  approved command.
- `capabilities --refresh --deep`, `doctor`, `debug inspect --menus`,
  `debug screenshot`, `debug aria`, `debug page-html` (inline scripts stripped),
  `--debug` Playwright traces + `debug trace list`, `config`, `env`, `version`,
  `completion`.
- Windows: global install with `npm link`; PowerShell, cmd.exe and Git Bash, exit
  codes, stdin piping (`--prompt -`, `--file -`).

## What was tested and how

| Suite                             | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                     | Result                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm test` (Vitest, offline)     | 241 tests in 14 files: URL/ID parsing, errors and agent fields, config validation and migration, the output contract for every command family, dry-run and nesting safeguards, redaction, Drive service against a fake transport, CLI end-to-end in-process (help, catalog, confirmation, detach/wait, batch), task store, browser lock and leases, shutdown, workflows/jobs/resume, MCP adapter, UI label patterns, browser launch flags | ✅ 241 passed, ~2.5 s                                           |
| `pnpm test:live` (`GVIDS_LIVE=1`) | editor suite (create, scenes, text, duration, script, image, background/format, template + voiceover, MP4 export, download + GIF, trash/restore, capabilities), processes suite (above), Drive suite (skipped without OAuth), one opt-in AI test                                                                                                                                                                                          | ✅ 15 passed, 7 skipped (6 Drive: no OAuth; 1 opt-in AI), 222 s |
| `pnpm mcp:smoke`                  | stdio MCP server with the official client, temporary home: tool list and annotations, envelopes, dry-run, `--yes` enforcement, nesting refusals, person-only commands, batch, `vids_wait`                                                                                                                                                                                                                                                 | ✅ 17 checks                                                    |
| `pnpm check`                      | Prettier, ESLint, `tsc --noEmit`, unit tests, `docs:check` (generated command reference up to date)                                                                                                                                                                                                                                                                                                                                       | ✅                                                              |
| Package                           | `pnpm pack` (96 files, 348 KB, no tests, maps or secrets), production-only install from the tarball, then version, commands, guide, completion, dry-run, doctor, tasks, MCP smoke and live commands from the install                                                                                                                                                                                                                      | ✅                                                              |
| Fresh checkout                    | the repository files copied to an empty folder, `pnpm install --frozen-lockfile`, `pnpm check`, build, MCP smoke                                                                                                                                                                                                                                                                                                                          | ✅                                                              |

### Exact commands

```bash
pnpm install
pnpm check                                 # format, lint, typecheck, unit tests, docs
pnpm build
pnpm mcp:smoke
npm link                                   # gvids on PATH
gvids browser login                        # you sign in once
gvids doctor
GVIDS_LIVE=1 pnpm test:live                # PowerShell: $env:GVIDS_LIVE=1; pnpm test:live
```

## Not live-tested

- **Drive API** (no OAuth client on this machine): `auth login/status/logout`, the API
  paths of `list`, `search`, `info`, `rename`, `trash`, `restore`, `download`
  (`files.download`), plus `copy`, `move`, `delete`, `thumbnail`, `permissions`,
  `share`, `unshare`, `url --check`, `--folder`, `create --via-api`,
  `storyboard --context-drive-file`. All are unit-tested against a fake transport.
  To verify them:
  1. In Google Cloud Console, enable the Google Drive API and create an OAuth client
     of type **Desktop app** (README → "Google OAuth setup").
  2. Save its JSON as `~/.gvids/client_secret.json` (never commit it).
  3. `gvids auth login` (you approve in the browser), then `gvids auth status`.
  4. `pnpm build`, then `GVIDS_LIVE=1 pnpm test:live`. The Drive suite creates one
     video, a copy and a folder, shares the video publicly and unshares it, and
     removes everything at the end.
- **AI allowance**: `avatar generate`, `ai edit`, `ai animate` and the automatic
  choice in the AI clip preview (`--insert`). The opt-in test runs with
  `GVIDS_LIVE_AI=1`.

## APIs used

Official, documented Google APIs only:

- **Drive API v3**: `files.list`, `files.get` (metadata; `alt=media` for Drive media
  files), `files.update` (rename, move, trash/restore), `files.copy`, `files.delete`,
  `files.create` (`create --via-api`), `permissions.list/create/update/delete`,
  `about.get`, **`files.download`** (`mimeType=video/mp4`, a long-running operation)
  with `operations.get` polling, and the file's `thumbnailLink`. Vids files are
  `application/vnd.google-apps.vid`; `files.export` is not supported for them.
- **OAuth 2.0 for installed apps**: authorization endpoint with loopback redirect,
  PKCE (S256) and `state`; token, refresh and revoke endpoints; `tokeninfo` for
  `auth status`. Scope: `drive` (or `drive.readonly`).

No private or undocumented Google endpoints are called. The editor is driven only
through its UI (accessibility roles and names).

## Browser-driven functions

All in `src/browser/` (page objects in `pages/`, labels in `selectors/`):

Create (blank, format, template + scene selection, upload, Slides, AI storyboard),
rename, trash/restore, storyboard (generate, regenerate, custom outline, inspect),
scenes (list, add, duplicate, move, delete, background, duration), video size,
text (list, add, edit, delete, style), media (upload, Drive picker, delete), templates
(gallery, apply), voiceover (voices, generate, remove), scripts (get, set), avatars
(list, generate), AI video (options, generate, edit, animate), Slides import, UI
export (MP4/GIF), capabilities probe, debug tooling.

## Experimental (implemented, not run end-to-end)

- `avatar generate`, `ai edit`, `ai animate` — they spend AI allowance; built on the
  same panel code as the verified voiceover and AI generate flows.
- The automatic choice in the AI clip preview (`--insert new-scene|current-scene|none`):
  implemented after the live generation, with the exact buttons observed then ("Insert
  in new scene", "More options" › "Insert in current scene"); during that run the final
  click was made by hand with the same locators and gvids detected the inserted clip.
- `storyboard regenerate` / `create-draft --outline-file` / `--outline-only` (the
  storyboard itself is verified through `create --prompt`).
- `media add` for video/audio files (PNG verified), `media delete`.
- All Drive API commands (see "Not live-tested").

## Unsupported

- Google publishes no Vids editing API; editor features exist only via UI automation.
- Not automated: recording (camera/screen), music and image generation, captions,
  Export to Drive / YouTube (publishing left to you), transitions, animations,
  crop/trim/replace, precise object positioning, comments, version history, creating
  personal avatars (needs a verification recording).
- GIF export of videos longer than 30 s (Vids limit).
- `download --revision` without OAuth (only the API can fetch revisions).

## Known issues and limits

- **UI dependency.** Editor commands depend on Google's English UI (`hl=en` is forced).
  When it changes, commands fail with `UI_CHANGED` and save a screenshot, a sanitized
  accessibility snapshot and a JSON summary to `~/.gvids/debug`; labels live in
  `src/browser/selectors/`.
- **UI variants.** Vids showed different pickers for the same action on different runs
  (modal vs. embedded in the Uploads panel); gvids handles the variants seen so far.
- **Same video, two commands.** Commands may run in parallel, but two commands editing
  the same video at the same time can interfere (each has its own tab).
- **Interrupted runs** can leave a dialog open in a reused tab; `gvids browser close`
  resets it.
- **AI generation is slow** (about 4.5 minutes for a 10 s clip); use `--detach` and
  `gvids wait`, or `--timeout 15m`.
- `scene list` text comes from timeline thumbnails: letter-spaced designs read as
  "g o o d l u c k", and very long videos may lazily render off-screen thumbnails.
- `download` without OAuth and without an output path opens the editor to learn the
  title (for the file name) before it can check whether that file exists.
- A freshly inserted video can briefly read as `image` in `text list` before its player
  loads.
- Vids greys out File › Move to trash for a video that was **never edited**, so the
  editor-based `trash` asks you to rename/edit it first (the Drive API path has no
  such limit).
- Opening a never-edited video closes its "Getting started" dialog (the video stays
  blank, as with the dialog's Close button).
- `task cancel` kills a worker that has not stopped after 15 s. A killed (not
  cancelled) worker can leave its tab open: in a one-off browser until the next
  command closes that browser as its last user, in a warm browser until
  `gvids browser close`.
- pnpm 11+ has no `pnpm link --global`; use `npm link` from a checkout.
- Without the Drive API, `list` shows only what the Vids home page lists (recent
  videos, 15 on this account); use `search` for others.
- A command's first run in a fresh browser pays ~6 s for the browser and editor;
  keep one warm with `gvids browser open --headless`.

## Notes on the test sessions

- The first live run of the editor suite failed two tests: a trashed video's "File is
  in trash" dialog can appear before the editor toolbar and hides the editor from the
  accessibility tree. `waitReady` now recognizes it (fast `VIDEO_IN_TRASH`).
- During early exploration (2026-09-22) stray keystrokes in a Vids tab probably
  submitted a thumbs-up on a Vids feedback toast. gvids itself only ever presses
  _Got it_ / _Close_ on popups.
- Exploring left your Vids "menus shown" setting on; it was switched back to the
  default compact mode (menus hidden) and gvids restores it after every command.

## Test resources in your Google account

Created by this work on 2026-09-22/23 (titles as they are now). Nothing else was
modified or deleted; your own four "Untitled video" files were not touched.

| ID                                             | Title / purpose                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `1o6R8YXWie-GdbccB5GXnNl0VQ4Cxz-KLO28tPk4SjJs` | "gvids test video": main exploration video (~1:50)                     |
| `1X98GK2K5T5VQzUZKri6A-bctoB03n6r_6ccVD7PDmMU` | "Photosynthesis: How Plants Make Food": first storyboard exploration   |
| `1WyWmAFC6oaoqjJEyH3E7U1zBEYjqE2j4Od6btbB9se4` | "gvids storyboard test": `create --prompt` (13 scenes)                 |
| `1PBJiWFz-YFk16-HrweN9MBqa22l387Md6stHTPwS584` | "gvids storyboard probe": 5 s video used for styled text + GIF         |
| `1ypXRSuJyy5N9W_IqijvIMOQ5AbpaDM3jk3rHcWqX_I4` | "Simple gvids video": workflow example, AI clip in scene 2, test image |
| `1K-2V8hKvFNRD_QlSdUOG2e5BzXL9zb_ITh8pUMGRolg` | "gvids trash test": trash/restore and Slides imports                   |
| `1nfwEAvXw2vL85Y2olo6XAiPWXDQOHUKmjaBoJ8IieCE` | "gvids template test (renamed)": also used to verify `rename`          |
| `1PJswUYzH3zkoJp95JknuZCH_ONfd5QY-71Uw6Q9PEsw` | "gvids template test 2"                                                |
| `1ugWd2eSVUnWcBZzbtULg1lZ7jntxqHjb0GhpqkAaQ2w` | "gvids upload test"                                                    |
| `1axMVzvVUWk7wfbtQhVWzlHH9M0Ji3DYXtdYgWscVkeI` | "gvids slides create test"                                             |
| `1HeSZYa-5AylrHHzuI_PqU_U6d-M7jwgaxMsUEw5ldJ8` | Google Slides "gvids slides test" (one blank slide)                    |
| `1__OYly-11CX6tRMT0Dp9mXhcTMglZ7oK`            | Drive image "gvids-test-media.png" (My Drive)                          |

They are kept as reference material for the verified features. To remove them:

```bash
gvids trash 1o6R8YXWie-GdbccB5GXnNl0VQ4Cxz-KLO28tPk4SjJs --yes   # repeat per video ID
```

The Slides deck and the PNG are ordinary Drive files: move them to the trash from
Google Drive.

### Cleanup

Every live-suite run creates its own video ("gvids live test …", "gvids process live
test …") and moves it to the trash at the end (recoverable for 30 days). After the final runs, the process-suite videos were confirmed in the trash (`gvids info` returns `VIDEO_IN_TRASH`) and no "gvids live test" video is left in the Vids home list.

Moved to the trash earlier (recoverable for 30 days with `gvids restore <id>`):

| ID                                             | What it was                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `161lyxlzjQK6gcbYWx_JkIgs_9NFlrbfCWuB9tB2oQTU` | "Untitled video" from start-dialog exploration                     |
| `1yqPHVaTxP9EPwUZ-BHuf44dJEDVB5TQ55I5pW5J0R40` | "Untitled video" left by a failed `create --template` run          |
| `1rY_eCm3vb3TNBFAyopH4A7Csf1KrVonIlkV1Qn1j6ZI` | empty video from picker exploration (renamed before trashing)      |
| `1ZhKE3-0nZUIUe1nVRoBu4J2IUv6N-CIgDXm1n3rb7D4` | empty video left by a failed `create --upload` run (renamed first) |
| `1ungfz82Lyv-MYP8bHNufaCOs3Vlj2OJNf6pMUvFrZDM` | empty video left by a failed `create --slides` run (renamed first) |
| `1PGMlROoxIVlWPOA-ko1-k-cn2v0EyLUWuHvkWx693Z4` | empty video left by a failed `create --slides` run (renamed first) |
| `152NUUTWrTlpUNUYZY71bwBMawrn8A9utJBv7ZQHNOPo` | "gvids live test 2026-09-23-12-17" (first live-suite run)          |

The never-edited videos had to be renamed "gvids leftover (empty test video)" first
because Vids disables Move to trash for unedited videos.

## Project structure

```
src/
  cli/          program.ts (Commander tree, global flags, worker tasks), index.ts (entry,
                signals), context.ts, kit.ts (dry-run, detach, nesting, validation),
                catalog.ts, fallback.ts, automation.ts (withAutomation), output/,
                commands/*.ts
  auth/         OAuth loopback + PKCE, client credentials, scopes, token store (keyring/file)
  google/       Drive transport (Google hosts only), files/permissions services,
                downloads (files.download LRO)
  browser/      launcher, session (external/reused/launched over CDP), coordination.ts
                (launch lock, leases), ui.ts (uiStep), diagnostics/, selectors/ (all UI
                labels), pages/ (editor, start dialog, storyboard, panels), operations/
  automation/   workflow schema + planner, job store, runner (resume/cancel), executor,
                tasks.ts (background task store and workers)
  mcp/          MCP server (tools call the CLI in-process with --json)
  config/ errors/ utils/ (shutdown registry, redaction, input checks) vids/ version.ts
tests/          unit/ (offline), live/ (opt-in), helpers/, fixtures/
docs/           architecture, authentication, browser-automation, commands (generated),
                google-drive, google-vids, research, troubleshooting, workflows
examples/       simple-video, ai-video, slides-to-video, narrated-video, batch-project
scripts/        clean.mjs, generate-command-docs.ts, mcp-smoke.mjs, mcp-call.mjs
```

## Setup

See README: Node 22.12+, `pnpm install && pnpm build && npm link`, then
`gvids browser login`. For Drive features create a Desktop OAuth client, save it as
`~/.gvids/client_secret.json`, and run `gvids auth login`.

## Next improvements

1. Run the Drive half live once an OAuth client exists (`GVIDS_LIVE=1 pnpm test:live`)
   and record fixtures from real responses.
2. Run `avatar generate`, `ai edit`/`animate` and the automatic AI insert choice once
   (each uses AI allowance) and promote them to verified.
3. A nightly live canary that runs `gvids capabilities --refresh --deep` and the live
   suite to catch UI changes early.
4. Media crop/trim/replace, transitions and animations (UI exists; not automated).
5. Non-English UI support by moving labels into per-locale tables (today `hl=en` is
   forced).
6. A per-video lock, so two commands cannot edit the same video at the same time.
