const GITHUB_API = 'https://api.github.com';

// ─── Response types ────────────────────────────────────────────────────────────

export type AuthorAssociation =
  | 'AUTHOR'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'MANNEQUIN'
  | 'MEMBER'
  | 'NONE'
  | 'OWNER';

export interface GHUser {
  login: string;
  type: string; // "User" | "Bot"
}

export interface GHComment {
  id: number;
  user: GHUser;
  author_association: AuthorAssociation;
  body: string;
  created_at: string;
  html_url: string;
  issue_url: string; // "https://api.github.com/repos/owner/repo/issues/1234"
}

export interface GHEvent {
  id: number;
  actor: GHUser | null;
  event: string; // "closed", "reopened", "labeled", "assigned", "unassigned", etc.
  created_at: string;
  issue: { number: number; title: string; state: string; html_url: string } | null;
  label?: { name: string; color: string };
  assignee?: GHUser;
}

export interface GHIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: GHUser;
  updated_at: string;
  closed_at: string | null;
  assignees: GHUser[];
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function getNextUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] ?? null : null;
}

async function ghFetch<T>(
  url: string,
  pat: string,
): Promise<{ data: T; linkHeader: string | null }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} on ${url}: ${body}`);
  }

  const data = (await response.json()) as T;
  const linkHeader = response.headers.get('Link');
  return { data, linkHeader };
}

// Fetch all pages of a paginated endpoint — no early stopping.
// Used for endpoints that natively support 'since' (e.g. comments).
async function fetchAllPages<T extends { created_at: string }>(
  initialUrl: string,
  pat: string,
): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = initialUrl;

  while (url) {
    const { data, linkHeader } = await ghFetch<T[]>(url, pat);
    results.push(...data);
    url = getNextUrl(linkHeader);
  }

  return results;
}

/**
 * Fetch pages of issue events with early-stop pagination.
 *
 * Events are returned newest-first (descending). Once we encounter the first
 * event with created_at <= since, all subsequent items on that page AND every
 * subsequent page are guaranteed to be older — so we stop immediately.
 *
 * This turns a full-history scan into an O(recent pages) operation.
 */
async function fetchEventsSince(initialUrl: string, pat: string, since: string): Promise<GHEvent[]> {
  const results: GHEvent[] = [];
  let url: string | null = initialUrl;

  while (url) {
    const { data, linkHeader } = await ghFetch<GHEvent[]>(url, pat);
    let hitOldEvent = false;

    for (const evt of data) {
      if (evt.created_at <= since) {
        // This event and everything after it is at-or-before 'since'. Stop.
        hitOldEvent = true;
        break;
      }
      results.push(evt);
    }

    if (hitOldEvent) break; // Don't fetch the next page — it's all old.
    url = getNextUrl(linkHeader);
  }

  return results;
}

// ─── Public API methods ────────────────────────────────────────────────────────

/**
 * Fetch all new comments in a repo since a given ISO timestamp.
 * GitHub natively supports 'since' for comments.
 */
export async function getRepoComments(
  owner: string,
  repo: string,
  since: string,
  pat: string,
): Promise<GHComment[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/comments?since=${encodeURIComponent(since)}&per_page=100`;
  return fetchAllPages<GHComment>(url, pat);
}

/**
 * Fetch all new issue events in a repo since a given ISO timestamp.
 * Events are returned newest-first. We stop paginating as soon as we hit
 * an event older than 'since', making this efficient even for large repos.
 */
export async function getRepoEvents(
  owner: string,
  repo: string,
  since: string,
  pat: string,
): Promise<GHEvent[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/events?per_page=100`;
  return fetchEventsSince(url, pat, since);
}

/**
 * Fetch a single issue — used at add-time and for initializing state on first run.
 */
export async function getIssue(
  owner: string,
  repo: string,
  number: number,
  pat: string,
): Promise<GHIssue> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`;
  const { data } = await ghFetch<GHIssue>(url, pat);
  return data;
}

/**
 * Fetch repo collaborators — used at add-time to populate watch_users.
 */
export async function getCollaborators(
  owner: string,
  repo: string,
  pat: string,
): Promise<GHUser[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/collaborators?per_page=100`;
  return fetchAllPages<GHUser & { created_at: string }>(url, pat).catch(() => {
    // 403 if PAT doesn't have collaborator access — return empty, not a fatal error
    console.warn(`Could not fetch collaborators for ${owner}/${repo} (PAT may lack access)`);
    return [];
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Extract issue number from a GitHub comment's issue_url field */
export function extractIssueNumber(issueUrl: string): number {
  const segments = issueUrl.split('/');
  return parseInt(segments[segments.length - 1]!, 10);
}
