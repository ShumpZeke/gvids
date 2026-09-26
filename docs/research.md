# Research: what Google exposes for Google Vids (September 2026)

This document records what was verified before and while building gvids, where
each fact came from, and what gvids does and does not depend on. It is the
source of truth for the hybrid architecture (Drive API first, browser
automation for everything the API cannot do).

Research date: 2026-09-22/23. Account used for live UI checks: a personal
Google account with a Google One membership (not Workspace).

## TL;DR

| Question                                   | Answer                                                                                                                                            | Source                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is there a public Google Vids editing API? | **No.** No REST API, no Apps Script service, no Workspace API mentions Vids editing.                                                              | Workspace Updates Vids label (all 2026 posts checked), Drive release notes, Google Developers search                                                                                                |
| Drive MIME type for Vids                   | `application/vnd.google-apps.vid`                                                                                                                 | [Drive MIME types](https://developers.google.com/workspace/drive/api/guides/mime-types)                                                                                                             |
| Can Vids be exported with `files.export`?  | **No** — Drive answers `fileNotExportable`.                                                                                                       | [Download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)                                                                                              |
| Official way to get an MP4                 | `files.download` (long-running operation) → poll `operations.get` → GET `downloadUri`                                                             | [files.download](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download), [LRO guide](https://developers.google.com/workspace/drive/api/guides/long-running-operations) |
| GIF via API?                               | No (only MP4). GIF is an editor menu item (File › Download › GIF animation).                                                                      | Live UI                                                                                                                                                                                             |
| Create a Vid via API?                      | Not documented. `files.create` with the Vids MIME type is **untested** (needs OAuth) and exposed only as `gvids create --via-api` (experimental). | —                                                                                                                                                                                                   |

## Official APIs

### Google Drive API v3 (used)

Everything file-level about a Vid is a Drive operation:

| Operation        | Drive method                                                                               | gvids command                     |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------- |
| List / search    | `files.list` with `q=mimeType='application/vnd.google-apps.vid' and trashed=false …`       | `list`, `ls`, `search`            |
| Metadata         | `files.get` (fields incl. `owners`, `capabilities`, `thumbnailLink`, `videoMediaMetadata`) | `info`, `url --check`             |
| Rename           | `files.update` `{name}`                                                                    | `rename`                          |
| Copy             | `files.copy`                                                                               | `copy`, `cp`                      |
| Move             | `files.update` `addParents`/`removeParents`                                                | `move`, `mv`                      |
| Trash / restore  | `files.update` `{trashed}`                                                                 | `trash`, `rm`, `restore`          |
| Delete           | `files.delete` (permanent)                                                                 | `delete`                          |
| Sharing          | `permissions.list/create/update/delete`                                                    | `permissions`, `share`, `unshare` |
| MP4              | `files.download?mimeType=video/mp4` + `operations.get`                                     | `download`, `export --format mp4` |
| Thumbnail        | `thumbnailLink` from `files.get`                                                           | `thumbnail`                       |
| Account          | `about.get` (`user`) — avoids needing an extra e-mail scope                                | `auth status`                     |
| Media from Drive | `files.get?alt=media` (for images/videos to insert)                                        | `media add-drive`                 |

All calls set `supportsAllDrives=true`; list calls use `includeItemsFromAllDrives=true`.

#### The MP4 download flow (verified against the docs)

1. `POST https://www.googleapis.com/drive/v3/files/{fileId}/download?mimeType=video/mp4` (empty body).
   Returns an `Operation`. Accepted scopes: `drive`, `drive.file`, `drive.readonly`.
2. If `done` is not `true`, poll `GET https://www.googleapis.com/drive/v3/operations/{name}` with
   exponential backoff (Google suggests ~10 s). **Only poll when the first response is not done**
   (polling a done operation can return 403).
3. When done: `response.@type = type.googleapis.com/google.apps.drive.v3.DownloadFileResponse`,
   `response.downloadUri`, `response.partialDownloadAllowed`. On failure `error` holds a
   canonical error code and message.
4. `GET downloadUri` with the same `Authorization: Bearer …` header and stream to disk.
   Operations remain available for at least 12 hours.

gvids implements exactly this in `src/google/downloads.ts` (bounded polling with backoff,
progress callbacks, `.gvids-part` temp file, size check, atomic rename). The `@googleapis/drive`
client (v26) includes both `files.download` and `operations.get`.

### Google OAuth 2.0 for installed apps (used)

Desktop-app OAuth client, loopback redirect `http://127.0.0.1:<random port>`, PKCE (S256),
random `state`, `access_type=offline` + `prompt=consent` to get a refresh token. See
[authentication.md](authentication.md). Scopes are explained in `gvids auth scopes`.

### Things checked and **not** available

- **Google Vids REST API** — none. The [Workspace Updates Vids feed](https://workspaceupdates.googleblog.com/search/label/Google%20Vids)
  (Feb–Sep 2026) contains no API, Apps Script or developer announcements. A third-party API index
  (apis.io) likewise lists Vids as documentation-only.
- **Apps Script** — no `VidsApp` service.
- **Workspace Events / Drive events** — Drive events (GA May 2026) cover file-level changes only.
- **Slides API against Vids files** — the Vids editor clearly reuses Slides infrastructure
  (object IDs like `g7297e64d_0_10`, `punch-filmstrip-*`, "sketchy" menus). Whether the Slides API
  accepts a Vids file ID was **not tested** (needs OAuth) and gvids does **not** rely on it.

## Current Google Vids capabilities (from Google's announcements)

From the Workspace Updates blog, 2026 (availability varies by edition/plan/region):

- AI video clips with **Omni** (Gemini Omni video generation; July 2026), earlier Veo 3.1; longer Veo
  videos and parallel clips (June 2026). Consumer accounts: a monthly free allowance.
- **Edit videos** with Omni (text-based edits of clips) and **Animate** (image → video).
- **AI avatars**: 53 presets (realistic, 3D and 2D cartoon), custom and branded avatars, personal
  avatars (verification, not in EEA/CH/UK), emotion/pacing audio tags like `[excitedly]`.
- **AI voiceovers**: 30+ conversational voices (Gemini 3.1 Flash TTS), 24 languages.
- **Music** generation (Lyria 3 / 3 Pro), image generation.
- **Slides to video** (speaker notes become scripts; multilingual; optional avatar presenter),
  **Docs to video** (Docs/PDF/Word → video summary; Sept 2026).
- **Recording** (camera/screen, Chrome extension, from Slides), up to 30-minute projects.
- Export: MP4, GIF, **Export to Drive**, **Export to YouTube** (private upload).

## Live UI observations (the automation contract)

Verified in a signed-in browser on 2026-09-22 (English UI, `hl=en`). All labels used by gvids live
in `src/browser/selectors/`.

- **URLs**: home `https://docs.google.com/videos/`; `https://docs.google.com/videos/create` creates a
  new file immediately and opens the editor with a _Getting started_ dialog; editor
  `https://docs.google.com/videos/d/<id>/edit?scene=id.<pageId>` (the URL tracks the current scene).
- **Getting started dialog**: format toggle buttons "Create a landscape/portrait/square video"
  (`aria-pressed`), then creation options. Landscape offers _Create AI videos, Edit videos, Personal
  avatar, AI avatar, Docs to video, Slides to video, Record, Upload, Templates, Blank vid_; **portrait
  offers only Create AI videos, Edit videos, Personal avatar, Record, Upload, Blank vid.**
- **Menus are hidden by default** ("compact controls"); the _Show the menus (Ctrl+Shift+F)_ button
  reveals File/Edit/View/Insert/Format/Scene/Arrange/Tools/Help. gvids shows them while automating
  and hides them again afterwards so the user's preference is unchanged.
- **Storyboard ("Help me create")** — File › Storyboard: prompt (≤5000 chars, `@` mentions Drive
  files) → _Setting the scene…_ → _Edit the outline_ (topics ≤255 chars, add/remove, _Try again_) →
  _Select a design_ (12 designs) → _Create the draft video_ (progress messages such as "Developing
  your story…") → editor with ~10–15 scenes, scripts, narration and music.
  **Vids disables File › Storyboard as soon as a video is renamed or edited**, so gvids runs the
  storyboard on a fresh video first and renames afterwards.
- **Timeline**: each scene is an SVG `rect` with role button named "Scene N of M". **M can be stale**
  (observed "Scene 1 of 5" with 22 scenes), so gvids counts the buttons. Durations are SVG text like
  `5.0`; transitions are buttons named "Push between scene 2 and 3" / "Add transition…"; narration
  clips have labels like "Welcome to the - Elio starting in scene 1 at 0 seconds with duration 3
  seconds". Scene length is changed by dragging `.appsFlixTimelineSceneHandleBackground` handles.
- **Canvas**: one `<svg>` per scene under `.pages`; objects are `<g id="editor-<objectId>">`
  (paragraphs `…-paragraph-N`, page background `…-bg`). Inserting a title leaves the box in text
  edit mode with placeholder text; Ctrl+A then typing replaces it.
- **Scene menu**: New scene, Templates, Styles ›, Duplicate scene(s), Delete scene(s), Split scene at
  playhead, Move scene › (left/right/to beginning/to end), Background › (palette gridcells and
  _Add a custom color_ → dialog with a "Hex color" textbox), Transition, Animation.
- **File › Video size** dialog: combobox "Page or video size select" with Landscape 16:9 /
  Portrait 9:16 / Square 1:1 (+ custom width/height), Apply.
- **Insertion rail** (toolbar "Insertion"): Generate an AI video clip, Generate an avatar, Generate a
  voiceover, Generate music, Generate an image, Record, Drive and Photos, Stock and web, Captions,
  Insert text, Insert from templates, Insert shapes and lines. Buttons toggle side sheets and expose
  `aria-pressed`.
- **AI video clip** side sheet: tabs _Create / Edit / Animate_; prompt textboxes are rendered
  **outside** the ARIA complementary region and a placeholder overlay intercepts clicks (gvids
  focuses the editable). Create tab starts collapsed (gallery) — _Expand_ reveals _Avatar,
  Ingredients_, a **Model** menu (observed: "Omni 720p with audio") and an **Aspect ratio** menu
  (Landscape 16:9, Portrait 9:16), then _Generate_.
- **AI voiceover** side sheet: _Current scene / All scenes_, a canvas-rendered script editor (form
  "Scripts"), voice picker dialog "Select a voice" (37 voices, e.g. "3 out of 37 voices. Knox voice
  that is smooth and low pitch…") + _Select_, then _Insert voiceover_ / _Update voiceover_. A
  narration clip appears in ~5 s.
- **AI avatar** side sheet: same script editor, "Avatars" dialog with radio groups (Realistic, 3D
  Cartoon, 2D Cartoon, custom) and _Select_.
- **Templates**: 104 templates in the side panel listbox "Templates sidebar"; opening one shows a
  listbox of its scenes and _Insert all scenes_ (start dialog also offers _Insert selected scene_).
- **Slides to video** opens the Google Drive Picker iframe (`/picker/v2/home`, dialog "Select
  document") with a search box "Search in Drive or paste URL". Pasting a presentation URL and pressing
  Enter pre-selects it; the confirm button is named "Select 1 item". Then two dialogs: _Select
  slides_ (placeholder checkboxes "Disabled while loading your slides", then "Slide N" checkboxes and
  a switch "Include AI voiceover, script, background music and animation", _Next_) and, with the
  switch on, _Edit script and customize video_ (Gemini-written script per slide, radio group
  _Narration_: "AI avatar and voiceover" / "Voiceover only", voice style, animation-sync switch,
  _Create the draft video_). Imported scenes go after the selected scene. The Getting started
  dialog's own _Slides to video_ opens the same picker.
- **Pickers vary**: the start dialog's _Upload_ opens an "Open a file" picker (left-nav options
  _Google Drive / Photos / Upload_; the Upload pane has a _Browse_ button). Insert › _Drive & Photos_
  opens either a modal "Drive & Photos" picker (the search box appears after pressing _Search_) or
  the same picker embedded in the Uploads side panel, where pasting a file URL + Enter **inserts the
  file immediately**. A modal picker makes the rest of the editor `aria-hidden`, so role-based
  locators cannot see the editor until it closes.
- **Downloads in the editor**: File › Download › _MP4 video (.mp4)_ / _GIF animation (.gif)_. The tab
  shows "Downloading… Leave this tab open until the download is complete", renders in the browser
  and saves a `blob:` URL (observed: a 1:50 video → 24 MB MP4 in ~15 s; a 5 s video → 5.5 KB GIF in
  ~14 s). **GIFs are limited to videos of 30 seconds or less**: longer videos get an alert dialog
  "Can't download GIF — To download as a GIF, shorten the vid to 30 seconds or less."
- **Trash**: File › _Move to trash_ shows an alert dialog "File moved to trash" (buttons _Take out of
  trash_, _Go to Vids home screen_); opening a trashed video shows "File is in trash" with the same
  buttons, a moment after the editor toolbar appears (together with the scene thumbnails).
- **Never-edited videos** reopen the modal _Getting started_ dialog every time they are opened (the
  editor behind it is aria-hidden), and **File › Move to trash is disabled** for them until the first
  edit (a rename is enough).
- **Scene durations** snap to 0.1 s; drags under ~5 px are ignored (≈52 px per second at the default
  timeline zoom for a short video).
- **Scene thumbnails** in the timeline render a few hundred ms after the toolbar (a content `<g>` is
  prepended to each tile); their SVG text is the scene's visible text.
- **Templates side panel** reopens on the last template's scene list (with a _Back_ button); clicking a
  scene there inserts it right after the selected scene and **does not move the selection**. The
  start dialog's scene list is single-select (Ctrl-click just moves the selection).
- **Empty voiceover scripts** draw the placeholder "Enter a script, or type '[' to view audio tags" as
  ordinary SVG text.
- **Promos and toasts** appear frequently ("Customize your video's style — Got it", "Improve sound
  quality", "How would you rate the voiceover?", "Aspect ratio changed to match your canvas",
  "Download started"). The "Download started" bubble can take keyboard focus and close an open menu.
  gvids only ever presses _Got it_ / _Close_ and never feedback buttons.
- **Page tokens**: the editor HTML carries a session-bound request token in inline scripts, so
  `gvids debug page-html` drops inline script bodies.

## Browser sign-in finding

Google refuses sign-in ("This browser or app may not be secure") while **any DevTools client is
attached**, even to a normally launched Chrome. `gvids browser login` therefore launches the
dedicated profile as a plain Chrome process with **no debugging port**, lets the user sign in, and
only after the window is closed attaches (headlessly) to verify the session. Existing sessions work
normally under automation afterwards. gvids does not bypass MFA/CAPTCHA, harvest cookies or read
passwords.

## Internal interfaces

gvids does **not** call any internal Google endpoints. The editor talks to Google through the same
private, undocumented Docs-family save/RPC channels as Docs and Slides; they are unstable, may change
without notice and are not authorized for third-party use, so they are out of scope. Everything
editor-side is done by driving the visible UI through Playwright.

## What gvids depends on — and what it does not

**Depends on (stable, documented):** Drive API v3 (files, permissions, operations, about), OAuth 2.0
installed-app flow, Chrome/Edge/Chromium + Playwright over CDP.

**Depends on (unstable, centralized):** the Vids editor UI in English (`hl=en`), identified by
accessible roles/names — all in `src/browser/selectors/*`. `gvids capabilities` and
`gvids doctor` re-check them; failures produce `UI_CHANGED` with a screenshot and sanitized
accessibility snapshot.

**Does not depend on:** private RPCs, cookies read outside the browser, Slides API behaviour on Vids
files, undocumented Drive behaviour (except the explicitly experimental `create --via-api`).

## Sources

- Download and export files — https://developers.google.com/workspace/drive/api/guides/manage-downloads
- Manage long-running operations — https://developers.google.com/workspace/drive/api/guides/long-running-operations
- files.download reference — https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download
- operations.get reference — https://developers.google.com/workspace/drive/api/reference/rest/v3/operations/get
- Google Workspace and Drive MIME types — https://developers.google.com/workspace/drive/api/guides/mime-types
- Google Drive API release notes — https://developers.google.com/workspace/drive/release-notes
- Workspace Updates, Google Vids label — https://workspaceupdates.googleblog.com/search/label/Google%20Vids
- Get started with Google Vids — https://support.google.com/docs/answer/15082958
- Edit Drive videos with Vids — https://support.google.com/docs/answer/16466593
