import { getRepoComments, getRepoEvents, extractIssueNumber } from './githubClient';
import { passesCommentFilter, isWatchedUser, getUserRoleLabel, daysDiff } from './signalDetector';
import type { GlobalSettings, TrackerState, Watchlist, DailyDigestPayload, IssueConfig } from '@issue-tracker/types';
import type { GHComment, GHEvent } from './githubClient';

export async function generateDailyDigest(
  watchlist: Watchlist,
  state: TrackerState,
  settings: GlobalSettings,
  since: string,
  now: Date,
  pat: string
): Promise<DailyDigestPayload> {
  const payload: DailyDigestPayload = {
    date: now.toISOString().split('T')[0],
    critical_summary: [],
    watching: [],
    low: []
  };

  const byRepo = new Map<string, Array<[string, IssueConfig]>>();
  for (const [ref, config] of Object.entries(watchlist.issues)) {
    const key = config.repo;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key)!.push([ref, config]);
  }

  for (const [repoKey, repoIssues] of byRepo) {
    const [owner, repoName] = repoKey.split('/') as [string, string];

    // Optimize: Always fetch repo data once per daily run if the repo has watched issues.
    const needsFetch = repoIssues.length > 0;

    let repoComments: GHComment[] = [];
    let repoEvents: GHEvent[] = [];

    if (needsFetch) {
      console.log(`  [Digest] Fetching 24h activity for ${repoKey}`);
      try {
         [repoComments, repoEvents] = await Promise.all([
           getRepoComments(owner, repoName, since, pat),
           getRepoEvents(owner, repoName, since, pat)
         ]);
      } catch (err) {
         console.error(`  [Digest] Failed to fetch data for ${repoKey}:`, err);
         continue;
      }
    }

    for (const [issueRef, config] of repoIssues) {
      const issueState = state.issues[issueRef];
      if (!issueState) continue;
      
      const match = issueRef.match(/#(\d+)$/);
      const issueNumber = match ? match[1] : null;
      if (!issueNumber) continue;

      const prevActivityAt = issueState.last_activity_at ? new Date(issueState.last_activity_at) : null;
      let daysSilent = 0;
      let isInactive = false;

      if (prevActivityAt) {
         daysSilent = daysDiff(prevActivityAt, now);
         isInactive = daysSilent >= config.inactivity_threshold_days;
      }

      // Filter the 24-hour Repo data array cleanly
      const issueComments = repoComments
          .filter(c => extractIssueNumber(c.issue_url) === parseInt(issueNumber, 10))
          .filter(c => passesCommentFilter(c, config, settings));
      const issueEvents = repoEvents.filter(e => e.issue?.number === parseInt(issueNumber, 10));
      const relevantComments = issueComments.filter(c => isWatchedUser(c, config.watch_users, issueState));
      
      const hasActivity = relevantComments.length > 0 || issueEvents.length > 0;
      
      // For digest summaries, any literal activity today breaks the inactivity streak.
      if (hasActivity) {
        isInactive = false;
      }

      if (config.priority === 'critical') {
        if (hasActivity || isInactive) {
           payload.critical_summary.push({
             ref: issueRef,
             comments_today: relevantComments.length,
             events_today: issueEvents.length,
             is_inactive: isInactive,
             inactivity_days: isInactive ? Math.floor(daysSilent) : undefined
           });
        }
      } 
      else if (config.priority === 'watching') {
        let groupedComments: DailyDigestPayload['watching'][0]['grouped_comments'] = undefined;
        
        if (relevantComments.length > 0) {
           const first = relevantComments[0];
           groupedComments = {
             authorLogin: first.user.login,
             roleLabel: getUserRoleLabel(first, issueState),
             first_body_snippet: first.body.slice(0, 200),
             total_count: relevantComments.length
           };
        }

        if (hasActivity || isInactive) {
           payload.watching.push({
             ref: issueRef,
             is_inactive: isInactive,
             inactivity_days: isInactive ? Math.floor(daysSilent) : undefined,
             events_today: issueEvents.length,
             grouped_comments: groupedComments
           });
        }
      }
      else if (config.priority === 'low') {
         if (hasActivity || isInactive) {
            payload.low.push({
              ref: issueRef,
              is_inactive: isInactive,
              inactivity_days: isInactive ? Math.floor(daysSilent) : undefined,
              total_comments_today: relevantComments.length,
              total_events_today: issueEvents.length
            });
         }
      }
    }
  }

  return payload;
}
