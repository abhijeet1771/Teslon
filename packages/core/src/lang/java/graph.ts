import type { Edge } from '../../graph/imports.js';
import type { JavaReading } from './read.js';

/**
 * The Java dependency graph.
 *
 * Java does not resolve by path, so none of the TypeScript machinery applies.
 * Three things have to be handled, and the third is the one that matters:
 *
 *   explicit   `import com.acme.orders.OrderService;` names one type
 *   wildcard   `import com.acme.repo.*;` names a whole package
 *   implicit   **classes in the same package need no import at all**
 *
 * That last case is exactly what Teslon exists for. Two classes sitting in
 * the same package can use each other with nothing written down anywhere, so
 * a tool that only follows import statements will miss the dependency
 * completely — and in enterprise Java, a package is where the closely
 * related classes live, which is to say where the real coupling is.
 */

export interface JavaGraph {
  readonly edges: readonly Edge[];
  /** Fully-qualified type name → the file declaring it. */
  readonly declaredBy: ReadonlyMap<string, string>;
  /** Imports that pointed outside the repository, so they are not silent. */
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
}

const edge = (from: string, to: string, detail: string, signal: Edge['why']['signal'] = 'import'): Edge => ({
  from,
  to,
  why: { signal, detail, via: from },
});

export function buildJavaGraph(readings: readonly JavaReading[]): JavaGraph {
  const declaredBy = new Map<string, string>();
  const byPackage = new Map<string, JavaReading[]>();

  for (const r of readings) {
    for (const type of r.declares) {
      declaredBy.set(r.packageName ? `${r.packageName}.${type}` : type, r.file);
    }
    const list = byPackage.get(r.packageName);
    if (list) list.push(r);
    else byPackage.set(r.packageName, [r]);
  }

  const edges: Edge[] = [];
  const unresolved = new Map<string, string[]>();

  for (const r of readings) {
    // ---- explicit and wildcard imports --------------------------------
    for (const imported of r.imports) {
      if (imported.endsWith('.*')) {
        const pkg = imported.slice(0, -2);
        const members = byPackage.get(pkg) ?? [];
        if (members.length === 0) {
          const list = unresolved.get(r.file) ?? [];
          list.push(imported);
          unresolved.set(r.file, list);
          continue;
        }
        // A wildcard names no type, so every type in the package is a
        // candidate. Widening is the only safe reading of it.
        for (const member of members) {
          if (member.file !== r.file) {
            edges.push(edge(member.file, r.file, `wildcard import ${imported} — widened to the package`, 'widen'));
          }
        }
        continue;
      }

      const target = declaredBy.get(imported);
      if (target && target !== r.file) {
        edges.push(edge(target, r.file, `imports ${imported}`));
      } else if (!target && imported.startsWith('java')) {
        // The standard library is not a dependency worth tracking.
      } else if (!target) {
        const list = unresolved.get(r.file) ?? [];
        list.push(imported);
        unresolved.set(r.file, list);
      }
    }

    // ---- same package: a dependency nobody wrote down ------------------
    for (const sibling of byPackage.get(r.packageName) ?? []) {
      if (sibling.file === r.file) continue;
      // Only claim the edge when this file actually mentions a type the
      // sibling declares. Coupling every pair in a package would be true but
      // useless; a package of forty classes would become forty-times-forty.
      const mentions = sibling.declares.some(
        (type) => r.injected.includes(type) || r.exports.includes(type) || r.methods.includes(type),
      );
      if (mentions) {
        edges.push(
          edge(
            sibling.file,
            r.file,
            `same package (${r.packageName || 'default'}) — used without an import`,
            'name',
          ),
        );
      }
    }

    // ---- the test that names the class it tests -------------------------
    // `OrderServiceTest` tests `OrderService`. This is not a guess about
    // Java, it is how the ecosystem declares the link: Maven Surefire's
    // default include is literally `**/*Test.java`, and Gradle's is the same.
    // A test whose body is empty still declares its subject in its name, and
    // ignoring that throws away the one coverage signal every Java shop has.
    for (const suffix of ['Test', 'Tests', 'IT', 'ITCase', 'TestCase']) {
      for (const declared of r.declares) {
        if (!declared.endsWith(suffix) || declared === suffix) continue;
        const subject = declared.slice(0, -suffix.length);
        const target = declaredBy.get(r.packageName ? `${r.packageName}.${subject}` : subject);
        if (target && target !== r.file) {
          edges.push(
            edge(
              target,
              r.file,
              `${declared} names ${subject} as its subject — the convention Surefire and Gradle select tests by`,
              'name',
            ),
          );
        }
      }
    }

    // ---- shared database tables ----------------------------------------
    if (r.entityTables.length > 0) {
      for (const other of readings) {
        if (other.file === r.file || other.entityTables.length === 0) continue;
        const shared = r.entityTables.filter((t) => other.entityTables.includes(t));
        if (shared.length === 0) continue;
        // A writer is anything transactional; a reader is everything else.
        if (r.transactional && !other.transactional) {
          edges.push(
            edge(
              r.file,
              other.file,
              `writes ${shared.join(', ')} inside a transaction, which ${other.file.split('/').pop()} also maps`,
              'data-coupling',
            ),
          );
        }
      }
    }
  }

  return {
    edges: edges.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.why.detail.localeCompare(b.why.detail),
    ),
    declaredBy,
    unresolved,
  };
}

/**
 * Imports that left the repository, grouped so they can be reported once
 * rather than per file. An unresolved import is usually a third-party
 * dependency, but it can also be a module Teslon was not pointed at — and
 * those two look identical from inside one repository.
 */
export function unresolvedSummary(graph: JavaGraph): { readonly prefix: string; readonly count: number }[] {
  const byPrefix = new Map<string, number>();
  for (const imports of graph.unresolved.values()) {
    for (const i of imports) {
      const prefix = i.split('.').slice(0, 2).join('.');
      byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
    }
  }
  return [...byPrefix]
    .map(([prefix, count]) => ({ prefix, count }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}
