# Authentication

gvids uses two independent sign-ins. The browser profile is needed for anything
that edits a video; the Drive API (OAuth) is optional: without it, `list`,
`search`, `info`, `rename`, `trash`, `restore`, `download`, `export` and
`media add-drive` work through the browser, and only `copy`, `move`, `delete`,
`thumbnail`, sharing and some list filters need it.

|             | Drive API (OAuth)                                                                        | Browser profile                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Used for    | list, search, info, rename, copy, move, trash, delete, sharing, MP4 download, thumbnails | create, storyboard, scenes, text, media, templates, voiceover, avatars, AI video, format, GIF export |
| Set up with | `gvids auth login`                                                                       | `gvids browser login`                                                                                |
| Stored in   | OS credential store (or a 0600 file)                                                     | `~/.gvids/browser/profile` (a Chrome profile)                                                        |
| CI          | environment variables                                                                    | a pre-signed-in profile or `gvids browser connect`                                                   |

Commands that need only one of them never require the other. When both are
available, gvids prefers the Drive API; when the OAuth login is missing, expired
or lacks a scope, commands with a browser equivalent use that and say so in
`warnings`.

## 1. Create a Google Cloud OAuth client (once)

Google requires every app that calls the Drive API to have its own OAuth client.
This takes about five minutes.

1. Open <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → search for **Google Drive API** → **Enable**.
3. **Google Auth Platform → Branding** (the OAuth consent screen): choose **External**,
   fill in an app name (e.g. "gvids") and your e-mail.
4. **Audience**: add your Google account under **Test users**.
   _Testing mode refresh tokens expire after 7 days._ To avoid re-running
   `gvids auth login` weekly, publish the app (**Publish app** → In production). For
   personal use you can ignore the "unverified app" screen when signing in.
5. **Data access** (scopes): add `https://www.googleapis.com/auth/drive`
   (or `drive.readonly` if you only need read access and downloads).
6. **Clients → Create client → Application type: Desktop app** → **Create**.
7. **Download JSON**. Save it as:
   - Windows: `%USERPROFILE%\.gvids\client_secret.json`
   - macOS/Linux: `~/.gvids/client_secret.json`

   or pass it once: `gvids auth login --client-secret-file path\to\client_secret.json`
   (gvids copies it into `~/.gvids`).

A "Web application" client will not work — the loopback redirect gvids uses is
only allowed for Desktop clients.

## 2. Sign in

```bash
gvids auth login
```

gvids starts a temporary server on `127.0.0.1:<random port>`, opens the Google
consent page in your default browser (the URL is also printed for headless
machines) and waits up to 5 minutes. The flow uses PKCE (S256) and a random
`state`. No password or token is ever printed.

Options:

| Flag                              | Purpose                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--scopes full\|readonly`         | scope profile (default `full`, see below)                                                          |
| `--client-secret-file <file>`     | import a client JSON                                                                               |
| `--client-id` / `--client-secret` | pass the client inline                                                                             |
| `--no-browser`                    | only print the URL (copy it to a machine with a browser; forward the port with `ssh -L` if needed) |
| `--port <n>`                      | fixed loopback port                                                                                |
| `--login-hint <email>`            | preselect an account                                                                               |

Check it: `gvids auth status` verifies the token against Google. Without a
working login it fails with `AUTH_REQUIRED` (or `TOKEN_EXPIRED`,
`OAUTH_CLIENT_MISSING`, …; exit 3) and still returns the status as `data`.

`gvids auth logout --yes` revokes the token at Google and deletes it locally
(`--no-revoke` only deletes). It needs `--yes` because only a person can sign in
again. `auth login` itself needs a person at a browser, so it cannot run inside
`batch`, the MCP server or `--detach` (`USER_ACTION_REQUIRED`).

## Scopes

`gvids auth scopes` prints this table.

| Profile          | Scope                                            | Allows                                                                         | Google classification |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------- |
| `full` (default) | `https://www.googleapis.com/auth/drive`          | list, search, metadata, rename, move, copy, share, trash, delete, MP4 download | restricted            |
| `readonly`       | `https://www.googleapis.com/auth/drive.readonly` | list, search, metadata, permissions, MP4 download                              | restricted            |

Why not `drive.file`? That scope only covers files created or opened by the app
itself, which excludes nearly all existing videos. gvids does not request
e-mail/profile scopes: the signed-in account is read from Drive `about.get`.

## Where tokens are stored

- **Default (`auth.tokenStore=auto`)**: the OS credential store — Windows Credential
  Manager, macOS Keychain, or Secret Service on Linux — under service `gvids`,
  account `google-oauth-token`. If the keyring does not work (e.g. no Secret Service
  on a server), gvids falls back to `~/.gvids/credentials/tokens.json` with mode 0600.
- Force a store: `gvids config set auth.tokenStore keyring|file`.
- Stored: refresh token, current access token and expiry, granted scopes, the client
  ID that issued it, and the account e-mail. Never the client secret.

## CI and automation

Set environment variables instead of signing in interactively:

| Variables                                                           | Behaviour                                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GVIDS_ACCESS_TOKEN`                                                | use this short-lived access token as-is (no refresh)                                                                              |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GVIDS_REFRESH_TOKEN` | refresh-token flow (obtain the refresh token once with `gvids auth login` on a workstation and store it as a CI secret)           |
| `GVIDS_SERVICE_ACCOUNT_FILE` (+ `GVIDS_IMPERSONATE=user@domain`)    | service account, optionally with domain-wide delegation (Workspace only). A plain service account only sees files shared with it. |
| `GVIDS_HOME`                                                        | relocate `~/.gvids` (e.g. to a CI workspace)                                                                                      |

Precedence: `GVIDS_ACCESS_TOKEN` › `GVIDS_SERVICE_ACCOUNT_FILE` › `GVIDS_REFRESH_TOKEN`
› stored login.

## Browser sign-in

```bash
gvids browser login
```

A normal Chrome (or Edge) window opens with the dedicated gvids profile
(`~/.gvids/browser/profile`). Sign in exactly as usual — password, MFA, CAPTCHA and
passkeys are handled by you and Google; gvids never sees them. Wait until Google Vids
loads, then **close the window**. gvids then checks the session headlessly and prints
the signed-in account.

Why a plain window? Google blocks sign-in in browsers that are being driven by
automation. The login window therefore runs without any DevTools connection;
automation attaches only afterwards, to the already signed-in profile.

Other commands:

- `gvids browser status` — profile, running state, how many commands use it, and
  the signed-in account; not signed in fails with `LOGIN_REQUIRED` (exit 3) with
  the status as `data`. `--no-check` skips the sign-in check.
- `gvids browser open [id]` — start the gvids browser and keep it running (add
  `--headless` for no window); later gvids commands reuse it.
- `gvids browser close` — close it (refuses while other gvids commands use it;
  `--force` closes anyway).
- `gvids browser reset --yes` — delete the profile (signs gvids out of the browser).

### Using your own Chrome instead

If you would rather automate a Chrome you already use, start it with a
**separate** user-data directory and a local DevTools port, sign in, then connect:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\gvids-chrome"
gvids browser connect http://127.0.0.1:9222
```

Chrome refuses remote debugging on your default profile, which is why the separate
directory is required. Anything that can reach the port can control that browser
and its Google session, so gvids only accepts loopback endpoints unless you pass
`--allow-remote`. Undo with `gvids browser disconnect`.

## Security summary

- Tokens: keyring or 0600 file; redacted from all logs, errors, JSON output and
  debug files (access tokens, refresh tokens, `Bearer` headers, `GOCSPX-` client
  secrets, API keys, OAuth codes, Google session cookies). A `--client-secret`
  value is masked wherever gvids echoes a command (dry-run plans, task records,
  batch results).
- The access token is only ever sent to Google hosts over HTTPS
  (`*.googleapis.com`, `*.google.com`, `*.googleusercontent.com`).
- Browser: dedicated profile, never your main Chrome profile; no cookie export;
  diagnostics redact e-mail addresses and are written under `~/.gvids/debug`.
- Nothing is sent anywhere except Google.
- Never commit `client_secret*.json`, `~/.gvids`, or a `.gvids-debug` directory
  (the repository's `.gitignore` already excludes them).
