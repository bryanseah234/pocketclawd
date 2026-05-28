/* eslint-disable */
/**
 * Clawd — GitHub ingestion (PRD §17.1)
 *
 * Read-only across all user repos. Pulls:
 *   - Open/merged PRs (last 24h or since last run)
 *   - Commit activity digest
 *   - Open issues assigned to user
 *
 * Auth: GITHUB_PAT env var (classic token with `repo` scope).
 * Cron: daily at 02:00 alongside other cloud ingesters.
 * Slash command: /github-report [daily|weekly]
 */

import type { CloudIngester, Fact } from './types.js';

const GITHUB_API = 'https://api.github.com';

function getToken(): string {
  const token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT not set in .env');
  return token;
}

let cachedLogin: string | null = null;
async function getAuthenticatedLogin(): Promise<string> {
  if (cachedLogin) return cachedLogin;
  const me = (await ghFetch('/user')) as { login: string };
  cachedLogin = me.login;
  return me.login;
}

async function ghFetch(path: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

interface GHRepo { full_name: string; name: string; private: boolean }
interface GHEvent { type: string; repo: { name: string }; created_at: string; payload: Record<string, unknown> }
interface GHPR { title: string; html_url: string; state: string; created_at: string; updated_at: string; user: { login: string }; base: { repo: { full_name: string } } }
interface GHIssue { title: string; html_url: string; state: string; created_at: string; assignees: { login: string }[]; repository_url: string; labels: { name: string }[] }

export class GitHubPRIngester implements CloudIngester {
  readonly source = 'github-prs';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const facts: Fact[] = [];
    const errors: string[] = [];
    try {
      // Get recent events for the authenticated user (covers all repos).
      // GitHub requires the username in the path: `/users/{login}/events`.
      const login = await getAuthenticatedLogin();
      const events = (await ghFetch(`/users/${login}/events?per_page=100`)) as GHEvent[];
      const prEvents = events.filter(
        (e) => e.type === 'PullRequestEvent' && new Date(e.created_at) >= since,
      );

      for (const ev of prEvents) {
        const pr = ev.payload.pull_request as GHPR | undefined;
        if (!pr) continue;
        facts.push({
          text: `GitHub PR "${pr.title}" (${pr.state}) in ${ev.repo.name} by ${pr.user.login} — ${pr.html_url}`,
          source: 'github-prs',
          sourceId: pr.html_url,
          link: pr.html_url,
          occurredAt: new Date(pr.created_at),
        });
      }

      // Also fetch PRs assigned/review-requested for the user
      const reviewPRs = (await ghFetch('/search/issues?q=is:pr+is:open+review-requested:@me&per_page=30')) as { items: GHPR[] };
      for (const pr of reviewPRs.items ?? []) {
        facts.push({
          text: `GitHub PR review requested: "${pr.title}" in ${pr.base?.repo?.full_name ?? 'unknown'} — ${pr.html_url}`,
          source: 'github-prs',
          sourceId: pr.html_url,
          link: pr.html_url,
          occurredAt: new Date(pr.created_at),
        });
      }
    } catch (e) {
      errors.push(`github-prs: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export class GitHubCommitIngester implements CloudIngester {
  readonly source = 'github-commits';

  async fetch(since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const facts: Fact[] = [];
    const errors: string[] = [];
    try {
      const login = await getAuthenticatedLogin();
      const events = (await ghFetch(`/users/${login}/events?per_page=100`)) as GHEvent[];
      const pushEvents = events.filter(
        (e) => e.type === 'PushEvent' && new Date(e.created_at) >= since,
      );

      for (const ev of pushEvents) {
        const commits = (ev.payload.commits as { message: string; sha: string }[]) ?? [];
        const count = commits.length;
        const messages = commits.slice(0, 3).map((c) => c.message.split('\n')[0]).join('; ');
        facts.push({
          text: `GitHub: ${count} commit(s) pushed to ${ev.repo.name}: ${messages}`,
          source: 'github-commits',
          sourceId: `${ev.repo.name}:${ev.created_at}`,
          occurredAt: new Date(ev.created_at),
        });
      }
    } catch (e) {
      errors.push(`github-commits: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export class GitHubIssueIngester implements CloudIngester {
  readonly source = 'github-issues';

  async fetch(_since: Date): Promise<{ facts: Fact[]; errors: string[] }> {
    const facts: Fact[] = [];
    const errors: string[] = [];
    try {
      const issues = (await ghFetch('/issues?filter=assigned&state=open&per_page=50')) as GHIssue[];
      for (const issue of issues) {
        const repo = issue.repository_url.split('/').slice(-2).join('/');
        const labels = issue.labels.map((l) => l.name).join(', ');
        facts.push({
          text: `GitHub issue: "${issue.title}" in ${repo}${labels ? ` [${labels}]` : ''} — ${issue.html_url}`,
          source: 'github-issues',
          sourceId: issue.html_url,
          link: issue.html_url,
          occurredAt: new Date(issue.created_at),
        });
      }
    } catch (e) {
      errors.push(`github-issues: ${(e as Error).message}`);
    }
    return { facts, errors };
  }
}

export const githubIngesters: CloudIngester[] = [
  new GitHubPRIngester(),
  new GitHubCommitIngester(),
  new GitHubIssueIngester(),
];
