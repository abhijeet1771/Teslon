import { execFileSync } from 'node:child_process';
import type { ChangeSet, Limitation } from '../schema/index.js';

/**
 * Resolving what a pull request actually changed.
 *
 * Two things here were wrong in every naive implementation we looked at, and
 * both were verified in a lab before this module was written:
 *
 *   1. `git diff base head` attributes the base branch's own commits to the
 *      pull request. The change set is the diff from the *merge base*.
 *   2. A CI checkout at depth 1 cannot compute a merge base at all, and
 *      deepening only the base side still fails — the head side is truncated
 *      too. Both sides have to be deepened.
 */

export interface GitRunner {
  (args: readonly string[]): string;
}

/** Raised when the directory is not a git working tree at all. */
export class NotAGitRepositoryError extends Error {
  constructor(readonly cwd: string) {
    super(`"${cwd}" is not a git repository. Run Teslon inside a checkout, or pass a path to one.`);
    this.name = 'NotAGitRepositoryError';
  }
}

/** Raised when git itself is unavailable. */
export class GitUnavailableError extends Error {
  constructor(cause: string) {
    super(`git could not be run: ${cause}. Teslon needs git on PATH.`);
    this.name = 'GitUnavailableError';
  }
}

export function gitIn(cwd: string): GitRunner {
  return (args) => {
    try {
      // `core.quotepath=off` because git's default octal-quotes every path with
      // a non-ASCII byte: `src/prïce.ts` comes back as "src/pr\303\257ce.ts",
      // in quotes. That string matches no file on disk, so the changed file
      // was reported as absent and its whole radius vanished — on any team
      // that names a file in anything but ASCII.
      return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // Captured, not inherited: git's own diagnostics are ours to
        // interpret. Letting them through printed "fatal: not a git
        // repository" three times and then blamed unrelated branches.
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
      if (e.code === 'ENOENT') throw new GitUnavailableError('command not found');
      const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
      if (/not a git repository/i.test(stderr)) throw new NotAGitRepositoryError(cwd);
      // Everything else is a normal non-zero exit — callers decide what it means.
      throw err;
    }
  };
}

/** True when the directory is a git working tree. Never throws. */
export function isGitRepository(git: GitRunner): boolean {
  try {
    return git(['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

/** Depths we try, in order, when the clone is too shallow to reach a merge base. */
const DEEPEN_STEPS = [50, 250, 1000] as const;

export interface ResolveOptions {
  readonly base: string;
  readonly head: string;
  /** Set false in tests, or when the repo is known to be complete. */
  readonly allowFetch?: boolean;
  /** Not every checkout calls its remote "origin". */
  readonly remote?: string;
}

export interface Resolved {
  readonly change: ChangeSet;
  readonly limitations: readonly Limitation[];
}

function isShallow(git: GitRunner): boolean {
  try {
    return git(['rev-parse', '--is-shallow-repository']) === 'true';
  } catch {
    return false;
  }
}

function tryMergeBase(git: GitRunner, base: string, head: string): string | null {
  try {
    const out = git(['merge-base', base, head]);
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Deepen both sides progressively until a merge base resolves.
 *
 * `--deepen` rather than `--depth`: a second `--depth` fetch re-shallows the
 * ref it fetches, which is how "I fetched main, why is merge-base still
 * failing" happens. Deepening is additive and applies to what we already have.
 */
function deepenUntilMergeBase(
  git: GitRunner,
  base: string,
  head: string,
  remote: string,
): { mergeBase: string | null; deepened: number } {
  let deepened = 0;
  for (const step of DEEPEN_STEPS) {
    for (const ref of [base, head]) {
      try {
        git(['fetch', '--quiet', `--deepen=${step}`, remote, stripRemote(ref, remote)]);
      } catch {
        // A ref we cannot fetch is not fatal on its own; the merge-base check
        // below is the real test of whether we have enough history.
      }
    }
    deepened = step;
    const mb = tryMergeBase(git, base, head);
    if (mb) return { mergeBase: mb, deepened };
  }
  return { mergeBase: null, deepened };
}

function stripRemote(ref: string, remote: string): string {
  const prefix = `${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function changedFiles(git: GitRunner, from: string, to: string): string[] {
  // NUL-separated, so a path containing a newline or a quote survives intact.
  // quotepath=off covers non-ASCII; -z covers everything else git would quote.
  const out = git(['diff', '--name-only', '--no-renames', '-z', from, to]);
  return out.length === 0 ? [] : out.split('\0').filter(Boolean);
}

/**
 * The normal case: an open pull request, head not yet on base.
 */
export function resolveChange(git: GitRunner, opts: ResolveOptions): Resolved {
  const limitations: Limitation[] = [];
  const { base, head } = opts;

  // Diagnose the real problem first. "No merge base, are they related?" is a
  // misleading thing to say to someone standing in the wrong directory.
  if (!isGitRepository(git)) throw new NotAGitRepositoryError('.');

  let mergeBase = tryMergeBase(git, base, head);

  if (!mergeBase && isShallow(git) && opts.allowFetch !== false) {
    const r = deepenUntilMergeBase(git, base, head, opts.remote ?? 'origin');
    mergeBase = r.mergeBase;
    if (mergeBase) {
      limitations.push({
        what: `The checkout was shallow; history was deepened to ${r.deepened} commits on both refs to find the merge base.`,
        mitigation: 'Set the clone depth to 0 (full) in CI to make this unnecessary.',
      });
    }
  }

  if (!mergeBase) {
    // Invariant I1: we do not guess. A wrong change set produces a confident
    // wrong answer, which is worse than no answer.
    throw new NoMergeBaseError(base, head, isShallow(git));
  }

  return {
    change: {
      baseSha: git(['rev-parse', base]),
      headSha: git(['rev-parse', head]),
      mergeBase,
      files: changedFiles(git, mergeBase, head),
    },
    limitations,
  };
}

/**
 * The branch a pull request is most likely aimed at, when nobody said.
 *
 * Hard-coding `origin/main` failed on every repository whose default is
 * `master`, `develop` or `trunk`, and on every local clone with no remote — and
 * it failed as "no merge base, are they related branches?", which sends the
 * reader looking for a problem that is not there. The remote's own HEAD is the
 * declaration; the common names are the fallback; and the answer always says
 * which one it picked, because a silently chosen base is a silently chosen
 * change set.
 */
export function defaultBase(git: GitRunner, remote = 'origin'): { ref: string; how: string } | null {
  try {
    const declared = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (declared) return { ref: declared, how: `${remote}/HEAD points at it` };
  } catch {
    // No remote HEAD recorded — common in fresh clones and CI. Fall through.
  }
  const candidates = [
    `${remote}/main`, `${remote}/master`, `${remote}/develop`, `${remote}/trunk`,
    'main', 'master', 'develop', 'trunk',
  ];
  for (const ref of candidates) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      return { ref, how: `no default was declared, and ${ref} is the first conventional name that exists` };
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * A tree on disk that is exactly the commit being analysed.
 *
 * Every primitive reads files from disk, and git only says *which* files
 * changed. So when the commit being analysed is not what is checked out, the
 * change set came from one commit and the code was read from another — and
 * the result looked fine. Two ways that happens, both of them ordinary:
 *
 *   a different commit   you are on `main` and ask about `feature-x`, which is
 *                        precisely how a reviewer, a QA engineer or the local
 *                        app works: keep one clone, point at any PR.
 *   uncommitted edits    the working tree is the head commit plus whatever was
 *                        typed since, and a half-written file is not the PR.
 *
 * Either way the head is checked out into a temporary, detached worktree that
 * shares the repository's object store — no clone, no network, and nothing in
 * the user's working tree is touched. When the working tree already *is* the
 * head and is clean, it is used as it is.
 */
export interface PreparedTree {
  /** Where to read files from. */
  readonly root: string;
  /** How the tree was obtained, in a sentence, or null when nothing was done. */
  readonly note: string | null;
  readonly limitations: readonly Limitation[];
  /** Always call this, in a `finally`. Removing the worktree is idempotent. */
  readonly release: () => void;
}

export function prepareTree(
  git: GitRunner,
  root: string,
  head: string,
  makeTempDir: () => string,
): PreparedTree {
  const nothing = (): void => {};
  let headSha: string;
  let current: string;
  try {
    headSha = git(['rev-parse', '--verify', `${head}^{commit}`]);
    current = git(['rev-parse', 'HEAD']);
  } catch {
    return { root, note: null, limitations: [], release: nothing };
  }

  let dirty: string[] = [];
  try {
    // Untracked files count: a stray scratch file still lands in the file
    // list and can still add edges. Ignored files do not, and porcelain
    // already leaves them out.
    dirty = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      .split('\0')
      .filter(Boolean)
      .map((l) => l.slice(3));
  } catch {
    dirty = [];
  }

  if (headSha === current && dirty.length === 0) {
    return { root, note: null, limitations: [], release: nothing };
  }

  const why =
    headSha !== current
      ? `the working tree is on ${current.slice(0, 10)}, not on ${head} (${headSha.slice(0, 10)})`
      : `the working tree has ${dirty.length} uncommitted change${dirty.length === 1 ? '' : 's'}`;

  const dir = makeTempDir();
  try {
    git(['worktree', 'add', '--detach', '--force', dir, headSha]);
  } catch (err) {
    // Old git, a bare repository, or a filesystem that refuses. Analyse what
    // is on disk, and say exactly how far it is from the truth.
    return {
      root,
      note: null,
      limitations: [
        {
          what: `The code was read from the working tree, but ${why}, and a clean checkout of ${head} could not be made (${(err as Error).message.split('\n')[0]}).`,
          mitigation:
            headSha !== current
              ? `The changed-file list is right; the import graph and the file contents are not this pull request's. Check out ${head} and run again before trusting the radius.`
              : `Uncommitted edits are included in what was read: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}. Commit or stash them and run again before trusting the radius.`,
          files: dirty.slice(0, 50),
        },
      ],
      release: nothing,
    };
  }

  let released = false;
  return {
    root: dir,
    note: `Read from a clean checkout of ${head} at ${headSha.slice(0, 10)}, because ${why}. Your working tree was not touched.`,
    limitations: [],
    release: () => {
      if (released) return;
      released = true;
      try {
        git(['worktree', 'remove', '--force', dir]);
      } catch {
        try {
          git(['worktree', 'prune']);
        } catch {
          // Leaving a temp directory behind is untidy, never incorrect.
        }
      }
    },
  };
}

export class NoMergeBaseError extends Error {
  constructor(
    readonly base: string,
    readonly head: string,
    readonly shallow: boolean,
  ) {
    super(
      `No merge base between "${base}" and "${head}"` +
        (shallow
          ? '. The repository is shallow and could not be deepened far enough — fetch more history, or clone with full depth.'
          : '. Are they related branches?'),
    );
    this.name = 'NoMergeBaseError';
  }
}

/**
 * The pull request is already merged and the branch may be gone.
 *
 * All three cases verified in the lab:
 *   merge commit  -> diff against the first parent
 *   squash commit -> diff against its only parent
 *   rebase        -> the commits were replayed with new hashes and nothing
 *                    ties them together, so the caller has to supply the range
 *                    (from the host's API) and we diff that.
 */
export function resolveMerged(
  git: GitRunner,
  sha: string,
  fallbackRange?: { readonly from: string; readonly to: string },
): Resolved {
  // A range the caller supplied wins. It used to be consulted only when the
  // commit had no parent at all, which never happens for a rebase merge — so
  // `merged <last> <from>..<to>` silently analysed the last commit alone, and
  // on a real PR that was the test-only one.
  if (fallbackRange) {
    return {
      change: {
        baseSha: fallbackRange.from,
        headSha: fallbackRange.to,
        mergeBase: fallbackRange.from,
        files: changedFiles(git, fallbackRange.from, fallbackRange.to),
        recoveredFrom: 'commit-range',
      },
      limitations: [],
    };
  }

  const parents = git(['rev-list', '--parents', '-n', '1', sha]).split(/\s+/).slice(1);

  if (parents.length >= 2) {
    const firstParent = parents[0]!;
    return {
      change: {
        baseSha: firstParent,
        headSha: sha,
        mergeBase: firstParent,
        files: changedFiles(git, firstParent, sha),
        recoveredFrom: 'merge-commit',
      },
      limitations: [],
    };
  }

  if (parents.length === 1) {
    const parent = parents[0]!;
    return {
      change: {
        baseSha: parent,
        headSha: sha,
        mergeBase: parent,
        files: changedFiles(git, parent, sha),
        recoveredFrom: 'squash-commit',
      },
      limitations: [
        {
          what: 'This commit has a single parent, so it is a squash or a plain commit.',
          mitigation:
            'If the pull request was rebased, several commits landed separately and this is only one of them — supply the commit range for the full change set.',
        },
      ],
    };
  }

  throw new Error(`Cannot recover a change set from ${sha}: it has no parent and no range was supplied.`);
}
