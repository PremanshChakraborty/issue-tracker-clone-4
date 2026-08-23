import { randomUUID } from 'crypto';
import type {
  IssueConfig,
  IssueState,
  Notification,
  GlobalSettings,
  NotificationType,
} from '@issue-tracker/types';
import type { GHComment, GHEvent, AuthorAssociation } from './githubClient';

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAINTAINER_ASSOCIATIONS: AuthorAssociation[] = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const KNOWN_BOTS = new Set([
  'dependabot[bot]',
  'github-actions[bot]',
  'codecov[bot]',
  'renovate[bot]',
  'stale[bot]',
  'allcontributors[bot]',
  'greenkeeper[bot]',
  'semantic-release-bot',
  'coderabbitai[bot]',
  'geptile[bot]',
  'sweep-ai[bot]',
]);


// ─── Helpers ───────────────────────────────────────────────────────────────────

export function daysDiff(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
}

function makeNotification(
  issueRef: string,
  config: IssueConfig,
  type: NotificationType,
  actor: string,
  summary: string,
  detail: string,
): Notification {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    issue_ref: issueRef,
    type,
    mode_at_time: config.mode,
    priority_at_time: config.priority,
    payload: { actor, summary, detail },
    delivered_to: 'telegram',
  };
}

function isBot(login: string, userType: string, filterBots: boolean): boolean {
  if (!filterBots) return false;
  return userType === 'Bot' || KNOWN_BOTS.has(login);
}

export function passesCommentFilter(
  comment: GHComment,
  config: IssueConfig,
  settings: GlobalSettings,
): boolean {
  const effectiveFilterBots = settings.filter_bots && !(config.show_bot_comments ?? false);
  if (isBot(comment.user.login, comment.user.type, effectiveFilterBots)) return false;
  if (comment.body.trim().length < settings.min_comment_length) return false;
  if (config.ignore_users.includes(comment.user.login)) return false;
  return true;
}

/**
 * Returns true if the comment's author matches any of the watch_users policies.
 * Keywords (case-insensitive): ALL, AUTHOR, MAINTAINER, CONTRIBUTOR, ASSIGNEE.
 * Otherwise, expects an exact GitHub login match.
 */
export function isWatchedUser(
  comment: GHComment,
  watchUsers: string[],
  state: IssueState,
): boolean {
  if (!watchUsers || watchUsers.length === 0) return false;

  const login = comment.user.login.toLowerCase();
  const association = comment.author_association;
  const authorLogin = state.issue_author?.toLowerCase() ?? '';
  const assigneesLower = (state.assignees ?? []).map((a) => a.toLowerCase());

  for (const w of watchUsers) {
    const kw = w.toUpperCase();
    if (kw === 'ALL') return true;
    if (kw === 'AUTHOR' && (association === 'AUTHOR' || login === authorLogin)) return true;
    if (kw === 'MAINTAINER' && MAINTAINER_ASSOCIATIONS.includes(association)) return true;
    if (kw === 'CONTRIBUTOR' && ['CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR'].includes(association)) return true;
    if (kw === 'ASSIGNEE' && assigneesLower.includes(login)) return true;
    
    // Explicit username match
    if (w.toLowerCase() === login) return true;
  }
  return false;
}

/**
 * Identify if the commenter is Author, Maintainer, or Assignee to append to their name.
 */
export function getUserRoleLabel(
  comment: GHComment,
  state: IssueState,
): string {
  const login = comment.user.login.toLowerCase();
  const association = comment.author_association;
  const authorLogin = state.issue_author?.toLowerCase() ?? '';
  const assigneesLower = (state.assignees ?? []).map((a) => a.toLowerCase());

  if (association === 'AUTHOR' || login === authorLogin) return ' (Author)';
  if (MAINTAINER_ASSOCIATIONS.includes(association)) return ' (Maintainer)';
  if (assigneesLower.includes(login)) return ' (Assignee)';
  return '';
}

/**
 * Build a human-readable summary line for a GitHub issue event.
 * Maps real GitHub API event type strings to readable text.
 */
function summariseEvent(evt: GHEvent): { summary: string; detail: string } {
  const actor = evt.actor?.login ?? 'unknown';

  switch (evt.event) {
    case 'assigned':
      return {
        summary: `@${actor} assigned @${evt.assignee?.login ?? 'unknown'}`,
        detail: '',
      };
    case 'unassigned':
      return {
        summary: `@${actor} unassigned @${evt.assignee?.login ?? 'unknown'}`,
        detail: '',
      };
    case 'labeled':
      return {
        summary: `@${actor} added label "${evt.label?.name ?? 'unknown'}"`,
        detail: '',
      };
    case 'unlabeled':
      return {
        summary: `@${actor} removed label "${evt.label?.name ?? 'unknown'}"`,
        detail: '',
      };
    case 'closed':
      return {
        summary: `@${actor} closed the issue`,
        detail: '',
      };
    case 'reopened':
      return {
        summary: `@${actor} reopened the issue`,
        detail: '',
      };
    case 'renamed':
      return {
        summary: `@${actor} renamed the issue`,
        detail: '',
      };
    case 'cross-referenced':
    case 'connected':
      return {
        summary: `Issue was linked to a PR`,
        detail: `Referenced by @${actor}`,
      };
    case 'merged':
      return {
        summary: `Linked PR was merged`,
        detail: `Merged by @${actor}`,
      };
    case 'milestoned':
      return {
        summary: `@${actor} added to a milestone`,
        detail: '',
      };
    case 'demilestoned':
      return {
        summary: `@${actor} removed from milestone`,
        detail: '',
      };
    case 'review_requested':
      return {
        summary: `@${actor} requested a review`,
        detail: '',
      };
    case 'mentioned':
      return {
        summary: `@${actor} was mentioned`,
        detail: '',
      };
    default:
      return {
        summary: `@${actor} triggered "${evt.event}"`,
        detail: '',
      };
  }
}

// ─── Main export ───────────────────────────────────────────────────────────────

export interface DetectionResult {
  notifications: Notification[];
  /** Partial state updates to merge into IssueState after this run */
  updatedState: Partial<IssueState>;
}

export function detectSignals(
  issueRef: string,
  config: IssueConfig,
  state: IssueState,
  rawComments: GHComment[],
  rawEvents: GHEvent[],
  settings: GlobalSettings,
  now: Date,
): DetectionResult {
  const notifications: Notification[] = [];
  const updatedState: Partial<IssueState> = {};

  // ── Snooze check ─────────────────────────────────────────────────────────────
  if (config.snooze_until && new Date(config.snooze_until) > now) {
    console.log(`  [${issueRef}] Snoozed until ${config.snooze_until}, skipping.`);
    return { notifications: [], updatedState: {} };
  }

  // All event processing from this point uses filteredEvents only.
  // rawEvents are never touched again, except for assignees tracking.
  const filteredEvents = rawEvents.filter((evt) => {
    const login = evt.actor?.login ?? '';
    const userType = evt.actor?.type ?? 'User';
    if (isBot(login, userType, settings.filter_bots && !(config.show_bot_comments ?? false))) return false;
    if (config.ignore_users.includes(login)) return false;
    return true;
  });

  // Track latest assignees iteratively based on assigned/unassigned events
  let currentAssignees = [...(state.assignees ?? [])];
  for (const evt of rawEvents) {
    if (evt.event === 'assigned' && evt.assignee) {
      if (!currentAssignees.includes(evt.assignee.login)) currentAssignees.push(evt.assignee.login);
    } else if (evt.event === 'unassigned' && evt.assignee) {
      currentAssignees = currentAssignees.filter(a => a !== evt.assignee!.login);
    }
  }
  updatedState.assignees = currentAssignees;

  // ── Step B: Filter comments ───────────────────────────────────────────────────
  const comments = rawComments.filter((c) => passesCommentFilter(c, config, settings));

  // ── Step C: Track latest IDs and timestamps for state update ──────────────────
  // last_activity_at is updated from BOTH filtered comments and filtered events.
  // Bot-triggered events do NOT update last_activity_at (they don't reset inactivity).
  const prevActivityAt = state.last_activity_at ? new Date(state.last_activity_at) : null;
  let latestActivityAt = prevActivityAt;
  let latestCommentId = state.last_comment_id;
  let latestEventId = state.last_event_id;

  if (comments.length > 0) {
    const maxId = Math.max(...comments.map((c) => c.id));
    if (!latestCommentId || maxId > latestCommentId) latestCommentId = maxId;

    const latestDate = new Date(
      Math.max(...comments.map((c) => new Date(c.created_at).getTime())),
    );
    if (!latestActivityAt || latestDate > latestActivityAt) latestActivityAt = latestDate;
  }

  if (filteredEvents.length > 0) {
    // Track max event ID across ALL raw events (for dedup on next run), not just filtered.
    // But updated last_activity_at only from human events.
    const rawMaxId = Math.max(...rawEvents.map((e) => e.id));
    if (!latestEventId || rawMaxId > latestEventId) latestEventId = rawMaxId;

    const latestDate = new Date(
      Math.max(...filteredEvents.map((e) => new Date(e.created_at).getTime())),
    );
    if (!latestActivityAt || latestDate > latestActivityAt) latestActivityAt = latestDate;
  } else if (rawEvents.length > 0) {
    // Even if all events were bots, still advance last_event_id so we don't re-process.
    const rawMaxId = Math.max(...rawEvents.map((e) => e.id));
    if (!latestEventId || rawMaxId > latestEventId) latestEventId = rawMaxId;
  }

  updatedState.last_comment_id = latestCommentId;
  updatedState.last_event_id = latestEventId;
  if (latestActivityAt) {
    updatedState.last_activity_at = latestActivityAt.toISOString();
  }

  const relevantComments = comments.filter((c) =>
    isWatchedUser(c, config.watch_users, { ...state, assignees: currentAssignees }),
  );

  // hasNewActivity is true only for human-initiated activity (bot events excluded).
  const hasNewActivity = relevantComments.length > 0 || filteredEvents.length > 0;

  updatedState.window_comment_count = (state.window_comment_count ?? 0) + relevantComments.length;
  updatedState.window_event_count = (state.window_event_count ?? 0) + filteredEvents.length;

  // ── Step D: Event notifications ───────────────────────────────────────────────
  for (const evt of filteredEvents) {
    const actor = evt.actor?.login ?? 'unknown';
    const { summary, detail } = summariseEvent(evt);
    const notif = makeNotification(issueRef, config, 'status_change', actor, summary, detail);
    if (config.priority === 'low') {
       notif.delivered_to = 'frontend_only';
    }
    notifications.push(notif);
  }

  // ── Step E: Activity spike detection ──────────────────────────────────────────
  if (config.priority !== 'critical' && config.priority !== 'low') {
    if (updatedState.window_comment_count >= (settings.spike_comment_threshold ?? 5)) {
      const firstActors = [...new Set(relevantComments.slice(0, 5).map((c) => `@${c.user.login}`))].join(', ');
      notifications.push(
        makeNotification(
          issueRef,
          config,
          'spike',
          relevantComments[0]?.user.login ?? 'unknown',
          `Activity spike: ${updatedState.window_comment_count} new comments detected`,
          `Active users recently: ${firstActors}`
        )
      );
      updatedState.window_comment_count = 0; // Reset after firing
    }
  }

  // ── Step F: Priority-Specific Comments ────────────────────────────────────────
  if (config.priority === 'critical') {
    for (const comment of relevantComments) {
      const role = getUserRoleLabel(comment, { ...state, assignees: currentAssignees });
      notifications.push(
        makeNotification(
          issueRef,
          config,
          'comment',
          comment.user.login,
          `@${comment.user.login}${role} commented`,
          comment.body.slice(0, 200),
        ),
      );
    }
  } else if (config.priority === 'low') {
    // Generate frontend-only comment notifications for persistence
    for (const comment of relevantComments) {
      const role = getUserRoleLabel(comment, { ...state, assignees: currentAssignees });
      const notif = makeNotification(
        issueRef,
        config,
        'comment',
        comment.user.login,
        `@${comment.user.login}${role} commented`,
        comment.body.slice(0, 200),
      );
      notif.delivered_to = 'frontend_only';
      notifications.push(notif);
    }
  }
  // 'watching' priority gets NO instant comment notifications (they go to daily digest).
  // Inactivity is entirely handled statically during the Daily Digest generation.

  return { notifications, updatedState };
}
