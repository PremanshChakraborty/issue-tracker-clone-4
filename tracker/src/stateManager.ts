import * as fs from 'fs';
import * as path from 'path';
import type { Watchlist, TrackerState, GlobalSettings, Notification } from '@issue-tracker/types';

// Repo root is two levels up from tracker/src/
const ROOT = path.resolve(__dirname, '../..');
const MAX_NOTIFICATIONS = 500;

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filename), 'utf-8')) as T;
}

function writeJson(filename: string, data: unknown): void {
  fs.writeFileSync(path.join(ROOT, filename), JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export interface AllData {
  watchlist: Watchlist;
  state: TrackerState;
  settings: GlobalSettings;
  notifications: Notification[];
}

export function loadAll(): AllData {
  return {
    watchlist: readJson<Watchlist>('watchlist.json'),
    state: readJson<TrackerState>('state.json'),
    settings: readJson<GlobalSettings>('settings.json'),
    notifications: readJson<Notification[]>('notifications.json'),
  };
}

export function saveState(state: TrackerState): void {
  writeJson('state.json', state);
}

export function saveWatchlist(watchlist: Watchlist): void {
  writeJson('watchlist.json', watchlist);
}

export function saveNotifications(notifications: Notification[]): void {
  // Cap at MAX_NOTIFICATIONS — drop oldest if over limit
  const toSave =
    notifications.length > MAX_NOTIFICATIONS
      ? notifications.slice(notifications.length - MAX_NOTIFICATIONS)
      : notifications;
  writeJson('notifications.json', toSave);
}
