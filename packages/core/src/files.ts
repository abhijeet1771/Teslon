import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo']);

/**
 * Every file in the repository, repo-relative, POSIX-separated and sorted.
 *
 * Sorting is not cosmetic: it is what makes the whole analysis deterministic,
 * which invariant I3 asserts in the test suite.
 */
export function listFiles(root: string): string[] {
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };

  walk(root);
  return out.sort();
}
