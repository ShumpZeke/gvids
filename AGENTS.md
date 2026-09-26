# gvids — guide for AI agents

gvids drives Google Vids (Google's video editor) from the command line. It is built
to be called by agents: every command prints one JSON envelope, never prompts, and
reports failures as typed errors that say whether to retry, ask the user, or change
the arguments. `gvids guide` prints this file.

## 1. Output contract

Every command prints exactly one line of JSON on stdout:

```json
{"ok":true,"data":{...},"error":null}
{"ok":false,"data":null,"error":{"code":"LOGIN_REQUIRED","message":"...","exitCode":3,"retryable":false,"needsUser":true,"next":["gvids browser login"],"hint":["..."]}}
```

- The process exit code is `0` exactly when `ok` is `true`; otherwise it equals
  `error.exitCode`.
- `warnings` (array of strings) is added when something non-fatal happened, e.g. a
  fallback from the Drive API to the browser. Read it; do not treat it as failure.
- `data` can be present next to `ok:false` when there is useful partial
  information: `batch` (every item's result), `wait`, and the status commands
  `auth status`, `browser status` and `doctor` (the full status/report).
- stderr is silent. `--progress` streams JSON-line events there
  (`{"type":"status","message":"...","ms":1234}`); `--verbose` adds JSON-line logs.
  Every line on either stream is valid JSON, so `2>&1` stays parseable.
- `--pretty` indents the JSON. `--human` prints for people (avoid it).
- Exceptions: `guide` prints Markdown and `completion` a shell script (add `--json`
  to get either inside an envelope); `mcp` speaks MCP; the person-only commands
  `browser login` / `auth login` print sign-in instructions on stderr.
- A command group without a subcommand (`gvids scene`) returns the group's
  commands; `gvids` alone returns an overview.

Exit codes: 0 ok · 1 error · 2 invalid arguments or confirmation required ·
3 sign-in/OAuth required · 4 permission denied · 5 not found · 6 feature
unavailable (account, admin, region, quota, UI state) · 7 browser automation
failure · 8 timeout or still running · 9 Google API failure · 130 cancelled.

## 2. Handling errors

Decide from the error fields, in this order:

1. `needsUser: true` — only a person can fix it (sign in, consent, approve an
   action, change admin/plan settings). Tell the user what is needed; show them
   `next`. Do not try to work around sign-in, CAPTCHAs or permissions.
2. `retryable: true` — transient (UI timing, a closed tab, rate limit, 5xx,
   timeout, `STILL_RUNNING`). Retry once; for timeouts raise `--timeout`
   (e.g. `--timeout 20m`).
3. Otherwise fix the command: `INVALID_ARGUMENT` has `next: ["gvids <cmd> --help"]`;
   parse errors also carry `details.usage`; a name that does not exist (voice,
   template, palette color) lists the valid ones in `details.available`.

Common codes:

| Code                                                     | Meaning / what to do                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `LOGIN_REQUIRED`                                         | the gvids browser is not signed in: ask the user to run `gvids browser login`                      |
| `AUTH_REQUIRED`, `OAUTH_CLIENT_MISSING`, `TOKEN_EXPIRED` | no usable Drive API login; many commands fall back to the browser anyway                           |
| `USER_ACTION_REQUIRED`                                   | a person-only command was sent through `batch` or MCP: ask the user to run `next[0]` in a terminal |
| `CONFIRMATION_REQUIRED`                                  | see the safety rules below                                                                         |
| `VIDS_NOT_FOUND`, `VIDEO_IN_TRASH`                       | wrong ID, or restore first (`gvids restore <id>`)                                                  |
| `FEATURE_UNAVAILABLE`                                    | read the message: landscape-only, GIF over 30 s, never-edited video, …                             |
| `QUOTA_EXCEEDED`, `FEATURE_DISABLED_BY_ADMIN`            | account limits: tell the user                                                                      |
| `UI_CHANGED`                                             | retry once; if it repeats, report it with the files in `details.files`                             |
| `BROWSER_SESSION_ERROR`                                  | retryable; if it repeats: `gvids browser close`, then retry                                        |
| `GENERATION_TIMEOUT`, `STILL_RUNNING`                    | not failures of the work itself: wait longer                                                       |
| `CONFIG_ERROR`                                           | `next` has the `gvids config unset <key>` that repairs the file                                    |
| `NOT_READY`                                              | from `gvids doctor`: `next` lists the fixes                                                        |
| `CANCELLED`                                              | stopped by Ctrl+C, SIGTERM or `gvids task cancel`                                                  |

If `create` fails after the video was made, `details.createdVideo` names it:
retry the remaining steps on that video instead of creating another.

## 3. Safety rules

- Nothing ever prompts. These fail with `CONFIRMATION_REQUIRED` until `--yes` is
  given: `trash`, `delete`, `scene delete`, `unshare`, `share --anyone/--domain`,
  a workflow (`run` / `job resume`) that shares publicly, `auth logout`,
  `config reset`, `browser reset`. `error.next[0]` / `error.details.retryArgs`
  hold the exact command to run **after the user approved it**. Never add `--yes`
  on your own initiative.
- Removing a text box, media object or voiceover inside a video does not need
  `--yes` (Vids keeps version history), but it is `destructive` in the catalog.
- The same rules hold in `batch` (each item needs its own `--yes`) and through the
  MCP server (`confirm: true` on curated tools, or `--yes` in the generic tool's
  `args`).
- `--dry-run` on any command checks the arguments (IDs, numbers, colors, local
  files) and describes the effect without doing anything (`data.effect`,
  `data.run`, `data.requiresUserApproval`). It also wins over `--detach`.
- `gvids commands` marks every command with `effect` (read/write/destructive),
  `backend`, `confirm`, `aiQuota` (spends the user's Google AI allowance), `slow`
  and `human` (needs a person, e.g. `browser login`). Ask before spending AI quota
  if the user did not ask for AI generation.
- `trash` is recoverable for 30 days (`gvids restore <id>`); `delete` is permanent.

## 4. Before you start

```bash
gvids doctor            # what works here; fails with NOT_READY (report in data) if something blocks gvids
gvids capabilities      # cached feature list for this account (--refresh to re-probe)
```

- Editing needs the gvids browser profile signed in. If `LOGIN_REQUIRED`, ask the
  user to run `gvids browser login` (they sign in themselves).
- The Drive API (OAuth) is optional. Without a usable login, `list`, `search`,
  `info`, `rename`, `trash`, `restore`, `download`, `export` and `media add-drive`
  use the browser instead (see `warnings`). Only `copy`, `move`, `delete`,
  `thumbnail`, sharing and some list filters need `gvids auth login`.
- Videos are named by ID or by any Google Vids/Drive URL.

## 5. Finding videos and commands

```bash
gvids list                      # recent videos: data.files[].{id,name,url}
gvids search "quarterly"        # title search
gvids info <id>                 # title, scenes, duration, format
gvids commands                  # all commands, one line each
gvids commands scene --full     # arguments and options for the scene commands
gvids scene add --help          # one command as JSON
```

## 6. Recipes

Text options (`--text`, `--prompt`, `--script`) take literal text, `-` (read stdin)
or a path to a `.txt`, `.md`, `.json` or `.yaml` file. A value that starts like a
path (`./`, `../`, `/`, `~/`, `C:\`) must be an existing file, so send text that
starts with `/` through stdin.

Create from a prompt (Gemini storyboard, ~35 s, 10-15 scenes):

```bash
gvids create "Photosynthesis" --prompt "A 60 second explainer about photosynthesis for 10-year-olds"
```

Build step by step:

```bash
gvids create "Launch recap"                           # -> data.id
gvids scene add <id>                                  # blank scene 2
gvids text add <id> --scene 1 --text "Launch recap" --size 60 --bold
gvids scene background <id> 1 --color "#101010"
gvids media add <id> ./chart.png --scene 2
gvids script set <id> --scene 2 --text "Revenue grew 20 percent."
gvids voiceover generate <id> --scene 2 --script "Revenue grew 20 percent." --voice Knox
gvids scene duration <id> 2 --seconds 6.5
gvids scene list <id>                                 # verify
```

Other starting points:

```bash
gvids create "Deck video" --slides <presentation-url>           # AI narration (Vids default)
gvids slides import <id> <presentation-url> --no-ai --slides 1-3
gvids create "Onboarding" --template tutorial --template-scenes 1,3
gvids create "Clip" --upload ./clip.mp4
```

AI video clip (4-5 minutes; spends AI allowance): run it in the background.

```bash
gvids ai generate <id> --prompt "Slow aerial shot of a coastline at sunrise" --scene 2 --detach
gvids wait <task-id> --timeout 9m     # repeat while error.code == STILL_RUNNING
```

Export:

```bash
gvids download <id> out.mp4           # MP4 (Drive render, or the editor without OAuth)
gvids export <id> out.gif --format gif   # GIF only for videos of 30 s or less
```

Several commands in one call (stops at the first failure unless `--keep-going`;
an item may use `--detach` to start background work):

```bash
echo '[["scene","add","<id>"],["text","add","<id>","--scene","2","--text","Hello"]]' | gvids batch
```

A whole video as a file (resumable job):

```bash
gvids run video.yaml --dry-run        # plan (requiresUserApproval if it shares publicly)
gvids run video.yaml --detach         # then: gvids wait <task-id>
gvids job resume <job-id>             # after a failure: error.next names it
```

Workflow format: `docs/workflows.md` and `examples/*.yaml`.

## 7. Long operations and parallel work

- Typical times: editor commands 2-10 s each; storyboard ~35 s; Slides import
  10-20 s; MP4 export of a 2-minute video ~15 s; AI clip 4-5 min.
- For a series of editor commands, start a warm browser first:
  `gvids browser open --headless` (later commands attach in ~2 s instead of
  launching one in ~6 s), and `gvids browser close` when you are done.
- `--detach` runs any command in a background process and returns
  `data.taskId`. `gvids wait <task-id>` returns that command's own envelope and exit
  code, or `STILL_RUNNING` (exit 8, retryable) after `--timeout` (default 5m).
  `gvids tasks` lists them, `gvids task status <id>` shows the latest progress
  event, `gvids task cancel <id>` stops one (it closes its tabs first).
- Commands may run in parallel (several shells, background tasks, MCP calls):
  they share one browser, each in its own tab, and the browser closes after the
  last one unless it was opened with `browser open`. Do not edit the same video
  from two commands at once. `gvids browser close` refuses while other commands
  use the browser; wait for them or pass `--force`.

## 8. Limits of Google Vids

- Templates, Slides import and the AI storyboard need a **landscape** video
  (`create` handles this; convert with `gvids format <id> portrait` afterwards).
- The storyboard only works on a new, unedited video: use `create --prompt`.
- GIF export only for videos of 30 seconds or less.
- A never-edited video cannot be trashed through the editor; rename it first.
- Scene lengths snap to 0.1 s. Imported slides are appended after the last scene.
- Not automated: recording, music and image generation, captions, transitions,
  animations, crop/trim, exact object positions, publishing to YouTube.

## 9. MCP

`gvids mcp` serves the same commands over MCP (stdio), with the same safeguards.
Curated tools (`vids_*`) carry read-only/destructive/idempotent annotations; the
`gvids` tool runs any command (`{"args":["scene","list","<id>"]}`) and
`vids_commands` lists them. Destructive tools need `confirm: true` (or `--yes` in
`args`) after the user approved. `vids_wait` waits up to 45 s per call (below
common MCP client timeouts): call it again on `STILL_RUNNING`. Use `--detach` for
anything slow. Person-only commands come back as `USER_ACTION_REQUIRED`.
