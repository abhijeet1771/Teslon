import { CODE_RE, type Edge } from '../graph/imports.js';
import type { Limitation } from '../schema/index.js';

/**
 * What the repository's own history knows that no parser can.
 *
 * Every other signal reads the code as it is now. This one reads what people
 * actually did, and it is the only way to find a dependency that exists in
 * nobody's imports: the mock that has to be updated whenever the client is, the
 * fixture that encodes an endpoint's response shape, the migration and the
 * query that were written in the same sitting. Static analysis cannot see any
 * of those, because there is nothing there to see.
 *
 * It is also the signal most easily turned into noise, so the filters matter
 * more than the counting does.
 */

/** One commit, as the set of files it touched. */
export type Commit = readonly string[];

export interface CoChangeOptions {
  /**
   * Commits touching more than this are ignored. A commit that moves 200 files
   * is a rename, a reformat or a dependency bump, and it couples every pair of
   * files it touches — which is both false and, at 200 files, 19,900 false
   * edges from a single commit.
   */
  readonly maxFilesPerCommit?: number;
  /** A pair must have moved together at least this many times. */
  readonly minTogether?: number;
  /**
   * And that must be at least this share of the rarer file's own history. Two
   * files that each changed 80 times and overlapped 3 times are not coupled;
   * two that changed 4 times and overlapped 3 are.
   */
  readonly minConfidence?: number;
}

export interface CoChangeResult {
  readonly edges: readonly Edge[];
  readonly limitations: readonly Limitation[];
  readonly commitsRead: number;
  readonly commitsSkipped: number;
}

const DEFAULTS = { maxFilesPerCommit: 40, minTogether: 3, minConfidence: 0.5 };

export function coChangeEdges(commits: readonly Commit[], options: CoChangeOptions = {}): CoChangeResult {
  const maxFilesPerCommit = options.maxFilesPerCommit ?? DEFAULTS.maxFilesPerCommit;
  const minTogether = options.minTogether ?? DEFAULTS.minTogether;
  const minConfidence = options.minConfidence ?? DEFAULTS.minConfidence;

  const changes = new Map<string, number>();
  const together = new Map<string, number>();
  let commitsRead = 0;
  let commitsSkipped = 0;

  for (const commit of commits) {
    const files = [...new Set(commit)].sort();
    if (files.length < 2) {
      if (files.length === 1) changes.set(files[0]!, (changes.get(files[0]!) ?? 0) + 1);
      continue;
    }
    if (files.length > maxFilesPerCommit) {
      commitsSkipped++;
      // A sweep still proves each file changed, which is what the confidence
      // denominator is for — dropping it would make every pair look stronger.
      for (const f of files) changes.set(f, (changes.get(f) ?? 0) + 1);
      continue;
    }
    commitsRead++;
    for (const f of files) changes.set(f, (changes.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]!}\u0000${files[j]!}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: Edge[] = [];
  // Sorted so the edge list does not depend on Map iteration order (I3).
  for (const key of [...together.keys()].sort()) {
    const count = together.get(key)!;
    if (count < minTogether) continue;
    const [a, b] = key.split('\u0000') as [string, string];
    const rarer = Math.min(changes.get(a) ?? 0, changes.get(b) ?? 0);
    const confidence = rarer === 0 ? 0 : count / rarer;
    if (confidence < minConfidence) continue;
    const detail = `changed together in ${count} of the ${rarer} commits that touched the rarer of the two`;
    // Both directions: history does not say which one leads.
    edges.push(
      { from: a, to: b, why: { signal: 'cochange', detail, via: a } },
      { from: b, to: a, why: { signal: 'cochange', detail, via: b } },
    );
  }

  const limitations: Limitation[] = [];
  if (commitsSkipped > 0) {
    limitations.push({
      what: `${commitsSkipped} commit${commitsSkipped === 1 ? ' touched' : 's touched'} more than ${maxFilesPerCommit} files and ${commitsSkipped === 1 ? 'was' : 'were'} not read as evidence of coupling.`,
      mitigation: `A commit that large is a rename, a reformat or a dependency bump, and reading it as coupling would link every pair of files in it — ${maxFilesPerCommit} files is already ${(maxFilesPerCommit * (maxFilesPerCommit - 1)) / 2} pairs. The files still count toward how often each one changes, so the remaining pairs are not made to look stronger than they are.`,
    });
  }
  if (commitsRead === 0) {
    limitations.push({
      what: 'No usable commits were read, so history contributed nothing.',
      mitigation:
        'Either the history is too shallow or every commit was too large. Fetch more history to turn this signal on; nothing was narrowed by its absence.',
    });
  }

  return {
    edges: edges.sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to)),
    limitations,
    commitsRead,
    commitsSkipped,
  };
}

/**
 * A dependency moved and no source file changed.
 *
 * This is a whole class of change that is invisible to every other signal: the
 * diff is one lockfile, the radius computed from it is empty, and the report
 * reads as "nothing is affected" for a pull request that just replaced the date
 * library under twelve screens. The lockfile names which packages moved, and
 * the imports name who uses them.
 */
export interface LockfileResult {
  readonly edges: readonly Edge[];
  readonly limitations: readonly Limitation[];
  /** Packages whose version changed, with the move, for the report. */
  readonly moved: readonly { readonly name: string; readonly from: string; readonly to: string }[];
}

/**
 * Package versions out of a lockfile, for the three formats in use.
 *
 * Parsed with patterns rather than three real parsers on purpose: the question
 * is only "which names changed version", and a wrong answer in either direction
 * is safe here — a package read as changed that did not adds files that were
 * going to be retested anyway, and the parse is reported when it finds nothing.
 */
export function lockfileVersions(source: string, filename: string): Map<string, string> {
  const out = new Map<string, string>();

  if (filename.endsWith('.json')) {
    // npm: "node_modules/lodash": { "version": "4.17.21", … }
    for (const m of source.matchAll(/"(?:node_modules\/)?((?:@[^/"]+\/)?[^/"]+)"\s*:\s*\{[^{}]*?"version"\s*:\s*"([^"]+)"/g)) {
      out.set(m[1]!, m[2]!);
    }
    return out;
  }

  if (filename.includes('pnpm')) {
    // pnpm: /lodash@4.17.21: or '/@scope/name@1.0.0':
    for (const m of source.matchAll(/^\s{2}'?\/((?:@[^/]+\/)?[^@/]+)@([^:'\s(]+)/gm)) out.set(m[1]!, m[2]!);
    return out;
  }

  // yarn: lodash@^4.17.0:\n  version "4.17.21"
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = /^"?((?:@[^/@]+\/)?[^@\s"]+)@[^:]*:\s*$/.exec(lines[i]!);
    if (!head) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[j]!);
      if (v) {
        out.set(head[1]!, v[1]!);
        break;
      }
    }
  }
  return out;
}

/** Which packages a file imports, by bare specifier. */
const BARE_IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'".][^'"]*)['"]|\brequire\s*\(\s*['"]([^'".][^'"]*)['"]/g;

export function lockfileEdges(
  lockfile: string,
  before: string,
  after: string,
  importsByFile: ReadonlyMap<string, readonly string[]>,
): LockfileResult {
  const was = lockfileVersions(before, lockfile);
  const now = lockfileVersions(after, lockfile);

  const moved: { name: string; from: string; to: string }[] = [];
  for (const [name, version] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
    const old = was.get(name);
    if (old === undefined) moved.push({ name, from: '(absent)', to: version });
    else if (old !== version) moved.push({ name, from: old, to: version });
  }
  for (const [name, version] of [...was].sort(([a], [b]) => a.localeCompare(b))) {
    if (!now.has(name)) moved.push({ name, from: version, to: '(removed)' });
  }

  const movedNames = new Map(moved.map((m) => [m.name, m]));
  const edges: Edge[] = [];
  for (const file of [...importsByFile.keys()].sort()) {
    for (const spec of importsByFile.get(file) ?? []) {
      // `lodash/fp` and `@scope/pkg/sub` both resolve to their package root.
      const parts = spec.split('/');
      const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      const move = movedNames.get(pkg);
      if (!move) continue;
      edges.push({
        from: lockfile,
        to: file,
        why: {
          signal: 'lockfile',
          detail: `imports ${pkg}, which moved ${move.from} → ${move.to} with no change to its own source`,
          via: lockfile,
        },
      });
    }
  }

  const limitations: Limitation[] = [];
  if (moved.length > 0 && edges.length === 0) {
    limitations.push({
      what: `${moved.length} package${moved.length === 1 ? '' : 's'} moved in ${lockfile}, and no file in this repository imports ${moved.length === 1 ? 'it' : 'any of them'} directly.`,
      mitigation:
        'They are reached transitively, through another dependency, so the effect cannot be attributed to a file here. The versions are listed so the change is not invisible.',
    });
  }
  if (now.size === 0) {
    limitations.push({
      what: `No package versions could be read out of ${lockfile}.`,
      mitigation:
        'The dependency change is therefore not in the radius at all. Nothing else was narrowed, but a dependency bump in this pull request will not appear.',
    });
  }

  return {
    edges: edges.sort((a, b) => a.to.localeCompare(b.to) || a.why.detail.localeCompare(b.why.detail)),
    limitations,
    moved,
  };
}

/** Bare package specifiers per file, for the lockfile signal. */
export function bareImports(read: (file: string) => string, files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    if (!CODE_RE.test(file)) continue;
    const specs = new Set<string>();
    for (const m of read(file).matchAll(BARE_IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (spec && !spec.startsWith('node:')) specs.add(spec);
    }
    if (specs.size > 0) out.set(file, [...specs].sort());
  }
  return out;
}
