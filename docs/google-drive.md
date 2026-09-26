# Google Drive integration

All file-level operations on Google Vids go through the Google Drive API v3 when
there is an OAuth login (`gvids auth login`). Vids files have the MIME type
`application/vnd.google-apps.vid`; every list or search query gvids sends is
restricted to it.

When the Drive API cannot be used — no OAuth login, or one that is expired,
revoked or lacks a scope — these commands use the signed-in gvids browser
instead (the envelope says so in `warnings`, naming the reason, and in
`data.method`):

| Command                  | Browser fallback                                        |
| ------------------------ | ------------------------------------------------------- |
| `list`                   | recent videos from the Vids home page                   |
| `search <text>`          | the Vids home search (title matches)                    |
| `info`                   | title, scene count, duration and format from the editor |
| `rename`                 | the editor's title box                                  |
| `trash` / `restore`      | File › Move to trash / "Take out of trash"              |
| `download`, `export mp4` | File › Download › MP4 rendered in the browser           |
| `media add-drive`        | Insert › Drive & Photos picker                          |

`copy`, `move`, `delete`, `thumbnail`, sharing and the list filters (`--folder`,
`--owner`, `--starred`, `--trashed`, `--order-by`, `--all`, dates, …) need the
Drive API; with them, a missing login is an error (`AUTH_REQUIRED`) rather than a
fallback.

## Listing and searching

```bash
gvids list                     # 30 newest, table
gvids ls --limit 50
gvids list --all               # every page
gvids list --folder <folder-id|url>
gvids list --shared-with-me --starred
gvids list --owner me --order-by name --asc
gvids list --trashed
gvids list --drive <shared-drive-id>
gvids list --ids               # data.ids only

gvids search "biology"                       # title contains
gvids search "quarterly" --full-text         # title, description and indexed text
gvids search --modified-after 2026-09-01 --modified-before 2026-09-30
gvids search --owner colleague@example.com --created-after 2026-01-01
```

The generated Drive query is included in JSON output (`data.query`) so agents
can see exactly what was asked.

## Metadata and URLs

```bash
gvids info <id|url>            # name, owners, dates, parents, sharing, capabilities, size
gvids url <id>                 # https://docs.google.com/videos/d/<id>/edit (offline)
gvids url <id> --check         # confirm it exists via the API
gvids open <id>                # default browser
gvids open <id> --gvids-browser
gvids thumbnail <id> thumb.png --size 1280
```

Drive shortcuts that point at a Vid are resolved to the target automatically.

## Changing files

```bash
gvids rename <id> "New title"
gvids copy <id> --name "Copy name" --folder <folder>
gvids move <id> <folder-id|url|root>
gvids trash <id> --yes          # recoverable for 30 days
gvids restore <id>
gvids delete <id> --yes         # permanent
```

gvids never prompts. `trash`, `delete` and `unshare` (and public sharing) refuse
with `CONFIRMATION_REQUIRED` (exit 2) until `--yes` is given; the error's `next`
is the exact command to run after the user approved. `--dry-run` shows what would
happen without calling the API. gvids checks the file's `capabilities` first so
"you can't rename this" is reported clearly instead of as a raw 403.

## Sharing

```bash
gvids permissions <id>
gvids share <id> person@example.com --role reader|commenter|writer
gvids share <id> person@example.com --role writer --no-notify
gvids share <id> team@example.com --group --role commenter --message "FYI"
gvids share <id> --domain example.com --role reader
gvids share <id> --anyone reader --yes          # public link: requires --yes
gvids unshare <id> person@example.com --yes     # removing access requires --yes
gvids unshare <id> --anyone --yes
gvids unshare <id> --permission-id <permission-id> --yes
```

`share` is idempotent: sharing again with the same role reports `unchanged`; a
different role updates the existing permission instead of adding a duplicate.
The owner permission is never removed. Role aliases: viewer→reader,
editor→writer.

## MP4 download (long-running operation)

Vids cannot be exported with `files.export` (Google returns `fileNotExportable`).
The documented path is `files.download`, which renders on Google's servers:

```bash
gvids download <id>                     # ./downloads/<title>.mp4
gvids download <id> out.mp4
gvids download <id> exports/ --overwrite
gvids download <id> --revision <revision-id>
gvids download <id> --timeout 45m --detach   # slow renders: then gvids wait <task-id>
gvids export <id> --format mp4          # same thing
```

What happens (visible with `--progress`, or `--human`):

```
Preparing render…
Rendering…              ← polls operations.get with backoff (5 s → 20 s)
Downloading… 42% … 89% … 100%
Saved: ./downloads/My video.mp4 (24 MB, render 1m12s, transfer 3s)
```

The OAuth token is sent only to Google hosts over HTTPS; a download URI pointing
anywhere else is refused.

The file is written to `<name>.mp4.gvids-part`, size-checked against
`Content-Length`, then renamed, so an interrupted download never leaves a
truncated `.mp4`. Existing files are not overwritten without `--overwrite`.

Without OAuth, `gvids export <id> --via-browser` downloads through the editor's
File › Download instead (the browser renders the MP4 locally; GIF export is only
available this way: `gvids export <id> --format gif`).

## Errors

| Situation                                  | Code                  | Exit                                       |
| ------------------------------------------ | --------------------- | ------------------------------------------ |
| no OAuth login                             | `AUTH_REQUIRED`       | 3                                          |
| refresh token expired/revoked              | `TOKEN_EXPIRED`       | 3                                          |
| token lacks a scope                        | `INSUFFICIENT_SCOPES` | 3                                          |
| Drive API not enabled in the Cloud project | `API_NOT_ENABLED`     | 9                                          |
| file missing / not visible                 | `VIDS_NOT_FOUND`      | 5                                          |
| not a Vids file                            | `NOT_A_VID`           | 2                                          |
| no permission                              | `PERMISSION_DENIED`   | 4                                          |
| rate limited                               | `RATE_LIMITED`        | 9 (gvids already retried idempotent calls) |
| Google 5xx or network failure              | `GOOGLE_API_ERROR`    | 9 (`retryable: true`)                      |
| render failed                              | `DOWNLOAD_ERROR`      | 9                                          |
| render took too long                       | `GENERATION_TIMEOUT`  | 8                                          |

Idempotent requests (GET/HEAD/PUT/DELETE) are retried automatically on 429 and
5xx with exponential backoff.
