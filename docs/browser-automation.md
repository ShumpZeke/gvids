# Browser automation

Google publishes no API for editing a Vid, so everything inside the editor —
creating videos, storyboards, scenes, text, media, templates, voiceovers,
avatars, AI video, aspect ratio, GIF export — is done by driving the real Google
Vids web app with [Playwright](https://playwright.dev) over the Chrome DevTools
Protocol.

## How a browser command runs

1. **Attach or launch** (`src/browser/session.ts`), in this order:
   - an external Chrome registered with `gvids browser connect <endpoint>`;
   - the gvids browser if it is already running (found via
     `~/.gvids/browser/profile/DevToolsActivePort`) — fast; `gvids browser open
--headless` starts one for a series of commands (or watch with `browser open`);
   - otherwise launch installed Chrome (or Edge, or Playwright's Chromium) with
     `--user-data-dir=~/.gvids/browser/profile --remote-debugging-port=0` on
     `127.0.0.1`, headless if `--headless`/`browser.headless=true`, and with
     `--disable-extensions`: signing in to Chrome in the gvids profile syncs your
     extensions into it, and their scripts would otherwise run inside the pages
     gvids drives (they also slowed every start by about 0.8 s). The
     `gvids browser login` window keeps them.

   Finding or launching happens under a lock file (`~/.gvids/browser/launch.lock`)
   and every attached command registers a lease (`~/.gvids/browser/leases/`), so
   commands started at the same time — parallel shells, background tasks, MCP
   calls — share one browser instead of racing to launch two on the same profile.

2. **Open the editor** (`src/browser/pages/editor-page.ts`) at
   `https://docs.google.com/videos/d/<id>/edit?hl=en` and wait for the Insertion
   toolbar — or, in a browser that stays running, claim an idle tab a previous
   successful command left on the same video (no reload). Each command works in
   its own tab. Sign-in redirects become `LOGIN_REQUIRED` (exit 3); "file does not
   exist" becomes `VIDS_NOT_FOUND`; "You need access" becomes `PERMISSION_DENIED`.
3. **Act** through page objects: menus (`menu(['Scene', /^Duplicate scene/])`),
   the Insertion rail (`openInsertion('voiceover')`), side panels
   (`VoiceoverPanel`, `AvatarPanel`, `AiVideoPanel`), dialogs (`StartDialog`,
   `StoryboardFlow`), the Drive picker.
4. **Finish**: close side sheets, hide the menus again if gvids revealed them,
   wait for "Document status: Saved to Drive", then either mark the editor tab
   idle (successful command, persistent browser; at most two idle tabs) or close
   it, and release the lease. A browser started by `gvids browser open` (or with
   `browser.keepOpen`) keeps running until `gvids browser close`; any other
   gvids-started browser is closed (gracefully, so cookies are written) by the
   last command that used it.

Ctrl+C, SIGTERM and `gvids task cancel` run the same finish step (close the
command's tabs, release the lease) before gvids exits with `CANCELLED` (130).

`gvids browser close` refuses while other gvids commands hold leases (they
would fail); `--force` closes anyway.

Every step runs inside `uiStep()`. A Playwright timeout becomes:

- `FEATURE_DISABLED_BY_ADMIN`, `REGIONAL_RESTRICTION`, `QUOTA_EXCEEDED`,
  `AI_GENERATION_UNAVAILABLE` or `VIDS_ACCESS_REQUIRED` when Google shows such a
  message on the page, otherwise
- `UI_CHANGED` (exit 7, retryable), after saving a screenshot, a sanitized
  accessibility snapshot and console/network errors to the debug directory
  (default `~/.gvids/debug`; `error.details.files` lists them).

Raw Playwright failures outside a step (a page that fails to load, a closed tab,
a lost CDP connection) become `BROWSER_SESSION_ERROR` (exit 7, retryable) with the
terminal escape codes and Playwright call log removed from the message. Names the
page does not offer (an unknown voice, avatar, template or palette color) are
`INVALID_ARGUMENT` with `details.available`.

## Selector strategy

In order of preference, gvids locates elements by:

1. ARIA role (`button`, `menuitem`, `dialog`, `complementary`, `tab`, `textbox`, …)
2. accessible name (`aria-label` or text), usually a full-match regex
3. dialog/panel names as scopes (`getByRole('dialog', { name: 'Select a voice' })`)
4. structural relationships (the innermost element containing both the AI prompt
   box and its _Generate_ button)
5. a few stable CSS hooks, only where Google exposes no role: the title input
   (`input.docs-title-input`), per-scene canvases (`.pages > svg`), object groups
   (`g[id^="editor-"]`), timeline drag handles.

There are no `nth-child` chains. All labels are defined once in
`src/browser/selectors/{common,editor,storyboard,ai,templates}.ts`. The UI
language is forced to English with `hl=en` (`browser.locale`).

## Waiting for AI generation

No fixed sleeps. Each long operation watches for the state change that marks
completion, with a bounded deadline (`--timeout`, default `ai.timeoutMs` = 15 m):

| Operation          | Done when                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Storyboard outline | "Edit the outline" heading and outline textboxes appear                                              |
| Storyboard draft   | the "Getting started" dialog closes                                                                  |
| Voiceover          | a new narration clip labelled "… starting in scene N …" appears                                      |
| Avatar / AI clip   | a new timeline clip or canvas object appears (an _Insert_ button in the panel is clicked if offered) |
| Media upload       | a new object or clip appears in the scene                                                            |
| UI download        | Playwright receives the download event                                                               |

Failure messages shown by Vids ("Something went wrong", quota, policy) are
turned into typed errors instead of waiting for the timeout.

## Debugging

```bash
gvids debug inspect <id>              # visible elements with roles/names
gvids debug inspect <id> --menus      # plus every menu's items and enabled state
gvids debug inspect <id> --panel aiVideo
gvids debug aria <id>                 # full ARIA snapshot (YAML)
gvids debug screenshot <id> --full
gvids debug page-html <id>            # HTML with e-mails/tokens redacted
gvids scene list <id> --debug         # any command: traces + diagnostics
gvids debug trace list
gvids debug trace show                # opens the newest trace in the Playwright viewer
```

Everything is written to the debug directory: `~/.gvids/debug` by default, or
`debug.directory` (relative paths resolve against the working directory); `gvids
config path` shows it. E-mail addresses are replaced with `<email>` and query
strings are stripped from URLs before anything is saved.

Watch automation live: `gvids browser open` (headed, stays running), then run
any command — it reuses that window.

## Headless vs headed

Default is headed (`browser.headless=false`) to match what people expect when
they are watching. For agents/CI use `--headless` or
`gvids config set browser.headless true`. Headless Chrome with the signed-in
profile was used for most of gvids' own testing.

## Known UI behaviours gvids handles

- Menus hidden by default ("compact controls") — shown temporarily.
- "Scene N of M" labels with a stale M — gvids counts scene buttons instead.
- Storyboard disabled after a video is renamed/edited — `create --prompt` runs it
  before renaming; `storyboard generate` explains the restriction.
- Rail buttons toggle their panels — gvids checks `aria-pressed` first.
- Placeholder overlays intercept clicks on AI prompts — gvids focuses the editable.
- Menus ignore clicks while the editor initializes, and the "Download started"
  bubble can steal focus and close an open menu — gvids retries the whole menu
  path (up to four times) but never re-clicks a final item it already clicked.
- Scene thumbnails render a moment after the toolbar — gvids waits for them
  before reading scene text or checking the trash state.
- Modal dialogs at load hide the editor from the accessibility tree: a trashed
  video's "File is in trash" (gvids stops and reports `VIDEO_IN_TRASH`) and a
  never-edited video's "Getting started" (gvids closes it, leaving the video blank).
- Refusals shown as alert dialogs ("Can't download GIF", "File is in trash") are
  detected and reported as typed errors instead of waiting for a timeout.
- Pickers come in several variants (modal "Select document"/"Open a file"/"Drive &
  Photos", or embedded in the Uploads panel, where Enter already inserts) — gvids
  searches by URL, then checks whether the insertion happened before clicking a
  result or the "Select N items" button.
- A modal picker makes the editor `aria-hidden`, so `create --slides` drives the
  picker and import dialogs first and attaches to the editor afterwards.
- Timeline drags under ~5 px are ignored and lengths snap to 0.1 s — `scene
duration` overshoots and returns, then re-measures and corrects.
- Coach marks, rating toasts, "Aspect ratio changed" toasts — dismissed with
  _Got it_/_Close_ only (never feedback buttons).

## Live tests

Unit tests run offline. The live suites drive real Google and are opt-in:

```bash
gvids browser login          # once
gvids auth login             # optional: enables the Drive API suite
pnpm build                   # the process suite runs the built CLI
set GVIDS_LIVE=1             # PowerShell: $env:GVIDS_LIVE=1
pnpm test:live
```

- `editor.live.test.ts` creates `gvids live test <timestamp>` and exercises
  scenes, text, format, templates, voiceover, export, capabilities and
  trash/restore.
- `processes.live.test.ts` runs `gvids` as separate processes: parallel commands
  on one browser, warm-browser tab reuse, `--detach` + `wait`, and `task cancel`
  while `browser close` is refused.
- `drive.live.test.ts` needs an OAuth login (its tests are reported as skipped
  without one): list/search filters, info, permissions, rename, copy, move,
  delete (of its own copy), public share + unshare, files.download, trash/restore.

Every suite only touches videos (and a folder) it creates and removes them at the
end. Set `GVIDS_LIVE_AI=1` to also run one AI clip generation (uses your quota).
