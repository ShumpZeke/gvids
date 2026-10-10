# Cinematic Studio

Create Higgsfield-inspired shot-based cinematic workflows using Google Vids' image and video generation and existing gvids automation.

## Usage

    gvids studio presets
    gvids studio plan examples/cinematic-product.yaml
    gvids studio compile examples/cinematic-product.yaml -o campaign.yaml
    gvids studio run examples/cinematic-product.yaml --headless --detach
    gvids wait TASK_ID

Creative briefs use YAML or JSON. Keys: version (1), name, format (landscape/portrait/square), look (see presets), optional style, lighting, negative, model, voice, shots, and export. Each shot requires a prompt; optional kind (video/image), camera, framing, movement, lighting, style, avoid, references (video), caption, narration, duration, music.

Each shot becomes a scene. Video shots invoke AI clip generation and insert the clip into the current scene; image shots invoke image generation; music generates an instrumental track and narration generates a voiceover. Camera and look controls are prompt guidance, not proprietary or deterministic motion effects.

Studio compiles to the standard workflow engine and its persistent job log. Use gvids job resume JOB_ID after interruptions. Local references are resolved relative to the original brief. Preview plans without generating anything.

Google account availability, usage limits, pricing and region restrictions apply; the tool does not bypass sign-in or quotas.
