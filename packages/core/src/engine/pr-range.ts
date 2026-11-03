import { execFileSync } from 'node:child_process';

/**
 * Which two commits to compare for a pull request, worked out from git alone.
 *
 * QA tests the base branch, not the PR's own branch. So a PR is checked where
 * it lands:
 *
 * - merged with a merge commit: that merge, against its first parent;
 * - rebase-merged: the commits it landed as, found by patch-id;
 * - squash-merged: the one commit whose diff is the PR's whole diff;
 * - open: GitHub's test merge (refs/pull/N/merge), which is the PR merged into
 *   today's base branch; without it, the PR's own branch, and the answer says
 *   how far behind the base it is.
 *
 * `how` says which case it was. Nothing here touches the network; fetching the
 * PR's refs is the caller's job.
 */

export interface PrRange {
  /** The commit the change is measured from. */
  readonly base: string;
  readonly head: string;
  readonly state: 'open' | 'merged';
  /** Which commits were compared and why, in words. */
  readonly how: string;
  /** Where the code around the change was read from. */
  readonly context: 'landed' | 'test-merge' | 'pr-branch' | 'given';
}

function git(repo: string, args: readonly string[], input?: string): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30, ...(input !== undefined ? { input } : {}) }).trim();
}
function ok(repo: string, args: readonly string[]): boolean {
  try { git(repo, args); return true; } catch { return false; }
}

/** commit → patch-id for every non-merge commit in a range. */
function patchIds(repo: string, range: string, limit: number): Map<string, string> {
  const log = git(repo, ['log', '--no-merges', '-p', '--no-color', '--format=commit %H', `-n${limit}`, range]);
  const out = new Map<string, string>();
  if (!log) return out;
  for (const line of git(repo, ['patch-id', '--stable'], log + '\n').split('\n')) {
    const [pid, sha] = line.split(' ');
    if (pid && sha) out.set(sha, pid);
  }
  return out;
}

const short = (s: string): string => s.slice(0, 7);

export function prRange(repo: string, headRef: string, baseRef: string, opts: { baseSha?: string; mergeRef?: string; /** the base branch as people call it, e.g. main for origin/main */ label?: string } = {}): PrRange {
  const name = opts.label ?? baseRef;
  const head = git(repo, ['rev-parse', '--verify', `${headRef}^{commit}`]);
  const tip = git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  if (opts.baseSha) {
    const base = git(repo, ['rev-parse', '--verify', `${opts.baseSha}^{commit}`]);
    return { base, head, state: ok(repo, ['merge-base', '--is-ancestor', head, tip]) ? 'merged' : 'open', how: `from the base commit given (${short(base)})`, context: 'given' };
  }

  if (ok(repo, ['merge-base', '--is-ancestor', head, tip])) {
    // Merged with a merge commit: the head is inside the base branch.
    const path = git(repo, ['rev-list', '--first-parent', '--ancestry-path', `${head}..${tip}`]).split('\n').filter(Boolean);
    const entry = path[path.length - 1];
    const parents = entry ? git(repo, ['rev-list', '--parents', '-n', '1', entry]).split(' ').slice(1) : [];
    if (entry && parents.length >= 2) {
      return { base: parents[0]!, head: entry, state: 'merged', how: `merged by ${short(entry)}; checked as it landed on ${name}`, context: 'landed' };
    }
    throw new Error(`${headRef} reached ${name} without a merge commit (fast-forward), so where it started cannot be read from git. Pass the PR's base commit with --base-sha.`);
  }

  const fork = git(repo, ['merge-base', tip, head]);
  const prIds = patchIds(repo, `${fork}..${head}`, 500);
  const behind = Number(git(repo, ['rev-list', '--count', `${fork}..${tip}`]));
  if (behind > 0 && prIds.size) {
    const mainIds = patchIds(repo, `${fork}..${tip}`, 5000);
    const wanted = new Set(prIds.values());
    // rebase-merged: every commit of the PR is on the base branch under a new hash
    const landed = [...mainIds].filter(([, pid]) => wanted.has(pid)).map(([sha]) => sha);
    if (landed.length === prIds.size) {
      const ordered = git(repo, ['rev-list', '--reverse', '--first-parent', `${fork}..${tip}`]).split('\n').filter((c) => landed.includes(c));
      const first = ordered[0]!, last = ordered[ordered.length - 1]!;
      const base = git(repo, ['rev-parse', `${first}^`]);
      return { base, head: last, state: 'merged', how: `rebase-merged: landed on ${name} as ${short(first)}..${short(last)}; checked as it landed`, context: 'landed' };
    }
    // squash-merged: one commit on the base branch carries the PR's whole diff
    const whole = git(repo, ['patch-id', '--stable'], git(repo, ['diff', '--no-color', fork, head]) + '\n').split(' ')[0];
    const squash = whole ? [...mainIds].find(([, pid]) => pid === whole)?.[0] : undefined;
    if (squash) {
      return { base: git(repo, ['rev-parse', `${squash}^`]), head: squash, state: 'merged', how: `squash-merged as ${short(squash)}; checked as it landed`, context: 'landed' };
    }
  }
  // open: GitHub's test merge is the PR merged into today's base branch
  if (opts.mergeRef && ok(repo, ['rev-parse', '--verify', '--quiet', `${opts.mergeRef}^{commit}`])) {
    const merge = git(repo, ['rev-parse', `${opts.mergeRef}^{commit}`]);
    const parents = git(repo, ['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1);
    if (parents.length >= 2 && parents[1] === head) {
      return { base: parents[0]!, head: merge, state: 'open', how: `open; checked as if merged into ${name} today (GitHub's test merge ${short(merge)})`, context: 'test-merge' };
    }
  }
  return {
    base: fork, head, state: 'open', context: 'pr-branch',
    how: behind > 0
      ? `open; checked on its own branch, which is ${behind} commit${behind === 1 ? '' : 's'} behind ${name}: code that changed on ${name} since is not seen. Fetch refs/pull/N/merge to check it as merged.`
      : `open; branched from ${name} at ${short(fork)}`,
  };
}
