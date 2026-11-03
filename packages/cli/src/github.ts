import { execFileSync } from 'node:child_process';

/**
 * The only network Teslon uses: the customer's own GitHub, to read a PR's
 * title and base and to post one comment. In GitHub Actions everything comes
 * from the runner's environment; locally from the `origin` remote and a token
 * in GITHUB_TOKEN or GH_TOKEN. GitHub Enterprise Server works through
 * GITHUB_API_URL. Without a token, Teslon still runs; it just cannot post.
 */

export interface GhContext {
  readonly api: string;
  readonly server: string;
  /** owner/name */
  readonly repo: string | null;
  readonly token: string | null;
}

export function ghContext(root: string): GhContext {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (process.env.GITHUB_REPOSITORY) {
    return { api: process.env.GITHUB_API_URL ?? 'https://api.github.com', server: process.env.GITHUB_SERVER_URL ?? 'https://github.com', repo: process.env.GITHUB_REPOSITORY, token };
  }
  let url = '';
  try { url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* no origin */ }
  // https://host/owner/name(.git) or git@host:owner/name(.git)
  const m = /^(?:https?:\/\/(?:[^@/]+@)?([^/]+)\/|git@([^:]+):)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) return { api: 'https://api.github.com', server: 'https://github.com', repo: null, token };
  const host = (m[1] ?? m[2])!;
  const server = `https://${host}`;
  return { api: host === 'github.com' ? 'https://api.github.com' : `${server}/api/v3`, server, repo: m[3]!, token };
}

async function call<T>(ctx: GhContext, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ctx.api}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'teslon',
      ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

export interface PrInfo {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly merged: boolean;
}

export async function prInfo(ctx: GhContext, n: number): Promise<PrInfo | null> {
  if (!ctx.repo) return null;
  const p = await call<{ number: number; title: string; html_url: string; user?: { login: string }; base: { ref: string }; head: { sha: string }; merged?: boolean }>(ctx, 'GET', `/repos/${ctx.repo}/pulls/${n}`);
  return { number: p.number, title: p.title, url: p.html_url, author: p.user?.login ?? '', baseRef: p.base.ref, headSha: p.head.sha, merged: !!p.merged };
}

/** Post the comment, or update Teslon's earlier one on the same PR so there is only ever one. */
export async function upsertComment(ctx: GhContext, n: number, body: string, marker: string): Promise<string> {
  if (!ctx.repo) throw new Error('no GitHub repository: set GITHUB_REPOSITORY or an origin remote on GitHub');
  if (!ctx.token) throw new Error('no token: set GITHUB_TOKEN (in Actions: permissions: pull-requests: write)');
  for (let page = 1; page <= 10; page++) {
    const list = await call<{ id: number; body?: string; html_url: string }[]>(ctx, 'GET', `/repos/${ctx.repo}/issues/${n}/comments?per_page=100&page=${page}`);
    const mine = list.find((c) => c.body?.startsWith(marker));
    if (mine) return (await call<{ html_url: string }>(ctx, 'PATCH', `/repos/${ctx.repo}/issues/comments/${mine.id}`, { body })).html_url;
    if (list.length < 100) break;
  }
  return (await call<{ html_url: string }>(ctx, 'POST', `/repos/${ctx.repo}/issues/${n}/comments`, { body })).html_url;
}
