import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Provenance } from '../schema/index.js';

/**
 * The reverse import graph.
 *
 * This is the layer most "impact analysis" tools ship, and on a torture
 * fixture built from real patterns it found 34.8% of the true dependencies.
 * It is the floor of the product, never the product.
 */

export const CODE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** An edge from `to` (the thing changed) back to `from` (the thing affected). */
export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly why: Provenance;
}

export interface Alias {
  /** e.g. `@app/` */
  readonly prefix: string;
  /** Repo-relative target, e.g. `src/` */
  readonly target: string;
}

const CANDIDATE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
] as const;

/**
 * Resolve an import specifier to a file in the repository.
 * Returns null for bare specifiers (packages) and anything unresolvable —
 * the caller decides what an unresolvable target means.
 */
export function resolveSpecifier(
  fromFile: string,
  spec: string,
  files: ReadonlySet<string>,
  aliases: readonly Alias[] = [],
): string | null {
  let base: string;

  if (spec.startsWith('.')) {
    base = normalize(join(dirname(fromFile), spec));
  } else {
    const alias = aliases.find((a) => spec.startsWith(a.prefix));
    if (!alias) return null;
    base = normalize(join(alias.target, spec.slice(alias.prefix.length)));
  }

  // A TypeScript source importing "./x.js" means "./x.ts" on disk.
  const rewritten = base.endsWith('.js') ? base.slice(0, -3) : null;

  for (const stem of rewritten ? [base, rewritten] : [base]) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = stem + suffix;
      if (files.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Static and literal-dynamic imports.
 *
 * `import()` with a variable path is deliberately *not* matched here; it is
 * handled by the widening layer, which over-approximates rather than missing.
 */
const IMPORT_RE =
  /(?:^|[\s;=(])(?:import|export)\s+(?:[\w*{},\s]+\s+from\s+)?['"]([^'"]+)['"]|(?:^|[\s;=(])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

export interface ImportGraph {
  /** file -> files it imports */
  readonly forward: ReadonlyMap<string, ReadonlySet<string>>;
  /** file -> files that import it */
  readonly reverse: ReadonlyMap<string, ReadonlySet<string>>;
  readonly edges: readonly Edge[];
  /** Specifiers we could not resolve, per file. These widen the radius. */
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
}

export function buildImportGraph(
  root: string,
  allFiles: readonly string[],
  aliases: readonly Alias[] = [],
): ImportGraph {
  const files = new Set(allFiles);
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const unresolved = new Map<string, string[]>();
  const edges: Edge[] = [];

  for (const f of allFiles) {
    forward.set(f, new Set());
    reverse.set(f, new Set());
  }

  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;

    let src: string;
    try {
      src = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }

    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;

      const target = resolveSpecifier(file, spec, files, aliases);
      if (!target) {
        // Bare package specifiers are expected and not interesting on their
        // own; relative ones that fail to resolve are worth widening on.
        if (spec.startsWith('.')) {
          const list = unresolved.get(file) ?? [];
          list.push(spec);
          unresolved.set(file, list);
        }
        continue;
      }
      if (target === file) continue;

      forward.get(file)!.add(target);
      reverse.get(target)!.add(file);
      edges.push({
        from: target,
        to: file,
        why: { signal: 'import', detail: `imports ${spec}`, via: file },
      });
    }
  }

  return { forward, reverse, edges, unresolved };
}

/**
 * Walk a graph from seeds, recording the shortest hop count to each node.
 * Seeds themselves are returned at distance 0.
 */
export function walk(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  seeds: readonly string[],
): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];

  for (const s of seeds) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const d = dist.get(current)!;
    for (const next of adjacency.get(current) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }

  return dist;
}

/**
 * Like `walk`, but also records which node each one was reached through, so a
 * multi-hop item can still show the reason for its own edge rather than an
 * unhelpful "reached transitively". Invariant I4 applies at every hop, not
 * just the first.
 */
export function walkWithParents(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  seeds: readonly string[],
): { dist: Map<string, number>; parent: Map<string, string> } {
  const dist = new Map<string, number>();
  const parent = new Map<string, string>();
  const queue: string[] = [];

  for (const s of seeds) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    const d = dist.get(current)!;
    // Sorted so the chosen parent is stable across runs — invariant I3.
    for (const next of [...(adjacency.get(current) ?? [])].sort()) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        parent.set(next, current);
        queue.push(next);
      }
    }
  }

  return { dist, parent };
}
