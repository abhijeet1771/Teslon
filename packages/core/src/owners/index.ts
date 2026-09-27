import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Who to ask about a file.
 *
 * This is the question a lead asks first and no impact analyser answers: the
 * radius says *what* to test, and the person reading it still has to find out
 * who owns it. The answer is already in the repository in two forms, and they
 * are not equally good.
 *
 * `CODEOWNERS` is a declaration — someone wrote down who is responsible, and
 * GitHub enforces it on review. Git history is evidence — whoever touched a
 * file most recently probably understands it, but nobody promised that. So the
 * declaration wins where it exists, the evidence fills the gaps, and every
 * assignment says which of the two it came from. A manager chasing the wrong
 * person because a tool guessed confidently is worse off than one who was told
 * "nobody has declared this; the last three commits were Priya's".
 */

export interface Ownership {
  readonly file: string;
  readonly owners: readonly string[];
  readonly source: 'CODEOWNERS' | 'git-history' | 'none';
  /** The CODEOWNERS line that matched, so the assignment can be checked. */
  readonly rule?: string;
}

export interface OwnersFile {
  readonly path: string;
  readonly rules: readonly { readonly pattern: string; readonly owners: readonly string[]; readonly line: number }[];
}

/** Where GitHub, GitLab and Bitbucket look, in the order GitHub resolves them. */
const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];

export function findCodeowners(root: string): OwnersFile | null {
  for (const path of CODEOWNERS_PATHS) {
    let src: string;
    try {
      src = readFileSync(join(root, path), 'utf8');
    } catch {
      continue;
    }
    const rules: { pattern: string; owners: string[]; line: number }[] = [];
    src.split('\n').forEach((raw, i) => {
      const text = raw.replace(/#.*$/, '').trim();
      if (text.length === 0) return;
      const [pattern, ...owners] = text.split(/\s+/);
      if (!pattern || owners.length === 0) return;
      rules.push({ pattern, owners, line: i + 1 });
    });
    return { path, rules };
  }
  return null;
}

/**
 * The gitignore-flavoured subset CODEOWNERS uses.
 *
 * The rule that catches people out is that a pattern with no slash in it
 * matches at any depth, while one with a slash is anchored to the repository
 * root — so `*.ts` covers the whole tree and `src/*.ts` covers exactly one
 * directory. Getting this backwards silently assigns the whole repository to
 * one team, which reads as a working feature.
 */
function toRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const directory = p.endsWith('/');
  if (directory) p = p.slice(0, -1);

  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        body += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else body += '[^/]*';
    } else if (c === '?') body += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(c)) body += `\\${c}`;
    else body += c;
  }

  // A directory pattern owns everything under it; a file pattern owns itself.
  const tail = directory ? '/.*' : '(?:/.*)?';
  return new RegExp(anchored ? `^${body}${tail}$` : `(?:^|/)${body}${tail}$`);
}

/**
 * Resolve ownership for a set of files.
 *
 * `authors` is optional git evidence, supplied by the caller because core does
 * not run git. Leaving it out is not an error; the result then says `none` for
 * anything CODEOWNERS does not cover, which is a true statement and a useful
 * one — undeclared ownership on a Tier 1 file is itself worth reporting.
 */
export function resolveOwnership(
  root: string,
  files: readonly string[],
  authors: ReadonlyMap<string, readonly string[]> = new Map(),
): Ownership[] {
  const owners = findCodeowners(root);
  const compiled = (owners?.rules ?? []).map((r) => ({ ...r, re: toRegExp(r.pattern) }));

  return files
    .map((file) => {
      // Last match wins. This is CODEOWNERS' own precedence rule, not
      // gitignore's, and the difference decides who gets paged.
      let matched: (typeof compiled)[number] | undefined;
      for (const rule of compiled) if (rule.re.test(file)) matched = rule;
      if (matched) {
        return { file, owners: matched.owners, source: 'CODEOWNERS' as const, rule: `${owners!.path}:${matched.line} ${matched.pattern}` };
      }
      const fromHistory = authors.get(file);
      if (fromHistory && fromHistory.length > 0) {
        return { file, owners: fromHistory, source: 'git-history' as const };
      }
      return { file, owners: [], source: 'none' as const };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Who to talk to, rolled up.
 *
 * A per-file list is what a script wants; a lead wants three names and the
 * worst tier each of them is on the hook for, because that is the whole of
 * "who do I go and stand next to this afternoon".
 */
export function ownershipRollup(
  ownership: readonly Ownership[],
  tierOf: ReadonlyMap<string, number>,
): { readonly owner: string; readonly files: number; readonly topTier: number; readonly source: Ownership['source'] }[] {
  const byOwner = new Map<string, { files: number; topTier: number; source: Ownership['source'] }>();
  for (const o of ownership) {
    const tier = tierOf.get(o.file) ?? 4;
    for (const name of o.owners.length > 0 ? o.owners : ['(nobody declared)']) {
      const slot = byOwner.get(name);
      if (slot) {
        slot.files++;
        slot.topTier = Math.min(slot.topTier, tier);
      } else byOwner.set(name, { files: 1, topTier: tier, source: o.source });
    }
  }
  return [...byOwner]
    .map(([owner, v]) => ({ owner, ...v }))
    .sort((a, b) => a.topTier - b.topTier || b.files - a.files || a.owner.localeCompare(b.owner));
}
