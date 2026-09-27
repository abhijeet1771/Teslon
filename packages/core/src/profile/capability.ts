import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilityProfile } from '../schema/index.js';
import type { Edge } from '../graph/imports.js';

/**
 * What a piece of code does, extracted rather than guessed.
 *
 * No model is involved. Everything here comes from something the code
 * *declares*: a decorator, a type, a SQL string, a guard, a throw. That makes
 * it deterministic — same file, same profile, always — and it makes the
 * failure mode explicit: when a convention is not recognised, the field is
 * absent and `nature` falls back to `unknown`.
 *
 * `unknown` is treated as `mutating` everywhere downstream. Assuming a piece
 * of code has no side effects because we failed to parse it is the single
 * most dangerous mistake this module could make.
 */

const HTTP_DECORATOR_RE = /@(Get|Post|Put|Delete|Patch|All)\(\s*['"`]([^'"`]+)['"`]/i;
/** express/fastify/koa style: app.get('/path', handler) */
const HTTP_CALL_RE = /\b(?:app|router|server)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i;

const WRITE_SQL_RE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|CREATE\s+TABLE)\b/i;
/**
 * A string only counts as SQL when a verb is followed by the clause that names
 * a table. Matching a bare keyword meant the UI copy "Delete your account"
 * was read as a statement, which set `nature` to `read-only` on a file we had
 * in fact learnt nothing about — the exact assumption of innocence this
 * module exists to avoid.
 */
const ANY_SQL_RE =
  /\b(?:SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+["'`]?\w+["'`]?\s+SET|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE|TRUNCATE\s+(?:TABLE\s+)?\w)/i;
const TABLE_RE = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+["'`]?([a-z_][\w]*)["'`]?/gi;

const SIDE_EFFECTS: readonly (readonly [RegExp, string])[] = [
  [/\bsend(?:Mail|Email)\s*\(/i, 'sends email'],
  [/\bemit\s*\(\s*['"`]([^'"`]+)/, 'emits event'],
  [/\bpublish\s*\(\s*['"`]([^'"`]+)/, 'publishes message'],
  [/\benqueue\s*\(|\.\s*add\s*\(\s*['"`]/i, 'enqueues a job'],
  [/\bcharge\s*\(|payments?\.|stripe\.|\/refund\b/i, 'touches payments'],
  [/\bwriteFile|\bunlink|\bmkdir/i, 'writes to disk'],
];

function interfaceFields(src: string, typeName: string): string[] {
  const m = new RegExp(`(?:interface|type)\\s+${typeName}\\s*=?\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) return [];
  return m[1]!
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('//'));
}

function sqlLiterals(src: string): string[] {
  const out: string[] = [];
  for (const re of [/`([^`]*)`/g, /'([^'\n]*)'/g, /"([^"\n]*)"/g]) {
    for (const m of src.matchAll(re)) {
      const body = m[1]!;
      if (ANY_SQL_RE.test(body)) out.push(body);
    }
  }
  return out;
}

export function profileFile(root: string, file: string): CapabilityProfile | null {
  let src: string;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }

  const symbol =
    /export\s+(?:async\s+)?function\s+(\w+)/.exec(src)?.[1] ??
    /export\s+(?:default\s+)?class\s+(\w+)/.exec(src)?.[1];

  const dec = HTTP_DECORATOR_RE.exec(src);
  const call = HTTP_CALL_RE.exec(src);
  const http = dec
    ? { method: dec[1]!.toUpperCase(), path: dec[2]! }
    : call
      ? { method: call[1]!.toUpperCase(), path: call[2]! }
      : undefined;

  const inTypeName = /function\s+\w+\s*\(\s*\w+\s*:\s*(\w+)/.exec(src)?.[1];
  const outTypeName = /\)\s*:\s*Promise<\s*(\w+)\s*>/.exec(src)?.[1];

  const reads = new Set<string>();
  const writes = new Set<string>();
  let sawSql = false;

  for (const sql of sqlLiterals(src)) {
    sawSql = true;
    const target = WRITE_SQL_RE.test(sql) ? writes : reads;
    for (const m of sql.matchAll(TABLE_RE)) target.add(m[1]!.toLowerCase());
  }

  const callsOut = [...new Set([...src.matchAll(/\bfetch\s*\(\s*['"`](https?:\/\/[^'"`/]+)/g)].map((m) => m[1]!))];

  const sideEffects: string[] = [];
  for (const [re, label] of SIDE_EFFECTS) {
    const m = re.exec(src);
    if (!m) continue;
    sideEffects.push(m[1] ? `${label} ${m[1]}` : label);
  }

  // `a ?? b ? c : d` parses as `(a ?? b) ? c : d`, which threw the real guard
  // name away and reported 'requireAuth' for every guarded handler.
  const declaredGuard = /@UseGuards\(\s*(\w+)/.exec(src)?.[1];
  const auth = declaredGuard ?? (/\brequireAuth\b/.test(src) ? 'requireAuth' : undefined);

  const flags = [...new Set([...src.matchAll(/\b(?:isOn|isEnabled|flag|getFlag)\s*\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]!))];

  const errorPaths = [...src.matchAll(/throw new (\w+)\s*\(\s*['"`]([^'"`]*)/g)].map(
    (m) => `${m[1]}: ${m[2]}`,
  );

  // We only claim read-only when we actually understood the data access.
  // No recognised SQL and no recognised effects means we learnt nothing, and
  // the honest answer is `unknown`, not `read-only`.
  const nature: CapabilityProfile['nature'] =
    writes.size > 0 || sideEffects.length > 0
      ? 'mutating'
      : sawSql || callsOut.length > 0
        ? 'read-only'
        : // An endpoint we could not read the data access of is not read-only,
          // it is unexamined. Downstream treats unknown as mutating.
          'unknown';

  const profile: CapabilityProfile = {
    file,
    ...(symbol ? { symbol } : {}),
    ...(http ? { http } : {}),
    ...(inTypeName ? { input: { type: inTypeName, fields: interfaceFields(src, inTypeName) } } : {}),
    ...(outTypeName ? { output: { type: outTypeName, fields: interfaceFields(src, outTypeName) } } : {}),
    readsTables: [...reads].sort(),
    writesTables: [...writes].sort(),
    callsOut: callsOut.sort(),
    sideEffects,
    ...(auth ? { auth } : {}),
    flags: flags.sort(),
    errorPaths,
    nature,
  };

  return profile;
}

/**
 * Coupling through the database.
 *
 * One endpoint writes a table another endpoint reads. There is no import
 * between them and there never will be, so no import graph can find this —
 * verified in the lab on two handlers that share only the `orders` table.
 */
export function dataCouplingEdges(profiles: readonly CapabilityProfile[]): Edge[] {
  const edges: Edge[] = [];

  for (const writer of profiles) {
    if (writer.writesTables.length === 0) continue;
    for (const reader of profiles) {
      if (reader.file === writer.file) continue;
      const shared = writer.writesTables.filter((t) => reader.readsTables.includes(t));
      if (shared.length === 0) continue;

      edges.push({
        from: writer.file,
        to: reader.file,
        why: {
          signal: 'data-coupling',
          detail: `writes ${shared.join(', ')}, which ${reader.http ? `${reader.http.method} ${reader.http.path}` : reader.file} reads`,
          via: writer.file,
        },
      });
    }
  }

  // Deterministic order regardless of input ordering.
  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * How many distinct cases a tester should expect, from the branches the code
 * declares. Not a substitute for judgement — a floor, so "I tested it" can be
 * checked against something.
 */
export function minimumCases(p: CapabilityProfile): number {
  const errorCases = p.errorPaths.length + 1; // the happy path plus each throw
  const flagCases = p.flags.length > 0 ? 2 ** Math.min(p.flags.length, 3) : 1;
  return errorCases * flagCases;
}
