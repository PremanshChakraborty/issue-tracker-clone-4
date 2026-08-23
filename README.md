# Issue Tracker

Smart GitHub issue monitoring with Telegram notifications — signal over noise.

You pick the GitHub issues you care about, choose how closely to watch each one, and get Telegram alerts only for activity that actually matters: a maintainer replying, an issue going stale, a linked PR merging. Everything runs on your own GitHub account. There is no database and no server holding your data.

---

## Table of contents

- [How it works](#how-it-works)
- [Repository layout](#repository-layout)
- [Data model](#data-model)
- [The tracker (`tracker/`)](#the-tracker-tracker)
- [The frontend (`issue-tracker-ui/`)](#the-frontend-issue-tracker-ui)
- [Configuration reference](#configuration-reference)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)

---

## How it works

```
┌──────────────────┐        ┌─────────────────────┐        ┌────────────────────┐
│  Next.js UI      │  reads │  YOUR tracker repo  │  reads │  Tracker CLI       │
│  (Vercel)        │ ─────► │  watchlist.json     │ ◄───── │  (GitHub Actions   │
│                  │ writes │  settings.json      │ writes │   cron, every 30m) │
│  GitHub App API  │        │  state.json         │        │                    │
└──────────────────┘        │  notifications.json │        └─────────┬──────────┘
         │                  └─────────────────────┘                  │
         │ session                                                   │ alerts
         ▼                                                           ▼
   GitHub OAuth                                                 Telegram bot
```

1. You sign in with GitHub and generate your own tracker repo from a template.
2. You install the GitHub App on that one repo. The app mints short-lived installation tokens so the UI can read and write the JSON config files there.
3. You connect Telegram. The bot webhook writes `TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN` into your repo's Actions secrets — you never copy or paste a credential.
4. Activation commits a cron schedule into `.github/workflows/tracker.yml` in your repo and fires the first run.
5. From then on, a GitHub Actions cron job polls the watched issues, detects meaningful signals, sends Telegram messages, and commits updated state back to your repo.

**Your data lives in your repo.** The hosted frontend keeps only ephemeral routing state in Redis (installation → repo mapping, Telegram chat ID, short-lived connect tokens).

---

## Repository layout

This repository is the **template** users generate their personal tracker from. It contains the tracker CLI, the shared types, the Actions workflow, and the seed JSON files.

```
.
├── .github/workflows/tracker.yml   # Cron workflow that runs the tracker
├── tracker/                        # Node.js CLI — polls GitHub, sends Telegram alerts
│   └── src/
│       ├── main.ts                 # Orchestration: load → detect → notify → persist
│       ├── githubClient.ts         # Raw GitHub REST calls + pagination
│       ├── signalDetector.ts       # Filtering and signal logic (the core)
│       ├── digestGenerator.ts      # Builds the daily digest payload
│       ├── telegramNotifier.ts     # Message formatting + Telegram Bot API
│       └── stateManager.ts         # Reads/writes the JSON files on disk
├── packages/types/                 # Shared TypeScript types (@issue-tracker/types)
├── issue-tracker-ui/               # Next.js 16 frontend + API routes (separate git repo)
├── watchlist.json                  # Which issues to watch, and how
├── settings.json                   # Global preferences
├── state.json                      # Per-issue cursors and alert bookkeeping
└── notifications.json              # Append-only notification history (capped at 500)
```

> `issue-tracker-ui/` is gitignored here — it is maintained as its own repository and deployed separately. It is documented in full below.

npm workspaces at the root cover `packages/*` and `tracker`. The UI has its own `package.json` and lockfile.

---

## Data model

There is no database. Four JSON files at the root of the user's repo hold everything.

### `watchlist.json`

```jsonc
{
  "issues": {
    "nodejs/node#1234": {
      "repo": "nodejs/node",
      "issue_number": 1234,
      "title": "Fix the thing",
      "added_at": "2026-01-05T10:00:00.000Z",
      "mode": "awaiting_reply",
      "priority": "critical",
      "inactivity_threshold_days": 3,
      "stale_re_alert_days": 2,
      "watch_users": ["ALL"],
      "ignore_users": [],
      "notify_on": ["comments", "closed", "merged"],
      "priority_bypass_quiet_hours": true,
      "snooze_until": null,
      "notes": "",
      "auto_remove_on_close": true,
      "show_bot_comments": false
    }
  }
}
```

Keys are issue refs in the form `owner/repo#number`.

### `state.json`

Per-issue cursors so each run only processes new activity:

| Field | Meaning |
|---|---|
| `last_comment_id` / `last_event_id` | Highest IDs seen — used for dedup |
| `last_activity_at` | Latest *human* activity; bot events do not reset it |
| `issue_author`, `assignees` | Cached for role labelling and `AUTHOR`/`ASSIGNEE` watch rules |
| `inactivity_alerted`, `inactivity_last_alerted_at` | Stale-alert bookkeeping |
| `window_comment_count`, `window_event_count` | Counters for spike detection; reset on spike or digest |
| `last_telegram_message_id` | ID of the most recent Telegram message for the issue |

Top level also carries `last_run` and `last_digest_sent_at`.

### `settings.json`

Global preferences — see the [configuration reference](#configuration-reference).

### `notifications.json`

An append-only array of notification records read by the frontend history views. Each record carries `delivered_to`:

- `telegram` — sent instantly
- `frontend_only` — recorded for the UI, deliberately not pushed
- `undelivered` — suppressed by quiet hours, or the send failed

The tracker caps the file at the most recent **500** records.

---

## The tracker (`tracker/`)

A one-shot Node.js CLI (`tsx src/main.ts`). It reads the JSON files from the repo checkout, does its work, and writes them back; the workflow commits the diff.

### Run flow

1. **Load** `watchlist.json`, `state.json`, `settings.json`, `notifications.json` from disk. Exit early if the watchlist is empty.
2. **Evaluate quiet hours** in the configured IANA timezone. Same-day (`09:00–18:00`) and midnight-crossing (`23:00–07:00`) ranges both work.
3. **Initialize state** for newly added issues by fetching the issue once (author, assignees, `updated_at`).
4. **Compute `since`** — `state.last_run`, or one cron interval back on the very first run.
5. **Group issues by repo** and fetch, per repo, `GET /repos/{o}/{r}/issues/comments?since=…` and `GET /repos/{o}/{r}/issues/events`, both paginated. One batch of calls per repo, not per issue. A failure on one repo is logged and skipped; the others still run.
6. **Detect signals** per issue (below).
7. **Auto-remove** issues that were closed during the window when `auto_remove_on_close` is set.
8. **Route notifications** — send instantly via Telegram, mark `frontend_only`, or suppress under quiet hours. Critical issues with `priority_bypass_quiet_hours` still send.
9. **Daily digest** — if the digest time has passed and no digest was sent since, build and send it, then zero the window counters.
10. **Persist** `state.json`, `watchlist.json`, `notifications.json`.

### Signal detection (`signalDetector.ts`)

Filters applied in order, per issue:

- **Snooze** — if `snooze_until` is in the future, the issue is skipped entirely.
- **Bots** — dropped when `settings.filter_bots` is on and the issue doesn't set `show_bot_comments`. Detection is by GitHub user `type === "Bot"` plus a known-bot login list (dependabot, renovate, codecov, coderabbitai, …).
- **Ignore list** — comments and events from `ignore_users` are dropped.
- **Comment length** — comments shorter than `min_comment_length` are dropped ("+1", "same here").
- **Watch users** — a comment is relevant only if its author matches `watch_users`. Entries are either exact GitHub logins or keywords: `ALL`, `AUTHOR`, `MAINTAINER` (OWNER/MEMBER/COLLABORATOR), `CONTRIBUTOR` (incl. first-timers), `ASSIGNEE`.

Assignees are tracked incrementally from `assigned` / `unassigned` events, so `ASSIGNEE` rules stay accurate without extra API calls. Event IDs advance even for bot-only events, so nothing is reprocessed.

What gets emitted depends on priority:

| Priority | Comments | Events | Spike detection |
|---|---|---|---|
| `critical` | instant Telegram | instant Telegram | off (everything already alerts) |
| `watching` | deferred to daily digest | instant Telegram | on |
| `low` | `frontend_only` | `frontend_only` | off |

A **spike** fires when `window_comment_count` reaches `spike_comment_threshold`, then resets the counter. **Inactivity** is evaluated during digest generation rather than per-run.

Events are rendered into readable summaries — `@alice assigned @bob`, `@carol added label "bug"`, `Linked PR was merged`.

### Telegram delivery (`telegramNotifier.ts`)

Messages are sent with `parse_mode: HTML` and HTML-escaped bodies. Two shapes: instant alerts and the daily digest, the latter grouped into critical / watching / low sections.

### Commands

```bash
npm start -w tracker        # one-shot run (requires env vars below)
npm run typecheck -w tracker
```

Required environment: `GITHUB_TOKEN` (the built-in Actions token — no PAT needed), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

### Workflow (`.github/workflows/tracker.yml`)

Triggers on a `*/30 * * * *` schedule and `workflow_dispatch`. It checks out the repo, installs dependencies, runs the tracker, then commits `state.json`, `notifications.json`, and `watchlist.json` with `[skip ci]` in the message so state commits never retrigger CI.

---

## The frontend (`issue-tracker-ui/`)

Next.js 16 (App Router) with React 19, NextAuth v5, and TypeScript. It is both the UI and the API layer — there is no separate backend service. Deployed independently (Vercel is the natural target).

### Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16 App Router, React 19 |
| Auth | NextAuth v5 (`next-auth@5 beta`) with the GitHub OAuth provider |
| Repo access | GitHub App via `@octokit/auth-app` + `@octokit/rest` |
| Ephemeral state | Upstash Redis (`@upstash/redis`) |
| Secret injection | `libsodium-wrappers` (sealed-box encryption for GitHub Actions secrets) |
| Icons | `lucide-react` |
| Styling | Hand-written CSS with design tokens in `app/globals.css` — no Tailwind |

### Pages

| Route | Type | Purpose |
|---|---|---|
| `/` | server | Reads session + Redis and redirects to the correct onboarding step or `/dashboard`. Avoids a flash of the wrong page. |
| `/setup` | client | Five-step onboarding wizard |
| `/dashboard` | client | Stat cards, priority ring chart, activity sparkline, inactivity risk list, repo summary, digest timeline, quick actions |
| `/watchlist` | client | All watched issues with mode/priority filters and sorting by risk, activity, or date added |
| `/issues/[ref]` | client | Per-issue detail: config, cursors, and full notification history |
| `/settings` | client | Global settings form backed by `settings.json` |

Client pages gate themselves on `/api/auth/status` and redirect to `/setup?step=…` when onboarding is incomplete.

Issue refs are URL-encoded with double dashes: `nodejs/node#1234` → `nodejs--node--1234`. Decoding takes the last segment as the issue number and the second-to-last as the repo name, so owners containing dashes survive the round trip (`lib/utils.ts`).

### Setup wizard

| Step | Component | What happens |
|---|---|---|
| 1 | `Step1SignIn` | GitHub OAuth sign-in |
| 2 | `Step2CreateRepo` | Links to `github.com/new?template_name=…`, then validates the pasted repo URL — checks `template_repository` and falls back to a sentinel check for `.github/workflows/tracker.yml`. Forks are rejected. |
| 3 | `Step3InstallApp` | Sends the user to `github.com/apps/{slug}/installations/new`. GitHub redirects back to `/api/github/callback`. |
| 4 | `Step4ConnectTelegram` | Requests a one-time connect token, opens `t.me/{bot}?start={uuid}`, polls `/api/telegram/status` every few seconds |
| 5 | `Step5Activate` | Verifies the workflow file and Actions secrets, injects the cron `schedule:` block into `tracker.yml`, commits it, marks the account activated, and dispatches the first run |

### API routes

All routes live under `app/api/`. Every route except the Telegram webhook requires a NextAuth session.

#### Auth & status

| Route | Method | Behaviour |
|---|---|---|
| `/api/auth/[...nextauth]` | GET, POST | NextAuth handlers. The JWT and session callbacks add `githubId` and `githubLogin`. |
| `/api/auth/status` | GET | Single source of truth for onboarding state → `{ authenticated, githubLogin, installed, repoOwner, repoName, telegramConnected, activated }` |
| `/api/auth/token` | GET | Mints a fresh GitHub App installation token scoped to the user's tracker repo. Returns a 55-minute `expiresAt` as a safety window against the real 60-minute TTL. The client keeps it in memory only — never `localStorage`. |
| `/api/activate` | POST | Marks the account activated in Redis |

#### GitHub App

| Route | Method | Behaviour |
|---|---|---|
| `/api/github/callback` | GET | Installation callback. Mints a token, lists accessible repos, and **requires exactly one** — anything else redirects back with `wrong_repo_count`. Persists the installation record, then redirects to the Telegram step. |

#### Repo file access

| Route | Method | Behaviour |
|---|---|---|
| `/api/repo/[file]` | GET | Reads and parses a JSON file from the user's repo → `{ data, sha }`. `file` is allowlisted to `watchlist.json`, `settings.json`, `state.json`, `notifications.json`. |
| `/api/repo/[file]` | PUT | Commits `{ content, sha, message? }` back via `createOrUpdateFileContents` |
| `/api/settings` | GET / PUT | Typed convenience wrapper over `settings.json` |

#### Watchlist

| Route | Method | Behaviour |
|---|---|---|
| `/api/watchlist` | POST | `{ url, mode, overrides? }`. Validates the GitHub issue URL server-side, fetches issue metadata, rejects duplicates with 409, builds the config from `MODE_DEFAULTS[mode]` plus overrides, and commits. Returns `isClosedWarning` when the issue is already closed. |
| `/api/watchlist` | DELETE | `{ ref }` — removes the issue and commits |
| `/api/watchlist/[ref]` | PATCH | Merges a partial `IssueConfig` into the existing entry |

#### Telegram

| Route | Method | Behaviour |
|---|---|---|
| `/api/telegram/connect-token` | POST | Creates a UUID connect token in Redis with a 10-minute TTL → `{ token, botName }` |
| `/api/telegram/status` | GET | Polling endpoint → `{ connected }` |
| `/api/telegram/webhook` | POST | Bot webhook — see below. Unauthenticated by session; guarded by a shared secret header. |

**Webhook flow.** Verifies `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET` (403 on mismatch), parses `/start {uuid}`, resolves the token to an installation, mints a GitHub token, fetches the repo's Actions public key, sealed-box-encrypts both `TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN`, writes them as repo secrets, marks the user connected, deletes the one-time token, and replies with a confirmation. Expired links get a friendly "request a fresh link" message. It always returns 200 for handled updates so Telegram doesn't retry.

Register it once with:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-domain>/api/telegram/webhook","secret_token":"<TELEGRAM_WEBHOOK_SECRET>"}'
```

### Error codes

API routes return `{ error: "<code>" }` with a matching status:

`unauthorized` (401) · `not_installed` (404) · `forbidden_file` (400) · `missing_fields` (400) · `invalid_url` (400) · `issue_not_found` (404) · `file_not_found` (404) · `not_found` (404) · `already_watched` (409) · `sha_conflict` (409) · `github_error` (502) · `write_failed` (502) · `watchlist_read_failed` (502) · `token_mint_failed` (502)

**`sha_conflict` matters.** GitHub requires the current file SHA on every write. Two concurrent writers — say the UI and the tracker's state commit — mean the second gets a 409. Clients must refetch the file and retry rather than force the write.

### Library modules

| File | Role |
|---|---|
| `auth.ts` | NextAuth config; enriches the token and session with `githubId` / `githubLogin` |
| `lib/githubApp.ts` | Lazily constructs `createAppAuth` (it validates `appId` eagerly, which breaks build-time static analysis) and mints installation tokens |
| `lib/kv.ts` | Lazily initialized Upstash client + typed helpers for installations, connect tokens, Telegram status, activation |
| `lib/encryptSecret.ts` | libsodium sealed-box encryption for GitHub Actions secrets |
| `lib/utils.ts` | Relative time, `daysSince`, ref encode/decode, priority colours and badges, mode/notification labels, snooze checks, date grouping |

### Redis keys

| Key | Value | TTL |
|---|---|---|
| `installation:{githubUserId}` | `{ installation_id, repo_owner, repo_name, installed_at }` | none |
| `telegram:connect:{uuid}` | `{ installation_id, github_user_id }` | 10 minutes |
| `telegram:connected:{githubUserId}` | `{ connected_at }` | none |
| `activated:{githubUserId}` | `{ activated_at }` | none |

### Styling

A dark, GitHub-adjacent theme driven entirely by CSS custom properties in `app/globals.css` — backgrounds, borders, a violet accent (`#6e56cf`), semantic priority colours (`--critical` red, `--watching` amber, `--low` grey), radii, shadows, and transitions. Components use a `glass` card class and utility classes like `badge badge-error`. `lib/utils.ts` maps priorities onto these tokens so colours stay consistent between charts, badges, and lists.

### Types

`issue-tracker-ui/types/index.ts` **manually mirrors** `packages/types/index.ts` — the UI does not import the workspace package. Change one and you must change the other.

---

## Configuration reference

### Issue modes

Picking a mode sets the defaults; individual fields can be overridden per issue afterwards.

| Mode | Priority | Inactivity threshold | Re-alert after | Auto-remove on close | Bypass quiet hours |
|---|---|---|---|---|---|
| `awaiting_reply` | critical | 3 days | 2 days | yes | yes |
| `inactivity_watch` | watching | 14 days | 7 days | no | no |
| `wip_watch` | low | 21 days | 10 days | yes | no |

### Global settings (`settings.json`)

| Key | Type | Meaning |
|---|---|---|
| `cron_interval_minutes` | number | Poll interval; also the first-run lookback window |
| `digest_time` | `"HH:MM"` | When the daily digest is sent |
| `digest_mode` | boolean | Declared in the type and surfaced as a default in the UI, but not currently read by the tracker |
| `quiet_hours_start` / `quiet_hours_end` | `"HH:MM"` | Suppression window. Equal values disable it. |
| `timezone` | IANA string | Timezone quiet hours are evaluated in, e.g. `Asia/Kolkata`. Defaults to `UTC`. |
| `filter_bots` | boolean | Drop bot comments and events globally |
| `min_comment_length` | number | Minimum comment length to count as signal |
| `spike_comment_threshold` | number | Comments in a window that trigger a spike alert |
| `default_mode` | `IssueMode` | Mode preselected when adding an issue |

### Notification types

`comment` · `inactivity` · `status_change` · `spike` · `daily_digest`

### Watched event types

`comments`, `assigned`, `unassigned`, `labeled`, `unlabeled`, `closed`, `reopened`, `renamed`, `cross-referenced`, `connected`, `merged`, `milestoned`, `demilestoned`, `review_requested`, `mentioned`.

---

## Local development

```bash
# From the repo root — installs the tracker + shared types workspaces
npm install

# Type-check and run the tracker once
npm run typecheck -w tracker
GITHUB_TOKEN=… TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… npm start -w tracker
```

The frontend has its own dependency tree:

```bash
cd issue-tracker-ui
npm install
npm run dev      # http://localhost:3000
npm run build
npm start
```

There is **no test suite** in this project.

For local Telegram webhook development you need a public URL (ngrok or similar) pointed at `/api/telegram/webhook`, registered with `setWebhook`.

---

## Environment variables

### Frontend — `issue-tracker-ui/.env.local`

```bash
AUTH_GITHUB_ID=                 # GitHub OAuth App client ID
AUTH_GITHUB_SECRET=             # GitHub OAuth App client secret
AUTH_SECRET=                    # NextAuth secret (random string)

GITHUB_APP_ID=                  # GitHub App numeric ID
GITHUB_APP_PRIVATE_KEY=         # RSA private key, PEM, newlines escaped as \n
NEXT_PUBLIC_GITHUB_APP_SLUG=    # App slug, used to build the install URL
NEXT_PUBLIC_TEMPLATE_OWNER=     # Owner of this template repo
NEXT_PUBLIC_TEMPLATE_REPO=      # Name of this template repo

UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

TELEGRAM_BOT_TOKEN=
NEXT_PUBLIC_TELEGRAM_BOT_NAME=  # Bot @username, without the @
TELEGRAM_WEBHOOK_SECRET=        # Arbitrary secret validated on every webhook call
```

### Tracker — GitHub Actions secrets

| Name | Source |
|---|---|
| `GITHUB_TOKEN` | Provided automatically by Actions |
| `TELEGRAM_BOT_TOKEN` | Injected by the Telegram webhook during setup |
| `TELEGRAM_CHAT_ID` | Injected by the Telegram webhook during setup |

---

## Deployment

**Frontend.** Deploy `issue-tracker-ui/` to any Next.js host with all env vars set. Point the GitHub App's setup callback URL at `https://<domain>/api/github/callback` and the OAuth callback at `https://<domain>/api/auth/callback/github`, then register the Telegram webhook.

**GitHub App permissions.** Repository contents (read & write, for the JSON config files and the workflow), Actions secrets (write, for injecting Telegram credentials), and issues (read, for issue metadata and activity).

**Tracker.** Nothing to deploy — each user's generated repo runs it on GitHub Actions. Keep this template repo up to date; users get fixes by pulling from it.
