import { execFileSync } from 'node:child_process';

/**
 * A repository as it stood at one commit, read straight from git.
 *
 * The engine never checks anything out: base and head are two snapshots of
 * the same repository, and every rule reads both. A file that cannot be read
 * comes back as `null`, never as an empty string, so a caller cannot mistake
 * "missing" for "empty".
 */
export interface Snapshot {
  readonly repo: string;
  readonly ref: string;
  /** Every tracked path at this commit. */
  readonly files: readonly string[];
  has(path: string): boolean;
  read(path: string): string | null;
  /** The text of one line, 1-based, or null. Evidence is re-checked with this. */
  line(path: string, n: number): string | null;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function snapshot(repo: string, ref: string): Snapshot {
  const sha = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const files = git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean);
  const present = new Set(files);
  const cache = new Map<string, string | null>();
  const lines = new Map<string, readonly string[]>();
  const read = (path: string): string | null => {
    if (cache.has(path)) return cache.get(path) ?? null;
    let text: string | null = null;
    if (present.has(path)) {
      try {
        text = git(repo, ['show', `${sha}:${path}`]);
      } catch {
        text = null;
      }
    }
    cache.set(path, text);
    return text;
  };
  return {
    repo,
    ref: sha,
    files,
    has: (p) => present.has(p),
    read,
    line(path, n) {
      let ls = lines.get(path);
      if (!ls) {
        const t = read(path);
        if (t === null) return null;
        ls = t.split('\n');
        lines.set(path, ls);
      }
      return ls[n - 1] ?? null;
    },
  };
}

/** Lines that changed between two commits, per file, on each side. */
export interface ChangedFile {
  readonly path: string;
  readonly status: 'added' | 'deleted' | 'modified';
  /** 1-based head-side lines that are new or changed. */
  readonly headLines: readonly number[];
  /** 1-based base-side lines that were removed or changed. */
  readonly baseLines: readonly number[];
  /** Each diff hunk: the base lines it replaces and the head lines it puts in their place. */
  readonly hunks: readonly { readonly base: readonly number[]; readonly head: readonly number[] }[];
}

export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const out = git(repo, ['diff', '--no-renames', '-U0', '--no-color', base, head]);
  const files: ChangedFile[] = [];
  let cur: { path: string; status: ChangedFile['status']; headLines: number[]; baseLines: number[]; hunks: { base: number[]; head: number[] }[] } | null = null;
  let oldPath = '';
  for (const raw of out.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      // Binary and mode-only changes have no +++ line; the header still names
      // the file, so it is recorded with no lines rather than dropped.
      const m = / b\/(.*)$/.exec(raw);
      cur = { path: m?.[1] ?? raw, status: 'modified', headLines: [], baseLines: [], hunks: [] };
      oldPath = '';
      continue;
    }
    if (raw.startsWith('--- ')) {
      oldPath = raw.slice(4).replace(/^a\//, '');
      continue;
    }
    if (raw.startsWith('+++ ') && cur) {
      const newPath = raw.slice(4).replace(/^b\//, '');
      cur.status = oldPath === '/dev/null' ? 'added' : newPath === '/dev/null' ? 'deleted' : 'modified';
      cur.path = cur.status === 'deleted' ? oldPath : newPath;
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h && cur) {
      const bs = Number(h[1]), bc = h[2] === undefined ? 1 : Number(h[2]);
      const hs = Number(h[3]), hc = h[4] === undefined ? 1 : Number(h[4]);
      const hunk = { base: [] as number[], head: [] as number[] };
      for (let i = 0; i < bc; i++) { cur.baseLines.push(bs + i); hunk.base.push(bs + i); }
      for (let i = 0; i < hc; i++) { cur.headLines.push(hs + i); hunk.head.push(hs + i); }
      cur.hunks.push(hunk);
    }
  }
  if (cur) files.push(cur);
  return files;
}
