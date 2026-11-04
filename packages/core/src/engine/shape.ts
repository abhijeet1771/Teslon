import type { Hop, Delta } from './model.js';
import type { SpringFacts, Endpoint } from './spring.js';
import { exposedAs } from './spring.js';
import { hasAnn, annStrings, type JType, type JField } from './java.js';
import { routeQuote, callMadeBy, type ApiCall } from './vue.js';
import { browserCalls, importChain, screenTitle, type WhereCtx } from './where.js';
import { angularReads, type TypedRead } from './ngtypes.js';

/**
 * Response shape: a field of what an API sends or reads changes its JSON name,
 * disappears from the JSON, or changes type. Nothing in the Java code breaks,
 * no test fails, and every screen that reads the old name goes blank.
 *
 * The JSON shape of each changed Java type is read as Jackson writes it
 * (field names, `@JsonProperty`, `@JsonIgnore`, `transient`, class-level
 * `@JsonIgnoreProperties`) at base and at head, and the two are compared. A
 * change is carried to every type that holds it (a field-level
 * `@JsonIgnoreProperties` cuts the path), to the APIs that return or take
 * those types, to the front-end type the page declares for that API's
 * response, and to each template read of the old name, typed by the
 * TypeScript checker: the column, the field, the dropdown.
 */

const CONTAINERS = new Set(['ResponseEntity', 'List', 'Set', 'Collection', 'Iterable', 'Optional', 'Page', 'Slice', 'Mono', 'Flux', 'Map', 'HashMap', 'ArrayList', 'HashSet', 'LinkedHashSet', 'Stream', 'CompletableFuture', 'Callable', 'DeferredResult', 'EntityModel', 'CollectionModel', 'PagedModel', 'Array', 'Observable', 'HttpResponse', 'Promise', 'Partial', 'Required', 'Readonly', 'NonNullable', 'Pick', 'Omit', 'Record', 'Signal', 'WritableSignal', 'void', 'Void', 'String', 'Long', 'Integer', 'Boolean', 'Object', 'string', 'number', 'boolean', 'undefined', 'null', 'any', 'unknown']);
const ids = (t: string): string[] => (t.match(/[A-Za-z_$][\w$]*/g) ?? []).map((x) => x.split('.').pop()!).filter((x) => !CONTAINERS.has(x));
const words = (n: string): string => n.replace(/(DTO|Dto|Entity|Model|Request|Response)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
const fileName = (p: string): string => p.split('/').pop() ?? p;
const REQUIRED = new Set(['NotNull', 'NotBlank', 'NotEmpty']);

interface JProp {
  readonly field: string;
  readonly json: string;
  readonly type: string;
  readonly line: number;
  /** Lines of its annotations and declaration. */
  readonly from: number;
  readonly annLine: number | null;
  /** Field-level @JsonIgnoreProperties: what this path leaves out of the type it holds. */
  readonly ignoredNested: ReadonlySet<string>;
  readonly required: boolean;
}
interface JShape { readonly name: string; readonly module: string; readonly file: string; readonly line: number; readonly props: readonly JProp[]; readonly custom: readonly string[]; readonly ignored: ReadonlyMap<string, { line: number; why: string }> }

function findType(f: SpringFacts, file: string, name: string): JType | undefined {
  return f.javaFiles.get(file)?.types.find((t) => t.name.split('.').pop() === name);
}

function shapeOf(f: SpringFacts, key: string): JShape | null {
  const dto = f.dtos.get(key);
  if (!dto) return null;
  const t = findType(f, dto.file, dto.name);
  if (!t || (t.kind !== 'class' && t.kind !== 'record')) return null;
  const custom: string[] = [];
  for (const a of t.annotations) if (/^(JsonSerialize|JsonNaming|JsonAutoDetect|JsonView|JsonFilter|JsonAppend)$/.test(a.name)) custom.push(`@${a.name} on ${t.name}`);
  for (const m of t.methods) for (const a of m.annotations) if (/^(JsonValue|JsonAnyGetter|JsonGetter|JsonProperty|JsonSerialize)$/.test(a.name)) custom.push(`@${a.name} on ${t.name}.${m.name}()`);
  const classIgnore = hasAnn(t.annotations, 'JsonIgnoreProperties');
  const ignoredByClass = new Set(classIgnore ? annStrings(classIgnore) : []);
  const props: JProp[] = [];
  const ignored = new Map<string, { line: number; why: string }>();
  for (const fl of t.fields as readonly JField[]) {
    if (fl.mods?.includes('static')) continue;
    if (fl.mods?.includes('transient')) { ignored.set(fl.name, { line: fl.line, why: 'transient' }); continue; }
    const ji = hasAnn(fl.annotations, 'JsonIgnore');
    if (ji && !/false/.test(ji.args.map((x) => x.t).join(''))) { ignored.set(fl.name, { line: ji.line, why: '@JsonIgnore' }); continue; }
    for (const a of fl.annotations) if (/^(JsonUnwrapped|JsonSerialize|JsonRawValue|JsonValue)$/.test(a.name)) custom.push(`@${a.name} on ${t.name}.${fl.name}`);
    const d = dto.fields.find((x) => x.name === fl.name);
    const json = d?.json ?? fl.name;
    if (ignoredByClass.has(json)) { ignored.set(fl.name, { line: classIgnore!.line, why: `@JsonIgnoreProperties on ${t.name}` }); continue; }
    const jp = hasAnn(fl.annotations, 'JsonProperty');
    const jip = hasAnn(fl.annotations, 'JsonIgnoreProperties');
    props.push({
      field: fl.name, json, type: fl.type, line: fl.line,
      from: Math.min(fl.line, ...fl.annotations.map((a) => a.line)),
      annLine: jp?.line ?? null,
      ignoredNested: new Set(jip ? annStrings(jip) : []),
      required: fl.annotations.some((a) => REQUIRED.has(a.name)),
    });
  }
  return { name: dto.name, module: dto.module, file: dto.file, line: dto.line, props, custom, ignored };
}

interface Change {
  readonly type: JShape;
  readonly was: JProp;
  readonly kind: 'renamed' | 'removed' | 'retyped';
  readonly now?: JProp;
  /** for removed: why, and where */
  readonly gone?: { line: number; why: string; side: 'head' | 'base' };
}

function diff(b: JShape, h: JShape): Change[] {
  const out: Change[] = [];
  for (const was of b.props) {
    const now = h.props.find((p) => p.field === was.field);
    if (!now) {
      // the Java field moved but the JSON kept its name: nothing a client sees
      if (h.props.some((p) => p.json === was.json)) continue;
      const ig = h.ignored.get(was.field);
      out.push({ type: h, was, kind: 'removed', gone: ig ? { line: ig.line, why: ig.why, side: 'head' } : { line: was.line, why: 'the field is gone', side: 'base' } });
    } else if (now.json !== was.json) out.push({ type: h, was, now, kind: 'renamed' });
    else if (ids(now.type).join() !== ids(was.type).join() && now.type.replace(/\s/g, '') !== was.type.replace(/\s/g, '')) out.push({ type: h, was, now, kind: 'retyped' });
  }
  return out;
}

/** Types whose JSON holds the changed type, with the path down to the field. */
function carriers(f: SpringFacts, start: JShape, json: string): { type: string; path: string[]; via?: { file: string; line: number; field: string } }[] {
  const out: { type: string; path: string[]; via?: { file: string; line: number; field: string } }[] = [{ type: start.name, path: [json] }];
  const shapes = [...f.dtos.keys()].filter((k) => k.startsWith(`${start.module}|`)).map((k) => shapeOf(f, k)).filter((s): s is JShape => !!s);
  let frontier = [...out];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: typeof out = [];
    for (const c of frontier) {
      for (const s of shapes) {
        for (const p of s.props) {
          if (!ids(p.type).includes(c.type)) continue;
          // @JsonIgnoreProperties({"bankAccount"}) on Label.operations: this path does not carry it
          if (p.ignoredNested.has(c.path[0]!)) continue;
          if (out.some((o) => o.type === s.name && o.path.length <= c.path.length + 1)) continue;
          const n = { type: s.name, path: [p.json, ...c.path], via: { file: s.file, line: p.line, field: p.field } };
          out.push(n); next.push(n);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export interface ShapeCtx extends WhereCtx { explain(file: string, line: number): void }

/** Front-end types that are a Java type: the page declares the response type of a call to an API returning it. */
function apiLinks(fh: SpringFacts, ui: WhereCtx['ui']): Map<string, { java: string; call: ApiCall; e: Endpoint }> {
  const links = new Map<string, { java: string; call: ApiCall; e: Endpoint }>();
  // a read (GET) is the clearest evidence of what a page receives
  for (const e of [...fh.endpoints].sort((a, b) => Number(b.verb === 'GET') - Number(a.verb === 'GET'))) {
    const jt = ids(e.returns);
    if (jt.length !== 1) continue;
    for (const c of browserCalls(fh, ui, e)) {
      const tt = c.resultType ? ids(c.resultType) : [];
      if (tt.length === 1 && !links.has(tt[0]!)) links.set(tt[0]!, { java: jt[0]!, call: c, e });
    }
  }
  return links;
}

const readsCache = new WeakMap<object, TypedRead[]>();
function readsOf(ctx: WhereCtx): TypedRead[] {
  const hit = readsCache.get(ctx.H);
  if (hit) return hit;
  const r = ctx.ui.routes.length && ctx.H.files.some((f) => /\.ts$/.test(f) && /@angular\//.test(ctx.H.read(f) ?? '')) ? angularReads(ctx.H) : [];
  readsCache.set(ctx.H, r);
  return r;
}

/**
 * The front end reads a field the API does not send: a rename made on one side only. TypeScript compiles it,
 * the build passes, and the page shows nothing. Only reads this PR introduced are reported, on types the page
 * gets straight from a Java API.
 */
export function contractCheck(ctx: ShapeCtx): void {
  const { fh, ui } = ctx;
  const changed = new Map(ctx.changes.filter((c) => c.status !== 'deleted').map((c) => [c.path, new Set(c.headLines)]));
  if (![...changed.keys()].some((f) => /\.(ts|html)$/.test(f) && ui.files.includes(f))) return;
  const links = apiLinks(fh, ui);
  const javaOf = (ts0: string): { java: string; how: string } | null => {
    const l = links.get(ts0);
    if (l) return { java: l.java, how: `${l.call.verbs.join('/')} ${l.call.tpl} is typed ${l.call.resultType}, and ${l.e.verb} ${l.e.path} returns ${l.e.returns}` };
    const n = ts0.replace(/^I(?=[A-Z])/, '');
    return [...fh.dtos.values()].some((d) => d.name === n) ? { java: n, how: `${ts0} is named like the Java type ${n}` } : null;
  };
  const done = new Set<string>();
  for (const r of readsOf(ctx)) {
    const isNew = (changed.get(r.file)?.has(r.line) ?? false) || (changed.get(r.typeFile)?.has(r.declLine) ?? false);
    if (!isNew) continue;
    const j = javaOf(r.type);
    if (!j) continue;
    const key = [...fh.dtos.keys()].find((k) => k.endsWith(`|${j.java}`));
    const shape = key ? shapeOf(fh, key) : null;
    if (!shape || shape.custom.length || shape.props.some((p) => p.json === r.prop)) continue;
    const sends = shape.props.map((p) => p.json);
    const near = sends.find((p) => p.toLowerCase().includes(r.prop.toLowerCase()) || r.prop.toLowerCase().includes(p.toLowerCase()));
    const id = `contract:${r.type}.${r.prop}`;
    const causes: Hop[] = [
      { label: 'The page reads', file: r.typeFile, line: r.declLine, quote: r.prop, rule: `${r.type}.${r.prop}` },
      { label: 'The API sends', file: shape.file, line: shape.line, quote: shape.name, rule: `${shape.name} as JSON: ${sends.join(', ')}; no "${r.prop}"` },
    ];
    if (!ctx.deltas.some((d) => d.id === id)) ctx.deltas.push({ id, kind: 'response-shape-changed', title: `${r.type}.${r.prop} is read, but ${shape.name} sends no "${r.prop}"`, endpoint: '', rules: [], causes });
    for (const rt of ui.routes.filter((x) => ctx.closure(x.component).has(r.component))) {
      const k = `${rt.path}|${r.file}:${r.line}`;
      if (done.has(k)) continue;
      done.add(k);
      const sid = `screen:${rt.path}`;
      const title = screenTitle(ui.components.get(rt.component), rt.path);
      ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
      ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: r.label || r.prop, do: `Open ${title} and look at ${r.label || r.expr}.`, expect: `It shows the ${words(shape.name)}'s ${near ?? r.prop}. Risk: blank, because the page reads "${r.prop}" and ${shape.name} sends no "${r.prop}"${near ? ` (it sends "${near}")` : ''}.`, before: 'Shown.', after: 'Blank.', proof: 'derived', hops: [...causes, { label: 'Same type as the API', file: r.typeFile, line: r.declLine, quote: r.prop, rule: j.how }, { label: 'The page reads it', file: r.file, line: r.line, quote: r.prop, rule: `${r.label ? `${r.label}: ` : ''}${r.expr}` }, ...(importChain(ui, rt.component, r.component) ?? []), { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }] });
    }
  }
}

export function responseShape(ctx: ShapeCtx): void {
  const { fb, fh, ui, H } = ctx;
  const changedJava = new Set(ctx.changes.filter((c) => c.path.endsWith('.java') && c.status !== 'deleted' && !/\/src\/test\//.test(c.path)).map((c) => c.path));
  if (!changedJava.size) return;
  const changes: Change[] = [];
  for (const [key, dto] of fh.dtos) {
    if (!changedJava.has(dto.file) || !fb.dtos.has(key)) continue;
    const b = shapeOf(fb, key), h = shapeOf(fh, key);
    if (!b || !h) continue;
    if (h.custom.length) {
      ctx.unseen.push({ what: `custom JSON for ${h.name} (${h.custom.slice(0, 2).join(', ')})`, why: 'Teslon reads the JSON Jackson writes from fields; a custom serializer or naming rule can change it in ways not read here', resolve: `call an API that returns ${h.name} at base and at head and compare the JSON`, files: [h.file] });
    }
    changes.push(...diff(b, h));
  }
  if (!changes.length) return;
  const naming = H.files.filter((f) => /application[^/]*\.(ya?ml|properties)$/.test(f)).find((f) => /property-naming-strategy|propertyNamingStrategy/.test(H.read(f) ?? ''));
  if (naming) ctx.unseen.push({ what: `a JSON naming strategy in ${fileName(naming)}`, why: 'it renames every JSON field; the names below are as written in the Java code', resolve: 'check one response of each changed API by hand', files: [naming] });

  const links = apiLinks(fh, ui);
  const typedReads = (): TypedRead[] => readsOf(ctx);

  for (const ch of changes) {
    const T = ch.type;
    const old = ch.was.json;
    const neu = ch.now?.json;
    const noun = words(T.name);
    const id = `shape:${T.name}.${ch.was.field}`;
    const causes: Hop[] = [];
    if (ch.kind === 'renamed') causes.push({ label: 'JSON name changed', file: T.file, line: ch.now!.annLine ?? ch.now!.line, quote: ch.now!.annLine ? 'JsonProperty' : ch.now!.field, rule: `${T.name}.${ch.was.field} is sent and read as "${neu}", not "${old}"` });
    else if (ch.kind === 'removed') causes.push(ch.gone!.side === 'head'
      ? { label: 'Left out of the JSON', file: T.file, line: ch.gone!.line, quote: ch.gone!.why.startsWith('@') ? ch.gone!.why.slice(1).split(' ')[0]! : ch.gone!.why, rule: `${T.name}.${ch.was.field} ("${old}") is no longer sent or read: ${ch.gone!.why}` }
      : { label: 'Field removed', file: T.file, line: ch.was.line, quote: ch.was.field, rule: `${T.name}.${ch.was.field} ("${old}") is gone from the JSON`, side: 'base' });
    else causes.push({ label: 'JSON type changed', file: T.file, line: ch.now!.line, quote: ch.now!.field, rule: `${T.name}.${old}: ${ch.was.type} → ${ch.now!.type}` });
    const d: Delta = {
      id, kind: 'response-shape-changed',
      title: ch.kind === 'renamed' ? `${T.name}: JSON field "${old}" is now "${neu}"` : ch.kind === 'removed' ? `${T.name}: JSON field "${old}" is no longer sent or read` : `${T.name}: JSON field "${old}" is now ${ch.now!.type}, was ${ch.was.type}`,
      endpoint: '', rules: [], causes,
    };
    ctx.deltas.push(d);
    // the field's lines are this change
    if (ch.now) for (let l = ch.now.from; l <= ch.now.line; l++) ctx.explain(T.file, l);
    if (ch.kind === 'removed' && ch.gone!.side === 'head') ctx.explain(T.file, ch.gone!.line);
    for (let l = ch.was.from; l <= ch.was.line; l++) ctx.follow(T.file, l, 'base');

    const risk = ch.kind === 'renamed' ? `the API now sends "${neu}" and this page reads "${old}"` : ch.kind === 'removed' ? `the API no longer sends "${old}"` : `"${old}" now arrives as ${ch.now!.type}`;
    const blank = ch.kind === 'retyped' ? 'shown wrongly' : 'blank';

    // ---- APIs
    const apis: string[] = [];
    const carriedBy = carriers(fh, T, old);
    const writes: Endpoint[] = [];
    for (const c of carriedBy) {
      const direct = c.type === T.name;
      const shapeOfC = c.path.join('.');
      for (const e of fh.endpoints.filter((x) => x.module === T.module)) {
        const returns = ids(e.returns).includes(c.type);
        const takes = !!e.body && ids(e.body.type).includes(c.type);
        if (!returns && !takes) continue;
        const exp = exposedAs(fh, e);
        const ext = exp ? exp.path : e.path;
        const aid = `api:${e.verb} ${ext}`;
        const apiHop: Hop = { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} ${returns ? `returns ${e.returns}` : `takes ${e.body!.type}`}` };
        const holdHops: Hop[] = direct || !c.via ? [] : [{ label: 'Holds it', file: c.via.file, line: c.via.line, quote: c.via.field, rule: `${c.type}.${c.path.slice(0, -1).join('.')} holds ${T.name}, and nothing on that path leaves out "${old}"` }];
        ctx.surface({ id: aid, kind: 'api', name: `${e.verb} ${ext}`, where: `${e.service ?? ''} ${e.verb} ${e.path}`.trim(), tier: direct ? 'test-first' : 'test-next' });
        ctx.touched.add(e);
        apis.push(`${e.verb} ${ext}`);
        if (returns) ctx.addCase({ surface: aid, delta: id, tier: direct ? 'test-first' : 'test-next', field: shapeOfC, do: `Call ${e.verb} ${ext} and read ${shapeOfC}.`, expect: ch.kind === 'renamed' ? `It is "${c.path.slice(0, -1).concat(neu!).join('.')}" now; "${old}" is gone.` : ch.kind === 'removed' ? `"${old}" is gone.` : `It is ${ch.now!.type} now.`, before: `"${shapeOfC}" (${ch.was.type})`, after: ch.kind === 'renamed' ? `"${neu}"` : ch.kind === 'removed' ? 'absent' : ch.now!.type, proof: 'derived', hops: [...causes, ...holdHops, apiHop] });
        if (takes && /^(POST|PUT|PATCH)$/.test(e.verb) && ch.kind !== 'retyped') {
          writes.push(e);
          const required = ch.was.required && !!e.body?.valid;
          ctx.addCase({ surface: aid, delta: id, tier: direct ? 'test-first' : 'test-next', field: shapeOfC, do: `Send ${e.verb} ${ext} with ${shapeOfC} set, as before the change.`, expect: required ? `Rejected (400): ${T.name}.${ch.was.field} is required and is now read from ${neu ? `"${neu}"` : 'nowhere'}.` : `Accepted, but ${old} is not saved: ${neu ? `it is now read from "${neu}"` : 'it is no longer read'}.`, before: 'Saved.', after: required ? 'HTTP 400.' : 'Value dropped.', proof: 'derived', hops: [...causes, ...holdHops, apiHop, ...(required ? [{ label: 'Required', file: T.file, line: ch.was.line, quote: ch.was.field, rule: `${T.name}.${ch.was.field} must be set, and @Valid enforces it`, side: 'base' as const }] : [])] });
        }
      }
    }
    if (apis.length) ctx.unseen.push({ what: `callers outside this repository of ${[...new Set(apis)].slice(0, 3).join(', ')}${apis.length > 3 ? ` and ${apis.length - 3} more` : ''}`, why: `mobile apps, partner systems and scripts are not in the code; they still ${ch.kind === 'renamed' ? `send and read "${old}"` : `expect "${old}"`}`, resolve: 'check gateway access logs for other callers of these paths', files: [T.file] });

    // ---- screens: each template read of the old name on the front-end copy of this type
    const tsNames = new Set([...links].filter(([, v]) => v.java === T.name).map(([k]) => k));
    for (const cand of [`I${T.name}`, T.name, `${T.name}Model`, `${T.name}Dto`, `${T.name}DTO`]) if (!links.has(cand)) tsNames.add(cand);
    const hits = typedReads().filter((r) => r.prop === old && tsNames.has(r.type));
    const done = new Set<string>();
    const reached = new Set<string>();
    for (const r of hits) {
      const link = links.get(r.type);
      const linkHops: Hop[] = link
        ? [{ label: 'Same type as the API', file: link.call.file, line: link.call.line, quote: link.call.code.slice(0, 24).trim(), rule: `${link.call.verbs.join('/')} ${link.call.tpl} is typed ${link.call.resultType}, and ${link.e.verb} ${link.e.path} returns ${link.e.returns}` }]
        : [];
      const typeHop: Hop = { label: 'Its front-end type', file: r.typeFile, line: r.declLine, quote: old, rule: `${r.type}.${old}: the page's copy of ${T.name}.${ch.was.field}${link ? '' : ` (named like ${T.name})`}` };
      const readHop: Hop = { label: 'The page reads it', file: r.file, line: r.line, quote: old, rule: `${r.label ? `${r.label}: ` : ''}${r.expr}` };
      for (const rt of ui.routes.filter((x) => ctx.closure(x.component).has(r.component))) {
        const sid = `screen:${rt.path}`;
        const k = `${sid}|${r.kind}|${r.label}|${r.file}:${r.line}`;
        if (done.has(k)) continue;
        done.add(k);
        const title = screenTitle(ui.components.get(rt.component), rt.path);
        reached.add(sid);
        ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: r.kind === 'attr' || r.kind === 'condition' || r.kind === 'loop' ? 'test-next' : 'test-first' });
        const hops = [...causes, ...linkHops, typeHop, readHop, ...(importChain(ui, rt.component, r.component) ?? []), { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }];
        const what = r.label || r.expr;
        // the screen's own record: /operation/:id/view shows an operation
        const own = (rt.path.split('/').filter((x) => x && !x.startsWith(':'))[0] ?? noun).replace(/[-_]/g, ' ');
        const view = rt.path.includes(':') ? ` for a saved ${own}` : '';
        if (r.kind === 'show') ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: what, do: `Open ${title}${view} and look at ${r.label ? `${r.label}` : r.expr}.`, expect: `${r.label || old} shows the ${noun}'s ${old}. Risk: ${blank}, because ${risk}.`, before: 'Shown.', after: blank === 'blank' ? 'Blank.' : 'Shown wrongly.', proof: 'derived', hops });
        else if (r.kind === 'option') ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: what, do: `Open ${title} and open the ${what} list.`, expect: `Each option shows a ${noun}'s ${old}. Risk: ${blank} options, because ${risk}.`, before: 'Options named.', after: blank === 'blank' ? 'Blank options.' : 'Shown wrongly.', proof: 'derived', hops });
        else if (r.kind === 'control') {
          if (!rt.path.endsWith('/new')) ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: what, do: `Open ${title}${view} and look at the ${what} field.`, expect: `Filled with the saved ${what.toLowerCase()}. Risk: empty, because ${risk.replace('this page reads', 'the form reads')}.`, before: 'Filled.', after: 'Empty.', proof: 'derived', hops });
          // saving: the page sends the old name to an API that now reads the new one
          const files = ctx.closure(rt.component);
          const save = ui.calls.find((c) => callMadeBy(ui, files, c) && writes.some((e) => c.verbs.includes(e.verb) && browserCalls(fh, ui, e).includes(c)));
          if (save && ch.kind !== 'retyped') {
            const e = writes.find((x) => save.verbs.includes(x.verb) && browserCalls(fh, ui, x).includes(save))!;
            const required = ch.was.required && !!e.body?.valid;
            ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: what, do: `${rt.path.endsWith('/new') ? `Create a ${own} with ${what} filled in` : `Change ${what}`} and press Save.`, expect: `Saved, and shown after reload. Risk: ${required ? `${rt.path.endsWith('/new') ? 'rejected (400)' : `rejected, or Save stays disabled with ${what} empty`}, because the page sends "${old}" and the server now requires "${neu ?? old}"` : `${what} is not saved, because the page sends "${old}" and the server ${neu ? `reads "${neu}"` : 'no longer reads it'}`}.`, before: 'Saved.', after: required ? 'Rejected.' : 'Not saved.', proof: 'derived', hops: [...hops, { label: 'The page sends it', file: save.file, line: save.line, quote: save.code.slice(0, 24).trim(), rule: `${save.verbs.join('/')} ${save.tpl} → ${e.verb} ${e.path} takes ${e.body!.type}` }] });
          }
        } else ctx.addCase({ surface: sid, delta: id, tier: 'test-next', field: what, do: `Open ${title} and check what depends on ${r.expr}.`, expect: `As before. Risk: it now behaves as if ${old} were empty, because ${risk}.`, before: 'As released.', after: 'Treated as empty.', proof: 'derived', hops });
      }
    }

    // screens that load a changed API where no typed read was found: Vue pages, or reads the checker could not type.
    // A read by name is shown as such; otherwise the screen is listed to check, never dropped.
    const nameRe = new RegExp(`(^|[.?])${old.replace(/[$]/g, '\\$')}\\b`);
    for (const c0 of carriedBy) {
      for (const e of fh.endpoints.filter((x) => x.module === T.module && ids(x.returns).includes(c0.type))) {
        const exp = exposedAs(fh, e);
        const ext = exp ? exp.path : e.path;
        const apiHop: Hop = { label: 'API', file: e.file, line: e.line, quote: 'Mapping', rule: `${e.verb} ${e.path} returns ${e.returns}` };
        for (const call of browserCalls(fh, ui, e)) {
          const callHop: Hop = { label: 'The page calls it', file: call.file, line: call.line, quote: call.code.slice(0, 24).trim(), rule: `${call.verbs.join('/')} ${call.tpl}` };
          for (const rt of ui.routes.filter((x) => callMadeBy(ui, ctx.closure(x.component), call))) {
            const sid = `screen:${rt.path}`;
            if (reached.has(sid)) continue;
            reached.add(sid);
            const title = screenTitle(ui.components.get(rt.component), rt.path);
            const chain = [...causes, apiHop, callHop, ...(importChain(ui, rt.component, call.file) ?? []), { label: 'Screen', file: rt.file, line: rt.line, quote: routeQuote(rt), rule: `route ${rt.path}` }];
            const shows = [...ctx.closure(rt.component)].filter((f) => /\.(vue|m?js)$/.test(f)).flatMap((f) => (ui.components.get(f)?.shows ?? []).filter((x) => nameRe.test(x.expr)).map((x) => ({ ...x, file: f })));
            // an untyped form (FormBuilder, patchValue): its controls are bound to the API's fields by name
            const controls = [...ctx.closure(rt.component)].flatMap((f) => { const k = ui.components.get(f); return (k?.elements ?? []).filter((el) => el.attrs['formControlName'] === old).map((el) => ({ el, k: k! })); });
            if (controls.length && ch.kind !== 'retyped') {
              ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
              const own = (rt.path.split('/').filter((x) => x && !x.startsWith(':'))[0] ?? noun).replace(/[-_]/g, ' ');
              for (const { el, k } of controls) {
                const id0 = el.attrs['id'];
                const label = (id0 && k.elements.find((x) => x.tag === 'label' && x.attrs['for'] === id0)?.text) || old;
                const hop: Hop = { label: 'The form field', file: el.file ?? k.file, line: el.line, quote: old, rule: `formControlName="${old}": an untyped form, filled from the API by field name` };
                if (rt.path.includes(':')) ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: label, do: `Open ${title} for a saved ${own} and look at the ${label} field.`, expect: `Filled with the saved ${label.toLowerCase()}. Risk: it shows its default instead, because ${risk.replace('this page reads', 'the form reads')}.`, before: 'Filled.', after: 'Default value.', proof: 'derived', hops: [...chain, hop] });
                const save = ui.calls.find((c) => callMadeBy(ui, ctx.closure(rt.component), c) && writes.some((w) => c.verbs.includes(w.verb) && browserCalls(fh, ui, w).includes(c)));
                if (save) ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: label, do: `${rt.path.endsWith('/new') ? `Create a ${own}` : `Change something else`} and press Save, then reload.`, expect: `${label} keeps its value. Risk: ${ch.kind === 'removed' ? `the server no longer reads "${old}", so ${label} is not saved${rt.path.includes(':') ? ' and may be reset' : ''}` : `the page sends "${old}" and the server reads "${neu}", so ${label} is not saved`}.`, before: 'Saved.', after: 'Not saved.', proof: 'derived', hops: [...chain, hop, { label: 'The page sends it', file: save.file, line: save.line, quote: save.code.slice(0, 24).trim(), rule: `${save.verbs.join('/')} ${save.tpl}` }] });
              }
              continue;
            }
            if (shows.length) {
              ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-first' });
              for (const sh of shows) ctx.addCase({ surface: sid, delta: id, tier: 'test-first', field: sh.label || sh.expr, do: `Open ${title} and look at ${sh.label || sh.expr}.`, expect: `It shows the ${noun}'s ${old}. Risk: ${blank}, because ${risk}.`, before: 'Shown.', after: 'Blank.', proof: 'derived', hops: [...chain, { label: 'The page reads it', file: sh.file, line: sh.line, quote: old, rule: `${sh.expr} (read by name; its type is not checked)` }] });
            } else {
              ctx.surface({ id: sid, kind: 'screen', name: title, where: rt.path, tier: 'test-next' });
              ctx.addCase({ surface: sid, delta: id, tier: 'test-next', do: `Open ${title} and use what loads ${e.verb} ${ext}.`, expect: `Works as before. It loads ${c0.path.join('.')}, which ${ch.kind === 'renamed' ? `is now "${c0.path.slice(0, -1).concat(neu!).join('.')}"` : ch.kind === 'removed' ? 'is gone' : `is now ${ch.now!.type}`}; nothing on this screen was found reading it.`, before: 'As released.', after: 'Loads changed JSON.', proof: 'derived', hops: chain });
            }
          }
        }
      }
    }
  }
}
