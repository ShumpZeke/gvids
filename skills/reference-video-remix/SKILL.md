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
`<Funny premise> 💀 #GOLINAD #Vergil #Goli #Target #FYP #Shorts`

Description pattern:
`<One-line joke summary>\n\nGet your Goli NAD+ Gummies at Target.\n\n#GOLINAD #Vergil #Goli #Target #FYP #ForYou #Shorts #GamingMemes #PS2 #Meme`

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

## Built-in character: Vergil (default main character)

When the user says "Vergil", "my character", or gives no character image, use the
bundled references in `refs/vergil/` (paths relative to this skill folder) for EVERY
clip — generation, editing, animation, and QC:

| File | Use for |
|---|---|
| `refs/vergil/vergil_turnaround_front_side_back.jpg` | Full-body identity: outfit, proportions, front/side/back. Primary `--image` for full/medium shots. |
| `refs/vergil/vergil_face_expressions.jpg` | Face/hair lock and allowed expressions (neutral, slightly annoyed, dry/unimpressed). Primary `--image` for close-ups. |
| `refs/vergil/vergil_moodboard_voice_vibe.jpg` | Acting, poses, voice direction. Read it when writing prompts, the script, and TTS direction. |

Pass both identity sheets on every gvids AI call (Vids accepts several `--image`):

```bash
gvids ai edit VID source_segments/0N_source_muted.mp4 \
  --image "<skill>/refs/vergil/vergil_turnaround_front_side_back.jpg" \
  --image "<skill>/refs/vergil/vergil_face_expressions.jpg" \
  --prompt-file prompts/0N_prompt.txt --aspect 9:16 --insert new-scene
```

Copy them into the project's `refs/` folder at the start so the package is self-contained.
A user-supplied image overrides these only if the user says so.

Character lock (add to every clip prompt):
"Vergil from Devil May Cry, PS2/early-PS3 low-poly in-engine look: spiky swept-back
silver-white hair built from large faceted polygons; pale skin; ice-blue eyes; sharp
jaw; long royal-blue tailcoat with silver-white filigree embroidery down the front
panels and a large ornate filigree pattern on the back, gold trim on all edges, rust-orange
lining, high standing collar; gold-studded cuffs; black ribbed zip-up vest; black trousers;
dark brown leather gloves; black knee-high boots with gold heel trim. Same design every clip."

Katana: the reference sheet shows one, but the skill's rule stands — NO sword unless the
user explicitly asks for it. Say "no sword, no weapon, hands empty" in prompts.

Acting and voice (from the moodboard): composed, self-assured, speaks plainly, direct to
camera, power in restraint. Expressions limited to neutral, slightly annoyed, dry/casually
unimpressed, slightly cocky (small smirk at most). Typical gestures: arms crossed, one
gloved hand raised in a small dismissive gesture, slight head turn. Voice: mid-low, calm,
dry, casual, slightly cocky, never shouting. Sample register: "...Go on." / "Is that all?" /
"Hmph." / "So be it."

QC against the refs: silver faceted hair, blue coat with filigree + gold trim, black vest,
gloves; reject clips with a different coat color, modern/realistic skin, anime/cartoon
style, big expressions, or an unrequested sword.

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
