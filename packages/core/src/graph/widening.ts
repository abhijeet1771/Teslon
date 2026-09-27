import { readFileSync } from 'node:fs';
import { dirname, join, normalize, basename } from 'node:path';
import type { Edge } from './imports.js';
import { CODE_RE, resolveSpecifier, type Alias } from './imports.js';
import { tokensInFile } from './names.js';

/**
 * The safety net.
 *
 * Measuring the shipped engine against the torture fixture gave 69.6%, while
 * the nine-layer prototype reached 95.7%. The whole difference was these
 * layers, and every one of them exists because a dependency has no import to
 * follow. They share one rule: when a target cannot be resolved, widen.
 *
 *   dynamic import with a variable    widen to the directory
 *   obj[key] dispatch                 widen to everything the module can reach
 *   template partials                 {{> name }} is an edge
 *   config files naming real files    a route table is a dependency
 *   generated-from headers            the spec is the real source
 *   runtime-built strings             `price-${x}` matches names starting price
 *   copy-pasted code                  coupled behaviour, zero edges
 */

const TEMPLATE_RE = /\.(?:hbs|handlebars|mustache|ejs|njk|liquid)$/;
const CONFIG_RE = /\.(?:json|ya?ml|toml)$/;
const FILE_REF_RE = /["']([\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte))["']/g;

const read = (root: string, file: string): string => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return '';
  }
};

const edge = (from: string, to: string, signal: Edge['why']['signal'], detail: string): Edge => ({
  from,
  to,
  why: { signal, detail, via: from },
});

/**
 * `import(\`./pages/${name}\`)` names no file. Widening to every candidate in
 * that directory over-approximates, which is the only safe direction: the
 * alternative is a dependency that silently is not there.
 */
export function dynamicImportEdges(
  root: string,
  allFiles: readonly string[],
): Edge[] {
  const out: Edge[] = [];
  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    const src = read(root, file);
    for (const m of src.matchAll(/import\s*\(\s*[`'"]([^`'"]*\$\{[^}]*\}[^`'"]*)[`'"]/g)) {
      const literalPrefix = m[1]!.split('${')[0] ?? '.';
      const dir = normalize(join(dirname(file), dirname(literalPrefix) === '.' ? '' : dirname(literalPrefix)));
      for (const candidate of allFiles) {
        if (!CODE_RE.test(candidate) || candidate === file) continue;
        if (dirname(candidate) !== (dir === '' ? '.' : dir)) continue;
        out.push(edge(candidate, file, 'widen', `dynamic import of "${m[1]}" — widened to this directory`));
      }
    }
  }
  return out;
}

/**
 * `handlers[name]()` where `handlers` came from another module. The key is not
 * knowable, so every target that module can dispatch to is a candidate.
 */
export function dynamicDispatchEdges(
  root: string,
  allFiles: readonly string[],
  aliases: readonly Alias[] = [],
): Edge[] {
  const files = new Set(allFiles);
  const out: Edge[] = [];

  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    const src = read(root, file);

    const dynamicallyRead = new Set(
      [...src.matchAll(/\b(\w+)\s*\[\s*(\w+)\s*\]/g)]
        .filter((m) => !/^\d+$/.test(m[2]!))
        .map((m) => m[1]!),
    );
    if (dynamicallyRead.size === 0) continue;

    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const names = m[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim());
      if (!names.some((n) => dynamicallyRead.has(n))) continue;

      const definingFile = resolveSpecifier(file, m[2]!, files, aliases);
      if (!definingFile) continue;

      for (const im of read(root, definingFile).matchAll(/from\s*['"]([^'"]+)['"]/g)) {
        const target = resolveSpecifier(definingFile, im[1]!, files, aliases);
        if (target && target !== file) {
          out.push(
            edge(target, file, 'widen', `reached by dynamic key through ${basename(definingFile)} — widened`),
          );
        }
      }
    }
  }
  return out;
}

/** `{{> priceRow }}` in a template is as real a dependency as an import. */
export function templateEdges(root: string, allFiles: readonly string[]): Edge[] {
  const out: Edge[] = [];
  for (const file of allFiles) {
    if (!TEMPLATE_RE.test(file)) continue;
    const src = read(root, file);
    for (const m of src.matchAll(/\{\{>\s*([\w/-]+)/g)) {
      const name = m[1]!;
      for (const candidate of allFiles) {
        if (!TEMPLATE_RE.test(candidate) || candidate === file) continue;
        if (basename(candidate).replace(/\.\w+$/, '') === basename(name)) {
          out.push(edge(candidate, file, 'template', `included as partial {{> ${name} }}`));
        }
      }
    }
  }
  return out;
}

/**
 * Files that list paths for reasons that are not dependencies. A manifest,
 * a lockfile or a coverage report mentions half the repository and would
 * couple all of it to itself.
 */
const NOT_A_MAPPING =
  /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[\w.]*\.json|jsconfig\.json|composer\.lock|.*\.lock|coverage[\w.-]*\.json|.*\.tsbuildinfo|expected\.json|.*\.snap)$/i;

/**
 * Maximum share of the repository one config may reference before it is
 * treated as a manifest rather than a mapping.
 *
 * Without this, a single file listing many paths dominated the result: on the
 * torture fixture it added 41 edges for +8.7% recall and +22 over-selection,
 * three quarters of all the noise the widening layers produced.
 */
const MAPPING_MAX_SHARE = 0.15;
const MAPPING_MAX_FILES = 40;

export interface ConfigEdgeResult {
  readonly edges: readonly Edge[];
  /** Configs skipped for looking like manifests, so the skip is not silent. */
  readonly skipped: readonly { readonly file: string; readonly references: number }[];
}

/** A route table or module map names real files. Those are edges. */
export function configEdgesDetailed(root: string, allFiles: readonly string[]): ConfigEdgeResult {
  const files = new Set(allFiles);
  const out: Edge[] = [];
  const skipped: { file: string; references: number }[] = [];
  const budget = Math.min(MAPPING_MAX_FILES, Math.max(5, Math.ceil(allFiles.length * MAPPING_MAX_SHARE)));

  for (const file of allFiles) {
    if (!CONFIG_RE.test(file) || NOT_A_MAPPING.test(file)) continue;

    const resolved = new Set<string>();
    for (const m of read(root, file).matchAll(FILE_REF_RE)) {
      const referenced = m[1]!;
      for (const c of [referenced, normalize(join(dirname(file), referenced))]) {
        if (files.has(c) && c !== file) {
          resolved.add(c);
          break;
        }
      }
    }

    if (resolved.size > budget) {
      skipped.push({ file, references: resolved.size });
      continue;
    }
    for (const target of [...resolved].sort()) {
      out.push(edge(target, file, 'config', `named in ${basename(file)}`));
    }
  }

  return { edges: out, skipped };
}

export function configEdges(root: string, allFiles: readonly string[]): Edge[] {
  return [...configEdgesDetailed(root, allFiles).edges];
}

/** `// AUTO-GENERATED from openapi.yaml` — the spec is the real source. */
export function generatedEdges(root: string, allFiles: readonly string[]): Edge[] {
  const out: Edge[] = [];
  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    const head = read(root, file).slice(0, 2000);
    const m = /(?:auto-?generated|generated|do not edit)[^\n]*?\bfrom\s+([\w./@-]+\.\w+)/i.exec(head);
    if (!m) continue;
    const named = m[1]!;
    for (const candidate of allFiles) {
      if (candidate === file) continue;
      if (candidate === named || basename(candidate) === basename(named)) {
        out.push(edge(candidate, file, 'generated', `generated from ${basename(named)}`));
      }
    }
  }
  return out;
}

/**
 * `` `price-${variant}` `` never equals a literal name, so the name index
 * cannot match it. The literal fragment can: anything starting `price-` is a
 * candidate.
 */
export function runtimeStringEdges(root: string, allFiles: readonly string[]): Edge[] {
  const owners = new Map<string, Set<string>>();
  for (const file of allFiles) {
    for (const token of tokensInFile(file, read(root, file))) {
      if (token.length < 4) continue;
      const set = owners.get(token) ?? new Set<string>();
      set.add(file);
      owners.set(token, set);
    }
  }

  const out: Edge[] = [];
  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    for (const m of read(root, file).matchAll(/[`'"]([\w-]{3,})[-_.]?\$\{/g)) {
      const prefix = m[1]!.toLowerCase();
      for (const [token, ownerFiles] of owners) {
        const lower = token.toLowerCase();
        if (lower === prefix || !lower.startsWith(prefix)) continue;
        // A prefix shared by half the repository is a word, not a reference.
        if (ownerFiles.size > 12) continue;
        for (const owner of ownerFiles) {
          if (owner !== file) {
            out.push(edge(owner, file, 'runtime-string', `built at runtime as "${m[1]}-…" — matches "${token}"`));
          }
        }
      }
    }
  }
  return out;
}

/**
 * Copy-pasted logic has no edge of any kind, and changing one copy usually
 * means the other is wrong now. Structure is compared with identifiers
 * stripped, so renamed copies still match.
 *
 * Known limit, measured: a function short enough to produce fewer than a
 * handful of shingles cannot be told apart from coincidence. Lowering the
 * threshold far enough to catch those couples unrelated files, so it is left
 * uncaught and said out loud rather than traded for noise.
 */
export interface CloneEdgeResult {
  readonly edges: readonly Edge[];
  /** Files whose candidate set hit the bound, so the omission is not silent. */
  readonly capped: readonly string[];
}

/**
 * Candidates come from a file's *rarest* structural fragments, not from every
 * file in the repository.
 *
 * The first version compared every pair: O(n²) pairs, each scanning one file's
 * shingles. Measured on a 5,000-file tree that was 3.67 seconds — 87% of the
 * entire analysis, for a signal that found nothing the others did not. At
 * 50,000 files the same shape is minutes, which is a scaling wall rather than
 * a slow step.
 *
 * An inverted index fixes it without weakening the comparison: two files can
 * only be clones if they share a fragment, so the index names the only
 * candidates worth the exact Jaccard, and the exact Jaccard is still what
 * decides. Frequency ordering matters — a fragment present in half the
 * repository is boilerplate and proposes everything, so the rarest fragments
 * drive candidate selection and the bound is reported when it bites.
 */
const RARE_SHINGLES_PER_FILE = 24;
const MAX_CANDIDATES_PER_FILE = 96;

export function cloneEdgesDetailed(
  root: string,
  allFiles: readonly string[],
  similarity = 0.5,
): CloneEdgeResult {
  const SHINGLE = 5;
  const normalise = (src: string): string[] =>
    src
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\b(?:const|let|var|function|export|return|async|await|public|private|readonly)\b/g, '')
      .replace(/\b[A-Za-z_$][\w$]*\b/g, 'ID')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean);

  const shingles = new Map<string, Set<string>>();
  for (const file of allFiles) {
    if (!CODE_RE.test(file)) continue;
    const tokens = normalise(read(root, file));
    const set = new Set<string>();
    for (let i = 0; i + SHINGLE <= tokens.length; i++) set.add(tokens.slice(i, i + SHINGLE).join(' '));
    if (set.size >= 3) shingles.set(file, set);
  }

  // shingle -> the files containing it
  const byShingle = new Map<string, string[]>();
  for (const [file, set] of shingles) {
    for (const sh of set) {
      const list = byShingle.get(sh);
      if (list) list.push(file);
      else byShingle.set(sh, [file]);
    }
  }

  const out: Edge[] = [];
  const capped: string[] = [];
  const done = new Set<string>();
  // Sorted so the edge list, and which candidates survive the bound, do not
  // depend on Map iteration order — invariant I3.
  for (const file of [...shingles.keys()].sort()) {
    const mine = shingles.get(file)!;
    const rarest = [...mine].sort(
      (a, b) => (byShingle.get(a)?.length ?? 0) - (byShingle.get(b)?.length ?? 0) || a.localeCompare(b),
    );

    const candidates = new Set<string>();
    let hitBound = false;
    for (const sh of rarest.slice(0, RARE_SHINGLES_PER_FILE)) {
      for (const other of byShingle.get(sh) ?? []) {
        if (other === file) continue;
        if (candidates.size >= MAX_CANDIDATES_PER_FILE) {
          hitBound = true;
          break;
        }
        candidates.add(other);
      }
      if (hitBound) break;
    }
    if (hitBound) capped.push(file);

    for (const other of [...candidates].sort()) {
      const key = file < other ? `${file}\u0000${other}` : `${other}\u0000${file}`;
      if (done.has(key)) continue;
      done.add(key);
      const theirs = shingles.get(other)!;
      // Exact Jaccard, unchanged. The index chose who to compare, not the verdict.
      const [small, large] = mine.size <= theirs.size ? [mine, theirs] : [theirs, mine];
      let shared = 0;
      for (const sh of small) if (large.has(sh)) shared++;
      if (shared === 0) continue;
      const jaccard = shared / (mine.size + theirs.size - shared);
      if (jaccard < similarity) continue;
      const detail = `${(jaccard * 100).toFixed(0)}% structurally identical — a copy`;
      out.push(edge(file, other, 'clone', detail), edge(other, file, 'clone', detail));
    }
  }

  return {
    edges: out.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.why.detail.localeCompare(b.why.detail),
    ),
    capped: capped.sort(),
  };
}

export function cloneEdges(root: string, allFiles: readonly string[], similarity = 0.5): Edge[] {
  return [...cloneEdgesDetailed(root, allFiles, similarity).edges];
}

/** Every widening layer, in one call. */
export function wideningEdges(
  root: string,
  allFiles: readonly string[],
  aliases: readonly Alias[] = [],
): Edge[] {
  return [
    ...dynamicImportEdges(root, allFiles),
    ...dynamicDispatchEdges(root, allFiles, aliases),
    ...templateEdges(root, allFiles),
    ...configEdges(root, allFiles),
    ...generatedEdges(root, allFiles),
    ...runtimeStringEdges(root, allFiles),
    ...cloneEdges(root, allFiles),
  ].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.why.detail.localeCompare(b.why.detail));
}
