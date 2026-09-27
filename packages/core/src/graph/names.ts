import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edge } from './imports.js';

/**
 * The shared name index.
 *
 * Six different ways of hiding a dependency turn out to be the same shape of
 * problem: a string in one file naming something declared in another.
 *
 *   dependency injection    register('price', …)      resolve('price')
 *   registry objects        { 'invoice.render': fn }  handlers[name]
 *   event buses             emit('order.paid')        on('order.paid')
 *   CSS                     .price-tag { }            class="price-tag"
 *   database columns        ADD COLUMN unit_price     SELECT unit_price
 *   translations            { "cart.total": … }       t('cart.total')
 *
 * Indexing every rare name-like token and coupling the files that share one
 * catches all six with a single mechanism. In the lab this was the largest
 * single contributor to recall.
 *
 * Two scanning bugs cost us real recall before they were found, and both are
 * fixed here:
 *
 *   - A naive `/['"`]…['"`]/` scan lets a backtick swallow the quotes inside a
 *     template literal, so `<span class="price-tag">` never yields its class.
 *     Each quote style is scanned separately, and nested quotes are scanned
 *     inside the match.
 *   - Requiring a dot or dash in a token ("name-ish") silently excluded
 *     single-word keys like 'price', which is what most DI containers use.
 */

export const TEXT_RE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|less|hbs|html|vue|svelte|json|ya?ml|sql|graphql)$/;

/**
 * Words that appear in almost every file and would couple the whole
 * repository if treated as meaningful names.
 */
const STOPWORDS = new Set([
  'string', 'number', 'boolean', 'object', 'default', 'export', 'import',
  'return', 'const', 'function', 'class', 'true', 'false', 'null', 'undefined',
  'http', 'https', 'utf8', 'use strict', 'node_modules', 'index', 'src', 'test',
  'value', 'name', 'type', 'data', 'error', 'result', 'options', 'config',
]);

/**
 * A token is only evidence if it is rare. Appearing in one file proves
 * nothing; appearing in forty means it is a common word, not an identifier.
 */
export interface NameIndexOptions {
  readonly minFiles?: number;
  readonly maxFiles?: number;
}

const DEFAULTS = { minFiles: 2, maxFiles: 12 } as const;

function isInteresting(token: string): boolean {
  if (token.length < 3 || token.length > 60) return false;
  if (STOPWORDS.has(token.toLowerCase())) return false;
  if (token.startsWith('./') || token.startsWith('../')) return false;
  if (/^\d+$/.test(token)) return false;
  return /^[a-z@/][\w.\-:/@]*$/i.test(token);
}

/** Every name-like token a file mentions, whatever syntax it used to say it. */
export function tokensInFile(path: string, src: string): Set<string> {
  const tokens = new Set<string>();
  const add = (t: string): void => {
    if (isInteresting(t)) tokens.add(t);
  };

  // Scan each quote style separately so a template literal cannot swallow the
  // quoted strings inside it.
  for (const re of [/'([^'\n]{1,60})'/g, /"([^"\n]{1,60})"/g, /`([^`]{1,200})`/g]) {
    for (const m of src.matchAll(re)) {
      const body = m[1]!;
      add(body);
      for (const inner of body.matchAll(/["']([^"'\n]{1,60})["']/g)) add(inner[1]!);
      for (const cls of body.matchAll(/class=["']([^"']+)["']/g)) {
        for (const c of cls[1]!.split(/\s+/)) add(c);
      }
    }
  }

  if (/\.(?:css|scss|less)$/.test(path)) {
    for (const m of src.matchAll(/\.([a-z][\w-]{2,})\s*[,{:\s]/gi)) add(m[1]!);
  }

  if (/\.(?:hbs|html|vue|svelte)$/.test(path)) {
    for (const m of src.matchAll(/class=["']([^"']+)["']/g)) {
      for (const c of m[1]!.split(/\s+/)) add(c);
    }
    for (const m of src.matchAll(/\{\{>\s*([\w-]+)/g)) add(m[1]!);
  }

  if (/\.(?:json|ya?ml)$/.test(path)) {
    for (const m of src.matchAll(/["']?([\w.\-/]{3,60})["']?\s*:/g)) add(m[1]!);
  }

  // snake_case identifiers are how database columns appear on both sides:
  // in the migration that creates them and in the query that reads them.
  if (/\.(?:sql|ts|tsx|js|jsx|mjs)$/.test(path)) {
    for (const m of src.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/gi)) add(m[1]!);
  }

  return tokens;
}

export interface NameIndex {
  readonly edges: readonly Edge[];
  /** token -> files mentioning it, for tokens that survived the rarity filter. */
  readonly shared: ReadonlyMap<string, readonly string[]>;
}

export function buildNameIndex(
  root: string,
  allFiles: readonly string[],
  options: NameIndexOptions = {},
): NameIndex {
  const minFiles = options.minFiles ?? DEFAULTS.minFiles;
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;

  const byToken = new Map<string, string[]>();

  for (const file of allFiles) {
    if (!TEXT_RE.test(file)) continue;
    let src: string;
    try {
      src = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const token of tokensInFile(file, src)) {
      const list = byToken.get(token);
      if (list) list.push(file);
      else byToken.set(token, [file]);
    }
  }

  const edges: Edge[] = [];
  const shared = new Map<string, readonly string[]>();

  // Sorted so the edge list is deterministic regardless of Map iteration order.
  for (const token of [...byToken.keys()].sort()) {
    const files = byToken.get(token)!.slice().sort();
    if (files.length < minFiles || files.length > maxFiles) continue;
    shared.set(token, files);

    // Coupling here is symmetric: we do not know which side declares the name
    // and which consumes it, and for impact purposes it does not matter.
    for (const a of files) {
      for (const b of files) {
        if (a === b) continue;
        edges.push({
          from: a,
          to: b,
          why: { signal: 'name', detail: `shares the name "${token}"`, via: a },
        });
      }
    }
  }

  return { edges, shared };
}
