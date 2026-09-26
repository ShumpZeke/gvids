# Troubleshooting

Start with:

```bash
gvids doctor            # installation, OAuth, Drive, browser, Vids editor, AI features
gvids capabilities --refresh
gvids env               # non-secret info to paste into a bug report
gvids config path       # where gvids keeps config, tasks, jobs and diagnostics
```

`gvids doctor` fails with `NOT_READY` (exit 1) when something blocks gvids; the
whole report is still in `data`, and `error.next` lists the fixes.

## Reading gvids output

gvids prints one JSON envelope per command (it is built for agents). For readable
output add `--human`, or set `GVIDS_OUTPUT=text` / `gvids config set output.format
text`. stderr is silent by default: add `--progress` to watch what a long command
is doing, or `--verbose` / `--debug` for logs. Failures carry `retryable`,
`needsUser` and `next` (the commands to run next) in `error`.

## Configuration

**`CONFIG_ERROR` "Invalid configuration in …/config.json"**
`error.next` names the bad keys (`gvids config unset <key>`). `gvids config list`,
`get`, `set`, `unset`, `reset` and `path` still work with a broken file, so it can
be repaired; a file that is not valid JSON at all is only replaced by
`gvids config reset --yes`.

**Warning "Config key output.json is obsolete"**
Earlier versions used `output.json`; it is read as `output.format` (json/text).
Rewrite the file with the command in the warning.

**Warning "Unknown config key(s) ignored"**
A typo in `config.json`. See the valid keys with `gvids config list`.

## Authentication

**`AUTH_REQUIRED` / "Google authentication is required."**
Run `gvids auth login`. For CI set `GVIDS_REFRESH_TOKEN` + `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET` (see [authentication.md](authentication.md)). Many
commands work without it through the browser (see [google-drive.md](google-drive.md)).

**`OAUTH_CLIENT_MISSING`**
No OAuth client configured. Create a _Desktop app_ client and save its JSON as
`~/.gvids/client_secret.json`, or pass `--client-secret-file`.

**`TOKEN_EXPIRED` after about a week**
Your consent screen is in _Testing_ mode, where Google expires refresh tokens
after 7 days. Publish the app (Google Auth Platform → Audience → Publish) and log
in again.

**`API_NOT_ENABLED`**
Enable the Google Drive API for the Cloud project that owns your OAuth client.

**"This app is blocked" / "Access blocked" during consent**
Add your account as a test user, or publish the app. Workspace admins can block
unconfigured third-party apps; ask them to allow your client ID.

**Token store errors on Linux**
Without a Secret Service (GNOME Keyring/KWallet) use file storage:
`gvids config set auth.tokenStore file`.

## Browser session

**`LOGIN_REQUIRED` — "The gvids browser profile is not signed in"**
A person runs `gvids browser login`, signs in, waits for Vids to load, and closes
the window. `gvids browser status` reports the same state (`LOGIN_REQUIRED` with
the status as `data`).

**`USER_ACTION_REQUIRED` from batch or MCP**
Sign-in commands (`browser login`, `auth login`) wait for a person at a window, so
they cannot run inside `batch` or the MCP server. Run them in a terminal.

**Google says "This browser or app may not be secure"**
This happens when a browser is being automated during sign-in. `gvids browser
login` avoids it by launching a plain window. If you use `gvids browser connect`,
sign in to that Chrome _before_ connecting.

**`BROWSER_PROFILE_LOCKED`**
The gvids profile is open in a window gvids did not start (for example a
`browser login` window). Close it, or run `gvids browser close`.

**`BROWSER_SESSION_ERROR` "Another gvids command is still starting or closing the browser"**
gvids serializes browser start-up between processes with a lock in
`~/.gvids/browser/`. It is retryable; a lock left by a crashed process is cleaned
up automatically.

**`BROWSER_SESSION_ERROR` "The browser step failed: …"**
A page failed to load, a tab was closed, or the connection to Chrome dropped
(for example because `gvids browser close --force` ran meanwhile). It is
retryable; if it repeats, run `gvids browser close` and retry.

**`gvids browser close` refuses: "N gvids command(s) are still using the browser"**
Background tasks or other commands use it. Wait for them
(`gvids tasks --status running`), or close anyway with `--force` (they fail).

**`BROWSER_NOT_FOUND`**
Install Google Chrome (recommended), or `npx playwright install chromium`, or
`gvids config set browser.executablePath "C:\path\to\chrome.exe"`.

**Commands hang when reusing a running browser**
A tab may be stuck behind a dialog. gvids detects an unresponsive managed browser
and restarts it; you can also run `gvids browser close`.

**I want to watch what gvids does**
`gvids browser open` (visible, stays running), then run commands — they reuse it.
Or add `--headed` to a single command. If a headless gvids browser is already
running, close it first.

## Editor automation

**`UI_CHANGED` — "… could not be located. The Google Vids interface may have changed."**
gvids saved a screenshot, a sanitized accessibility snapshot and a JSON summary;
`error.details.files` lists them (default directory: `~/.gvids/debug`, see
`gvids config path`). Retry once; if it repeats:

```bash
gvids debug inspect <id> --menus     # what the UI exposes now
gvids <same command> --debug         # records a Playwright trace
gvids debug trace show               # step through it
```

UI labels live in `src/browser/selectors/`; most breakages are fixed by updating
a label there.

**`INVALID_ARGUMENT` "… is not a palette color" / "Voice … is not available" / "Template … was not found"**
The name is not offered; `error.details.available` lists the valid names.

**`FEATURE_UNAVAILABLE` "The menu item … is disabled"**
Some features are format- or state-dependent: templates, Slides conversion and the
storyboard are landscape-only; the storyboard disappears once a video has been
edited or renamed (create a new one with `gvids create --prompt`).

**`FEATURE_DISABLED_BY_ADMIN`, `REGIONAL_RESTRICTION`, `QUOTA_EXCEEDED`, `AI_GENERATION_UNAVAILABLE`**
Google showed that message in the editor. Check your plan/admin settings, region
and remaining AI allowance.

**`GENERATION_TIMEOUT`**
The operation was still running. Raise the limit: `--timeout 30m`. The video in
Vids may already contain the result — check with `gvids scene list <id>`.

**`create` failed but a video exists**
The file is created as soon as Vids opens its start page. The error's
`details.createdVideo` names it; retry on that video or remove it (rename, then
`gvids trash <id> --yes`).

**Text lands in the wrong place / objects overlap**
Use `gvids text list <id> --scene N` for object IDs and edit by ID. gvids clicks a
point where the target object is topmost, but heavily layered scenes can still
confuse selection.

**`VIDEO_IN_TRASH` (exit 5)**
The video is in the Drive trash; Vids shows a "File is in trash" dialog over it.
Restore it with `gvids restore <id>` (works with or without an OAuth login).

**`FEATURE_UNAVAILABLE` "Vids does not offer "Move to trash" for this video."**
Vids disables File › Move to trash for a video that was never edited. Rename it
first (`gvids rename <id> "…"`), or trash it with an OAuth login (Drive API).

**Warning "No Drive API login; … through the Vids web app instead."**
Not an error. `list`, `search`, `info`, `rename`, `trash`, `restore`, `download`,
`export` and `media add-drive` fall back to the browser when the Drive API cannot
be used (no login, or an expired or under-scoped one; the warning names the
reason). The JSON result says which path ran (`"method": "drive-api"` or
`"browser"`).

**A command hangs on a menu or leaves a popup behind**
Vids sometimes shows bubbles ("Download started") that take focus and close an
open menu; gvids retries the whole menu path. If a run was interrupted, the
reused browser can keep a half-finished dialog: `gvids browser close` resets it.

**Non-English Google account**
gvids forces the English UI with `hl=en`. If you changed `browser.locale`, set it
back: `gvids config unset browser.locale`.

## Background tasks

**`STILL_RUNNING` (exit 8) from `gvids wait`**
Not a failure: call `gvids wait <task-id>` again (the MCP `vids_wait` tool waits
45 s per call). `gvids task status <task-id>` shows the latest progress event.

**A task stays "running" after its process died**
It does not: a task whose process is gone, or whose worker stopped updating its
heartbeat for a minute, is reported as failed with "The background process ended
without reporting a result". The worker's own output is in
`~/.gvids/tasks/<task-id>.err.jsonl`.

**`gvids task cancel`**
Asks the worker to stop; it closes its browser tabs and records `CANCELLED`
(exit 130). A worker that does not stop within 15 s is killed. Finished tasks are
deleted after 7 days.

## Downloads

**`INVALID_ARGUMENT` "… already exists"**
Pass `--overwrite`, or choose another path.

**`DOWNLOAD_ERROR` "Drive could not render the video"**
Open the video in Vids and check for failed media or unsupported content, then retry.

**No OAuth but need an MP4**
`gvids download` falls back to the editor's File › Download › MP4 by itself;
`gvids export <id> out.mp4 --via-browser` forces that path. Only
`download --revision` needs the Drive API.

**`FEATURE_UNAVAILABLE` "Google Vids refused the GIF download"**
Vids only exports GIFs for videos of 30 seconds or less. Shorten the video, or
export an MP4.

## Windows

- Works in PowerShell, cmd.exe and Git Bash. Quote paths with spaces.
- `gvids completion powershell | Out-String | Invoke-Expression` enables tab completion
  for the current session; append to `$PROFILE` to keep it.
- Linking a source checkout: `npm link` (pnpm 11+ has no `pnpm link --global`). If you
  prefer pnpm's global directory, run `pnpm setup` once so it is on `PATH`, then open a
  new terminal.
- In `cmd.exe`, check exit codes with delayed expansion (`cmd /v:on`, `!ERRORLEVEL!`);
  `%ERRORLEVEL%` inside one line is expanded before the command runs.
- Ctrl+C / SIGTERM close gvids' tabs and print a `CANCELLED` envelope before exit
  130; to stop a background task on Windows, use `gvids task cancel`.

## Reporting a bug

Include `gvids env`, the failing command with `--debug`, and the files it wrote to
the debug directory (`gvids config path`; screenshots show your video — share them
only if you're comfortable). gvids never writes tokens or passwords to those files.
