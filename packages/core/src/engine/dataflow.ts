import type { Hop } from './model.js';
import type { SpringFacts, Endpoint } from './spring.js';
import type { JType, JMethod, JavaFile } from './java.js';
import type { WhereCtx } from './where.js';
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

export interface DataFlow {
  readonly written: readonly Written[];
  /** Does this endpoint's code (or what it calls) read or write the entity? */
  readsEntity(e: Endpoint, entity: string): boolean;
}

export function followWritesAndEvents(ctx: WhereCtx): DataFlow {
  const { fh, fb, H, B } = ctx;
  const written: Written[] = [];
  const events: { type: string; hop: Hop; removed: boolean }[] = [];
  const seen = new Set<string>();
  const add = (w: Written): void => { const k = `${w.entity}.${w.field}@${w.hop.file}:${w.hop.line}:${w.hop.side ?? ''}`; if (!seen.has(k)) { seen.add(k); written.push(w); } };

  for (const cf of ctx.changes) {
    if (fileKind(cf.path) !== 'java' || /(^|\/)src\/test\//.test(cf.path)) continue;
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
          if (at && simple(at.type.name) === entityFile.name) add({ entity: entityFile.name, field: '*', hop: { label: side === 'base' ? 'Entity code removed' : 'Entity code', file, line: n, quote: code.slice(0, 24), rule: `${entityFile.name} itself changed`, ...sideOf } });
        }
        for (const m of t.matchAll(/(\w+)\s*\.\s*set([A-Z]\w*)\s*\(/g)) {
          const field = lowerFirst(m[2]!);
          for (const entity of byField.get(field) ?? []) add({ entity, field, hop: { label: side === 'base' ? 'Write removed' : 'Writes', file, line: n, quote: `set${m[2]}`, rule: `${m[1]}.set${m[2]}(…) writes ${entity}.${field}`, ...sideOf } });
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
        // a value computed here and written by the caller: order.setTotal(pricing.orderTotal(…))
        if (side === 'head' && at?.method) {
          const target = `${simple(at.type.name)}.${at.method.name}`;
          for (const e of f.callEdges.filter((x) => x.to === target)) {
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
  const uses = (at: string, entity: string, depth: number, seenAt: Set<string>): boolean => {
    if (seenAt.has(at) || depth > 5) return false;
    seenAt.add(at);
    const [cls, method] = at.split('.') as [string, string];
    const t = types.get(cls);
    if (t) {
      const repoFields = new Set(t.fields.filter((x) => repos.get(simple(x.type)) === entity).map((x) => x.name));
      for (const m of t.methods.filter((x) => x.name === method)) {
        if (simple(m.returnType) === entity || m.returnType.includes(`<${entity}>`) || m.params.some((p) => simple(p.type) === entity)) return true;
        if (m.body.some((tok) => tok.t === entity || repoFields.has(tok.t))) return true;
      }
    }
    return fh.callEdges.filter((x) => x.from === at).some((x) => uses(x.to, entity, depth + 1, seenAt));
  };
  return {
    written,
    readsEntity(e, entity) {
      const k = `${e.cls}.${e.method}|${entity}`;
      if (!memo.has(k)) memo.set(k, uses(`${e.cls}.${e.method}`, entity, 0, new Set()));
      return memo.get(k)!;
    },
  };
}
