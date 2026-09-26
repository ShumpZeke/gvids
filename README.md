# gvids — Google Vids for AI agents

gvids lets agents (and scripts) create, edit and export
[Google Vids](https://workspace.google.com/products/vids/) videos from the command line.
It is built for machines first:

- **One JSON envelope per command** on stdout, compact, nothing else there:
  `{"ok":true,"data":{…},"error":null}`. Warnings ride inside it.
- **Typed errors** that tell an agent what to do next: `code`, `exitCode`,
  `retryable`, `needsUser` (ask the person) and `next` (commands to run).
- **Never prompts.** Destructive or public actions fail with `CONFIRMATION_REQUIRED`
  and hand back the exact command to run once the user approved (`--yes`).
- **Self-describing:** `gvids commands` lists every command with its effect,
  backend, confirmation and AI-quota flags; `gvids <command> --help` returns one
  command as JSON; `gvids guide` is a Markdown guide written for agents
  ([AGENTS.md](AGENTS.md)).
- **Safe to explore:** `--dry-run` on any command checks the arguments and
  describes the effect without running it.
- **Long work in the background:** `--detach` returns a task id at once;
  `gvids wait <id>` returns the command's own envelope later; `task cancel` stops
  it cleanly.
- **Parallel-safe:** commands started at the same time (shells, background
  tasks, MCP calls) share one browser, each in its own tab.
- **Batching:** `gvids batch` runs a JSON list of commands in one call.
- **MCP server:** `gvids mcp` exposes the same commands, with the same
  safeguards, as annotated MCP tools.

```text
$ gvids create "Photosynthesis" --prompt "A 60 second explainer for 10-year-olds"
{"ok":true,"data":{"id":"1WyW…","url":"https://docs.google.com/videos/d/1WyW…/edit","title":"Photosynthesis","scenes":13,"format":"landscape","mode":"storyboard"},"error":null}

$ gvids scene delete 1WyW… 3
{"ok":false,"data":null,"error":{"code":"CONFIRMATION_REQUIRED","message":"Refusing to delete scene 3 without confirmation.","exitCode":2,"retryable":false,"needsUser":true,"next":["gvids scene delete 1WyW… 3 --yes"],…}}

$ gvids ai generate 1WyW… --prompt "Aerial shot of a forest at dawn" --scene 2 --detach
{"ok":true,"data":{"taskId":"task_20260923204609_484d4b","status":"running",…,"next":["gvids wait task_20260923204609_484d4b"]},"error":null}
```

Google publishes **no API for editing Vids**. gvids is a hybrid client: the official
**Google Drive API** for file operations and MP4 rendering where an OAuth login
exists, and **browser automation** (Playwright driving the real Vids editor by
accessibility roles) for everything inside a video. Without a usable OAuth login,
listing, search, info, rename, trash/restore, downloads and Drive media also go
through the browser. Research: [docs/research.md](docs/research.md).

## For agents: the contract in one screen

| Topic         | Behaviour                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stdout        | exactly one JSON line per command (`--pretty` indents; `--human` renders for people)                                                                                       |
| stderr        | silent; `--progress` streams JSON-line events, `--verbose`/`--debug` JSON-line logs                                                                                        |
| exit code     | `0` exactly when `ok` · `2` usage/confirmation · `3` sign-in · `4` permission · `5` not found · `6` unavailable · `7` automation · `8` timeout · `9` API · `130` cancelled |
| errors        | `{code, message, exitCode, retryable, needsUser, next?, hint?, details?}`                                                                                                  |
| confirmations | never prompted; `CONFIRMATION_REQUIRED` + `next[0]` = command with `--yes` (run it only after the user agrees)                                                             |
| discovery     | `gvids commands`, `gvids commands scene --full`, `gvids <cmd> --help`, `gvids guide`                                                                                       |
| previews      | `--dry-run` on any command (validates inputs; wins over `--detach`)                                                                                                        |
| slow work     | `--detach` → `gvids wait <task-id>` (returns `STILL_RUNNING`, exit 8, retryable, until done)                                                                               |
| many edits    | `gvids batch` (JSON array of argument arrays on stdin or in a file)                                                                                                        |
| speed         | `gvids browser open --headless` keeps a warm browser; commands on the same video reuse its tab (~2 s each)                                                                 |

Exceptions to "one JSON line": `guide` prints Markdown and `completion` a shell
script (unless `--json`), `mcp` speaks MCP, and the person-only `browser login`/
`auth login` print sign-in instructions on stderr. Status commands (`auth status`,
`browser status`, `doctor`) fail with a typed error when the answer is "not
ready", and still return the full status as `data`.

## Setup

Requirements: Node.js 22.12+, Google Chrome (or Edge; Playwright's Chromium also
works), Windows, macOS or Linux.

gvids is not on npm; install it from this repository.

**1. Install**

```bash
git clone https://github.com/ShumpZeke/gvids.git
cd gvids
corepack enable             # provides pnpm (or: npm install -g pnpm)
pnpm install
pnpm run build
npm link                    # puts the `gvids` command on your PATH
gvids --version
```

If `pnpm install` does not download a browser and you have no Chrome/Edge, run
`npx playwright install chromium`.

**2. Sign in to Google in the browser (required, once)**

```bash
gvids browser login         # a window opens: sign in to your Google account
gvids doctor                # checks sign-in, browser and Vids access
```

This is the one step that needs a person: you sign in (MFA and CAPTCHA included)
in a dedicated profile (`~/.gvids/browser/profile`); gvids never sees the
password. Everything else can be driven by an agent. Your account needs Google
Vids (Google Workspace or a Google AI plan).

**3. Optional: Drive API (faster file operations)**

Without it, sharing, copy, move, trash, rename and thumbnails still work through
the Vids editor. With it they are faster, and you also get permanent delete,
comments, version lists, advanced list filters and server-side MP4 export.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Google Drive API**.
2. Google Auth Platform → **Branding**: app name, your email. → **Audience**:
   External; add yourself as a test user (or publish the app, which needs a
   homepage and privacy-policy URL, so sign-ins don't expire every 7 days).
3. **Clients** → Create client → **Desktop app** → download the JSON.
4. Save it as `~/.gvids/client_secret.json`, then:

```bash
gvids auth login            # approve Drive access in the browser
gvids auth status
```

Details and CI variables: [docs/authentication.md](docs/authentication.md).

**4. Optional: use it from an agent**

- Claude Code skill: copy `skills/gvids` into `~/.claude/skills/`.
- MCP: add `gvids mcp` as a stdio server (see [MCP](#mcp) below).
- Any agent: `gvids guide` prints the full agent contract.

**Update:** `git pull && pnpm install && pnpm run build`.
**Uninstall:** `npm unlink -g gvids`, then delete `~/.gvids`.

## What agents can do

| Area       | Commands                                                                                                                      | Backend             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Discover   | `guide` `commands` `capabilities` `doctor` `list` `search` `info`                                                             | local / Drive or UI |
| Create     | `create` blank, `--prompt` (Gemini storyboard), `--template`, `--upload`, `--slides`, `--format`                              | browser             |
| Scenes     | `scene list/add/duplicate/delete/move/duration/background`, `format`                                                          | browser             |
| Content    | `text list/add/edit/delete`, `media add/add-drive/delete`, `template list/search/apply`, `script get/set`                     | browser             |
| AI         | `storyboard generate/regenerate/create-draft`, `ai options/generate/edit/animate`, `voiceover …`, `avatar …`, `slides import` | browser             |
| Files      | `rename` `trash` `restore` `copy` `move` `delete` `thumbnail` `permissions` `share` `unshare`                                 | Drive (or browser)  |
| Export     | `download` (MP4), `export --format mp4\|gif`                                                                                  | Drive or browser    |
| Automation | `batch`, `run` (YAML/JSON workflows, resumable jobs), `--detach` + `wait`/`tasks`/`task …`, `mcp`                             | both                |

Full reference (generated from the code, with each command's effect and
requirements): [docs/commands.md](docs/commands.md). Editor features in depth:
[docs/google-vids.md](docs/google-vids.md). Workflows:
[docs/workflows.md](docs/workflows.md).

## Recipes

```bash
# Build a video step by step
id=$(gvids create "Launch recap" | jq -r .data.id)
gvids browser open --headless                      # optional: keep the browser warm
gvids scene add "$id"
gvids text add "$id" --scene 1 --text "Launch recap" --size 60 --bold
gvids media add "$id" ./chart.png --scene 2
gvids voiceover generate "$id" --scene 2 --script "Revenue grew 20 percent." --voice Knox
gvids download "$id" launch.mp4
gvids browser close

# The same edits in one call
echo '[["scene","add","'$id'"],["text","add","'$id'","--scene","2","--text","Hello"]]' | gvids batch

# A slow AI clip in the background
task=$(gvids ai generate "$id" --prompt "Aerial shot of a forest at dawn" --scene 2 --detach | jq -r .data.taskId)
gvids wait "$task" --timeout 9m                    # repeat while error.code == "STILL_RUNNING"
gvids task cancel "$task"                          # or stop it (closes its tabs first)

# Preview before changing anything
gvids trash "$id" --dry-run
```

More in [AGENTS.md](AGENTS.md) (also printed by `gvids guide`).

## MCP

```bash
claude mcp add gvids -- gvids mcp
```

or `{ "mcpServers": { "gvids": { "command": "gvids", "args": ["mcp"] } } }` for any
client. 30 tools: `gvids` (run any command by argument list), `vids_commands`,
`vids_wait` (waits up to 45 s per call), and curated `vids_*` tools (list, search,
get, create, storyboard, scenes, text, media, templates, Slides, AI, voiceover,
sharing, download, export, rename, trash/restore, capabilities, workflows). Every
tool carries MCP annotations (read-only, destructive, idempotent, open-world) from
the command catalog; destructive tools need `confirm: true` after the user
approved. The MCP server runs commands in-process with exactly the CLI's checks;
person-only commands come back as `USER_ACTION_REQUIRED`. Relative paths resolve
against the server's working directory.

## Limits

- Editor automation depends on Google's English UI (`hl=en` is forced). When it
  changes, commands fail with `UI_CHANGED` (retryable once) and save diagnostics
  under `~/.gvids/debug`; they never continue blindly.
- Vids rules apply: the storyboard only on new, unedited videos; templates, Slides
  import and the storyboard need landscape; GIF export only up to 30 s; AI
  generation uses the account's allowance and varies by plan and region.
- Not automated: recording, music/image generation, captions, transitions,
  animations, crop/trim, exact positioning, publishing to YouTube.
- What was verified live is listed in [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md).

## Security

- OAuth tokens live in the OS credential store (or a 0600 file); tokens, cookies,
  authorization headers and client secrets are redacted from all output, logs and
  debug files (saved page HTML drops inline scripts). The access token is only sent
  to Google hosts over HTTPS.
- The automation browser uses its own profile; gvids never reads passwords or exports
  cookies, and never bypasses sign-in, MFA or CAPTCHAs.
- Public sharing (also inside workflows), removing access, trash, delete, scene
  deletion, sign-out and resets require `--yes` — in the CLI, in `batch` and
  through MCP alike.
- `browser connect` accepts only loopback endpoints unless `--allow-remote`.
- One Drive scope (`drive`, or `drive.readonly` with `--scopes readonly`).

## For people

Add `--human` to any command for readable output (or `GVIDS_OUTPUT=text`, or
`gvids config set output.format text`). Troubleshooting:
[docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```bash
pnpm install
pnpm dev -- list                 # run from source (tsx)
pnpm build                       # clean + tsc → dist/
pnpm check                       # format, lint, typecheck, unit tests, docs:check
pnpm test                        # unit tests (offline: fake Drive, no browser)
pnpm test:live                   # real Google; GVIDS_LIVE=1, pnpm build, a signed-in browser profile
pnpm docs:commands               # regenerate docs/commands.md from the CLI
pnpm mcp:smoke                   # start the built `gvids mcp` over stdio and check it (offline)
```

Architecture: [docs/architecture.md](docs/architecture.md). TypeScript, Node 22+,
Commander, `@googleapis/drive`, Playwright over CDP, Zod, Pino, Vitest.

## License

MIT
