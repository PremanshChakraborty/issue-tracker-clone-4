// ─── Primitives ───────────────────────────────────────────────────────────────

export type IssueMode = 'awaiting_reply' | 'inactivity_watch' | 'wip_watch';

export type Priority = 'critical' | 'watching' | 'low';

// These match the actual strings returned in `event` field by GitHub Issues Events API.
// 'comments' is kept as a special token — it covers the separate comments endpoint.
export type EventType =
  | 'comments'        // new comment on the issue (separate endpoint)
  | 'assigned'        // issue assigned to a user
  | 'unassigned'      // assignment dropped
  | 'labeled'         // label added
  | 'unlabeled'       // label removed
  | 'closed'          // issue closed
  | 'reopened'        // issue reopened
  | 'renamed'         // issue title changed
  | 'cross-referenced'// another issue/PR referenced this one
  | 'connected'       // PR linked via "closes #N"
  | 'merged'          // linked PR was merged
  | 'milestoned'      // added to a milestone
  | 'demilestoned'    // removed from a milestone
  | 'review_requested'// review requested on linked PR
  | 'mentioned';      // user mentioned in issue body

export type NotificationType =
  | 'comment'
  | 'inactivity'
  | 'status_change'
  | 'spike'
  | 'daily_digest';

// ─── settings.json ────────────────────────────────────────────────────────────

export interface GlobalSettings {
  cron_interval_minutes: number;
  digest_mode: boolean;
  digest_time: string;           // "HH:MM" 24h
  quiet_hours_start: string;     // "HH:MM" 24h in the configured timezone
  quiet_hours_end: string;       // "HH:MM" 24h in the configured timezone
  timezone: string;              // IANA tz, e.g. "Asia/Kolkata". Defaults to "UTC"
  filter_bots: boolean;
  min_comment_length: number;
  spike_comment_threshold: number;
  default_mode: IssueMode;
}

// ─── watchlist.json ───────────────────────────────────────────────────────────

export interface IssueConfig {
  repo: string;                        // "owner/repo"
  issue_number: number;
  title: string;
  added_at: string;                    // ISO timestamp
  mode: IssueMode;
  priority: Priority;
  inactivity_threshold_days: number;
  stale_re_alert_days: number;
  watch_users: string[];               // GitHub usernames to watch
  ignore_users: string[];              // GitHub usernames to ignore
  notify_on: EventType[];
  priority_bypass_quiet_hours: boolean;
  snooze_until: string | null;         // ISO timestamp or null
  notes: string;
  auto_remove_on_close: boolean;
  show_bot_comments: boolean;
}

export interface Watchlist {
  issues: Record<string, IssueConfig>; // key: "owner/repo#number"
}

// ─── state.json ───────────────────────────────────────────────────────────────

export interface IssueState {
  issue_author: string;                 // login
  assignees: string[];                  // array of logins
  last_comment_id: number | null;
  last_event_id: number | null;
  last_activity_at: string | null;      // ISO timestamp
  inactivity_alerted: boolean;
  inactivity_last_alerted_at: string | null; // ISO timestamp
  last_telegram_message_id: number | null;
  window_comment_count: number;         // Reset when spike triggers or digest sends
  window_event_count: number;           // Reset when digest sends
}

export interface TrackerState {
  last_run: string | null;              // ISO timestamp
  last_digest_sent_at: string | null;   // ISO timestamp
  issues: Record<string, IssueState>;  // key: "owner/repo#number"
}

// ─── notifications.json ───────────────────────────────────────────────────────

export interface NotificationPayload {
  actor: string;
  summary: string;
  detail: string;
}

export interface Notification {
  id: string;                          // UUID v4
  timestamp: string;                   // ISO timestamp
  issue_ref: string;                   // "owner/repo#number"
  type: NotificationType;
  mode_at_time: IssueMode;
  priority_at_time: Priority;
  payload: NotificationPayload;
  delivered_to: 'telegram' | 'undelivered' | 'frontend_only';
}

// ─── Mode defaults ────────────────────────────────────────────────────────────

export const ALL_EVENT_TYPES: EventType[] = [
  'comments',
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'closed',
  'reopened',
  'renamed',
  'cross-referenced',
  'connected',
  'merged',
  'milestoned',
  'demilestoned',
  'review_requested',
  'mentioned',
];

export const MODE_DEFAULTS: Record<IssueMode, Partial<IssueConfig>> = {
  awaiting_reply: {
    priority: 'critical',
    inactivity_threshold_days: 3,
    stale_re_alert_days: 2,
    watch_users: ['ALL'],
    notify_on: ALL_EVENT_TYPES,
    priority_bypass_quiet_hours: true,
    auto_remove_on_close: true,
  },
  inactivity_watch: {
    priority: 'watching',
    inactivity_threshold_days: 14,
    stale_re_alert_days: 7,
    watch_users: ['ALL'],
    notify_on: ALL_EVENT_TYPES,
    priority_bypass_quiet_hours: false,
    auto_remove_on_close: false,
  },
  wip_watch: {
    priority: 'low',
    inactivity_threshold_days: 21,
    stale_re_alert_days: 10,
    watch_users: ['ALL'],
    notify_on: ALL_EVENT_TYPES,
    priority_bypass_quiet_hours: false,
    auto_remove_on_close: true,
  },
};

export interface DailyDigestPayload {
  date: string;
  
  critical_summary: Array<{ 
    ref: string; 
    comments_today: number; 
    events_today: number; 
    is_inactive: boolean;
    inactivity_days?: number;
  }>;

  watching: Array<{
    ref: string;
    is_inactive: boolean;
    inactivity_days?: number;
    events_today: number;
    grouped_comments?: {
      authorLogin: string;
      roleLabel: string;
      first_body_snippet: string;
      total_count: number;
    };
  }>;

  low: Array<{
    ref: string;
    is_inactive: boolean;
    inactivity_days?: number;
    total_comments_today: number;
    total_events_today: number; 
  }>;
}
