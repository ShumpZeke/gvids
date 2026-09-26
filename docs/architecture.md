# Architecture

gvids is a TypeScript (ESM, Node 22+) CLI built on Commander, designed to be
driven by AI agents: machine-readable output by default, typed errors, no prompts,
and a self-describing command catalog. It is a _hybrid_ client: every operation
uses the strongest interface Google offers.

```
priority 1  official API ........ Google Drive API v3 (files, permissions, operations, about)
priority 2  documented Workspace API ... none exists for Vids editing (see research.md)
priority 3  stable public HTTP .. docs.google.com/videos URLs (create/edit/home)
priority 4  browser automation .. Playwright over CDP, driving the visible editor by ARIA roles/names
priority 5  last-resort UI ...... keyboard shortcuts / geometry (only scene duration drag)
```

API code and browser code never import each other; they meet only in the
command layer and in the workflow executor.

## Layout

```
src/
├── cli/
│   ├── index.ts              process entry: exit code, Ctrl+C/SIGTERM → cleanup + CANCELLED envelope
│   ├── program.ts            Commander tree, global flags, runCli() (embeddable, no process.exit),
│   │                         the --detach worker side (heartbeat, cancel, outcome)
│   ├── kit.ts                action() wrapper: context, nesting rules, --dry-run (validated), --detach,
│   │                         typed error reporting
│   ├── fallback.ts           the warning when a command falls back from the Drive API to the browser
│   ├── context.ts            CommandContext: config, Output, logger, lazy Drive/auth/browser services
│   ├── catalog.ts            per-command metadata (effect, backend, confirm, AI quota…) + JSON help
│   ├── automation.ts         withAutomation(): browser session lifecycle for editor commands
│   ├── output/               Output (JSON envelopes, warnings, progress events), tables, formatting
│   └── commands/             one module per command group (agent.ts: guide/commands/batch;
│                             tasks.ts: wait/tasks/task)
├── auth/                     OAuth loopback+PKCE, client credentials, token stores, scopes
├── google/                   Drive transport (interface + @googleapis/drive impl), DriveService,
│                             permissions, LRO downloads, query building
├── vids/                     domain types, URL/ID parsing, capability model + cache
├── browser/
│   ├── launcher.ts           find Chrome/Edge/Chromium, spawn with a DevTools port, raw CDP close
│   ├── coordination.ts       cross-process launch lock and per-command leases on the managed browser
│   ├── session.ts            BrowserSession: external / reused / launched modes, tracing, idle tabs,
│   │                         last-user-closes lifecycle
│   ├── selectors/            every UI label and CSS hook (common, editor, storyboard, ai, templates)
│   ├── pages/                page objects: account, home-page, editor-page, start-dialog, storyboard, panels
│   ├── operations/           VidsAutomation facade, UI capability probe
│   ├── diagnostics/          failure capture (screenshot, sanitized ARIA, console/network log)
│   └── ui.ts                 uiStep() error classification, armed(), availability detection
├── automation/               workflow schema + planner, job store, runner, live executor,
│                             background tasks (--detach workers)
├── mcp/                      MCP server (thin adapter that runs CLI commands in-process)
├── config/                   ~/.gvids paths, config table (types, limits, defaults, env) and store
├── errors/                   typed errors, exit codes, Google API / Playwright error mapping
└── utils/                    logger (pino, redaction), redaction, input (stdin/files), time, fs,
                              shutdown (cleanup registry for signals and task cancel)
```

## Request flow

```
argv ─► runCli ─► Commander ─► action(kit, handler)
                                 │  CommandContext.create(): config, Output(json|text), logger → envelope
                                 │  nesting check (batch/MCP) · --timeout check
                                 │  --dry-run → validate inputs, describe, return (wins over --detach)
                                 │  --detach → record task, spawn worker, return task id
                                 ▼
                              handler
                   ┌─────────────┴──────────────┐
          Drive API commands               editor commands
          ctx.drive() → DriveService       withAutomation(ctx, …)
          → GoogleDriveTransport              → BrowserSession.start()
          → @googleapis/drive                 → VidsAutomation → page objects → Playwright
                   └─────────────┬──────────────┘
                                 ▼
                    ctx.out.result(data, human)  → stdout: one JSON envelope (or --human text)
          errors → toGvidsError → ctx.out.failure → error envelope + exit code
```

## Key design decisions

**Typed errors and exit codes.** Every failure is a `GvidsError` subclass with a
stable `code` (e.g. `AUTH_REQUIRED`, `UI_CHANGED`, `FEATURE_DISABLED_BY_ADMIN`),
an exit code, and actionable hints. Google API errors go through
`mapGoogleApiError`; Playwright timeouts go through `uiStep`, which first checks
the page for "not available" messages (admin disabled, region, quota) and
otherwise captures diagnostics and throws `UiChangedError`.

**Agent-first output.** Every command prints exactly one compact JSON envelope
`{ ok, data, error, warnings? }` on stdout. Warnings (including logger warnings)
are collected into the envelope instead of being printed. stderr stays silent
unless `--progress` (JSON-line events) or `--verbose`/`--debug` (JSON-line logs),
so even `2>&1` output is line-parseable JSON. `--human` switches to human
rendering. Nothing ever prompts: confirmations fail with `CONFIRMATION_REQUIRED`
carrying the exact approved command. All output passes through secret redaction.

**Errors tell the agent what to do.** `SerializedError` adds `exitCode`,
`retryable` (transient: UI timing, rate limits, 5xx, timeouts, `STILL_RUNNING`),
`needsUser` (sign-in, consent, approval, admin/plan limits) and `next` (commands,
taken from hints like "Run: gvids auth login" or set explicitly). Defaults come
from the error code; call sites can override them.

**Self-description.** `catalog.ts` annotates every leaf command (a unit test keeps
the map complete) with its effect (read/write/destructive), backend
(local/drive/browser/drive|browser/oauth), confirmation, AI-quota, slow and
person-only flags. It powers `gvids commands`, JSON `--help`, the generic
`--dry-run`, the generated reference and the MCP tool annotations.

**Background work.** `--detach` records a task in `~/.gvids/tasks/` and spawns
the same command in a detached process with `GVIDS_TASK_ID` set. The starter and
the worker never write the same file: the starter writes `<id>.json` (command,
pid), the worker writes `<id>.result.json` (its envelope, exclusive create, first
outcome wins) and touches `<id>.alive` every 5 s. A task whose pid is gone, or
whose heartbeat is older than a minute (pid reuse), is reported as failed.
`gvids task cancel` writes `<id>.cancel`; the worker notices within half a
second, runs the shutdown cleanups (closes its tabs, releases its browser lease),
records `CANCELLED` and exits 130, and is killed if it has not stopped after 15 s.
Finished tasks are pruned after 7 days. `gvids wait` relays the stored envelope
and exit code, or fails with `STILL_RUNNING` (retryable) at its timeout.

**Nesting.** `batch` runs items in-process and the MCP server runs tool calls
in-process, both through `runCli()` with `invocation` set. A nested run never
acts as a task worker (`GVIDS_TASK_ID` is stripped), and `action()` refuses, by
resolved command path, what cannot work nested: `batch` and `mcp` inside batch,
`mcp`/`completion` behind MCP, and person-only commands (`USER_ACTION_REQUIRED`).
Confirmations apply unchanged: `--yes` is per command.

**Shutdown.** Browser sessions and running jobs register cleanups in
`utils/shutdown.ts`. Ctrl+C, SIGTERM and task cancellation run them (at most 8 s),
then write a `CANCELLED` envelope unless a result was already printed; failures
that happen during the teardown are reported as `CANCELLED`, not as the error the
teardown caused.

**Warm browser and tab reuse.** A persistent browser (`gvids browser open
--headless`, or `browser.keepOpen`) keeps up to two idle editor tabs after
successful commands. The next command on the same video claims one atomically
(inside the page) and skips the editor load, so a read takes ~2 s instead of ~6 s.
Tabs from failed commands are closed, never reused.

**Browser sessions.** `BrowserSession.start` prefers, in order: an external
Chrome (`gvids browser connect`), an already-running gvids browser (reused over
its `DevToolsActivePort`), or a newly launched one. Launching spawns the real
Chrome binary with `--user-data-dir=~/.gvids/browser/profile
--remote-debugging-port=0 --disable-extensions` (detached, so it can outlive the launching command)
and attaches with `chromium.connectOverCDP`. "Find or launch" and "close if
unused" run under a lock file, and each attached command holds a lease file, so
parallel commands share one browser: a one-off browser is closed (CDP
`Browser.close`, so cookies are flushed) by the last command that used it, a
persistent one only by `gvids browser close`, which refuses while leases exist
unless `--force`. Stale locks and leases (dead pid) are cleaned up. If a reused
browser does not respond (a hung tab can block attaching), gvids sends
`Browser.close` over a bare WebSocket and relaunches.

**Selector resilience.** Locators are built from ARIA roles and accessible
names (`getByRole('button', { name: 'Generate a voiceover' })`), menu paths
(`menu(['Scene', /^Move scene/, /^Move scene left/])`) and dialog names; CSS is
used only for a handful of stable hooks (title input, canvas SVG, timeline
handles). The UI is forced to English with `hl=en`. All labels live in
`src/browser/selectors/` — updating gvids after a Google UI change means editing
that directory.

**State-transition waiting.** No fixed sleeps for long operations: `poll()` with
bounded exponential backoff for Drive renders; generation steps watch for the
new timeline clip, object or dialog state; everything takes `--timeout`.

**UI hygiene.** gvids reveals Vids' hidden menus only while it works and hides
them again, closes the side sheets it opened, dismisses coach marks with
"Got it"/"Close" only, and waits for "Saved to Drive" before disconnecting.

**Workflows are jobs.** A YAML/JSON workflow is compiled into a flat list of
steps with stable IDs, persisted under `~/.gvids/jobs/<job>.json` after every
transition. Steps record the video ID as soon as it exists. Resume skips done
steps, re-runs the failed one, and several steps check for existing effects
(text already present, voiceover already there, file already exported) so a
resumed step does not duplicate work.

**API first, editor as fallback.** File-level commands use the Drive API. When
that fails because of the OAuth login (none, expired or revoked, missing scope —
any `AuthError`), `list`, `search`, `info`, `rename`, `trash`, `restore`,
`download`, `export` and `media add-drive` switch to the equivalent browser
action (`viaDriveOrBrowser()`), say so in `warnings` with the reason, and set
`"method": "drive-api" | "browser"`. `list`/`search` use the Vids home page
(recent videos, title search) and `info` the editor. Commands without a browser
equivalent (`copy`, `move`, sharing, `delete`, `thumbnail`, Drive-only list
filters) stay API-only. The OAuth token is only sent to Google hosts over HTTPS.

**Validate before side effects.** Arguments, local input files, colors, sizes
and IDs are checked before a browser starts or an API call is made, so a typo
cannot leave a half-edited video; `--dry-run` runs the same checks. `create`
reports the video it made (`details.createdVideo`) if a later step fails.

**Small startup.** Every command loads only what it needs: the Google client
libraries, Playwright, the MCP SDK, zod (workflows) and yaml (`--human`, YAML
inputs) are imported on first use, and configuration is validated from a table
instead of a schema library. A local command (`commands`, `tasks`, `wait`,
dry-runs) loads about a third of the modules it did before.

**MCP is an adapter.** `gvids mcp` registers tools that call `runCli()` in-process
with captured streams (`--json` first, `--human`/`--pretty` dropped), so MCP
clients get exactly the CLI's behaviour, safeguards and envelopes. A generic
`gvids` tool runs any command; curated `vids_*` tools carry annotations derived
from the catalog; `vids_wait` waits at most 45 s per call so it stays under
common client request timeouts.

## Testing

- `pnpm test` — unit tests: URL parsing, config (validation, migration,
  repair), error mapping and agent fields, redaction, input handling, Drive
  service and LRO download against an in-memory fake Drive
  (`tests/helpers/fake-drive.ts`, fixtures in `tests/fixtures/`), permissions,
  workflow parsing/planning, job persistence/resume/cancel, the whole CLI
  in-process (`tests/helpers/cli.ts`, which stubs the browser and task spawning),
  the output contract (`contract.test.ts`), the command catalog, background tasks
  (races, heartbeat, cancel, prune), the browser lock and leases, shutdown, UI
  label patterns and the MCP adapter.
- `pnpm mcp:smoke` — starts the built `gvids mcp` over stdio with the official
  client and checks tools, annotations, envelopes and refusals (offline).
- `pnpm docs:check` — fails when `docs/commands.md` no longer matches the code.
- `pnpm test:live` — opt-in tests against real Google (see
  [browser-automation.md](browser-automation.md#live-tests)).
