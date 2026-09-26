# Reference Video Remix Skill

Reusable skill for the workflow we've been doing:

1. Give the agent a reference short-form video.
2. Tell it the new topic/premise.
3. Give it the main character reference image.
4. The agent analyzes the source, rewrites the script to match pacing, cuts the source into 3 muted <=10s segments, generates one prompt per segment, renders each segment independently, adds TTS/captions, stitches locally, and exports the final video + title/description.

## Important design choice

Do NOT use Google/video-model Extend as the normal workflow.

Each generated clip should be based on its own original source-video segment. This preserves source camera, body motion, pose, environment, and pacing much better.

If the generation CLI cannot take a source video as conditioning, the agent should not pretend it can reproduce the source exactly. It should fall back to anchor-frame image-to-video, or export prompts + muted source clips for another vid2vid tool.

## Example request

Use the reference-video-remix skill on this video.
Topic: looksmaxxing / zygos.
Main character: use my main character reference image.
Keep the sponsor tag only at the end.
Make the final video automatically. If TTS is bad, I'll replace it.
