import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_RE, resolveSpecifier, type Alias } from './imports.js';

/**
 * Symbol-level edges, and the proof paths they make possible.
 *
 * A file-level graph can say "money.ts reaches CheckoutPage". It cannot say
 * *which function* got there, which is the thing a reviewer actually wants to
 * see: a change to `formatMoney` reaching the invoice PDF is a different
 * conversation from a change to `applyDiscount` reaching it.
 *
 * `import { formatMoney } from './money'` names the symbol, so that edge is
 * exact. A default or namespace import does not, so those degrade to
 * file-level and are marked — they widen rather than disappear.
 */

export type ImportKind = 'named' | 'default' | 'namespace' | 'side-effect';

export interface SymbolEdge {
  /** The module being imported from. */
  readonly from: string;
  /**
   * The symbol named by the import, or `*` when the import does not name one
   * (default, namespace or side-effect). `*` means "any symbol in this file".
   */
  readonly symbol: string;
  /** The importing file. */
  readonly to: string;
  readonly kind: ImportKind;
  /** Renamed on import: `import { a as b }` keeps `a` and records `b`. */
  readonly localName?: string;
}

const NAMED_IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+)|(\w+))\s*,?\s*(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /import\s*['"]([^'"]+)['"]/g;
const REEXPORT_RE = /export\s+(?:\{([^}]*)\}|\*)\s*from\s*['"]([^'"]+)['"]/g;

function splitNamed(clause: string): { name: string; local?: string }[] {
  return clause
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const withoutType = raw.replace(/^type\s+/, '');
      const [name, local] = withoutType.split(/\s+as\s+/).map((s) => s.trim());
      return local ? { name: name!, local } : { name: name! };
    })
    .filter((s) => s.name.length > 0);
}

export function buildSymbolEdges(
  root: string,
  allFiles: readonly string[],
  aliases: readonly Alias[] = [],
): SymbolEdge[] {
  const files = new Set(allFiles);
  const edges: SymbolEdge[] = [];

  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    let src: string;
    try {
      src = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }

    for (const m of src.matchAll(NAMED_IMPORT_RE)) {
      const spec = m[5]!;
      const target = resolveSpecifier(file, spec, files, aliases);
      if (!target || target === file) continue;

      const namedClause = m[1] ?? m[4];
      if (namedClause) {
        for (const { name, local } of splitNamed(namedClause)) {
          edges.push({
            from: target,
            symbol: name,
            to: file,
            kind: 'named',
            ...(local ? { localName: local } : {}),
          });
        }
      }
      // A default or namespace import binds the whole module, so we cannot
      // attribute the dependency to one symbol. `*` keeps the edge and says so.
      if (m[2]) edges.push({ from: target, symbol: '*', to: file, kind: 'namespace' });
      if (m[3]) edges.push({ from: target, symbol: '*', to: file, kind: 'default' });
    }

    for (const m of src.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const target = resolveSpecifier(file, m[1]!, files, aliases);
      if (!target || target === file) continue;
      if (edges.some((e) => e.from === target && e.to === file)) continue;
      edges.push({ from: target, symbol: '*', to: file, kind: 'side-effect' });
    }

    // A barrel re-export carries symbols onward, so it has to be an edge too
    // or every dependency through an index file would vanish.
    for (const m of src.matchAll(REEXPORT_RE)) {
      const target = resolveSpecifier(file, m[2]!, files, aliases);
      if (!target || target === file) continue;
      if (m[1]) {
        for (const { name } of splitNamed(m[1])) {
          edges.push({ from: target, symbol: name, to: file, kind: 'named' });
        }
      } else {
        edges.push({ from: target, symbol: '*', to: file, kind: 'namespace' });
      }
    }
  }

  return edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.symbol.localeCompare(b.symbol) || a.to.localeCompare(b.to),
  );
}

export interface PathStep {
  readonly file: string;
  /** The symbol that carried the dependency into this file. */
  readonly symbol: string;
  readonly kind: ImportKind;
}

/** One readable proof that a change reaches a place. */
export interface ProofPath {
  readonly origin: { readonly file: string; readonly symbol: string };
  readonly steps: readonly PathStep[];
  /** True when every hop named a symbol, so the path is exact end to end. */
  readonly exact: boolean;
}

export interface ProofOptions {
  /** Stop expanding beyond this depth. Cycles are always cut regardless. */
  readonly maxDepth?: number;
  /** Stop after this many paths, so a hub symbol cannot hang the run. */
  readonly maxPaths?: number;
}

/**
 * Every path from one changed symbol out to the files that depend on it.
 *
 * Paths, not a graph. A graph of two thousand nodes is a hairball nobody
 * reads; two thousand paths sorted by risk are read one at a time, and each
 * one is a complete argument on its own.
 */
export function proofPaths(
  edges: readonly SymbolEdge[],
  originFile: string,
  originSymbol: string,
  options: ProofOptions = {},
): ProofPath[] {
  const maxDepth = options.maxDepth ?? 12;
  const maxPaths = options.maxPaths ?? 500;

  const byFile = new Map<string, SymbolEdge[]>();
  for (const e of edges) {
    const list = byFile.get(e.from);
    if (list) list.push(e);
    else byFile.set(e.from, [e]);
  }

  const out: ProofPath[] = [];

  const expand = (file: string, symbol: string, steps: PathStep[], visited: ReadonlySet<string>): void => {
    if (out.length >= maxPaths) return;

    const candidates = (byFile.get(file) ?? []).filter(
      // `*` on either side means "the whole module", which matches anything.
      (e) => e.symbol === symbol || e.symbol === '*' || symbol === '*',
    );

    const next = candidates.filter((e) => !visited.has(e.to));

    if (next.length === 0 || steps.length >= maxDepth) {
      if (steps.length > 0) {
        out.push({
          origin: { file: originFile, symbol: originSymbol },
          steps: [...steps],
          exact: steps.every((s) => s.kind === 'named'),
        });
      }
      return;
    }

    for (const e of next) {
      expand(
        e.to,
        // Once a module is reached, anything it exports may carry the change on.
        '*',
        [...steps, { file: e.to, symbol: e.symbol, kind: e.kind }],
        new Set([...visited, e.to]),
      );
    }
  };

  expand(originFile, originSymbol, [], new Set([originFile]));

  // Shortest first: the most direct proof is the most convincing one.
  return out.sort(
    (a, b) => a.steps.length - b.steps.length || a.steps.at(-1)!.file.localeCompare(b.steps.at(-1)!.file),
  );
}

/** The shortest proof path to each distinct destination. */
export function shortestPathPerDestination(paths: readonly ProofPath[]): ProofPath[] {
  const best = new Map<string, ProofPath>();
  for (const p of paths) {
    const destination = p.steps.at(-1)!.file;
    const existing = best.get(destination);
    if (!existing || p.steps.length < existing.steps.length) best.set(destination, p);
  }
  return [...best.values()].sort(
    (a, b) => a.steps.length - b.steps.length || a.steps.at(-1)!.file.localeCompare(b.steps.at(-1)!.file),
  );
}

/** Exported symbols a file declares, so a changed file can be expanded to changed symbols. */
export function exportedSymbols(root: string, file: string): string[] {
  let src: string;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const m of src.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g,
  )) {
    names.add(m[1]!);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const { name } of splitNamed(m[1]!)) names.add(name);
  }
  return [...names].sort();
}
