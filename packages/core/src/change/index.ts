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
      return execFileSync('git', args as string[], {
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
  const out = git(['diff', '--name-only', '--no-renames', from, to]);
  return out.length === 0 ? [] : out.split('\n').filter(Boolean);
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

  throw new Error(`Cannot recover a change set from ${sha}: it has no parent and no range was supplied.`);
}
