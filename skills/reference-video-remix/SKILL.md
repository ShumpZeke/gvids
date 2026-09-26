---
name: reference-video-remix
description: >
  Turn a user-supplied short reference video into a new ~30 second vertical remix:
  analyze the source, preserve its pacing/camera/body-motion grammar, rewrite the dialogue
  for a new topic, cut and mute source segments, create character-consistent video-to-video
  prompts, render three independent clips, add TTS/captions, stitch, and output publishing copy.
  Optimized for low-poly PS2/early-PS3 character remixes and Goli NAD+ / Target campaign endings.
---

# Reference Video Remix Skill

## Core goal

The user gives:
1. a reference video,
2. a topic or premise,
3. usually one main character reference image,
4. optionally a second-person / prop / product reference image.

Return a finished remix package with as little user intervention as possible.

Default output:
- 3 connected clips, each <= 10 seconds,
- total length about 24–30 seconds,
- source-video motion/camera/pacing preserved,
- new dialogue matched to the original timing,
- main character restyled from the supplied reference image,
- PS2 / early-PS3 low-poly game look,
- restrained, deadpan acting,
- optional Goli NAD+ / Target sponsor tag only at the end,
- final stitched MP4,
- title + description + hashtags,
- muted source-cut ZIP,
- script + prompts + edit notes.

The user should only need to replace TTS if the automatic voice sounds wrong, or review a render if generation quality is bad.

## Non-negotiable creative rules

### 1. Preserve the reference video's visual grammar
Treat the reference video as the motion and editing blueprint.

The source video controls:
- timing,
- shot order,
- camera movement,
- body pose,
- gestures,
- framing,
- scene rhythm,
- object interaction,
- reaction timing,
- cut timing.

The character image controls:
- face,
- hair,
- clothing,
- colors,
- proportions,
- character identity.

Do NOT invent a totally different skit when a source video is provided.

### 2. Do not use video extension as the primary continuity method
Do NOT use Extend / continuation generation to make Clip 2 and Clip 3.

Reason: extension often drifts away from the original reference motion, framing, environment, and face.

Instead:
- cut the ORIGINAL reference into 3 source segments,
- transform each source segment independently,
- use the same character reference image on every segment,
- stitch the independently generated clips locally.

If the generation CLI cannot accept reference video conditioning:
- do not pretend it can,
- create an anchor image from the source frame for each segment,
- use image-to-video only as a fallback,
- clearly mark that fidelity will be lower.

### 3. PS2 / early-PS3 look, not modern CGI
Default visual style:
- obvious low-poly geometry,
- low-resolution / compressed textures,
- simple baked lighting,
- basic materials,
- old console in-engine cutscene feel,
- slightly stiff lip-sync,
- restrained facial animation,
- minimal eye acting,
- no photorealism,
- no modern Pixar-like/cartoon-like expressiveness.

When the output becomes too animated: reduce eye movement, eyebrow movement, hand gestures, head bobbing, body sway, and reaction intensity.

### 4. Deadpan is funnier
The humor should come from the wording, oddly specific details, visual context, and serious delivery.

Avoid:
- big cartoon reactions,
- constant yelling,
- exaggerated eye widening,
- random slapstick,
- generic AI-skit dialogue,
- rule-of-three filler,
- repetitive "It's not X, it's Y" constructions.

### 5. Sponsor integration must not ruin the joke
For Goli campaign remixes:
- let the actual joke end first,
- then hard cut to a short sponsor tag,
- keep the sponsor tag around 2–4 seconds when possible,
- do not force gummies into the premise unless the source format naturally supports it,
- do not make health claims,
- preferred line: "Get your Goli NAD+ Gummies at Target.",
- required campaign hashtag when requested: #GOLINAD.

## Workflow

### Step 1 — Inspect the source
Use local tools first.

Run:
- ffprobe for duration, FPS, resolution, and audio streams,
- ffmpeg to extract a contact sheet or frames every ~1–2 seconds,
- local transcription if available (faster-whisper, whisper, or equivalent).

Collect:
- total duration,
- exact spoken transcript,
- sentence timing,
- major scene/camera cuts,
- prop reveals,
- reaction beats,
- final punchline / ad beat.

Do not rely on OCR unless unavoidable.

If source speech cannot be transcribed, still analyze visual timing and ask for transcript only if necessary.

### Step 2 — Derive 3 source segments
Goal: 3 segments, normally 7–10 seconds each, NEVER above the video model's per-clip limit.

Prefer natural boundaries:
- sentence ending,
- camera cut,
- prop reveal,
- reaction,
- location change.

For a ~25–30 second source, start around:
- Clip 1: 0–9 sec
- Clip 2: 9–18 sec
- Clip 3: 18–end

Do not force equal lengths if a better natural cut exists.

Cut with ffmpeg and REMOVE AUDIO.

Example:
```bash
ffmpeg -y -ss START -to END -i source.mp4 -an -c:v libx264 -preset medium -crf 18 clip_01_muted.mp4
```

Create:
- 01_source_muted.mp4
- 02_source_muted.mp4
- 03_source_muted.mp4

Zip them with README.txt listing exact time ranges.

### Step 3 — Rewrite the dialogue
The new script must feel like the reference creator's STRUCTURE, not copy their exact wording.

Preserve:
- approximate number of beats,
- sentence density,
- setup-to-punchline pacing,
- pauses,
- reveal timing.

For Luca / Chinese-Time-type clips, prefer:
- specific observation,
- increasingly specific detail,
- dry escalation,
- one memorable punchline,
- hard-cut sponsor tag.

Avoid overstuffing niche slang. Use slang as seasoning.

If the user supplies niche vocabulary, use only terms that naturally fit and keep the sentence understandable without a glossary.

When using unverified online-community claims, treat them as community slang/jokes, not established science.

### Step 4 — Match dialogue to timing
Estimate speaking rate from the original.

Default target:
- 2.0–2.8 words/second depending on source pacing.

For each segment:
- keep rewritten dialogue within roughly +/-10% of original spoken duration,
- shorten rather than speed-read,
- allow intentional pauses when the source has reaction beats.

If automatic TTS overshoots:
1. rewrite shorter first,
2. only then use subtle time-stretch,
3. avoid >8% speed change unless necessary.

### Step 5 — Build per-clip video prompts
Every clip prompt must include this priority block:

Reference priority:
1. SOURCE VIDEO SEGMENT = motion, pose, camera, timing, environment, object interaction.
2. CHARACTER REFERENCE IMAGE = face, hair, outfit, colors, body proportions.
3. STYLE = PS2 / early-PS3 low-poly rendering.

Never let the generator replace the source-video composition with a newly invented composition.

Continuity lock for all clips:
- same face,
- same hair,
- same coat/outfit,
- same body proportions,
- same rendering style,
- no unexplained wardrobe changes,
- no random sword unless user explicitly wants one.

Default animation-control block:
"Keep the acting restrained and deadpan. Reduce movement significantly. Eyes stay mostly steady with only small natural glances. Eyebrows remain mostly neutral. Mouth movement is simple and slightly stiff like an old PS2 cutscene. Minimal head movement. Minimal hand gestures. No constant body sway. No exaggerated surprise. No cartoon reactions. Humor comes from dialogue and situation, not expressive animation."

Prompt safety:
Do not attempt to bypass moderation. If rejected, simplify into benign fictional animation, remove unsafe acts or medical claims, use generic props/vehicles/brands when needed, and never provide harmful procedural detail.

### Step 6 — Generate video clips
Preferred order:
1. video-to-video using each MUTED original segment,
2. same character reference image for all three,
3. independent generation for each clip,
4. local stitch.

DO NOT use Google/video-model Extend for continuity unless user specifically asks.

If Google video CLI is available:
- use it only for independent clip generation,
- pass the exact source segment if CLI supports video conditioning,
- pass the same reference image each time,
- request 9:16,
- request source-length-matched duration,
- request no baked subtitles.

If the CLI does NOT support video conditioning:
- do not claim the result will preserve the original,
- use frame/image conditioning as fallback,
- keep the original source segment package for manual vid2vid elsewhere.

### Step 7 — TTS
Attempt TTS automatically if a local or connected TTS tool exists.

Generate:
- clip_01_tts.wav
- clip_02_tts.wav
- clip_03_tts.wav

Voice direction:
- calm,
- low-energy,
- deadpan,
- serious,
- no announcer voice,
- no excessive emotional acting.

If user says TTS sounds wrong, export clean script and allow user to drop replacement audio into:
- clip_01_tts_user.wav
- clip_02_tts_user.wav
- clip_03_tts_user.wav

Prefer user replacement audio automatically when those files exist.

### Step 8 — Edit locally
Do NOT ask the video model to generate captions.

Local editing order:
1. generated video clip,
2. TTS,
3. optional sound effects,
4. captions,
5. sponsor/product end card,
6. final stitch.

Captions:
- derive from TTS timestamps if available,
- large vertical-video readable captions,
- do not cover face or product,
- keep wording exact,
- avoid excessive karaoke effects unless reference uses them.

Stitch with ffmpeg.

Target:
- H.264 MP4,
- AAC audio,
- 1080x1920 when practical,
- 30 fps unless source strongly suggests another FPS.

### Step 9 — Quality control
Before finalizing, check:

Visual:
- character identity stays consistent,
- clip style stays PS2/early-PS3,
- no accidental photorealism,
- no cartoon eye acting,
- no random weapons,
- no major source-camera drift,
- no weird hands/props during important shots.

Story:
- rewrite makes sense,
- source beat structure is still visible,
- joke lands before sponsor,
- niche vocabulary is not overused.

Audio:
- TTS fits each clip,
- dialogue not cut off,
- no overlapping words between stitched clips,
- volume consistent.

Ad:
- product line is separate from punchline,
- no unsupported health claims,
- Target mention present when required,
- #GOLINAD in publishing copy when required.

If one clip fails QC, regenerate ONLY that clip.

## Output folder structure
```text
project_name/
├── source/
│   ├── source.mp4
│   └── contact_sheet.jpg
├── refs/
│   ├── main_character.png
│   └── optional_secondary_ref.png
├── source_segments/
│   ├── 01_source_muted.mp4
│   ├── 02_source_muted.mp4
│   └── 03_source_muted.mp4
├── prompts/
│   ├── 01_prompt.txt
│   ├── 02_prompt.txt
│   └── 03_prompt.txt
├── script/
│   ├── full_script.txt
│   └── timed_script.txt
├── audio/
│   ├── clip_01_tts.wav
│   ├── clip_02_tts.wav
│   └── clip_03_tts.wav
├── generated/
│   ├── 01_generated.mp4
│   ├── 02_generated.mp4
│   └── 03_generated.mp4
├── final/
│   ├── final_video.mp4
│   ├── title_description.txt
│   └── upload_notes.txt
└── source_segments_muted.zip
```

## Required final response to user
Keep the chat reply concise.

Report:
- new concept in one sentence,
- 3 cut ranges,
- link to muted source ZIP,
- link to final video if generated,
- full script,
- title + description,
- any clip that needs review.

Do not dump long technical logs unless asked.

## Default Goli publishing copy
Use only if campaign context requires it.

Title pattern:
`<Funny premise> 💀 #GOLINAD #PS2Style #Goli #Target #FYP #Shorts`

Description pattern:
`<One-line joke summary>\n\nGet your Goli NAD+ Gummies at Target.\n\n#GOLINAD #PS2Style #Goli #Target #FYP #ForYou #Shorts #GamingMemes #PS2 #Meme`

## Using Google Vids (gvids) as the video generator

`gvids` is installed (see the `gvids` skill; also available as the `gvids` MCP server).
Vids' AI **Edit** mode is real video-to-video: it takes a source clip plus reference
images, so it satisfies Step 6's preferred path. Every AI call spends the user's
Google AI allowance - confirm the plan (3 clips = 3 generations) before starting,
and regenerate only a clip that fails QC.

Per project:

```bash
gvids doctor                                   # must be ready
gvids create "remix <project_name>" --format portrait     # returns data.id = VID
gvids ai options VID                           # models / aspect ratios offered
```

Per clip N (1..3), using the MUTED source segment and the SAME character image:

```bash
gvids ai edit VID source_segments/0N_source_muted.mp4 \
  --image refs/main_character.png \
  --prompt-file prompts/0N_prompt.txt \
  --aspect 9:16 --insert new-scene --timeout 15m
```

- Run clips one at a time (one command per video at a time; `VIDEO_BUSY` = wait).
  For long runs add `--detach`, then `gvids wait <task>`.
- Put "no captions, no on-screen text" in each prompt; captions are added locally (Step 8).
- If `ai edit` is refused or unavailable (`FEATURE_UNAVAILABLE`), fallback: extract an
  anchor frame per segment with ffmpeg and use
  `gvids ai animate VID anchor_0N.png --prompt-file prompts/0N_prompt.txt --aspect 9:16`
  - and say that fidelity to the source is lower.

Getting the generated clips out as files:

```bash
gvids scene list VID                           # scene order + durations
gvids export VID generated/vids_all.mp4        # one MP4 of the whole video
```

Then split `vids_all.mp4` into `generated/0N_generated.mp4` with ffmpeg using the
scene start times/durations from `scene list` (skip the initial blank scene if
present). Do Steps 7-8 (TTS, captions, end card, stitch) locally as described above.

Optional in Vids instead of local TTS: `gvids voiceover generate VID --scene N
--script-file script/clip_0N.txt --voice <name>` (list voices with
`gvids voiceover voices VID`; pick a calm, low-energy one). Local editing remains the
default because it gives exact caption timing.

When done, remove the scratch video only if the user agrees: `gvids trash VID --yes`
(recoverable for 30 days; never `gvids delete`).

## Built-in character: the silver-haired suit character (default main character)

When the user says "my character", "the suit guy", or gives no character image, use the
bundled reference `refs/main_character/main_character_sheet.jpg` (path relative to this skill
folder) for EVERY clip: generation, editing, animation, and QC. It holds front/side/back
turnarounds, a face close-up, four expression/vibe shots, and three in-scene poses.

Pass it on every gvids AI call:

```bash
gvids ai edit VID source_segments/0N_source_muted.mp4   --image "<skill>/refs/main_character/main_character_sheet.jpg"   --prompt-file prompts/0N_prompt.txt --aspect 9:16 --insert new-scene
```

Copy it into the project's `refs/` folder at the start so the package is self-contained.
A user-supplied image overrides it only if the user says so.

Character lock (add to every clip prompt):
"PS2/early-PS3 low-poly in-engine look: swept-back silver-white hair built from faceted
polygons with a few loose strands; pale skin; blue eyes; sharp jaw; thin rimless
rectangular sunglasses with a light blue tint; black two-button business suit with a subtle
dark check pattern; white dress shirt; narrow dark navy tie; black belt; black dress shoes;
bare hands, no gloves. Optional: long black overcoat for night exterior shots. Same design
every clip."

Katana: the sheet shows one, but the skill's rule stands: NO sword unless the user
explicitly asks for it. Say "no sword, no weapon" in prompts.

Acting and voice (from the sheet): cool, composed, understated, a little aloof. Poses:
hands in pockets, adjusting the glasses with one finger, seated with legs crossed and chin
resting on a hand, a slight downward look over the glasses. Expressions stay neutral,
unimpressed, or faintly smug; never big. Voice: mid-low, calm, dry, plain, never shouting.

QC against the ref: silver swept-back hair, tinted rimless glasses, black suit, white shirt,
navy tie; reject clips with a different outfit, missing glasses, realistic/modern skin,
anime/cartoon style, big expressions, or an unrequested sword.

## Getting the reference video (TikTok, YouTube Shorts, Instagram, X, or a file)

The user can give a link instead of a file. Use the bundled tool, which does Step 1 too:

```bash
python "<skill>/tools/fetch_reference.py" "<tiktok-url-or-local-file>" <project_dir>
```

It writes:
- `source/source.mp4`: the downloaded video (best MP4 quality, via yt-dlp)
- `source/info.json`: duration, fps, size, audio, uploader, url
- `source/contact_sheet.jpg`: 1 frame per second, tiled left to right, top to bottom (look at it to plan the 3 cuts)
- `script/source_transcript.json` + `.txt`: timed transcript with word timestamps (faster-whisper; falls back to the CPU)

Then continue at Step 2 (cut the 3 muted segments).

To find references, the user can paste links; the agent can also browse TikTok in a
browser to look at candidates, but download only the ones the user picks.

Rules:
- Public videos only; never log in to or bypass private or restricted accounts.
- The downloaded source stays local in `source/` as the motion/timing blueprint. Only the
  transformed result (new character, new script, new voice) is published, never the raw
  source footage or its audio. Keep `info.json` so the original creator can be credited if the user wants.

If a download fails with "Unexpected response" or similar, update yt-dlp first
(`yt-dlp -U`, or `pip install -U yt-dlp`) and retry; TikTok changes often.
Needs yt-dlp, ffmpeg/ffprobe, and `pip install faster-whisper` for the transcript.

## Watching a video (understand it before remixing)

You cannot play video, so turn it into things you can read and see:

```bash
python "<skill>/tools/watch_video.py" <project>/source/source.mp4 <project>/watch \
  --transcript <project>/script/source_transcript.json
```

Output in `<project>/watch/`:
- `WATCH.md`: duration, cut times, transcript, and a timeline (time -> frame file -> words spoken, CUT marks new shots)
- `sheet_1.jpg`, `sheet_2.jpg`, ...: 12 frames each (4 wide, 3 high), in time order, cells shaped like the video
- `frames/f_<seconds>.jpg`: every sampled frame (1 per second + just after each cut)
- `cuts.json`, `transcript.json`

Read `WATCH.md`, then OPEN EVERY SHEET IMAGE and write a short breakdown before planning:
shots and framing per cut, camera moves, gestures/poses per line, props, location,
on-screen caption style, and the joke beats (setup -> specifics -> punchline -> tag).
Use `--every 0.5` for fast-cut videos; `--scene 0.2` if cuts are missed.
Use the cut times from `cuts.json` as the preferred segment boundaries in Step 2.

## Creator reference: Luca / @santeluca (studied 2026-09-26)

Account: https://www.tiktok.com/@santeluca (list recent videos with
`yt-dlp --flat-playlist --playlist-end 10 --print "%(id)s %(duration)s %(title)s" https://www.tiktok.com/@santeluca`).
Format observed in two videos ("chinese barbers", "best doctors in the world"):
- 22-26 s, landscape or near-square, 3-5 shots; cuts every ~5-10 s, usually wide -> close -> wide.
- A white-haired video-game-style character (goggles, red sweater, camo pants) in a detailed
  3D scene (street barber / luxury clinic); mostly seated, small hand gestures, direct-ish address.
- Structure: bold opinion (1 line) -> 3-4 escalating, oddly specific details (prices, years,
  times) -> short personal punchline -> the tagline "You met me at a very ___ time in my life"
  -> merch plug. ~2.5 words/s, deadpan.
- Captions: big white bold sans with black outline, 2 lines max, lower third, phrase by phrase.
Mimic the STRUCTURE and pacing, not the exact lines; write new specifics for the new topic.

## Environment checklist (read first, every run)

Everything below was tested from Codex on 2026-09-26 and works:
1. `gvids doctor` -> must say ready (Google sign-in and Drive API are already done).
2. Tools: `yt-dlp`, `ffmpeg`, `ffprobe`, `python` with `faster-whisper` are installed.
   If a TikTok download fails, run `yt-dlp -U` and retry (it fixed TikTok once already).
3. This skill's folder: `C:\Users\vardh\.codex\skills\reference-video-remix` ->
   `tools/fetch_reference.py`, `tools/watch_video.py`, `refs/main_character/*.jpg`, `templates/`.
4. Pipeline: fetch_reference (download + transcript) -> watch_video (look at every sheet)
   -> plan 3 cuts from `cuts.json` -> cut muted segments -> script -> prompts with the character
   lock -> `gvids ai edit` per clip with the main character sheet -> export + split -> TTS/captions/stitch.
5. Confirm with the user before the 3 AI generations; everything before that is free.
6. See the `gvids` skill's "This machine" section for account, test videos and quirks.

## Lessons from the first full test (2026-09-26, portrait, 3 clips, ~12 min total)

- Vids AI **Edit** takes a source clip of 10 s or less and has NO reference-image input:
  `--image` is ignored for `ai edit`. Put the character description (hair, glasses, outfit,
  style) in every prompt instead; it held the identity well across all 3 clips.
  Reference images only attach on `ai generate` (Create tab, "Ingredients").
- Model/quality/aspect are one "Generation settings" button now; the clip follows the
  project's format, so create the project in the target format (`--format portrait`).
- Generated clips come with their OWN invented speech audio. Mute every clip before adding
  voiceover: `gvids media sound VID --object <video-object-id> --scene N --mute`
  (object ids from `gvids text list VID --scene N`). Otherwise captions pick up the fake speech.
- In-Vids finish that worked: `voiceover generate --scene N --voice Knox --script "..."`,
  `captions add`, delete the helper scene, `export` (1080x1920 MP4).
- Each clip took about 2.5-3.5 min.

## MUST RULE: character replace ("replace the person with this person")

Applies whenever the user uploads/links a video and asks to replace the person in it,
and to EVERY generation in this skill.

1. Main character reference: ALWAYS `refs/main_character/main_character_sheet.jpg`
   (unless the user supplies a different image for this job). Copy it into the project's
   `refs/` first. Every single generation uses it:
   - `ai generate` / `ai animate`: attach it (`--image` / the image argument).
   - `ai edit` (no image input in Vids): open and look at the sheet before writing EACH
     prompt, and put its full visual description (hair, face, glasses, outfit, colors,
     style) in the prompt. Same wording in every piece.
   - QC every piece against the sheet; regenerate only the pieces that drift.
2. Vids AI Edit only accepts clips of 10 s or less. For any longer video, split it,
   edit every piece, and stitch it back. Never skip a piece; never use Extend.
   ```bash
   python "<skill>/tools/fetch_reference.py" <url-or-file> <project>          # if it is a link
   python "<skill>/tools/watch_video.py" <project>/source/source.mp4 <project>/watch
   python "<skill>/tools/segments.py" split <project>/source/source.mp4 <project>/pieces \
       --transcript <project>/script/source_transcript.json --cuts <project>/watch/cuts.json
   ```
   Pieces are cut at scene cuts first, then sentence ends, never over 10 s
   (`pieces/segments.json` lists them). A 30 s video becomes 3-4 pieces.
3. For each piece N, in order (one at a time on the same Vids project):
   ```bash
   gvids ai edit VID <project>/pieces/NN_source_muted.mp4 \
     --prompt-file <project>/prompts/NN_prompt.txt --insert new-scene --timeout 14m
   ```
   Prompt = "Replace the person with the character described below; keep the source's
   motion, pose, camera, timing, framing, background and props exactly" + the sheet
   description + "no captions, no on-screen text".
   Create the Vids project in the source's shape first (`gvids create "<name>" --format portrait`
   for vertical video), because the edit follows the project format.
4. Get each edited piece out as `<project>/edited/NN_edited.mp4`: `gvids export VID all.mp4`,
   then cut it by the scene durations from `gvids scene list VID` (skip any helper scene).
5. Stitch back, re-timed to the original lengths, with the ORIGINAL audio restored:
   ```bash
   python "<skill>/tools/segments.py" stitch <project>/pieces/segments.json <project>/edited \
       <project>/final/replaced.mp4 --audio <project>/source/source.mp4 --size 1080x1920
   ```
   (Omit `--audio` only if the user wants new voice/captions; then mute the pieces in Vids.)
6. Check the result: same character in every piece, cuts land where the source's cuts are,
   audio in sync. Report which pieces were regenerated.

Cost: one AI generation per piece (a 30 s video = 3-4). Tell the user the count first.
