import { loadAll, saveState, saveWatchlist, saveNotifications } from './stateManager';
import {
  getRepoComments,
  getRepoEvents,
  getIssue,
  extractIssueNumber,
} from './githubClient';
import { detectSignals } from './signalDetector';
import { sendInstant, sendDailyDigest } from './telegramNotifier';
import { generateDailyDigest } from './digestGenerator';
import type {
  IssueConfig,
  IssueState,
  Notification,
  Watchlist,
  TrackerState,
} from '@issue-tracker/types';

// ─── Env ───────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Parse "owner/repo#1234" → { owner, repo, number } */
function parseIssueRef(ref: string): { owner: string; repo: string; number: number } {
  const match = ref.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) throw new Error(`Invalid issue ref format: "${ref}"`);
  return { owner: match[1]!, repo: match[2]!, number: parseInt(match[3]!, 10) };
}

/** Group watchlist issues by repo key ("owner/repo") */
function groupByRepo(
  issues: Record<string, IssueConfig>,
): Map<string, Array<[string, IssueConfig]>> {
  const map = new Map<string, Array<[string, IssueConfig]>>();
  for (const [ref, config] of Object.entries(issues)) {
    const key = config.repo;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push([ref, config]);
  }
  return map;
}

/** Check if current time falls within configured quiet hours.
 *  Hour/minute comparison is done in settings.timezone (IANA, e.g. "Asia/Kolkata")
 *  so the config always means what the user intends, regardless of the runner's
 *  system timezone (GitHub Actions uses UTC).
 */
function isQuietHours(
  settings: { quiet_hours_start: string; quiet_hours_end: string; timezone: string },
  now: Date,
): boolean {
  // Resolve current time in the user's timezone
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: settings.timezone ?? 'UTC',
  }).formatToParts(now);

  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const current = `${h}:${m}`;

  const { quiet_hours_start: start, quiet_hours_end: end } = settings;
  if (start === end) return false;
  // Handles same-day ranges (09:00–18:00) and midnight-crossing ranges (23:00–07:00)
  return start > end
    ? current >= start || current < end
    : current >= start && current < end;
}

/** Default IssueState for a newly tracked issue */
function defaultIssueState(author = '', assignees: string[] = []): IssueState {
  return {
    issue_author: author,
    assignees: assignees,
    last_comment_id: null,
    last_event_id: null,
    last_activity_at: null,
    inactivity_alerted: false,
    inactivity_last_alerted_at: null,
    last_telegram_message_id: null,
    window_comment_count: 0,
    window_event_count: 0,
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Issue Tracker Cron Start ===');
  const now = new Date();

  // GITHUB_TOKEN is the built-in Actions token — automatically available in every workflow run.
  // Users never need to create a PAT. It has read access to all public repos.
  const pat = requireEnv('GITHUB_TOKEN');
  const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');

  // 1. Load all JSON files
  const { watchlist, state, settings, notifications } = loadAll();
  const issueRefs = Object.keys(watchlist.issues);

  if (issueRefs.length === 0) {
    console.log('No issues in watchlist, exiting.');
    process.exit(0);
  }
  console.log(`Found ${issueRefs.length} issue(s) to process.`);

  // 2. Quiet hours check
  const quietHours = isQuietHours(settings, now);
  if (quietHours) console.log('Currently in quiet hours — only critical issues will notify.');

  // 3. Initialize state for any new issues (no state entry yet)
  for (const ref of issueRefs) {
    if (!state.issues[ref]) {
      console.log(`  New issue ${ref} — fetching initial state...`);
      const { owner, repo, number } = parseIssueRef(ref);
      try {
        const issue = await getIssue(owner, repo, number, pat);
        state.issues[ref] = {
          ...defaultIssueState(issue.user.login, issue.assignees.map((a) => a.login)),
          last_activity_at: issue.updated_at,
        };
        console.log(`  Initialized ${ref} with last_activity_at=${issue.updated_at}`);
      } catch (err) {
        console.warn(`  Could not initialize state for ${ref}:`, err);
        state.issues[ref] = defaultIssueState();
      }
    }
  }

  // 4. Compute 'since' timestamp for API queries
  //    On first ever run (last_run null), look back one cron interval
  const since =
    state.last_run ??
    new Date(now.getTime() - settings.cron_interval_minutes * 60 * 1000).toISOString();
  console.log(`Fetching activity since: ${since}`);

  // 5. Group issues by repo (one batch of API calls per repo)
  const byRepo = groupByRepo(watchlist.issues);

  const allNewNotifications: Notification[] = [];
  const digestQueue: Notification[] = [];
  const updatedWatchlist: Watchlist = {
    issues: { ...watchlist.issues },
  };
  const updatedState: TrackerState = {
    ...state,
    last_digest_sent_at: state.last_digest_sent_at ?? null,
    issues: { ...state.issues },
  };

  // 6. For each unique repo: fetch comments + events, then process each issue
  for (const [repoKey, repoIssues] of byRepo) {
    const [owner, repoName] = repoKey.split('/') as [string, string];
    console.log(`\nRepo: ${repoKey} (${repoIssues.length} watched issue(s))`);

    let repoComments = [];
    let repoEvents = [];

    try {
      [repoComments, repoEvents] = await Promise.all([
        getRepoComments(owner, repoName, since, pat),
        getRepoEvents(owner, repoName, since, pat),
      ]);
      console.log(
        `  Fetched ${repoComments.length} comment(s), ${repoEvents.length} event(s)`,
      );
    } catch (err) {
      // Per-repo failure — log and continue, don't abort other repos
      console.error(`  Failed to fetch data for ${repoKey}:`, err);
      continue;
    }

    // 7. For each watched issue in this repo
    for (const [issueRef, config] of repoIssues) {
      const { number: issueNumber } = parseIssueRef(issueRef);

      // Filter to only this issue's comments/events
      const issueComments = repoComments.filter(
        (c) => extractIssueNumber(c.issue_url) === issueNumber,
      );
      const issueEvents = repoEvents.filter((e) => e.issue?.number === issueNumber);

      console.log(
        `  Issue ${issueRef}: ${issueComments.length} comment(s), ${issueEvents.length} event(s)`,
      );

      const issueState = updatedState.issues[issueRef] ?? defaultIssueState();

      // 8. Detect signals
      const { notifications: newNotifs, updatedState: stateUpdate } = detectSignals(
        issueRef,
        config,
        issueState,
        issueComments,
        issueEvents,
        settings,
        now,
      );

      // Merge state updates
      updatedState.issues[issueRef] = { ...issueState, ...stateUpdate };

      // 9. Handle auto_remove_on_close
      const wasClosed = issueEvents.some((e) => e.event === 'closed');
      if (wasClosed && config.auto_remove_on_close) {
        delete updatedWatchlist.issues[issueRef];
        console.log(`  Auto-removed ${issueRef} from watchlist (issue closed).`);
      }

      // 10. Route notifications: instant vs frontend_only, respecting quiet hours
      for (const notif of newNotifs) {
        const bypassQuietHours = config.priority === 'critical' && config.priority_bypass_quiet_hours;

        if (quietHours && !bypassQuietHours) {
          console.log(`  [quiet hours] Suppressed ${notif.type} notification for ${issueRef}`);
          notif.delivered_to = 'undelivered';
          allNewNotifications.push(notif);
          continue;
        }

        if (notif.delivered_to === 'frontend_only') {
          allNewNotifications.push(notif);
          continue;
        }

        try {
          const msgId = await sendInstant(notif, config, telegramToken, telegramChatId);
          updatedState.issues[issueRef]!.last_telegram_message_id = msgId;
        } catch (err) {
          console.error(`  Failed to send instant notification for ${issueRef}:`, err);
          notif.delivered_to = 'undelivered';
        }
        allNewNotifications.push(notif);
      }
    }
  }

  // 11. Daily Digest Loop
  const digestTimeParts = settings.digest_time.split(':');
  const dHour = parseInt(digestTimeParts[0] ?? '8', 10);
  const dMin = parseInt(digestTimeParts[1] ?? '0', 10);
  
  const todayDigestCheck = new Date(now);
  todayDigestCheck.setHours(dHour, dMin, 0, 0);

  const lastDigest = updatedState.last_digest_sent_at ? new Date(updatedState.last_digest_sent_at) : new Date(0);
  
  const hasSentToday = lastDigest >= todayDigestCheck;
  if (now >= todayDigestCheck && !hasSentToday) {
     console.log('\n--- Generating Daily Digest ---');
     const sinceStr = lastDigest.getTime() > 0 ? lastDigest.toISOString() : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
     const payload = await generateDailyDigest(watchlist, updatedState, settings, sinceStr, now, pat);
     
     if (payload && (payload.low.length > 0 || payload.watching.length > 0 || payload.critical_summary.length > 0)) {
        const configMap = new Map(Object.entries(watchlist.issues));
        try {
           await sendDailyDigest(payload, configMap, telegramToken, telegramChatId);
           updatedState.last_digest_sent_at = now.toISOString();
           for (const st of Object.values(updatedState.issues)) {
             st.window_comment_count = 0;
             st.window_event_count = 0;
           }
        } catch (err) {
           console.error('Failed to send Daily Digest:', err);
        }
     } else {
        console.log('Daily digest skipped, payload empty.');
        updatedState.last_digest_sent_at = now.toISOString();
     }
  }

  // 12. Update last_run and persist all files
  updatedState.last_run = now.toISOString();
  saveState(updatedState);
  saveWatchlist(updatedWatchlist);
  saveNotifications([...notifications, ...allNewNotifications]);

  console.log(
    `\n=== Done. ${allNewNotifications.length} notification(s) generated. ===`,
  );
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
