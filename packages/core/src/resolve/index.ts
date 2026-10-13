import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { Alias } from '../graph/imports.js';
import type { Limitation } from '../schema/index.js';

/**
 * How this repository spells its own imports.
 *
 * Two conventions turn an internal import into something that looks external,
 * and between them they cover most of the code enterprises actually write:
 *
 *   tsconfig `paths`   `import { fmt } from '@/lib/money'` — the default in
 *                      every Next.js, Vite and Nx app. Without reading it, the
 *                      import is an unresolved bare specifier, and the file
 *                      that changed has no visible dependents at all.
 *   workspaces         `import { add } from '@acme/utils'` — a monorepo package
 *                      named in its own package.json. Without reading it, the
 *                      whole cross-package graph is treated as third-party,
 *                      which is exactly the graph a monorepo exists to share.
 *
 * Both failures were measured, not imagined: a changed `src/lib/money.ts`
 * imported through `@/lib/money`, and a changed `packages/utils` imported as
 * `@acme/utils`, each produced a radius of one — the changed file and nothing
 * else — with no limitation saying why.
 */

export interface DiscoveredAliases {
  readonly aliases: readonly Alias[];
  readonly limitations: readonly Limitation[];
  /** Where each alias came from, for the trust view. */
  readonly sources: readonly string[];
}

/**
 * tsconfig is JSONC: comments and trailing commas are legal, and real configs
 * use both. `JSON.parse` on one throws, and an alias reader that throws on the
 * first commented config reads nothing — silently.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface TsConfigLike {
  extends?: string | string[];
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/**
 * Read a tsconfig and everything it `extends`, nearest definition winning, as
 * tsc does. `paths` resolve relative to `baseUrl` when one is set and to the
 * config that declared them otherwise.
 */
function readTsconfig(
  root: string,
  file: string,
  seen: Set<string>,
): { baseUrl?: string; paths?: Record<string, string[]>; pathsFrom?: string } | null {
  if (seen.has(file)) return null; // an `extends` cycle is a broken config, not a reason to hang
  seen.add(file);
  let config: TsConfigLike;
  try {
    config = parseJsonc(readFileSync(join(root, file), 'utf8')) as TsConfigLike;
  } catch {
    return null;
  }

  let inherited: ReturnType<typeof readTsconfig> = null;
  for (const parent of [config.extends ?? []].flat()) {
    // A package-name extends (`@tsconfig/node20`) lives in node_modules and
    // never declares paths, so only relative parents are followed.
    if (!parent.startsWith('.')) continue;
    const target = normalize(join(dirname(file), parent.endsWith('.json') ? parent : `${parent}.json`));
    const got = readTsconfig(root, target, seen);
    if (got) inherited = { ...(inherited ?? {}), ...got };
  }

  const own = config.compilerOptions ?? {};
  const baseUrl = own.baseUrl !== undefined ? normalize(join(dirname(file), own.baseUrl)) : inherited?.baseUrl;
  const paths = own.paths ?? inherited?.paths;
  const pathsFrom = own.paths ? dirname(file) : inherited?.pathsFrom;
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(paths ? { paths } : {}),
    ...(pathsFrom !== undefined ? { pathsFrom } : {}),
  };
}

const posix = (p: string): string => {
  const n = normalize(p).split('\\').join('/');
  return n === '.' ? '' : n.replace(/^\.\//, '');
};

export function discoverAliases(root: string, allFiles: readonly string[]): DiscoveredAliases {
  const aliases: Alias[] = [];
  const sources: string[] = [];
  const limitations: Limitation[] = [];
  const unsupported: string[] = [];

  // ---- tsconfig / jsconfig paths, in every package of the repository ----
  const configs = allFiles.filter((f) => /(?:^|\/)(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/.test(f));
  for (const file of configs) {
    const cfg = readTsconfig(root, file, new Set());
    if (!cfg?.paths) continue;
    const anchor = cfg.baseUrl ?? cfg.pathsFrom ?? dirname(file);
    for (const [pattern, targets] of Object.entries(cfg.paths)) {
      const target = targets[0];
      if (!target) continue;
      // `@/*` -> `src/*` is a prefix mapping, which is all Alias can express
      // and all that real configs use. An exact mapping (`config` -> one file)
      // becomes a prefix that only ever matches itself.
      const starAt = pattern.indexOf('*');
      if (starAt >= 0 && starAt !== pattern.length - 1) {
        unsupported.push(`${file}: ${pattern}`);
        continue;
      }
      const prefix = starAt >= 0 ? pattern.slice(0, -1) : pattern;
      const to = starAt >= 0 ? target.replace(/\*$/, '') : target;
      const resolved = posix(join(anchor, to));
      aliases.push({ prefix, target: resolved === '' ? '' : resolved.endsWith('/') || starAt < 0 ? resolved : `${resolved}/` });
      sources.push(`${file}: ${pattern} → ${resolved}`);
    }
  }

  // ---- workspace packages: a name in package.json is an import path ----
  const manifests = allFiles.filter((f) => f.endsWith('package.json') && f !== 'package.json');
  for (const manifest of manifests) {
    let pkg: { name?: string; main?: string; module?: string; types?: string; source?: string; exports?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const dir = posix(dirname(manifest));
    // Point a bare `@acme/utils` at the source entry, not the built one: the
    // pull request changes source, and `dist/` is not in the tree.
    const entryCandidates = [
      pkg.source,
      pkg.types?.replace(/\.d\.ts$/, '.ts'),
      typeof pkg.exports === 'string' ? pkg.exports : undefined,
      pkg.module,
      pkg.main,
      'src/index',
      'index',
    ].filter((x): x is string => typeof x === 'string');
    const present = new Set(allFiles);
    const stems = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];
    let entry: string | undefined;
    for (const cand of entryCandidates) {
      const clean = posix(join(dir, cand.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.(?:c|m)?js$/, '')));
      const hit = stems.map((s) => clean + s).find((x) => present.has(x));
      if (hit) {
        entry = hit;
        break;
      }
    }
    // Deep imports (`@acme/utils/money`) resolve inside the package directory;
    // the bare name resolves to the entry file.
    aliases.push({ prefix: `${pkg.name}/`, target: `${dir}/` });
    if (entry) {
      aliases.push({ prefix: pkg.name, target: entry, exact: true });
      sources.push(`${manifest}: ${pkg.name} → ${entry}`);
    } else {
      sources.push(`${manifest}: ${pkg.name}/… → ${dir}/ (no source entry found for the bare name)`);
      limitations.push({
        what: `The workspace package ${pkg.name} has no source entry Teslon could find, so a bare \`import … from '${pkg.name}'\` does not resolve.`,
        mitigation: 'Deep imports into the package still resolve. Add a "source" field to its package.json pointing at the source entry to close the gap.',
        files: [manifest],
      });
    }
  }

  if (unsupported.length > 0) {
    limitations.push({
      what: `${unsupported.length} path mapping${unsupported.length === 1 ? ' uses' : 's use'} a wildcard in the middle, which Teslon does not resolve: ${unsupported.slice(0, 3).join('; ')}.`,
      mitigation: 'Imports through those mappings stay unresolved and are reported as such, so they can only widen the radius, never hide part of it.',
    });
  }

  // Longest prefix first, so `@acme/utils/` beats `@acme/` and an exact package
  // name beats a wildcard that happens to share its first characters.
  aliases.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  return { aliases, limitations, sources: sources.sort() };
}
