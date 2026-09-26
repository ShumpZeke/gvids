# Working with the Google Vids editor

These commands automate the Vids web editor through the signed-in gvids browser
profile (`gvids browser login` first). Run `gvids capabilities` to see what your
account offers; features differ between personal accounts, Google AI plans,
Workspace editions, school accounts and regions.

Maturity labels used below: **verified**: run end-to-end against the live
editor (2026-09-22/23, personal Google account with a Google AI plan);
**experimental**: implemented against the observed UI but not run end-to-end
(usually because it spends AI generation allowance), or inherently fragile.

## Creating videos

```bash
gvids create "History Project"                        # blank, landscape       (verified)
gvids create "Reel" --format portrait                 # portrait / square      (verified)
gvids create --prompt "Make a 60 second video explaining photosynthesis"   (verified)
gvids create "Launch" --prompt prompt.md --design 3 --format portrait
echo "make a video about Mars" | gvids create --prompt -
gvids create "Onboarding" --template tutorial                              (verified)
gvids create "Cut" --template personal-celebration --template-scenes 1,3,2 (verified; order kept)
gvids create "Clip" --upload ./clip.mp4                                   (verified)
gvids create "Deck" --slides <presentation-id|url>                         (verified)
gvids create "Empty" --via-api                                             (experimental, Drive files.create)
gvids create "X" --folder <folder-id> --open
```

Notes:

- Opening `docs.google.com/videos/create` creates the file immediately; gvids then
  answers the _Getting started_ dialog (format + option).
- Templates, Slides conversion and the AI storyboard are only offered for
  **landscape** videos. gvids creates landscape and converts to the requested
  format afterwards (the conversion may need manual touch-ups, as Vids warns).
- The storyboard is only available on a **new, unedited** video, so
  `create --prompt` runs it before renaming.
- `--template` accepts the display name or the slug from `gvids template list`.
  The start dialog inserts one selected scene; further `--template-scenes` are
  inserted from the Templates side panel.
- `--upload` goes through Google's "Open a file" picker (Upload → Browse) when
  Vids shows it, or the dialog's "Browse computer" button.
- `--slides` uses the dialog's own "Slides to video" option, with the Vids
  defaults (Gemini script and AI voiceover). For plain slides or a subset,
  create a blank video and use `gvids slides import --no-ai --slides …`.

## AI storyboard (Gemini "Help me create")

```bash
gvids storyboard generate <id> --prompt "Explain the quarterly results to executives"   (verified via create --prompt)
gvids storyboard generate <id> --prompt-file prompt.md --design 2
gvids storyboard generate <id> --prompt "…" --outline-only             # just the outline
gvids storyboard create-draft <id> --prompt "…" --outline-file outline.txt   # your own scene list
gvids storyboard regenerate <id> --prompt "…" --attempts 2             # ask for a different outline first
gvids storyboard generate <id> --prompt "Summarize @Q3 report" --context-drive-file "Q3 report"  (experimental)
gvids storyboard inspect <id>                                          # scenes, text, scripts, clips (verified)
```

Outline files: JSON/YAML list, `{ outline: [...] }`, or plain text with one topic
per line (bullets and numbering are stripped). Topics are limited to 255
characters, prompts to 5000.

## Scenes

```bash
gvids scene list <id>                           (verified)
gvids scene add <id> [--after 2]                (verified)
gvids scene duplicate <id> 3                    (verified)
gvids scene delete <id> 3 --yes                 (verified)
gvids scene move <id> 4 --before 2              (verified; also --after N, --to N)
gvids scene background <id> 2 --color "#101010" (verified; palette names like "black" also work)
gvids scene duration <id> 3 --seconds 8         (verified: 3, 4.2, 5, 6.5, 8 and 10 s all landed exactly)
gvids format <id>                               (verified: shows current size and options)
gvids format <id> portrait|landscape|square     (verified)
```

`scene list` returns index, duration, the transition into the scene, visible
text and narration clips. Scene numbers are 1-based and always refer to the
current order. A palette name that Vids does not offer fails with
`INVALID_ARGUMENT` and lists the palette's names in `details.available`.

`scene duration` drags the scene's right edge in the timeline: Vids has no
typed duration field. Lengths snap to 0.1 s and drags shorter than about 5 px
are ignored, so gvids overshoots and comes back, re-measures, and corrects up
to five times. Media in the scene (for example a video clip) can limit the length.

## Text

```bash
gvids text list <id> --scene 1                  (verified: object IDs, kind, text)
gvids text add <id> --scene 2 --text "Hello World"                     (verified)
gvids text add <id> --scene 2 --text notes.md --kind body --size 60 --bold --italic --align center --color "#d93025"   (verified)
gvids text edit <id> --scene 2 --object <object-id> --text "Updated"   (verified)
gvids text edit <id> --scene 2 --object <object-id> --italic --size 40
gvids text delete <id> --scene 2 --object <object-id>                  (verified)
```

Styling uses the editor's own shortcuts and toolbar (bold/italic/underline,
alignment, font size, text color via the custom color dialog). `--color` takes a
hex value and `--size` 1–400; both, and an empty `--text`, are rejected before
the browser starts, so a bad value never leaves a half-styled text box. Font
family, positioning and animations are not automated.

## Media

```bash
gvids media add <id> ./image.png --scene 1       (verified: PNG)
gvids media add <id> ./clip.mp4 --scene 1
gvids media add <id> ./music.mp3 --scene 1
gvids video add <id> ./clip.mp4 --scene 1        # alias
gvids media add-drive <id> <drive-file-id|url> --scene 2   (verified without OAuth: editor's Drive picker)
gvids media delete <id> --scene 1 --object <object-id>
```

Supported by Vids: PNG, JPEG, GIF; MP4, MOV, WebM, OGG; MP3, WAV, M4A, FLAC.
With a working OAuth login, `media add-drive` downloads the file with the Drive
API and uploads it; without one (or with an expired one) it pastes the file URL
into Insert › Drive & Photos. Local files are checked before the browser starts.
Replace/crop/trim/position are not automated yet (use the editor).

## Templates

```bash
gvids template list --refresh --vid <any-video-id>   (verified: 104 templates)
gvids template list                                  # cached, with last-verified date
gvids template search "education"
gvids template preview "how-to-video"
gvids template apply <id> how-to-video               (verified)
gvids template apply <id> personal-celebration --after 1 --scenes 9,4   (verified; lands as scenes 2 and 3)
```

Templates have no stable IDs in Vids, so gvids keeps its own abstraction:
`name` (slug), `displayName`, the accessible name used to locate it, and
`lastVerified`, cached in `~/.gvids/cache/templates.json`.

The side panel inserts each chosen scene right after the selected scene
without moving the selection, so gvids inserts `--scenes` in reverse to keep
your order. The panel also reopens on the last template used; gvids goes back
to the gallery first.

## Voiceover and scripts

```bash
gvids voiceover voices <id>                                  (verified: 37 voices)
gvids voiceover generate <id> --scene 1 --script "Hello everyone." --voice Knox   (verified)
gvids voiceover generate <id> --scene 2 --script-file narration.txt
gvids voiceover generate <id> --scene 3 --script "[excitedly] We did it!"
gvids voiceover remove <id> --scene 1                        (verified)
gvids script get <id> [--scene 3]                            (verified; empty scripts read as "")
gvids script set <id> --scene 3 --file script.txt            (verified, including --file - for stdin)
```

Language, pace and tone come from the chosen voice and from Vids' audio tags in
the script (`[calmly]`, `[excitedly]`, pauses); gvids does not expose separate
pace/tone switches because Vids does not have them.

## Avatars

```bash
gvids avatar list <id>                                       (verified: 53 avatars)
gvids avatar generate <id> --scene 1 --avatar Finley --script script.txt   (experimental)
```

Custom and personal avatars appear in `avatar list` when your account has them.
Personal avatars must be created in Vids first (they need a verification recording).

## AI video (Omni / Veo)

```bash
gvids ai options <id> [--mode create|edit|animate]           (verified: models + aspect ratios)
gvids ai generate <id> --prompt "Cinematic aerial view of New York at night"
gvids ai generate <id> --prompt "A slow cinematic pan across a calm ocean at sunrise" --scene 2   (verified: 10 s clip, ~4.5 min)
gvids ai generate <id> --prompt prompt.txt --image person.png --image logo.png --aspect portrait
gvids ai generate <id> --prompt "…" --model omni --insert none   # keep it in the AI gallery only
gvids ai edit <id> ./clip.mp4 --prompt "Turn this into a cinematic nighttime scene"   (experimental)
gvids ai animate <id> ./photo.png --prompt "Slow push-in, leaves moving in the wind"   (experimental)
```

Model and aspect names are read from the live UI — gvids does not hard-code
model names. `--model omni` matches "Omni 720p with audio" by prefix. Every
generation uses your Vids AI allowance.

A finished clip appears in the side sheet with _Insert_; Insert previews it on
the canvas with **Insert in new scene** (the Vids default) or, under _More
options_, **Insert in current scene**. `--insert` picks one: the default is
`current-scene` when `--scene` is given, otherwise `new-scene`; `none` leaves
the clip in the AI gallery. gvids waits for the new clip/object before it
returns.

## Slides

```bash
gvids slides import <vid-id> <slides-id|url>                   (verified: AI script + voiceover)
gvids slides import <vid-id> <slides-id|url> --no-ai --slides 1,3-5   (verified)
gvids slides import <vid-id> <slides-id|url> --narration avatar
gvids create "Deck video" --slides <slides-id>                 (verified)
```

Vids' import has two steps after the Drive picker: _Select slides_ (a checkbox
per slide and a switch for "AI voiceover, script, background music and
animation") and, with that switch on, _Edit script and customize video_
(narration: voiceover only or AI avatar + voiceover). gvids drives both and
appends the imported scenes after the last scene. Landscape videos only.

## Trash

```bash
gvids trash <id> --yes      (verified without OAuth: File › Move to trash)
gvids restore <id>          (verified without OAuth: "Take out of trash")
```

With an OAuth login these use the Drive API. Editing commands on a trashed
video fail with `VIDEO_IN_TRASH` (exit 5) instead of fighting the dialog Vids
shows over it. Vids greys out File › Move to trash for a video that was never
edited; rename or edit it first (or use the Drive API path).

Opening a never-edited video brings back its _Getting started_ dialog; editor
commands close it, which leaves the video blank (as the dialog's Close button
does).

## Export

```bash
gvids download <id> out.mp4                   # Drive API render; without OAuth, the editor (verified)
gvids export <id> out.mp4 --via-browser       # editor render in the browser (verified)
gvids export <id> out.gif --format gif        # editor only (verified for a 5 s video)
```

Vids only makes GIFs of videos that are **30 seconds or shorter**; longer ones
get a "Can't download GIF" dialog, which gvids reports as `FEATURE_UNAVAILABLE`
(exit 6) right away.

## Not automated (by design or not yet)

Recording (needs a camera/screen), music and image generation, captions, Export
to Drive / YouTube (publishing is left to you), transitions and animations,
media crop/trim/replace, precise object positioning, comments, version history.
These show up in `gvids capabilities` as available-in-Vids but "not automated".
