import type { Hop } from './model.js';
import type { SpringFacts, Endpoint, Listener, Channel } from './spring.js';
import { sameCodeLines, sameTokens, type JType, type JMethod, type JavaFile } from './java.js';
import { browserCalls, screenTitle, type WhereCtx } from './where.js';
import { callMadeBy, routeQuote } from './vue.js';
import { fileKind } from './kinds.js';

/**
 * What changed code hands on without being called: the rows it writes and the
 * events it publishes. Following callers finds who runs a change; it does not
 * find who later reads what the change stored, or who listens for what it
 * announced. Those are the screens and jobs a "safe to skip" would get wrong.
 *
 * - **Events.** A changed or removed `publishEvent(new X(…))`, or a changed
 *   event class X: every listener that takes X runs differently, or not at
 *   all. Those listeners are listed to test.
 * - **Data.** A changed line that writes an entity field (`order.setTotal(…)`),
 *   saves or deletes rows, or computes a value its caller writes straight into
 *   a field: every screen and job that reads that entity shows what the
 *   change stored. They are never skipped; the report holds them as unclear,
 *   with the write that reaches them.
 *
 * Both sides of the diff are read, so a removed write or a removed publish
 * counts as much as a new one.
 */

export interface Written {
  readonly entity: string;
  /** The field written, or '*' for whole rows (save, delete, the entity's own code). */
  readonly field: string;
  readonly hop: Hop;
}

const fileName = (p: string): string => p.split('/').pop() ?? p;
const simple = (n: string): string => n.replace(/<.*$/, '').split('.').pop()!;
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function locate(types: readonly JType[], line: number): { type: JType; method: JMethod | null } | null {
  let best: JType | null = null;
  for (const t of types) if (t.line <= line && line <= t.endLine && (!best || t.line >= best.line)) best = t;
  if (!best) return null;
  return { type: best, method: best.methods.find((m) => m.line <= line && line <= m.endLine) ?? null };
}

/** Repository interface → the entity it stores: `interface OrderRepository extends JpaRepository<Order, Long>`. */
function repositories(f: SpringFacts): Map<string, string> {
  const out = new Map<string, string>();
  const names = new Set(f.entities.map((e) => e.name));
  for (const jf of f.javaFiles.values()) for (const t of jf.types) {
    if (t.kind !== 'interface') continue;
    for (const s of t.supertypes) {
      const m = /Repository\s*<\s*([\w.]+)\s*,/.exec(s);
      if (m && names.has(simple(m[1]!))) out.set(simple(t.name), simple(m[1]!));
    }
  }
  return out;
}

/** Tables named by SQL in a method's string literals, with the line of each literal. */
function sqlTables(m: JMethod, re: RegExp): { table: string; line: number }[] {
  const out: { table: string; line: number }[] = [];
  for (const tok of m.body) {
    if (!/^("|`)/.test(tok.t)) continue;
    for (const x of tok.t.matchAll(re)) out.push({ table: x[2]!, line: tok.line });
  }
  return out;
}

export interface DataFlow {
  readonly written: readonly Written[];
  /** Does this endpoint's code (or what it calls) read or write the entity? */
  readsEntity(e: Endpoint, entity: string): boolean;
  /** Does this method (or what it calls) read or write the entity? */
  usesEntity(at: string, entity: string): boolean;
}

export function followWritesAndEvents(ctx: WhereCtx): DataFlow {
  const { fh, fb, H, B } = ctx;
  const written: Written[] = [];
  const events: { type: string; hop: Hop; removed: boolean }[] = [];
  const seen = new Set<string>();
  const add = (w: Written): void => { const k = `${w.entity}.${w.field}@${w.hop.file}:${w.hop.line}:${w.hop.side ?? ''}`; if (!seen.has(k)) { seen.add(k); written.push(w); } };

  // ---- what a method writes, itself or through what it calls (an interface's implementations too)
  const indexes = new Map<SpringFacts, { types: Map<string, { t: JType; file: string }>; repos: Map<string, string>; byField: Map<string, string[]>; entities: Set<string> }>();
  const indexOf = (f: SpringFacts) => {
    let x = indexes.get(f);
    if (!x) {
      const types = new Map<string, { t: JType; file: string }>();
      for (const [file, jf] of f.javaFiles) for (const t of jf.types) if (!types.has(simple(t.name))) types.set(simple(t.name), { t, file });
      const byField = new Map<string, string[]>();
      for (const e of f.entities) for (const c of e.columns) byField.set(c.field, [...(byField.get(c.field) ?? []), e.name]);
      x = { types, repos: repositories(f), byField, entities: new Set(f.entities.map((e) => e.name)) };
      indexes.set(f, x);
    }
    return x;
  };
  /** The entities `recv.setX(…)` can write in method m: by the receiver's declared type, else those the method touches. */
  const setterEntities = (f: SpringFacts, t: JType, m: JMethod, recv: string, field: string): string[] => {
    const ix = indexOf(f);
    const typeOf = new Map<string, string>([...t.fields.map((x) => [x.name, simple(x.type)] as [string, string]), ...m.params.map((x) => [x.name, simple(x.type)] as [string, string])]);
    for (let i = 0; i + 2 < m.body.length; i++) if (/^[A-Z]\w*$/.test(m.body[i]!.t) && /^[a-z]\w*$/.test(m.body[i + 1]!.t) && /^[=;:]$/.test(m.body[i + 2]!.t)) typeOf.set(m.body[i + 1]!.t, m.body[i]!.t);
    const vt = typeOf.get(recv);
    const cands = ix.byField.get(field) ?? [];
    if (vt) return ix.entities.has(vt) && cands.includes(vt) ? [vt] : [];
    // a lambda parameter or an untyped name: the entities this method names or reaches through its repositories
    const words = new Set(m.body.map((x) => x.t));
    const touched = cands.filter((e) => words.has(e) || [...words].some((w) => ix.repos.get(typeOf.get(w) ?? '') === e));
    return touched.length ? touched : cands;
  };
  const inactive = (f: SpringFacts, cls: string): { key: string; want: string; set: string } | null => {
    const ty = indexOf(f).types.get(cls);
    const a = ty?.t.annotations.find((x) => x.name === 'ConditionalOnProperty');
    if (!a || !ty) return null;
    const toks = a.args.map((x) => x.t).join(' ');
    const key = /(?:name|value)\s*=\s*"([^"]+)"/.exec(toks)?.[1] ?? /^\s*"([^"]+)"/.exec(toks)?.[1];
    const want = /havingValue\s*=\s*"([^"]*)"/.exec(toks)?.[1];
    const set = key ? f.settings.get(f.moduleOf(ty.file))?.get(key) : undefined;
    return key && want !== undefined && set !== undefined && set !== want ? { key, want, set } : null;
  };
  /** Methods a call to `at` can land in: itself, and the implementations when it is an interface's. */
  const landsIn = (f: SpringFacts, at: string): string[] => {
    const [c, m] = at.split('.') as [string, string];
    return [at, ...[...f.supertypes].filter(([impl, sups]) => sups.includes(c) && !inactive(f, impl)).map(([impl]) => `${impl}.${m}`)];
  };
  function writesFrom(f: SpringFacts, at: string, origin: string, depth = 0, seenAt = new Set<string>()): Written[] {
    if (seenAt.has(at) || depth > 5) return [];
    seenAt.add(at);
    const ix = indexOf(f);
    const [cls, method] = at.split('.') as [string, string];
    const out: Written[] = [];
    const ty = ix.types.get(cls);
    const side = f === fb ? { side: 'base' as const } : {};
    if (ty) for (const m of ty.t.methods.filter((x) => x.name === method)) {
      const typeOf = new Map<string, string>([...ty.t.fields.map((x) => [x.name, simple(x.type)] as [string, string]), ...m.params.map((x) => [x.name, simple(x.type)] as [string, string])]);
      for (let i = 0; i + 2 < m.body.length; i++) if (/^[A-Z]\w*$/.test(m.body[i]!.t) && /^[a-z]\w*$/.test(m.body[i + 1]!.t) && /^[=;:]$/.test(m.body[i + 2]!.t)) typeOf.set(m.body[i + 1]!.t, m.body[i]!.t);
      for (let i = 0; i + 3 < m.body.length; i++) {
        const a = m.body[i]!, name = m.body[i + 2]!;
        if (m.body[i + 1]!.t !== '.' || m.body[i + 3]!.t !== '(') continue;
        if (/^set[A-Z]/.test(name.t)) {
          const field = lowerFirst(name.t.slice(3));
          const ents = setterEntities(f, ty.t, m, a.t, field);
          for (const entity of ents) out.push({ entity, field, hop: { label: 'Writes', file: ty.file, line: name.line, quote: name.t, rule: `${cls}.${method}() writes ${entity}.${field}, and runs from ${origin}`, ...side } });
        }
        if (/^(save|saveAll|saveAndFlush|delete|deleteById|deleteAll|deleteAllById)$/.test(name.t)) {
          const entity = ix.repos.get(typeOf.get(a.t) ?? '');
          if (entity) out.push({ entity, field: '*', hop: { label: 'Writes', file: ty.file, line: name.line, quote: name.t, rule: `${cls}.${method}() ${name.t.startsWith('delete') ? 'deletes' : 'saves'} ${entity} rows, and runs from ${origin}`, ...side } });
        }
      }
    }
    for (const e of f.callEdges.filter((x) => x.from === at)) for (const to of landsIn(f, e.to)) out.push(...writesFrom(f, to, origin, depth + 1, seenAt));
    return out;
  }
  /** Callers that write what `target` returns: order.setTotal(x.m()), repo.save(x.m()), or `T v = x.m(); … v` written later. */
  function resultWrites(f: SpringFacts, target: string, why: string): Written[] {
    const out: Written[] = [];
    const S = f === fb ? B : H;
    const ix = indexOf(f);
    const [tc, tm] = target.split('.') as [string, string];
    const called = new Set([target, ...(f.supertypes.get(tc) ?? []).map((x) => `${x}.${tm}`)]);
    for (const e of f.callEdges.filter((x) => called.has(x.to))) {
      const ct = [e.line - 2, e.line - 1, e.line].map((k) => (k > 0 ? S.line(e.file, k) ?? '' : '')).join(' ');
      const stmt = ct.slice(Math.max(0, ct.lastIndexOf(';', ct.lastIndexOf(tm)) + 1));
      const lineWith = (w: string): number => [e.line, e.line - 1, e.line - 2].find((k) => k > 0 && (S.line(e.file, k) ?? '').includes(w)) ?? e.line;
      const sm = new RegExp(`(\\w+)\\s*\\.\\s*set([A-Z]\\w*)\\s*\\([^;]*\\b${tm}\\s*\\(`).exec(stmt);
      if (sm) for (const entity of ix.byField.get(lowerFirst(sm[2]!)) ?? []) out.push({ entity, field: lowerFirst(sm[2]!), hop: { label: 'Its result is written', file: e.file, line: lineWith(`set${sm[2]}`), quote: `set${sm[2]}`, rule: `${e.from}() writes what ${target}() returns into ${entity}.${lowerFirst(sm[2]!)}${why}` } });
      const sv = new RegExp(`(\\w+)\\s*\\.\\s*(save|saveAndFlush|saveAll)\\s*\\([^;]*\\b${tm}\\s*\\(`).exec(stmt);
      const [fc, fm] = e.from.split('.') as [string, string];
      const host = ix.types.get(fc);
      const meth = host?.t.methods.find((x) => x.name === fm && x.line <= e.line && e.line <= x.endLine);
      const repoOf = (v: string): string | undefined => ix.repos.get(simple(host?.t.fields.find((x) => x.name === v)?.type ?? ''));
      if (sv && repoOf(sv[1]!)) out.push({ entity: repoOf(sv[1]!)!, field: '*', hop: { label: 'Its result is saved', file: e.file, line: lineWith(sv[2]!), quote: sv[2]!, rule: `${e.from}() saves what ${target}() returns as ${repoOf(sv[1]!)} rows${why}` } });
      // handed straight to another call that writes: mailer.send(…, directory.forOrder(id))
      for (const other of f.callEdges.filter((x) => x.from === e.from && x.line === e.line && x.to !== e.to && !called.has(x.to) && new RegExp(`\\b${x.to.split('.')[1]}\\s*\\([^;]*\\b${tm}\\s*\\(`).test(stmt))) {
        for (const to of landsIn(f, other.to)) for (const w of writesFrom(f, to, `${e.from}()`)) out.push({ entity: w.entity, field: w.field, hop: { label: 'Its result is passed on', file: e.file, line: e.line, quote: tm, rule: `${e.from}() passes what ${target}() returns to ${other.to}(), which writes ${w.entity}${w.field === '*' ? '' : `.${w.field}`}${why}` } });
      }
      // T v = x.m(…); then v written or saved further down the same method
      const av = new RegExp(`(\\w+)\\s*=\\s*[^;=]*\\b${tm}\\s*\\(`).exec(stmt)?.[1];
      if (av && meth) {
        const body = meth.body;
        for (let i = 0; i + 3 < body.length; i++) {
          if (body[i]!.line <= e.line || body[i + 1]!.t !== '.' || body[i + 3]!.t !== '(') continue;
          const nm = body[i + 2]!.t;
          let depth = 0, usesIt = false;
          for (let j = i + 3; j < body.length; j++) { const tok = body[j]!.t; if (tok === '(') depth++; else if (tok === ')') { depth--; if (!depth) break; } else if (tok === av) usesIt = true; }
          if (!usesIt && body[i]!.t !== av) continue;
          if (/^set[A-Z]/.test(nm) && body[i]!.t !== av) for (const entity of ix.byField.get(lowerFirst(nm.slice(3))) ?? []) out.push({ entity, field: lowerFirst(nm.slice(3)), hop: { label: 'Its result is written', file: e.file, line: body[i + 2]!.line, quote: nm, rule: `${e.from}() writes ${av}, which ${target}() returned, into ${entity}.${lowerFirst(nm.slice(3))}${why}` } });
          if (/^(save|saveAndFlush|saveAll)$/.test(nm) && repoOf(body[i]!.t)) out.push({ entity: repoOf(body[i]!.t)!, field: '*', hop: { label: 'Its result is saved', file: e.file, line: body[i + 2]!.line, quote: nm, rule: `${e.from}() saves ${av}, which ${target}() returned${why}` } });
        }
      }
    }
    return out;
  }

  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java' || /(^|\/)src\/test\//.test(cf.path)) continue;
    // the same Java token for token writes what it wrote before
    if (cf.status === 'modified' && /\.java$/.test(cf.path) && sameTokens(B.read(cf.path) ?? '', H.read(cf.path) ?? '')) continue;
    const sides: { side: 'head' | 'base'; f: SpringFacts; jf: JavaFile | undefined; lines: number[]; text: (n: number) => string }[] = [
      { side: 'head', f: fh, jf: fh.javaFiles.get(cf.path), lines: cf.hunks.flatMap((h) => h.head), text: (n) => H.line(cf.path, n) ?? '' },
      { side: 'base', f: fb, jf: fb.javaFiles.get(cf.path), lines: cf.hunks.flatMap((h) => h.base), text: (n) => B.line(cf.path, n) ?? '' },
    ];
    for (const { side, f, jf, lines, text } of sides) {
      if (!jf) continue;
      const file = cf.path;
      const repos = repositories(f);
      const byField = new Map<string, string[]>();
      for (const e of f.entities) for (const c of e.columns) byField.set(c.field, [...(byField.get(c.field) ?? []), e.name]);
      const sideOf = side === 'base' ? { side: 'base' as const } : {};
      const entityFile = f.entities.find((e) => e.file === file);
      for (const n of lines) {
        const t = text(n);
        const code = t.trim();
        if (!code || /^(\/\/|\*|\/\*|import\s|package\s)/.test(code)) continue;
        // the entity's own code: what it computes, initialises or does on save. Annotations are typed elsewhere
        if (entityFile && !/^@/.test(code) && code !== '}' && code !== '{') {
          const at = locate(jf.types, n);
          // a line typed elsewhere as a JSON-only getter (read by Jackson, never by JPA) writes nothing
          const jsonOnly = side !== 'base' && !!at?.method && ctx.explained(file, n) && /^(get|is)[A-Z]/.test(at.method.name) && !at.method.params.length;
          if (at && !jsonOnly && simple(at.type.name) === entityFile.name) add({ entity: entityFile.name, field: '*', hop: { label: side === 'base' ? 'Entity code removed' : 'Entity code', file, line: n, quote: code.slice(0, 24), rule: `${entityFile.name} itself changed`, ...sideOf } });
        }
        for (const m of t.matchAll(/(\w+)\s*\.\s*set([A-Z]\w*)\s*\(/g)) {
          const field = lowerFirst(m[2]!);
          const here0 = locate(jf.types, n);
          for (const entity of here0?.method ? setterEntities(f, here0.type, here0.method, m[1]!, field) : byField.get(field) ?? []) add({ entity, field, hop: { label: side === 'base' ? 'Write removed' : 'Writes', file, line: n, quote: `set${m[2]}`, rule: `${m[1]}.set${m[2]}(…) writes ${entity}.${field}`, ...sideOf } });
        }
        const at = locate(jf.types, n);
        for (const m of t.matchAll(/(\w+)\s*\.\s*(save|saveAll|saveAndFlush|delete|deleteById|deleteAll|deleteAllById)\s*\(/g)) {
          const fieldType = at?.type.fields.find((x) => x.name === m[1])?.type;
          const entity = fieldType ? repos.get(simple(fieldType)) : undefined;
          if (entity) add({ entity, field: '*', hop: { label: side === 'base' ? 'Write removed' : 'Writes', file, line: n, quote: m[2]!, rule: `${m[1]}.${m[2]}(…) ${m[2]!.startsWith('delete') ? 'deletes' : 'saves'} ${entity} rows`, ...sideOf } });
        }
        for (const m of t.matchAll(/publishEvent\s*\(\s*(?:new\s+)?([A-Z]\w*)/g)) {
          events.push({ type: m[1]!, removed: side === 'base', hop: { label: side === 'base' ? 'Publish removed' : 'Publishes', file, line: n, quote: 'publishEvent', rule: `publishes ${m[1]}`, ...sideOf } });
        }
        // plain SQL in the method: update orders …, insert into orders …, delete from orders …
        if (at?.method) {
          const sqlWrites = sqlTables(at.method, /\b(update|insert\s+into|delete\s+from|merge\s+into)\s+["`]?(\w+)/gi);
          for (const { table, line } of sqlWrites) {
            const entity = f.entities.find((e) => e.table.toLowerCase() === table.toLowerCase())?.name;
            if (entity) add({ entity, field: '*', hop: { label: side === 'base' ? 'SQL write removed' : 'SQL writes', file, line, quote: table, rule: `${simple(at.type.name)}.${at.method.name}() writes ${table} with SQL`, ...sideOf } });
          }
        }
        // a line that changed before a write in the same method decides it (a condition, a loop, a return) or feeds it
        // (a value, a builder step): on either side, so a removed guard counts as much as a new one
        if (at?.method && !/^@/.test(code) && !/^(log|logger|LOG|LOGGER|System\.(out|err))\s*\./.test(code)) {
          const body = at.method.body;
          const ctl = /^(if|else|for|while|switch|case|return|try|catch|do|break|continue|throw)\b|^\}\s*(else|catch)\b/.test(code);
          const repoFieldsHere = new Map(at.type.fields.filter((x) => repos.has(simple(x.type))).map((x) => [x.name, repos.get(simple(x.type))!]));
          for (let i = 0; i + 3 < body.length; i++) {
            if (body[i]!.line < n || body[i + 1]!.t !== '.' || body[i + 3]!.t !== '(') continue;
            const name = body[i + 2]!.t;
            const decides: Hop = { label: ctl ? 'Decides a write' : 'Comes before a write', file, line: n, quote: code.slice(0, 24), rule: ctl ? `this line decides whether ${body[i]!.t}.${name}(…) on line ${body[i + 2]!.line} runs` : `this line comes before ${body[i]!.t}.${name}(…) on line ${body[i + 2]!.line}, in the same method, and can change what it writes`, ...sideOf };
            if (/^set[A-Z]/.test(name)) { const field = lowerFirst(name.slice(3)); for (const entity of setterEntities(f, at.type, at.method, body[i]!.t, field)) add({ entity, field, hop: decides }); }
            else if (/^(save|saveAll|saveAndFlush|delete|deleteById|deleteAll)$/.test(name) && repoFieldsHere.has(body[i]!.t)) add({ entity: repoFieldsHere.get(body[i]!.t)!, field: '*', hop: decides });
          }
        }
        // a changed line that calls code which writes, or decides whether that code runs: what it writes changes
        if (at?.method) {
          const here = `${simple(at.type.name)}.${at.method.name}`;
          const decides = /^(if|else|for|while|switch|case|return|try|catch|do)\b|^\}\s*(else|catch)\b/.test(code);
          for (const e of f.callEdges.filter((x) => x.from === here && (x.line === n || (decides && x.line > n && x.line <= at.method!.endLine)))) {
            for (const to of landsIn(f, e.to)) for (const w of writesFrom(f, to, `${here}()`)) {
              add({ entity: w.entity, field: w.field, hop: { label: e.line === n ? 'Calls what writes' : 'Decides a write', file, line: n, quote: e.line === n ? e.to.split('.')[1]! : code.slice(0, 24), rule: `${e.line === n ? `this line calls ${e.to}()` : `this line decides whether ${e.to}() runs (line ${e.line})`}, which writes ${w.entity}${w.field === '*' ? '' : `.${w.field}`} (${fileName(w.hop.file)}:${w.hop.line})`, ...sideOf } });
            }
          }
        }
        // a value computed here and written by the caller: order.setTotal(pricing.orderTotal(…))
        if (side === 'head' && at?.method) {
          const target = `${simple(at.type.name)}.${at.method.name}`;
          // callers reach an implementation through its interface: tax.apply(…) calls StandardTax.apply
          const called = new Set([target, ...(f.supertypes.get(simple(at.type.name)) ?? []).map((x) => `${x}.${at.method!.name}`)]);
          for (const e of f.callEdges.filter((x) => called.has(x.to))) {
            // the statement can start a line or two above the call: order.setTotal(pricing\n  .orderTotal(…))
            const ct = [e.line - 2, e.line - 1, e.line].map((k) => (k > 0 ? H.line(e.file, k) ?? '' : '')).join(' ');
            const sm = new RegExp(`(\\w+)\\s*\\.\\s*set([A-Z]\\w*)\\s*\\([^;]*\\b${at.method.name}\\s*\\(`).exec(ct.slice(Math.max(0, ct.lastIndexOf(';', ct.lastIndexOf(at.method.name)) + 1)));
            if (!sm) continue;
            const field = lowerFirst(sm[2]!);
            // cite the line the setter is on, so the quote re-checks
            const setLine = [e.line, e.line - 1, e.line - 2].find((k) => k > 0 && (H.line(e.file, k) ?? '').includes(`set${sm[2]}`)) ?? e.line;
            for (const entity of byField.get(field) ?? []) add({ entity, field, hop: { label: 'Its result is written', file: e.file, line: setLine, quote: `set${sm[2]}`, rule: `${e.from}() writes what ${target}() returns into ${entity}.${field}` } });
          }
          // within the method: a value set on this line and later written into a field
          const assigned = /^(?:final\s+)?(?:[\w<>,.?\s[\]]+\s+)?(\w+)\s*=[^=]/.exec(code)?.[1];
          if (assigned) {
            const body = at.method.body;
            for (let i = 0; i + 3 < body.length; i++) {
              if (body[i]!.line <= n || body[i + 1]!.t !== '.' || !/^set[A-Z]/.test(body[i + 2]!.t) || body[i + 3]!.t !== '(') continue;
              let depth = 0, uses = false;
              for (let j = i + 3; j < body.length; j++) { const tok = body[j]!.t; if (tok === '(') depth++; else if (tok === ')') { depth--; if (!depth) break; } else if (tok === assigned) uses = true; }
              if (!uses) continue;
              const field = lowerFirst(body[i + 2]!.t.slice(3));
              for (const entity of byField.get(field) ?? []) add({ entity, field, hop: { label: 'Then written', file, line: body[i]!.line, quote: body[i + 2]!.t, rule: `${assigned}, set on line ${n}, is written into ${entity}.${field}` } });
            }
          }
        }
      }
      // a changed event class: whoever takes it
      for (const t of jf.types) {
        if (!lines.some((n) => t.line <= n && n <= t.endLine && (text(n).trim() && !/^(\/\/|\*|\/\*|import\s|package\s)/.test(text(n).trim())))) continue;
        if (f.listeners.some((l) => l.takes.includes(simple(t.name)) && l.kind.includes('EventListener'))) events.push({ type: simple(t.name), removed: false, hop: { label: 'Event changed', file, line: t.line, quote: simple(t.name), rule: `${simple(t.name)} changed`, ...sideOf } });
      }
    }
  }

  // methods that behave differently because of a setting: what they write, and what callers write of their result
  for (const a of ctx.affected ?? []) {
    for (const to of landsIn(fh, a.at)) for (const w of writesFrom(fh, to, `${a.at}()`)) add({ ...w, hop: { ...w.hop, rule: `${w.hop.rule}; ${a.at}() reads the changed setting` } });
    for (const w of resultWrites(fh, a.at, `; ${a.at}() reads the changed setting`)) add(w);
  }
  // a changed method whose whole result is saved by its caller (a builder, a factory): repo.save(factory.from(…))
  for (const cf of ctx.changes) {
    const jf = fh.javaFiles.get(cf.path);
    if (!jf || fileKind(cf.path) !== 'java') continue;
    const done = new Set<string>();
    for (const n of cf.headLines) {
      const code = (H.line(cf.path, n) ?? '').trim();
      if (!code || /^(\/\/|\*|\/\*|import\s|package\s|@)/.test(code) || code === '}' || code === '{') continue;
      const at = locate(jf.types, n);
      if (!at?.method) continue;
      const target = `${simple(at.type.name)}.${at.method.name}`;
      if (done.has(target)) continue;
      done.add(target);
      const off = inactive(fh, simple(at.type.name));
      if (off) {
        ctx.unseen.push({ what: `environments where ${off.key}=${off.want}`, why: `${simple(at.type.name)} runs only when ${off.key}=${off.want}, and ${fh.serviceOf(cf.path) ?? 'the service'}'s settings here say ${off.key}=${off.set}: with these settings the change runs nowhere`, resolve: `test it where ${off.key}=${off.want} (a test or local environment), or confirm no environment uses it` });
        continue;
      }
      for (const w of resultWrites(fh, target, '')) if (w.hop.label !== 'Its result is written' || w.hop.rule.includes(' returned')) add(w);
    }
  }

  // ---- MapStruct: a changed @Mapping is a field whose value changes; into a @MappingTarget entity it is a write
  for (const cf of ctx.changes) {
    for (const [side, f, S, ns] of [['head', fh, H, cf.headLines], ['base', fb, B, cf.baseLines]] as const) {
      const jf = f.javaFiles.get(cf.path);
      if (!jf) continue;
      for (const t of jf.types.filter((x) => x.annotations.some((a) => a.name === 'Mapper'))) {
        for (const n of ns.filter((k) => k >= t.line && k <= t.endLine)) {
          const text = S.line(cf.path, n) ?? '';
          const tm0 = /@Mapping\s*\(([^]*)/.exec(text);
          if (!tm0) continue;
          const target = /target\s*=\s*"([\w.]+)"/.exec(text)?.[1];
          if (!target) continue;
          const m = t.methods.filter((x) => x.line >= n).sort((a, b) => a.line - b.line)[0];
          if (!m) continue;
          const what = /ignore\s*=\s*true/.test(text) ? (side === 'head' ? 'is no longer filled (ignore = true)' : 'is filled again (ignore removed)')
            : /expression\s*=/.test(text) ? (side === 'head' ? `is now computed as ${/expression\s*=\s*"([^"]*)"/.exec(text)?.[1] ?? 'an expression'}` : `was computed as ${/expression\s*=\s*"([^"]*)"/.exec(text)?.[1] ?? 'an expression'}, and no longer is`)
            : /source\s*=\s*"([\w.]+)"/.test(text) ? (side === 'head' ? `now comes from ${/source\s*=\s*"([\w.]+)"/.exec(text)![1]}` : `no longer comes from ${/source\s*=\s*"([\w.]+)"/.exec(text)![1]}: MapStruct now fills it by name, or leaves it empty`) : 'changed';
          const hop: Hop = { label: 'Mapping changed', file: cf.path, line: n, quote: 'Mapping', rule: `${simple(t.name)}.${m.name}(): ${target} ${what}`, ...(side === 'base' ? { side: 'base' as const } : {}) };
          const id = `mapper:${simple(t.name)}.${m.name}:${target}`;
          if (!ctx.deltas.some((d) => d.id === id)) ctx.deltas.push({ id, kind: 'code-changed', title: `${simple(t.name)}.${m.name}(): ${target} ${what}`, endpoint: '', rules: [], causes: [hop] });
          const into = m.params.find((x) => x.annotations.some((a) => a.name === 'MappingTarget'));
          const ent = into && f.entities.find((e) => e.name === simple(into.type));
          if (ent) add({ entity: ent.name, field: ent.columns.some((c) => c.field === target) ? target : '*', hop: { ...hop, rule: `${hop.rule}; it writes into ${ent.name}, so ${ent.name}.${target} is ${/ignore/.test(what) ? 'no longer changed by it' : 'written differently'}` } });
        }
      }
    }
  }

  // ---- messages between services: who publishes to a topic, and who listens on it
  followMessages();

  // an enum whose stored values change: rows already in the database hold the old ones
  const stored: { entity: string; field: string; enumName: string; gone: string[]; ordinal: boolean; hop: Hop }[] = [];
  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java' || cf.status !== 'modified') continue;
    const before = fb.javaFiles.get(cf.path), after = fh.javaFiles.get(cf.path);
    for (const eb of before?.types.filter((t) => t.kind === 'enum') ?? []) {
      const eh = after?.types.find((t) => t.kind === 'enum' && simple(t.name) === simple(eb.name));
      if (!eh) continue;
      const gone = eb.constants.filter((c) => !eh.constants.includes(c));
      const moved = eb.constants.some((c, i) => eh.constants.indexOf(c) !== i && eh.constants.includes(c)) || eh.constants.length !== eb.constants.length;
      if (!gone.length && !moved) continue;
      const enumName = simple(eh.name);
      // entity fields of this type, and how they are stored: by name (STRING) or by position (ORDINAL, the default)
      for (const jf of fh.javaFiles.values()) for (const t of jf.types) {
        const entity = fh.entities.find((e) => e.name === simple(t.name) && e.file === jf.path);
        if (!entity) continue;
        for (const fl of t.fields.filter((x) => simple(x.type) === enumName)) {
          const how = fl.annotations.find((a) => a.name === 'Enumerated');
          const ordinal = !how || !how.args.some((a) => a.t === 'STRING');
          if (!ordinal && !gone.length) continue;
          const hop: Hop = { label: ordinal ? 'Stored by position' : 'Stored by name', file: jf.path, line: how?.line ?? fl.line, quote: how ? 'Enumerated' : fl.name, rule: `${entity.name}.${fl.name} stores ${enumName} ${ordinal ? 'as its position in the list' : 'as its name'}` };
          stored.push({ entity: entity.name, field: fl.name, enumName, gone, ordinal, hop });
          add({ entity: entity.name, field: fl.name, hop });
        }
      }
    }
  }
  for (const s0 of stored) {
    ctx.unseen.push({
      what: s0.ordinal ? `${s0.entity} rows already stored with ${s0.enumName} by position` : `${s0.entity} rows already stored as ${s0.gone.join(', ')}`,
      why: s0.ordinal ? `${s0.entity}.${s0.field} is stored as a number, and this PR moves ${s0.enumName}'s values, so stored rows now mean another value` : `${s0.enumName} no longer has ${s0.gone.join(', ')}, so a stored row with ${s0.gone.length === 1 ? 'that value' : 'those values'} fails to load, and every screen showing it fails`,
      resolve: s0.ordinal ? 'add a migration that renumbers stored rows, or store the enum by name' : `count the rows with ${s0.gone.join(', ')} in production and add a migration that renames them`,
    });
  }

  // listeners of an event whose publishing or shape changed run differently, or not at all
  for (const ev of events) {
    for (const l of fh.listeners.filter((x) => x.takes.includes(ev.type))) {
      const stillPublished = [...fh.javaFiles.values()].some((jf) => jf.types.some((t) => t.methods.some((m) => m.body.some((tok, i) => tok.t === 'publishEvent' && m.body.slice(i, i + 6).some((x) => x.t === ev.type)))));
      const sid = `job:${l.cls}.${l.method}`;
      const listener: Hop = { label: 'Listens for it', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${l.cls}.${l.method}(${ev.type}) ${l.kind}` };
      ctx.surface({ id: sid, kind: 'job', name: `${l.cls}.${l.method}() ${l.kind}`, where: l.file, tier: ev.removed && !stillPublished ? 'test-first' : 'test-next' });
      ctx.addCase({
        surface: sid, delta: `event:${ev.type}`, tier: ev.removed && !stillPublished ? 'test-first' : 'test-next',
        do: `Do what publishes ${ev.type} and check what ${l.cls}.${l.method}() does.`,
        expect: ev.removed && !stillPublished
          ? `It runs as before. Risk: it never runs, because nothing publishes ${ev.type} any more.`
          : `It runs as before for every ${ev.type}, unless the change means otherwise.`,
        before: 'Runs.', after: ev.removed && !stillPublished ? 'Never runs.' : 'Runs changed code.', proof: 'derived', hops: [ev.hop, listener],
      });
    }
    if (fh.listeners.some((x) => x.takes.includes(ev.type)) && !ctx.deltas.some((d) => d.id === `event:${ev.type}`)) {
      ctx.deltas.push({ id: `event:${ev.type}`, kind: 'code-changed', title: ev.removed ? `${ev.type} is no longer published at ${ev.hop.file.split('/').pop()}:${ev.hop.line}` : `${ev.type}: what is published changed`, endpoint: '', rules: [], causes: [ev.hop] });
    }
  }

  // who reads an entity: an endpoint whose code, or what it calls, uses the entity or its repository
  const repos = repositories(fh);
  const types = new Map<string, JType>();
  for (const jf of fh.javaFiles.values()) for (const t of jf.types) types.set(simple(t.name), t);
  const memo = new Map<string, boolean>();
  function returnsEntity(e: Endpoint, entity: string): boolean {
    const names = (t: string): string[] => t.match(/[A-Z]\w*/g) ?? [];
    return names(e.returns).some((x) => x === entity || !!fh.dtos.get(`${e.module}|${x}`)?.fields.some((fl) => names(fl.type).includes(entity)));
  }
  function callsGetter(at: string, field: string, depth: number, seenAt: Set<string>): boolean {
    if (seenAt.has(at) || depth > 5) return false;
    seenAt.add(at);
    const [cls, method] = at.split('.') as [string, string];
    const cap = field[0]!.toUpperCase() + field.slice(1);
    const t = types.get(cls);
    if (t?.methods.some((x) => x.name === method && x.body.some((tok) => tok.t === `get${cap}` || tok.t === `is${cap}`))) return true;
    return fh.callEdges.filter((x) => x.from === at).some((x) => callsGetter(x.to, field, depth + 1, seenAt));
  }
  function uses(at: string, entity: string, depth: number, seenAt: Set<string>): boolean {
    if (seenAt.has(at) || depth > 5) return false;
    seenAt.add(at);
    const [cls, method] = at.split('.') as [string, string];
    const t = types.get(cls);
    if (t) {
      const repoFields = new Set(t.fields.filter((x) => repos.get(simple(x.type)) === entity).map((x) => x.name));
      for (const m of t.methods.filter((x) => x.name === method)) {
        if (simple(m.returnType) === entity || m.returnType.includes(`<${entity}>`) || m.params.some((p) => simple(p.type) === entity)) return true;
        if (m.body.some((tok) => tok.t === entity || repoFields.has(tok.t))) return true;
        const table = fh.entities.find((e) => e.name === entity)?.table;
        if (table && sqlTables(m, /\b(from|join|update|into)\s+["`]?(\w+)/gi).some((x) => x.table.toLowerCase() === table.toLowerCase())) return true;
      }
    }
    return fh.callEdges.filter((x) => x.from === at).some((x) => uses(x.to, entity, depth + 1, seenAt));
  }
  // an entity mapped to a column or table the database does not have: every read and write of it fails
  const migrationText = ctx.changes.filter((c) => c.status !== 'deleted' && fileKind(c.path) === 'data').map((c) => H.read(c.path) ?? '').join('\n');
  for (const eh of fh.entities) {
    const eb = fb.entities.find((x) => x.name === eh.name);
    if (!eb || !ctx.changes.some((c) => c.path === eh.file)) continue;
    const moved: { what: string; from: string; to: string; line: number; quote: string; unstored?: boolean }[] = [];
    if (eb.table.toLowerCase() !== eh.table.toLowerCase()) moved.push({ what: 'table', from: eb.table, to: eh.table, line: eh.line, quote: eh.table });
    for (const ch of eh.columns) {
      const cb = eb.columns.find((x) => x.field === ch.field);
      if (cb && cb.stored !== false && ch.stored === false) moved.push({ what: `${eh.name}.${ch.field}`, from: cb.column, to: '', line: ch.line, quote: 'Transient', unstored: true });
      else if (cb && ch.stored !== false && cb.column.toLowerCase() !== ch.column.toLowerCase()) moved.push({ what: `${eh.name}.${ch.field}`, from: cb.column, to: ch.column, line: ch.line, quote: ch.column });
    }
    for (const m of moved) {
      // a migration in this PR that names the new column or table takes care of it (and is followed on its own)
      if (!m.unstored && new RegExp('["\'\\s(]' + m.to + '["\'\\s,;)]', 'i').test(migrationText)) continue;
      const hop: Hop = m.unstored
        ? { label: 'No longer stored', file: eh.file, line: m.line, quote: m.quote, rule: `${m.what} is @Transient now: JPA no longer saves it to ${eb.table}.${m.from} or loads it back` }
        : { label: 'Mapped to', file: eh.file, line: m.line, quote: m.quote, rule: `${m.what} is now mapped to ${m.to}, and was ${m.from}; no migration in this PR creates ${m.to}` };
      const why = m.unstored ? `${m.what} is no longer saved or loaded, so it reads back empty for every row` : `${m.what === 'table' ? `${eh.name} is now stored in ${m.to}` : `${m.what} is now the column ${m.to}`}, which the database does not have`;
      if (m.unstored) ctx.unseen.push({ what: `${eb.table}.${m.from} in every environment`, why: `${why}; the column stays, and keeps the values written before this change`, resolve: `say whether ${m.from} should still be filled, or drop it with a migration` });
      else ctx.unseen.push({ what: `the ${eb.table} table in every environment`, why: `${why}: every query on ${eh.name} fails until a migration renames ${m.from} to ${m.to}`, resolve: `add a migration that renames ${m.from} to ${m.to}, or keep the old name` });
      add({ entity: eh.name, field: m.unstored ? m.what.split('.')[1]! : '*', hop });
      for (const e of fh.endpoints) {
        if (!uses(`${e.cls}.${e.method}`, eh.name, 0, new Set())) continue;
        // a field no longer stored shows where it is read back: an API that returns the entity, or code that calls its getter
        if (m.unstored && !(e.verb === 'GET' && returnsEntity(e, eh.name)) && !callsGetter(`${e.cls}.${e.method}`, m.what.split('.')[1]!, 0, new Set())) continue;
        for (const c of browserCalls(fh, ctx.ui, e)) for (const rt of ctx.ui.routes.filter((x) => callMadeBy(ctx.ui, ctx.closure(x.component), c))) {
          const sid = `screen:${rt.path}`;
          const title = screenTitle(ctx.ui.components.get(rt.component), rt.path);
          ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
          ctx.addCase({ surface: sid, delta: `map:${eh.name}`, tier: 'test-first', do: `Open ${title} and use what calls ${c.verbs.join('/')} ${c.tpl}.`, expect: m.unstored ? `It shows what it showed. Risk: ${m.what} is blank or wrong, because ${why}.` : `It works. Risk: it fails (500), because ${why}.`, before: 'Worked.', after: m.unstored ? 'Not stored.' : 'Mapping broken.', proof: 'derived', hops: [hop, { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} reads or writes ${eh.name}` }, { label: 'The page calls it', file: c.file, line: c.line, quote: c.code.slice(0, 24).trim(), rule: `${c.verbs.join('/')} ${c.tpl}` }, { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
        }
      }
      // jobs and listeners that save or load it fail the same way
      if (!m.unstored) for (const l of fh.listeners.filter((x) => uses(`${x.cls}.${x.method}`, eh.name, 0, new Set()))) {
        const sid = `job:${l.cls}.${l.method}`;
        ctx.surface({ id: sid, kind: 'job', name: `${l.cls}.${l.method}() ${l.kind}`, where: l.file, tier: 'test-first' });
        ctx.addCase({ surface: sid, delta: `map:${eh.name}`, tier: 'test-first', do: `Let ${l.cls}.${l.method}() run (or trigger it) and check that it still saves and loads ${eh.name}.`, expect: `It works. Risk: it fails, because ${why}.`, before: 'Worked.', after: 'Mapping broken.', proof: 'derived', hops: [hop, { label: 'Job', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${l.cls}.${l.method}() ${l.kind} reads or writes ${eh.name}` }] });
      }
      if (!ctx.deltas.some((d) => d.id === `map:${eh.name}`)) ctx.deltas.push({ id: `map:${eh.name}`, kind: 'code-changed', title: `${eh.name}: ${why}`, endpoint: '', rules: [], causes: [hop] });
    }
  }

  /**
   * Messages between services. A listener receives what a producer publishes on a topic: change the topic, the
   * consumer group, the record's shape, or what is put in it, and the listener on the other side runs differently or
   * not at all. Each such listener is listed, then what it writes, and the listeners of what it publishes in turn.
   */
  function followMessages(): void {
    const broker = (l: Listener): boolean => /^@(KafkaListener|RabbitListener|JmsListener|SqsListener)$/.test(l.kind);
    const lh = fh.listeners.filter(broker), lb = fb.listeners.filter(broker);
    if (!lh.length && !lb.length && !fh.producers.length && !fb.producers.length) return;
    const keyOf = (l: { cls: string; method: string }): string => `${l.cls}.${l.method}`;
    const matches = (c: Channel, topic: string): boolean => { if (!c.pattern) return c.name === topic; try { return new RegExp(`^${c.name}$`).test(topic); } catch { return false; } };
    const on = (ls: readonly Listener[], topic: string): Listener[] => ls.filter((l) => l.channels?.some((c) => matches(c, topic)));
    const produced = (f: SpringFacts): Set<string> => new Set(f.producers.flatMap((p) => (p.channel ? [p.channel.name] : [])));
    const producedH = produced(fh), producedB = produced(fb);
    // a producer whose topic could not be worked out may publish anywhere: no "nothing publishes" claim then
    const blind = fh.producers.some((p) => !p.channel);
    const listenHop = (l: Listener, side?: 'base'): Hop => ({ label: 'Listens on', file: l.file, line: l.line, quote: l.kind.replace('@', ''), rule: `${keyOf(l)}() ${l.kind} on ${(l.channels ?? []).map((c) => c.how).join(', ') || 'a topic'}${l.group ? `, group ${l.group}` : ''}`, ...(side ? { side } : {}) });
    const hits = new Map<string, { l: Listener; f: SpringFacts; first: boolean; reasons: string[]; risks: string[]; hops: Hop[] }>();
    const mark = (l: Listener, f: SpringFacts, first: boolean, reason: string, hops: Hop[], risk?: string): void => {
      const k = keyOf(l);
      const cur = hits.get(k) ?? { l, f, first: false, reasons: [], risks: [], hops: [] };
      cur.first ||= first;
      if (!cur.reasons.includes(reason)) cur.reasons.push(reason);
      if (risk && !cur.risks.includes(risk)) cur.risks.push(risk);
      for (const h of hops) if (!cur.hops.some((x) => x.file === h.file && x.line === h.line && x.side === h.side)) cur.hops.push(h);
      hits.set(k, cur);
    };
    const followSpan = (l: Listener, side?: 'base'): void => {
      const cf = ctx.changes.find((c) => c.path === l.file);
      if (!cf) return;
      for (const n of side ? cf.baseLines : cf.headLines) if (n >= l.line - 3 && n <= (l.annEnd ?? l.line)) ctx.follow(l.file, n, side);
    };

    // (a) a listener that now listens elsewhere, or in another consumer group
    for (const l of lh) {
      const b = lb.find((x) => keyOf(x) === keyOf(l));
      if (!b) continue;
      const now = (l.channels ?? []).map((c) => c.name).sort().join(', '), was = (b.channels ?? []).map((c) => c.name).sort().join(', ');
      if (now !== was) {
        const orphan = (l.channels ?? []).filter((c) => !c.pattern && !producedH.has(c.name)).map((c) => c.name);
        mark(l, fh, true, `now listens on ${now || 'nothing'} (was ${was || 'nothing'})`, [listenHop(l), listenHop(b, 'base')], orphan.length && !blind ? `nothing in this repository publishes ${orphan.join(', ')}, so it may never receive a record` : `records still published on ${was} no longer reach it`);
        followSpan(l); followSpan(b, 'base');
      }
      if ((l.group ?? '') !== (b.group ?? '')) {
        mark(l, fh, true, `its consumer group is now ${l.group ?? 'the default'} (was ${b.group ?? 'the default'})`, [listenHop(l), listenHop(b, 'base')], `a new consumer group starts where auto-offset-reset says (latest unless set): records published while it switches are never read by it, and with earliest every record still kept is read again`);
        followSpan(l); followSpan(b, 'base');
      }
    }
    // (b) a listener that is gone: what it did is no longer done
    for (const b of lb.filter((x) => !lh.some((y) => keyOf(y) === keyOf(x)))) mark(b, fb, true, `it was removed`, [listenHop(b, 'base')], `nothing does what it did on ${(b.channels ?? []).map((c) => c.name).join(', ') || 'its topic'} any more`);
    // (c) a topic nothing publishes any more, and one now published that nothing here listens on
    for (const t of producedB) {
      if (producedH.has(t) || blind) continue;
      const was = fb.producers.find((p) => p.channel?.name === t)!;
      const wasHop: Hop = { label: 'Published', file: was.file, line: was.line, quote: 'send', side: 'base', rule: `${was.from}() published to ${t} (${was.channel!.how})` };
      for (const l of on(lh, t)) mark(l, fh, true, `nothing publishes ${t} any more`, [wasHop, listenHop(l)], `it never receives a record: ${was.from}() published to ${t} before this change`);
    }
    for (const t of producedH) {
      if (producedB.has(t) || on(lh, t).length) continue;
      const p = fh.producers.find((x) => x.channel?.name === t)!;
      ctx.unseen.push({ what: `who consumes ${t}`, why: `${p.from}() now publishes to ${t} (${p.channel!.how}), and nothing in this repository listens on it`, resolve: `check which services subscribe to ${t} before release; the listeners of the old topic stop receiving` });
    }
    // (d) what a producer puts on a topic changed: the send itself, or a changed line that leads to it
    const forward = (f: SpringFacts, at: string, depth = 0, out = new Set<string>()): Set<string> => {
      if (out.has(at) || depth > 4) return out;
      out.add(at);
      for (const e of f.callEdges.filter((x) => x.from === at)) for (const to of landsIn(f, e.to)) forward(f, to, depth + 1, out);
      return out;
    };
    const messageTypes = new Set([...fh.producers, ...fb.producers].flatMap((p) => (p.payload ? [p.payload] : [])));
    for (const l of [...lh, ...lb]) for (const t of l.takes) if (!/^(ConsumerRecord|Message|String|Object|Acknowledgment|byte)$/.test(t)) messageTypes.add(t);
    for (const cf of ctx.changes) {
      if (fileKind(cf.path) !== 'java' || /(^|\/)src\/test\//.test(cf.path)) continue;
      if (cf.status === 'modified' && /\.java$/.test(cf.path) && sameTokens(B.read(cf.path) ?? '', H.read(cf.path) ?? '')) continue;
      // a method whose code is the same, token for token, publishes what it did before
      const quiet = sameCodeLines(fb.javaFiles.get(cf.path), fh.javaFiles.get(cf.path));
      for (const [side, f, S, ns] of [['head', fh, H, cf.headLines], ['base', fb, B, cf.baseLines]] as const) {
        const jf = f.javaFiles.get(cf.path);
        if (!jf) continue;
        const sideOf = side === 'base' ? { side: 'base' as const } : {};
        for (const n of ns) {
          if ((side === 'head' ? quiet.head : quiet.base).has(n)) continue;
          const code = (S.line(cf.path, n) ?? '').trim();
          if (!code || /^(\/\/|\*|\/\*|import\s|package\s)/.test(code) || code === '}' || code === '{') continue;
          const at = locate(jf.types, n);
          // a message type's own lines: its shape is the contract between the services
          const outer = jf.types.filter((t) => t.line <= n && n <= t.endLine).sort((a, b) => a.line - b.line)[0];
          if (outer && messageTypes.has(simple(outer.name)) && !at?.method) {
            const T = simple(outer.name);
            const hb = fb.javaFiles.get(cf.path)?.types.find((t) => simple(t.name) === T), hh = fh.javaFiles.get(cf.path)?.types.find((t) => simple(t.name) === T);
            const fb0 = new Set(hb?.fields.map((x) => x.name) ?? []), fh0 = new Set(hh?.fields.map((x) => x.name) ?? []);
            const gone = [...fb0].filter((x) => !fh0.has(x)), added = [...fh0].filter((x) => !fb0.has(x));
            const what = gone.length && added.length ? `${gone.join(', ')} → ${added.join(', ')}` : gone.length ? `${gone.join(', ')} removed` : added.length ? `${added.join(', ')} added` : 'its fields changed';
            const hop: Hop = { label: 'Message changed', file: cf.path, line: n, quote: code.slice(0, 24), rule: `${T} is published between services; ${what}`, ...sideOf };
            const topics = new Set([...fh.producers, ...fb.producers].filter((p) => p.payload === T && p.channel).map((p) => p.channel!.name));
            // a listener sees a shape change only through the fields it reads: a new field nobody reads changes nothing
            const readsField = (f0: SpringFacts, l: Listener, names: string[]): boolean => {
              const caps = names.map((x) => x[0]!.toUpperCase() + x.slice(1));
              for (const at0 of forward(f0, keyOf(l))) {
                const [c0, m0] = at0.split('.') as [string, string];
                const meth = indexOf(f0).types.get(c0)?.t.methods.filter((x) => x.name === m0) ?? [];
                // the record handed on whole (to a mapper, a serializer, a log of it): which fields are read is not seen
                if (meth.some((mm) => mm.body.some((tok, i) => names.includes(tok.t) && mm.body[i + 1]?.t === '(' && mm.body[i - 1]?.t === '.') || mm.body.some((tok) => caps.some((c) => tok.t === `get${c}` || tok.t === `is${c}`)))) return true;
              }
              return false;
            };
            const takers = lh.filter((l) => l.takes.includes(T) || [...topics].some((t) => l.channels?.some((c) => matches(c, t))))
              .filter((l) => (gone.length && readsField(fb, lb.find((x) => keyOf(x) === keyOf(l)) ?? l, gone)) || (added.length && readsField(fh, l, added)) || (!gone.length && !added.length));
            for (const l of takers) mark(l, fh, false, `the ${T} it receives changed: ${what}`, [hop, listenHop(l)], gone.length ? `a service still on the old version sends or reads ${gone.join(', ')}: renamed or removed fields arrive empty until every service is deployed` : undefined);
            if (takers.length) ctx.follow(cf.path, n, side === 'base' ? 'base' : undefined);
            continue;
          }
          if (!at?.method) continue;
          const here = `${simple(at.type.name)}.${at.method.name}`;
          const decides = /^(if|else|for|while|switch|case|return|try|catch|do)\b|^\}\s*(else|catch)\b/.test(code);
          const starts = [...(f.producers.some((p) => p.from === here) ? [here] : []), ...f.callEdges.filter((x) => x.from === here && (x.line === n || (decides && x.line > n && x.line <= at.method!.endLine))).flatMap((x) => landsIn(f, x.to))];
          const reach = new Set<string>();
          for (const st of starts) forward(f, st, 0, reach);
          for (const p of f.producers.filter((x) => reach.has(x.from) && x.channel)) {
            const hop: Hop = { label: 'Publishes', file: p.file, line: p.line, quote: 'send', rule: `${p.from}() publishes ${p.payload ?? 'a record'} to ${p.channel!.name} (${p.channel!.how})`, ...sideOf };
            const lineHop: Hop = { label: 'Changed', file: cf.path, line: n, quote: code.slice(0, 24), rule: p.from === here ? `${here}() publishes, and this line of it changed` : `this line leads to ${p.from}(), which publishes`, ...sideOf };
            for (const l of on(lh, p.channel!.name)) mark(l, fh, false, `what is published on ${p.channel!.name} changed (${fileName(cf.path)}:${n})`, [lineHop, hop, listenHop(l)], p.from === here && /\bsend\s*\(/.test(code) ? `the record's topic, key or value as sent changed: check order, partitioning and what the record holds` : undefined);
          }
        }
      }
      // a topic constant whose value changed: its line is the change, followed when a topic uses it
      for (const [side, f, S, ns] of [['head', fh, H, cf.headLines], ['base', fb, B, cf.baseLines]] as const) {
        for (const n of ns) {
          const m = /static\s+final\s+String\s+(\w+)\s*=\s*"([^"]*)"/.exec(S.line(cf.path, n) ?? '');
          if (!m) continue;
          const used = [...f.producers.map((p) => p.channel?.how ?? ''), ...f.listeners.flatMap((l) => (l.channels ?? []).map((c) => c.how))].some((h) => new RegExp(`\\b${m[1]} = `).test(h));
          if (used) ctx.follow(cf.path, n, side === 'base' ? 'base' : undefined);
        }
      }
    }
    // (e) settings that change how a service receives (found with the settings)
    for (const r of ctx.receiving ?? []) { const l = lh.find((x) => x.cls === r.cls && x.method === r.method); if (l) mark(l, fh, true, r.why, [r.hop, listenHop(l)]); }

    // each listener hit: list it, then what it writes, then the listeners of what it publishes in turn
    const queue = [...hits.keys()];
    const visited = new Set<string>();
    while (queue.length) {
      const k = queue.shift()!;
      if (visited.has(k)) continue;
      visited.add(k);
      const h = hits.get(k)!;
      const { l, f } = h;
      const base = f === fb;
      const sid = `job:${k}`;
      const tier = h.first ? 'test-first' : 'test-next';
      ctx.surface({ id: sid, kind: 'job', name: `${k}() ${l.kind}${base ? ' (removed)' : ''}`, where: l.file, tier });
      const topics = (l.channels ?? []).map((c) => c.name).join(', ') || 'its topic';
      ctx.addCase({
        surface: sid, delta: `msg:${k}`, tier,
        do: base ? `Check that nothing relied on ${k}(): it handled ${topics} before this change.` : `Publish a record on ${topics} (do what produces it) and check what ${k}() does with it.`,
        expect: `${base ? 'What it did is done elsewhere, or no longer needed.' : 'It handles it as before, or as the change intends.'}${h.risks.length ? ` Risk: ${h.risks.join('; ')}.` : ''}`,
        before: base ? 'Ran.' : 'Received and handled.', after: base ? 'Gone.' : h.reasons[0]!, proof: 'derived', hops: h.hops.slice(0, 5),
      });
      if (!ctx.deltas.some((d) => d.id === `msg:${k}`)) ctx.deltas.push({ id: `msg:${k}`, kind: 'code-changed', title: `${k}(): ${h.reasons.join('; ')}`, endpoint: '', rules: [], causes: h.hops.slice(0, 2) });
      // what it writes shows on the screens that read it
      for (const w of writesFrom(f, k, `${k}() (${l.kind}), which ${h.reasons[0]}`)) add(w);
      // what it publishes, the next service receives
      for (const p of f.producers.filter((x) => forward(f, k).has(x.from) && x.channel)) {
        for (const nl of on(f === fb ? lb : lh, p.channel!.name)) {
          if (keyOf(nl) === k) continue;
          mark(nl, f, false, `it receives what ${k}() publishes on ${p.channel!.name}, and ${k}() ${h.reasons[0]}`, [{ label: 'Publishes', file: p.file, line: p.line, quote: 'send', rule: `${p.from}() runs from ${k}() and publishes to ${p.channel!.name}`, ...(base ? { side: 'base' as const } : {}) }, listenHop(nl, base ? 'base' : undefined)]);
          queue.push(keyOf(nl));
        }
      }
    }
  }

  return {
    written,
    usesEntity: (at, entity) => uses(at, entity, 0, new Set()),
    readsEntity(e, entity) {
      const k = `${e.cls}.${e.method}|${entity}`;
      if (!memo.has(k)) memo.set(k, uses(`${e.cls}.${e.method}`, entity, 0, new Set()));
      return memo.get(k)!;
    },
  };
}
