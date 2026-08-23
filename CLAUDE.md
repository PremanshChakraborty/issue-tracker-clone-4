# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Issue Tracker is a monorepo for smart GitHub issue monitoring and Telegram notifications. Users install a GitHub App, configure a watchlist, and receive alerts about issue activity.

**Workspaces:**
- `issue-tracker-ui/` — Next.js 15 frontend + API routes (App Router, NextAuth v5, TypeScript)
- `tracker/` — Node.js CLI that runs on a cron schedule (GitHub Actions) to poll issues and send notifications
- `packages/types/` — Shared TypeScript type definitions

## Commands

All commands use npm workspaces. Run from the repo root unless noted.

```bash
# Frontend dev server
npm run dev -w issue-tracker-ui

# Frontend production build
npm run build -w issue-tracker-ui

# Run the tracker (CLI, one-shot)
npm start -w tracker

# Type-check tracker
npm run typecheck -w tracker

# Install all workspace dependencies
npm install
```

There are no test commands — the project has no test suite.

## Architecture

### Data Storage

There is no database. All persistent state lives as JSON files committed to each **user's own GitHub repo** (forked from the template):

| File | Contents |
|------|----------|
| `watchlist.json` | `{ issues: Record<"owner/repo#num", IssueConfig> }` |
| `state.json` | Per-issue last-seen IDs, inactivity alert state, `last_run` timestamp |
| `settings.json` | Cron interval, timezone, quiet hours, digest time |
| `notifications.json` | Append-only notification history (read by UI) |

The frontend API routes read/write these files via the GitHub App API (`repos.getContent` / `createOrUpdateFileContents`). The tracker reads them at startup and commits updates back at the end of each run.

**Upstash Redis** is used only for ephemeral state:
- GitHub App installation ID → owner/repo mapping
- Telegram connection tokens (10-minute TTL)
- Telegram chat ID per user

### Authentication Layers

1. **Frontend sessions** — GitHub OAuth via NextAuth v5. Session includes `user.githubId` and `user.githubLogin`. Config in `issue-tracker-ui/auth.ts`.
2. **Repo access** — GitHub App (RSA private key) mints short-lived installation tokens on demand. Lazy-initialized in `issue-tracker-ui/lib/githubApp.ts`.
3. **Telegram** — Webhook-based connection. One-time connect tokens stored in Redis; bot messages arrive at `/api/telegram/webhook`.

### Tracker Execution Flow (`tracker/src/main.ts`)

1. Load `watchlist.json`, `state.json`, `settings.json` from the user's repo via GitHub API
2. For each watched issue, fetch comments and events since the stored `last_comment_id` / `last_event_id`
3. `signalDetector.ts` filters results: skip bots, check comment length threshold, match watched users, detect inactivity, detect activity spikes
4. Send instant Telegram messages for triggered signals (respecting quiet hours)
5. If digest time reached, build and send daily digest via `digestGenerator.ts`
6. Commit updated `state.json` and `notifications.json` back to the repo

### Key Patterns

**Issue ref encoding** — Issue refs like `nodejs/node#1234` are URL-path-encoded as `nodejs--node--1234` (double-dash separators). Decoding: the last `--`-delimited segment is the issue number, second-to-last is the repo name, the rest is the owner. See `issue-tracker-ui/lib/utils.ts`.

**Issue modes** — Three preset modes drive defaults:
- `awaiting_reply`: priority critical, 3-day inactivity threshold
- `inactivity_watch`: priority watching, 14-day threshold
- `wip_watch`: priority low, 21-day threshold

Users can override priority and notification types per issue.

**Quiet hours** — Evaluated at tracker runtime in the user's configured IANA timezone. Midnight-crossing ranges (e.g., `23:00–07:00`) are supported. Critical issues can bypass quiet hours with `priority_bypass_quiet_hours: true`.

**Notification delivery status** — Each notification record carries `delivered_to`:
- `'telegram'` — sent instantly
- `'frontend_only'` — stored in `notifications.json`, not pushed
- `'undelivered'` — suppressed (quiet hours or error)

**SHA conflict on file writes** — GitHub's API requires the current file SHA when updating. If two concurrent writes target the same file, the second gets a 409. The UI must refetch the file and retry.

**Types sync** — `issue-tracker-ui/types/index.ts` manually mirrors `packages/types/index.ts`. Keep them in sync when changing shared types; the UI doesn't import the package directly.

### CI/CD

`.github/workflows/tracker.yml` triggers on `workflow_dispatch` (manual or scheduled). It runs `npm start -w tracker` and commits updated state files back to the repo with `[skip ci]` in the commit message to avoid loops.

## Environment Variables

The frontend requires `.env.local` in `issue-tracker-ui/`:

```
AUTH_GITHUB_ID=                    # GitHub OAuth App client ID
AUTH_GITHUB_SECRET=                # GitHub OAuth App secret
AUTH_SECRET=                       # NextAuth secret (random string)
GITHUB_APP_ID=                     # GitHub App numeric ID
GITHUB_APP_PRIVATE_KEY=            # RSA private key (PEM, newlines as \n)
NEXT_PUBLIC_GITHUB_APP_SLUG=       # GitHub App slug (for install URL)
NEXT_PUBLIC_TEMPLATE_OWNER=        # Owner of the template repo
NEXT_PUBLIC_TEMPLATE_REPO=         # Name of the template repo
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
TELEGRAM_BOT_TOKEN=
NEXT_PUBLIC_TELEGRAM_BOT_NAME=     # Bot @username (without @)
TELEGRAM_WEBHOOK_SECRET=           # Arbitrary secret for webhook validation
```

The tracker CLI reads `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` from environment (set as GitHub Actions secrets).

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
