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

## This machine (state as of 2026-09-26)

- Repo: https://github.com/ShumpZeke/gvids (public), local checkout `C:\Users\vardh\Documents\gvids`.
  `gvids` on PATH is `npm link`ed to it; after pulling or editing: `pnpm install && pnpm run build`.
- Google account: vardhmanmc12@gmail.com. Browser sign-in done (profile `~/.gvids/browser/profile`).
  Drive API OAuth done: app is **In production**, so the token does not expire weekly
  (sign-in shows an "unverified app" warning; that is expected). Client file: `~/.gvids/client_secret.json`.
- Codex has: this skill, the `reference-video-remix` skill, and the `gvids` MCP server
  (`~/.codex/config.toml`, `[mcp_servers.gvids]`, tool timeout 900 s). Use the CLI or the `vids_*` tools.
- Installed helpers: ffmpeg/ffprobe, yt-dlp, python + faster-whisper (GPU libs missing, CPU fallback is automatic).

Verified working live: create (blank/template/upload/Slides/Docs/storyboard), scenes, text,
media, stock, captions, transitions, animations, voiceover, share/permissions, copy/move/trash,
export MP4/GIF, AI clip generate/edit/animate, avatar, `image generate`, `music generate`,
`docs import` (incl. Create), comments, versions, MCP.

Known facts and quirks:
- A video that was never edited is NOT saved to Drive (Drive API says not found). `gvids create`
  without a title now saves it automatically; `gvids trash` on an unsaved one reports "nothing to trash".
- AI generation is fast now (image ~17 s, music ~16 s, Docs to video ~1 min); AI video clips take minutes.
- `docs import --script-only` / `storyboard --outline-only` use Gemini text but add nothing.
- If a command fails with `UI_CHANGED`, Google moved a control: fix the label in
  `src/browser/selectors/` or `src/browser/pages/` using the saved `.aria.yml`, rebuild, rerun.
  (Example fixed 2026-09-26: image aspect choices became `menuitemradio`.)
- Don't run two commands on the same video at once (`VIDEO_BUSY`); different videos are fine.
- Test videos (safe to use for experiments, never the user's own videos):
  `1wr97oizsKbOyMIQpDBt4k2rv_9Z8zfyM5-zmhyrYsnM` ("gvids blank probe"),
  `1A5aBq6FyP58ltz6_ZpPRb-YiXQ8xFeZL6aqSsn2J7a0` ("gvids storyboard test 4").
  Test Doc for Docs to video: `1Dr8rRHZGyZNYZIBsBWlcBk_eKtm9hBnOTg7ZL5RGaYI`.
- Do not touch the four "Untitled video" files from 2026-09-20; they belong to the user.
- Ask the user before spending AI generations, sharing publicly, or trashing anything.
