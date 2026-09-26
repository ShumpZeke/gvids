---
name: gvids
description: Create, edit, share, export and debug Google Vids videos with the gvids CLI (or its MCP server). Use when the user wants anything done in Google Vids - making a video from a prompt/template/Slides/Doc/upload, editing scenes/text/media/captions/voiceover, AI clips/images/music/avatars, sharing, exporting MP4/GIF - or when a gvids command fails and needs diagnosing.
---

# gvids

`gvids` drives Google Vids: the Drive API for file operations, a real Chrome
(Playwright) for everything in the editor. Every command prints ONE JSON line:
`{"ok":true,"data":...}` or `{"ok":false,"error":{code,message,retryable,needsUser,next,hint}}`.
Never parse `--human` output. Full contract: `gvids guide` (AGENTS.md).

## Start of every session

```bash
gvids doctor          # auth, browser, Vids access; fix what it lists
gvids commands        # every command with effect/backend/aiQuota flags
gvids <cmd> --help    # args and options as JSON
```

## Rules

- Run `--dry-run` first for anything that writes; it validates and never acts.
- `CONFIRMATION_REQUIRED` -> ask the user, then rerun the command given in `error.next` (adds `--yes`).
- `aiQuota: true` commands (ai generate/edit/animate, avatar, image/music generate,
  storyboard, docs import, slides import with AI) spend the user's Google AI allowance:
  get approval first. `docs import --script-only` / `storyboard ... --outline-only` preview cheaply.
- Never permanent-delete (`gvids delete`) unless the user explicitly asks; use `gvids trash`.
- One command per video at a time is enforced (`VIDEO_BUSY` = wait and retry).
- Scene numbers are 1-based. IDs accept bare IDs or full URLs.

## Common recipes

```bash
gvids create "Title" --prompt "60s explainer on photosynthesis"      # AI storyboard
gvids create "Title" --template "New employee onboarding"
gvids create "Title" --doc <doc-url> --voice Kaci                     # Docs to video
gvids scene list <id>; gvids text add <id> --scene 2 --text "Hi"
gvids media add <id> clip.mp4 --scene 1; gvids captions add <id>
gvids image generate <id> -p "..." --aspect landscape
gvids share <id> a@b.com --role writer
gvids export <id> out.mp4            # --format gif (any length), --to-drive
gvids run workflow.yaml              # multi-step, resumable (gvids job resume)
```

Long jobs: add `--detach` to get a task id, then `gvids wait <task>`.
MCP: `gvids mcp` exposes curated `vids_*` tools plus `vids_wait` with progress.

## Debugging a failure

1. Read `error.code`:
   - `LOGIN_REQUIRED` / `AUTH_*` (exit 3, needsUser) -> user runs `gvids browser login` or `gvids auth login`.
   - `UI_CHANGED` (exit 7) -> Google changed the editor. Open the files in
     `error.details.files` (`.png` screenshot + `.aria.yml` accessibility tree), find
     the new role/name, fix the label in `src/browser/selectors/*.ts` or the page
     module in `src/browser/pages/`, `pnpm run build`, rerun.
   - `FEATURE_UNAVAILABLE` (exit 6) -> account/region/format limit; follow `hint`.
   - `TIMEOUT`/`STILL_RUNNING` (exit 8) -> retry with `--timeout 15m` or `--async`.
   - `VIDS_NOT_FOUND` -> wrong ID, no access, or a never-edited video (not saved to Drive yet).
2. `gvids debug inspect <id>` dumps the live editor (aria tree + screenshot).
3. `--verbose --progress` stream JSON logs to stderr.
4. Browser stuck: `gvids browser status`, `gvids browser close`, retry.
5. Force the editor path (no Drive API): `--no-drive-api`.

## Repo layout (for fixing gvids itself)

- `src/cli/commands/*` commands; `src/cli/catalog.ts` must list every command (tests enforce).
- `src/browser/pages/*` editor automation; `src/browser/selectors/*` UI labels.
- `src/google/*` Drive API; `src/mcp/server.ts` MCP tools.
- `pnpm check` (lint, types, unit tests), `pnpm docs:commands` after adding commands,
  `GVIDS_LIVE=1 pnpm test:live` for the real-account suite.
