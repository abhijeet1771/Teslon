import ts from 'typescript';
import * as ng from '@angular/compiler';
import type { Snapshot } from './snapshot.js';
import type { FrontendFacts, Route, ApiCall, Component, Global } from './vue.js';
import type { TplElement, TplShow, TplLink } from './vue-template.js';

/**
 * The browser side of an Angular app, read with the TypeScript compiler and
 * Angular's own template parser: which screen is which route (lazy routes and
 * child route files included), which component draws which template and which
 * other components, and which HTTP calls each service makes.
 *
 * What it does not follow is said: a store (NgRx), a socket, or a URL it
 * cannot resolve makes the component opaque, so a screen running it is never
 * ruled out.
 */

const SKIP = /(^|\/)(node_modules|dist|build|target|coverage|e2e|cypress|\.angular)\//;
export const isNgFile = (f: string): boolean => /\.ts$/.test(f) && !/\.(spec|test|d)\.ts$/.test(f) && !SKIP.test(f);

interface FileIndex {
  readonly sf: ts.SourceFile;
  /** local name → file it is imported from */
  readonly imports: Map<string, string>;
  readonly importLines: Map<string, number>;
  readonly packages: Set<string>;
  /** files whose exports this file re-exports */
  readonly reexports: string[];
  /** module-level consts and class properties, for URLs */
  readonly consts: Map<string, ts.Expression>;
  readonly classProps: Map<string, Map<string, ts.Expression>>;
  readonly classBase: Map<string, string>;
}

const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** tsconfig `paths`, comments allowed, as [prefix, wildcard, targets]. */
function readPaths(snap: Snapshot): { pattern: string; targets: string[]; dir: string }[] {
  const out: { pattern: string; targets: string[]; dir: string }[] = [];
  for (const f of snap.files.filter((x) => /(^|\/)tsconfig(\.app)?\.json$/.test(x) && !SKIP.test(x))) {
    const raw = snap.read(f);
    if (!raw) continue;
    const parsed = ts.parseConfigFileTextToJson(f, raw).config as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } } | undefined;
    const paths = parsed?.compilerOptions?.paths;
    if (!paths) continue;
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const base = norm(join(dir, parsed?.compilerOptions?.baseUrl ?? '.'));
    for (const [pattern, targets] of Object.entries(paths)) out.push({ pattern, targets: targets.map((t) => norm(join(base, t))), dir: base });
  }
  // the most specific pattern first
  return out.sort((a, b) => b.pattern.replace('*', '').length - a.pattern.replace('*', '').length);
}

export const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);
export function norm(p: string): string {
  const parts: string[] = [];
  for (const s of p.split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }
  return parts.join('/');
}

export function makeResolver(snap: Snapshot): (from: string, spec: string) => string | null {
  const files = new Set(snap.files);
  const paths = readPaths(snap);
  const tryFile = (base: string): string | null => {
    for (const c of [base, `${base}.ts`, `${base}/index.ts`]) if (files.has(c) && c.endsWith('.ts')) return c;
    return null;
  };
  const cache = new Map<string, string | null>();
  return (from, spec) => {
    const k = `${from}\0${spec}`;
    if (cache.has(k)) return cache.get(k)!;
    let hit: string | null = null;
    if (spec.startsWith('.')) hit = tryFile(norm(join(from.slice(0, from.lastIndexOf('/')), spec)));
    else {
      for (const p of paths) {
        const star = p.pattern.indexOf('*');
        const matches = star < 0 ? spec === p.pattern : spec.startsWith(p.pattern.slice(0, star)) && spec.endsWith(p.pattern.slice(star + 1));
        if (!matches) continue;
        const middle = star < 0 ? '' : spec.slice(star, spec.length - (p.pattern.length - star - 1));
        for (const t of p.targets) { hit = tryFile(t.replace('*', middle).replace(/\.ts$/, '')) ?? (files.has(t.replace('*', middle)) ? t.replace('*', middle) : null); if (hit) break; }
        if (hit) break;
      }
    }
    cache.set(k, hit);
    return hit;
  };
}

/** Evaluate a URL expression to a template: literals, template strings, `+`, consts and `this.x`, across files. */
function urlOf(e: ts.Expression, file: string, cls: string | null, idx: Map<string, FileIndex>, depth = 0): string | null {
  if (depth > 6) return null;
  const fi = idx.get(file)!;
  const sf = fi.sf;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return urlOf(e.expression, file, cls, idx, depth + 1);
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) out += (urlOf(span.expression, file, cls, idx, depth + 1) ?? '{*}') + span.literal.text;
    return out;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (urlOf(e.left, file, cls, idx, depth + 1) ?? '{*}') + (urlOf(e.right, file, cls, idx, depth + 1) ?? '{*}');
  }
  // this.resourceUrl, including from a base class
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword && cls) {
    let c: string | undefined = cls;
    for (let i = 0; c && i < 5; i++) {
      const init = fi.classProps.get(c)?.get(e.name.text);
      if (init) return urlOf(init, file, c, idx, depth + 1);
      c = fi.classBase.get(c);
    }
    return null;
  }
  // encodeURIComponent(x), String(x): a path segment
  if (ts.isCallExpression(e)) return '{*}';
  if (ts.isIdentifier(e)) {
    const local = fi.consts.get(e.text);
    if (local) return urlOf(local, file, null, idx, depth + 1);
    const from = fi.imports.get(e.text);
    if (from) {
      const target = exportedConst(from, e.text, idx, 0);
      if (target) return urlOf(target.expr, target.file, null, idx, depth + 1);
    }
    return null;
  }
  void sf;
  return null;
}

function exportedConst(file: string, name: string, idx: Map<string, FileIndex>, depth: number): { expr: ts.Expression; file: string } | null {
  const fi = idx.get(file);
  if (!fi || depth > 4) return null;
  const local = fi.consts.get(name);
  if (local) return { expr: local, file };
  for (const r of fi.reexports) { const hit = exportedConst(r, name, idx, depth + 1); if (hit) return hit; }
  return null;
}

/** A URL template as a path: an unresolved base (`${SERVER_API_URL}api/x`) is taken as the server root. */
function toPath(tpl: string): { path: string; baseAssumed: boolean } | null {
  let t = tpl.replace(/(\{\*\})+/g, '{*}');
  let baseAssumed = false;
  if (t.startsWith('{*}')) { t = t.slice(3); baseAssumed = true; }
  if (/^https?:\/\//.test(t)) return null;
  if (!t.startsWith('/')) { if (!/^[\w-]/.test(t)) return null; t = `/${t}`; baseAssumed = true; }
  if (t.includes('{*}') && !/\/\{\*\}/.test(t) && t.indexOf('{*}') < 2) return null;
  return { path: t.replace(/\/+$/, '') || '/', baseAssumed };
}

export function decoratorArgs(n: ts.ClassDeclaration, name: string): ts.ObjectLiteralExpression | null {
  for (const d of ts.getDecorators(n) ?? []) {
    if (ts.isCallExpression(d.expression) && ts.isIdentifier(d.expression.expression) && d.expression.expression.text === name) {
      const a = d.expression.arguments[0];
      if (a && ts.isObjectLiteralExpression(a)) return a;
    }
  }
  return null;
}
export const prop = (o: ts.ObjectLiteralExpression, name: string): ts.Expression | null => {
  for (const p of o.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
  return null;
};
export const str = (e: ts.Expression | null): string | null => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : null);

/** `() => import('./x').then(m => m.Y)` or `() => import('./x')`: the module and the export taken. */
function lazyImport(e: ts.Expression | null): { spec: string; name: string | null } | null {
  if (!e || !(ts.isArrowFunction(e) || ts.isFunctionExpression(e))) return null;
  let body: ts.Node = e.body;
  if (ts.isBlock(body)) { const ret = body.statements.find(ts.isReturnStatement); if (!ret?.expression) return null; body = ret.expression; }
  let name: string | null = null;
  if (ts.isCallExpression(body) && ts.isPropertyAccessExpression(body.expression) && body.expression.name.text === 'then') {
    const cb = body.arguments[0];
    if (cb && ts.isArrowFunction(cb) && ts.isPropertyAccessExpression(cb.body)) name = cb.body.name.text;
    body = body.expression.expression;
  }
  if (ts.isCallExpression(body) && body.expression.kind === ts.SyntaxKind.ImportKeyword && body.arguments[0] && ts.isStringLiteral(body.arguments[0])) return { spec: body.arguments[0].text, name };
  return null;
}

interface RawRoute { path: string; line: number; file: string; component: string | null; children: RawRoute[]; childFile: string | null; outlet: string | null; /** resolvers and guards: they run for this screen and feed it data */ uses: { file: string; line: number }[] }

/** Angular template facts, in the same shape the Vue reader gives. */
function readNgTemplate(text: string, url: string, lineOffset: number): { elements: TplElement[]; shows: TplShow[]; links: TplLink[]; uses: string[]; useLines: Map<string, number>; errors: string[] } {
  const elements: TplElement[] = [], shows: TplShow[] = [], links: TplLink[] = [];
  const uses = new Set<string>();
  const useLines = new Map<string, number>();
  let parsed: ReturnType<typeof ng.parseTemplate>;
  try { parsed = ng.parseTemplate(text, url, { preserveWhitespaces: false }); }
  catch (e) { return { elements, shows, links, uses: [], useLines, errors: [String((e as Error).message).slice(0, 120)] }; }
  const line = (span: { start: { line: number } } | null | undefined): number => (span ? span.start.line + 1 + lineOffset : 1 + lineOffset);
  // a heading's text, not that of the buttons and links inside it
  const textOf = (nodes: ng.TmplAstNode[], heading = false): string => {
    const out: string[] = [];
    const walk = (ns: ng.TmplAstNode[]): void => {
      for (const n of ns) {
        if (n instanceof ng.TmplAstText) out.push(n.value);
        else if (n instanceof ng.TmplAstBoundText) out.push(`{{ ${(n.value as ng.ASTWithSource).source?.replace(/^\s*\{\{|\}\}\s*$/g, '').trim() ?? ''} }}`);
        else if (n instanceof ng.TmplAstElement) { if (!(heading && /^(button|a|select|input)$/.test(n.name))) walk(n.children); }
        else if (n instanceof ng.TmplAstTemplate) walk(n.children);
      }
    };
    walk(nodes);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  };
  const when: string[] = [];
  const loops: string[] = [];
  class V extends ng.TmplAstRecursiveVisitor {
    override visitElement(el: ng.TmplAstElement): void {
      const attrs: Record<string, string> = {};
      for (const a of el.attributes) attrs[a.name] = a.value;
      for (const i of el.inputs) attrs[`[${i.name}]`] = (i.value as ng.ASTWithSource).source ?? '';
      const on: Record<string, string> = {};
      for (const o of el.outputs) on[o.name] = (o.handler as ng.ASTWithSource).source ?? '';
      if (/^(input|select|textarea|option|label|h[1-6]|button|dt|th|td|dd|a|form|legend|caption|span)$/.test(el.name)) {
        elements.push({ tag: el.name, line: line(el.sourceSpan), attrs, text: textOf(el.children, /^h[1-6]$/.test(el.name)), when: [...when], on, loops: [...loops] });
      }
      if (el.name.includes('-')) { uses.add(el.name); if (!useLines.has(el.name)) useLines.set(el.name, line(el.sourceSpan)); }
      const rl = el.inputs.find((i) => i.name === 'routerLink');
      const rlStatic = el.attributes.find((a) => a.name === 'routerLink');
      if (rl || rlStatic) {
        let target = rlStatic?.value ?? '';
        if (rl) {
          const ast = (rl.value as ng.ASTWithSource).ast;
          if (ast instanceof ng.LiteralArray) target = ast.expressions.map((x) => (x instanceof ng.LiteralPrimitive ? String(x.value) : '*')).join('/').replace(/\/+/g, '/');
          else if (ast instanceof ng.LiteralPrimitive) target = String(ast.value);
          else target = '*';
        }
        links.push({ target, line: line(el.sourceSpan), text: textOf(el.children) });
      }
      super.visitElement(el);
    }
    override visitBoundText(t: ng.TmplAstBoundText): void {
      const src = (t.value as ng.ASTWithSource).source ?? '';
      shows.push({ expr: src.replace(/^\s*\{\{|\}\}\s*$/g, '').trim(), line: line(t.sourceSpan), label: '', when: [...when] });
    }
    override visitIfBlock(b: ng.TmplAstIfBlock): void {
      for (const br of b.branches) {
        when.push((br.expression as ng.ASTWithSource | null)?.source ?? 'else');
        ng.tmplAstVisitAll(this, br.children);
        when.pop();
      }
    }
    override visitForLoopBlock(b: ng.TmplAstForLoopBlock): void {
      loops.push(`${b.item.name} of ${(b.expression as ng.ASTWithSource).source ?? ''}`);
      ng.tmplAstVisitAll(this, b.children);
      loops.pop();
      if (b.empty) ng.tmplAstVisitAll(this, b.empty.children);
    }
  }
  ng.tmplAstVisitAll(new V(), parsed.nodes);
  return { elements, shows, links, uses: [...uses], useLines, errors: (parsed.errors ?? []).map((e) => String(e.msg ?? e).slice(0, 120)) };
}

const HTTP_VERB = /(?:^|\.)(?:http|httpClient|_http|client)\.(get|post|put|patch|delete|head|request)$/i;
const NG_OPAQUE = /(?:^|\.)(?:store|_store)\.(?:select|dispatch|pipe)$|^(?:createEffect|createSelector)$|^new (?:WebSocket|EventSource)$|webSocket$/;

/**
 * Members of app classes a file uses: `this.orders.list()` where `orders = inject(OrderService)` (or a typed field
 * or constructor parameter), `inject(OrderService).get(…)`, a local `const s = inject(X)`, and `orders.x` in the
 * component's template. Also each class member's span, and the members of its own class it uses through `this.`.
 */
function memberUse(fi: FileIndex, template: string): { uses: string[]; injects: string[]; escapes: string[]; members: { cls: string; name: string; start: number; end: number; eager: boolean }[]; edges: Map<string, string[]> } {
  const { sf } = fi;
  const uses = new Set<string>();
  const injects = new Set<string>();
  const escapes = new Set<string>();
  // an instance used other than as `x.member`: handed on, copied, indexed
  const memberOf = (n: ts.Node): boolean => !!n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n;
  // the injection itself (`x = inject(S)`) and a declared name are not uses; `const s = this.service` is: the alias is not followed
  const declares = (n: ts.Node): boolean => !!n.parent && ((ts.isVariableDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent)) && n.parent.initializer === n && ts.isCallExpression(n) || (ts.isVariableDeclaration(n.parent) || ts.isParameter(n.parent) || ts.isPropertyDeclaration(n.parent)) && n.parent.name === n);
  const members: { cls: string; name: string; start: number; end: number; eager: boolean }[] = [];
  const edges = new Map<string, string[]>();
  const appClass = (name: string): boolean => fi.imports.has(name) || fi.classProps.has(name);
  const injected = (e: ts.Expression | undefined): string | null =>
    e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'inject' && e.arguments[0] && ts.isIdentifier(e.arguments[0]) && appClass(e.arguments[0].text) ? e.arguments[0].text : null;
  const typeName = (t: ts.TypeNode | undefined): string | null => (t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && appClass(t.typeName.text) ? t.typeName.text : null);
  const vars = new Map<string, string>();
  const walk = (n: ts.Node, fields: Map<string, string>, cls: string | null, member: string | null): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const own = new Map<string, string>();
      const names = new Set<string>();
      for (const m of n.members) {
        if (m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) names.add(m.name.text);
        if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name)) { const t = injected(m.initializer) ?? typeName(m.type); if (t) { own.set(m.name.text, t); injects.add(t); } }
        if (ts.isConstructorDeclaration(m)) for (const p of m.parameters) if (ts.isIdentifier(p.name)) { const t = typeName(p.type); if (t) { own.set(p.name.text, t); injects.add(t); } }
      }
      for (const m of n.members) {
        const name = ts.isConstructorDeclaration(m) ? 'constructor' : m.name && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name)) ? m.name.text : null;
        if (!name) continue;
        const start = sf.getLineAndCharacterOfPosition(m.getStart(sf)).line + 1, end = sf.getLineAndCharacterOfPosition(m.getEnd()).line + 1;
        members.push({ cls: n.name.text, name, start, end, eager: ts.isPropertyDeclaration(m) || ts.isConstructorDeclaration(m) });
        const self: string[] = [];
        const look = (x: ts.Node): void => {
          if (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.ThisKeyword && names.has(x.name.text)) self.push(`${n.name!.text}.${x.name.text}`);
          ts.forEachChild(x, look);
        };
        look(m);
        if (self.length) edges.set(`${n.name.text}.${name}`, [...new Set(self)]);
        walk(m, own, n.name.text, name);
      }
      // the template uses the component's fields: `orders.list()`, `products.products.value()`; a bare field is handed on
      if (template) for (const [field, t] of own) {
        for (const mm of template.matchAll(new RegExp(`\\b${field}\\??\\.(\\w+)`, 'g'))) uses.add(`${t}.${mm[1]}`);
        if (new RegExp(`(?<![\\w.$])${field}(?![\\w$]|\\s*\\??\\.)`).test(template)) escapes.add(t);
      }
      return;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) { const t = injected(n.initializer); if (t) { vars.set(n.name.text, t); injects.add(t); } }
    {
      const held = ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword ? fields.get(n.name.text)
        : ts.isIdentifier(n) && !(n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) ? vars.get(n.text) ?? fields.get(n.text) : injected(n as ts.Expression);
      if (held && !memberOf(n) && !declares(n)) escapes.add(held);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const r = n.expression;
      // this.orders.list / orders.list / inject(OrderService).get
      const viaField = ts.isPropertyAccessExpression(r) && r.expression.kind === ts.SyntaxKind.ThisKeyword ? fields.get(r.name.text) : undefined;
      const viaVar = ts.isIdentifier(r) ? vars.get(r.text) ?? fields.get(r.text) : undefined;
      const viaInject = injected(r);
      const t = viaField ?? viaVar ?? viaInject;
      if (t) { uses.add(`${t}.${n.name.text}`); if (viaInject) injects.add(viaInject); }
    }
    if (ts.isCallExpression(n)) { const t = injected(n); if (t) injects.add(t); }
    ts.forEachChild(n, (x) => walk(x, fields, cls, member));
  };
  walk(sf, new Map(), null, null);
  return { uses: [...uses], injects: [...injects], escapes: [...escapes], members, edges };
}

export function readAngular(snap: Snapshot): FrontendFacts | null {
  const files = snap.files.filter(isNgFile);
  const ngFiles = files.filter((f) => /from\s+['"]@angular\//.test(snap.read(f) ?? ''));
  if (!ngFiles.length) return null;
  const resolve = makeResolver(snap);
  const fileSet = new Set(files);
  const all = new Set(snap.files);
  const idx = new Map<string, FileIndex>();

  // pass 1: an index per file
  for (const f of files) {
    const raw = snap.read(f);
    if (raw === null) continue;
    const sf = ts.createSourceFile(f, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fi: FileIndex = { sf, imports: new Map(), importLines: new Map(), packages: new Set(), reexports: [], consts: new Map(), classProps: new Map(), classBase: new Map() };
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const target = resolve(f, spec);
        if (!target) { if (!spec.startsWith('.')) fi.packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!); continue; }
        if (!fi.importLines.has(target)) fi.importLines.set(target, lineOf(sf, st));
        const cl = st.importClause;
        if (!cl) fi.imports.set(`#side:${target}`, target);
        if (cl?.name) fi.imports.set(cl.name.text, target);
        if (cl?.namedBindings && ts.isNamedImports(cl.namedBindings)) for (const el of cl.namedBindings.elements) fi.imports.set(el.name.text, target);
        if (cl?.namedBindings && ts.isNamespaceImport(cl.namedBindings)) fi.imports.set(cl.namedBindings.name.text, target);
      }
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolve(f, st.moduleSpecifier.text);
        if (target) { fi.reexports.push(target); if (!fi.importLines.has(target)) fi.importLines.set(target, lineOf(sf, st)); }
      }
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) fi.consts.set(d.name.text, d.initializer);
      if (ts.isClassDeclaration(st) && st.name) {
        const props = new Map<string, ts.Expression>();
        for (const m of st.members) if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isIdentifier(m.name) || ts.isPrivateIdentifier(m.name))) props.set(m.name.text, m.initializer);
        fi.classProps.set(st.name.text, props);
        const ext = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
        if (ext && ts.isIdentifier(ext.expression)) fi.classBase.set(st.name.text, ext.expression.text);
      }
    }
    idx.set(f, fi);
  }

  const calls: ApiCall[] = [];
  const components = new Map<string, Component>();
  const selectors = new Map<string, string>();
  const rawRoutes = new Map<string, RawRoute[]>();
  const referenced = new Set<string>();
  const templateOf = new Map<string, { elements: TplElement[]; shows: TplShow[]; links: TplLink[]; uses: string[]; useLines: Map<string, number>; file: string; line: number; errors: string[] }>();

  // pass 2: components, calls, routes
  for (const f of files) {
    const fi = idx.get(f);
    if (!fi) continue;
    const { sf } = fi;
    const opaque: { what: string; line: number }[] = [];
    const extraDeps: { file: string; line: number }[] = [];
    const pushes: { target: string; line: number }[] = [];
    let cls: string | null = null;

    const routeArray = (arr: ts.ArrayLiteralExpression): RawRoute[] => {
      const out: RawRoute[] = [];
      for (const el of arr.elements) {
        if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) {
          // ...errorRoute from another file
          const from = fi.imports.get(el.expression.text);
          const target = from ? exportedConst(from, el.expression.text, idx, 0) : null;
          const local = fi.consts.get(el.expression.text);
          const arr2 = target?.expr ?? local;
          if (arr2 && ts.isArrayLiteralExpression(arr2)) {
            const owner = target?.file ?? f;
            if (owner !== f) { referenced.add(owner); out.push({ path: '', line: lineOf(sf, el), file: f, component: null, children: [], childFile: owner, outlet: null, uses: [] }); }
            else out.push(...routeArray(arr2));
          }
          continue;
        }
        if (!ts.isObjectLiteralExpression(el)) continue;
        const pathExpr = prop(el, 'path');
        const path = str(pathExpr);
        if (path === null) continue;
        const r: RawRoute = { path, line: lineOf(sf, pathExpr!), file: f, component: null, children: [], childFile: null, outlet: str(prop(el, 'outlet')), uses: [] };
        // resolve: { x: XResolve }, canActivate: [guard], or inline functions that inject a service
        for (const key of ['resolve', 'canActivate', 'canActivateChild', 'canMatch', 'canDeactivate']) {
          const v = prop(el, key);
          if (!v) continue;
          const look = (x: ts.Node): void => {
            if (ts.isIdentifier(x)) { const t = fi.imports.get(x.text); if (t) r.uses.push({ file: t, line: lineOf(sf, x) }); }
            ts.forEachChild(x, look);
          };
          look(v);
        }
        const comp = prop(el, 'component');
        if (comp && ts.isIdentifier(comp)) r.component = fi.imports.get(comp.text) ?? (fi.classProps.has(comp.text) ? f : null);
        const lc = lazyImport(prop(el, 'loadComponent'));
        if (lc) r.component = resolve(f, lc.spec);
        const lch = lazyImport(prop(el, 'loadChildren'));
        if (lch) { const t = resolve(f, lch.spec); if (t) { r.childFile = t; referenced.add(t); } }
        const ch = prop(el, 'children');
        if (ch && ts.isArrayLiteralExpression(ch)) r.children = routeArray(ch);
        out.push(r);
      }
      return out;
    };

    const visit = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name) {
        const prev = cls;
        cls = n.name.text;
        const meta = decoratorArgs(n, 'Component');
        if (meta) {
          const sel = str(prop(meta, 'selector'));
          if (sel) for (const s of sel.split(',').map((x) => x.trim()).filter((x) => /^[\w-]+$/.test(x))) selectors.set(s, f);
          const tu = str(prop(meta, 'templateUrl'));
          const inline = prop(meta, 'template');
          const styles = [str(prop(meta, 'styleUrl')), ...((): string[] => { const s = prop(meta, 'styleUrls'); return s && ts.isArrayLiteralExpression(s) ? s.elements.map((x) => str(x)).filter((x): x is string => !!x) : []; })()];
          for (const s of styles) { if (!s) continue; const t = norm(join(f.slice(0, f.lastIndexOf('/')), s)); if (all.has(t)) extraDeps.push({ file: t, line: lineOf(sf, meta) }); }
          if (tu) {
            const t = norm(join(f.slice(0, f.lastIndexOf('/')), tu));
            const txt = snap.read(t);
            if (txt !== null) { templateOf.set(f, { ...readNgTemplate(txt, t, 0), file: t, line: 1 }); extraDeps.push({ file: t, line: lineOf(sf, meta) }); }
          } else if (inline && (ts.isNoSubstitutionTemplateLiteral(inline) || ts.isStringLiteral(inline))) {
            const startLine = lineOf(sf, inline) - 1;
            templateOf.set(f, { ...readNgTemplate(inline.text, f, startLine), file: f, line: startLine + 1 });
          }
        }
        ts.forEachChild(n, visit);
        cls = prev;
        return;
      }
      // const routes: Routes = [...]
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isArrayLiteralExpression(n.initializer)) {
        const typed = n.type?.getText(sf);
        const looksLikeRoutes = /\bRoutes?\b/.test(typed ?? '') || n.initializer.elements.some((e) => ts.isObjectLiteralExpression(e) && prop(e, 'path') !== null && (prop(e, 'component') || prop(e, 'loadComponent') || prop(e, 'loadChildren') || prop(e, 'children') || prop(e, 'redirectTo')));
        if (looksLikeRoutes) rawRoutes.set(f, [...(rawRoutes.get(f) ?? []), ...routeArray(n.initializer)]);
      }
      // provideRouter([...]) / RouterModule.forRoot([...]) / forChild([...]) with an inline array
      if (ts.isCallExpression(n) && /(^|\.)(provideRouter|forRoot|forChild)$/.test(n.expression.getText(sf)) && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
        rawRoutes.set(f, [...(rawRoutes.get(f) ?? []), ...routeArray(n.arguments[0])]);
      }
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = (ts.isNewExpression(n) ? 'new ' : '') + n.expression.getText(sf).replace(/^this\./, '');
        if (NG_OPAQUE.test(callee)) opaque.push({ what: `${callee}()`, line: lineOf(sf, n) });
      }
      // navigation from code: router.navigate(['/orders', id]), router.navigateByUrl('/products')
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(navigate|navigateByUrl)$/.test(n.expression.name.text) && n.arguments[0]) {
        const a = n.arguments[0];
        const part = (e: ts.Expression): string => (ts.isStringLiteralLike(e) ? e.text : ts.isNumericLiteral(e) ? e.text : '*');
        const target = ts.isArrayLiteralExpression(a) ? a.elements.map((e) => part(e as ts.Expression)).join('/').replace(/\/+/g, '/')
          : ts.isStringLiteralLike(a) ? a.text
          : ts.isTemplateExpression(a) ? a.head.text + a.templateSpans.map((x) => `*${x.literal.text}`).join('')
          : null;
        if (target && target.startsWith('/')) pushes.push({ target: `'${target}'`, line: lineOf(sf, n) });
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf).replace(/^this\./, '');
        const m = HTTP_VERB.exec(callee);
        let urlExpr: ts.Expression | undefined;
        let verbs: string[] = [];
        let resultType: string | undefined;
        let bodyArg: ts.Expression | undefined;
        if (m) {
          if (m[1]!.toLowerCase() === 'request') { const v = str(n.arguments[0] ?? null); verbs = [v ? v.toUpperCase() : 'GET']; urlExpr = n.arguments[1]; }
          else { verbs = [m[1]!.toUpperCase()]; urlExpr = n.arguments[0]; if (/^(POST|PUT|PATCH)$/.test(verbs[0]!)) bodyArg = n.arguments[1]; }
          resultType = n.typeArguments?.[0]?.getText(sf);
        } else if (/(^|\.)httpResource(\.\w+)?$/.test(callee) && n.arguments[0]) {
          verbs = ['GET'];
          resultType = n.typeArguments?.[0]?.getText(sf);
          // httpResource(() => url) or httpResource(() => ({ url, method }))
          const fn = n.arguments[0];
          const scan = (x: ts.Node): void => {
            if (ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === 'url') urlExpr = x.initializer;
            if (ts.isShorthandPropertyAssignment(x) && x.name.text === 'url') urlExpr = x.name;
            if (ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === 'method') { const v = str(x.initializer); if (v) verbs = [v.toUpperCase()]; }
            ts.forEachChild(x, scan);
          };
          if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body) && !ts.isParenthesizedExpression(fn.body) && !ts.isObjectLiteralExpression(fn.body)) urlExpr = fn.body;
          else scan(fn);
        }
        if (verbs.length && urlExpr) {
          const tpl = urlOf(urlExpr, f, cls, idx);
          const p = tpl ? toPath(tpl) : null;
          const line = lineOf(sf, n);
          if (!p) opaque.push({ what: `${callee}() to a URL this reader cannot resolve`, line });
          else {
            const body = bodyArg && ts.isIdentifier(bodyArg) ? bodyArg.text : undefined;
            calls.push({
              file: f, line, tpl: p.path, verbs, code: (sf.text.split('\n')[line - 1] ?? '').trim(),
              ...(body ? { payload: { name: body, props: [], whole: body, line } } : {}),
              ...(resultType ? { resultType } : {}),
              ...(p.baseAssumed ? { baseAssumed: true } : {}),
            } as ApiCall);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);

    const tpl = templateOf.get(f);
    const depLines: Record<string, number> = Object.fromEntries(fi.importLines);
    for (const d of extraDeps) depLines[d.file] ??= d.line;
    for (const e of tpl?.errors.slice(0, 1) ?? []) opaque.push({ what: `a template Angular could not fully parse (${e})`, line: tpl!.line });
    components.set(f, {
      file: f,
      elements: (tpl?.elements ?? []).map((e) => ({ ...e, file: tpl!.file })),
      shows: (tpl?.shows ?? []).map((x) => ({ ...x, file: tpl!.file })),
      routeParams: new Map(),
      pushes,
      links: (tpl?.links ?? []).map((x) => ({ ...x, file: tpl!.file })),
      deps: [...new Set([...fi.imports.values(), ...fi.reexports, ...extraDeps.map((d) => d.file)])],
      depLines,
      packages: [...fi.packages],
      opaque,
    });
  }

  // which members of app classes each file uses, and in which member each call is made
  const memberCalls = new Map<string, string[]>();
  for (const f of files) {
    const fi = idx.get(f);
    const c0 = components.get(f);
    if (!fi || !c0) continue;
    const u = memberUse(fi, templateOf.get(f) ? snap.read(templateOf.get(f)!.file) ?? '' : '');
    for (const [k, v] of u.edges) memberCalls.set(k, v);
    components.set(f, { ...c0, uses: u.uses, injects: u.injects, ...(u.escapes.length ? { escapes: u.escapes } : {}) });
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;
      if (c.file !== f) continue;
      const m = u.members.filter((x) => c.line >= x.start && c.line <= x.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
      if (m) calls[i] = { ...c, owner: m.cls, member: m.name, ...(m.eager ? { eager: true } : {}) };
    }
  }

  // components drawn by selector are part of the screen; selectors are known only now
  for (const [f, c] of components) {
    const tpl = templateOf.get(f);
    if (!tpl) continue;
    const extra: string[] = [];
    const lines: Record<string, number> = { ...c.depLines };
    const files: Record<string, string> = { ...(c.depFiles ?? {}) };
    for (const tag of tpl.uses) {
      const comp = selectors.get(tag);
      // the line is the template's, so the citation names the template file
      if (comp && comp !== f && !c.deps.includes(comp)) { extra.push(comp); if (lines[comp] === undefined) { lines[comp] = tpl.useLines.get(tag) ?? 1; files[comp] = tpl.file; } }
    }
    if (extra.length) components.set(f, { ...c, deps: [...c.deps, ...extra], depLines: lines, depFiles: files });
  }

  // routes: from the files nobody loads as children, down through children and lazy route files
  const routes: Route[] = [];
  const globals: Global[] = [];
  const joinPath = (a: string, b: string): string => `/${[a, b].map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
  const walk = (list: RawRoute[], prefix: string, depth: number, seen: Set<string>): void => {
    if (depth > 8) return;
    for (const r of list) {
      const full = joinPath(prefix, r.path);
      if (r.outlet && r.outlet !== 'primary' && r.component) {
        const sel = [...selectors].find(([, file]) => file === r.component)?.[0] ?? r.outlet;
        // cited by the route itself: its line holds the path, not a tag
        globals.push({ tag: sel, file: r.component, root: r.file, line: r.line, quote: r.path ? r.path : 'path', how: `drawn in the "${r.outlet}" outlet on every route` });
        continue;
      }
      if (r.component && fileSet.has(r.component) && !r.path.includes('**')) {
        routes.push({ path: full, component: r.component, file: r.file, line: r.line, quote: r.path ? r.path : 'path' });
        // what the route runs for this screen is part of it: a resolver loads its data
        const c = components.get(r.component);
        const extra = r.uses.filter((u) => u.file !== r.component && !c?.deps.includes(u.file));
        if (c && extra.length) {
          const depLines = { ...c.depLines }, depFiles = { ...(c.depFiles ?? {}) };
          for (const u of extra) { depLines[u.file] = u.line; depFiles[u.file] = r.file; }
          components.set(r.component, { ...c, deps: [...c.deps, ...extra.map((u) => u.file)], depLines, depFiles });
        }
      }
      if (r.children.length) walk(r.children, full, depth + 1, seen);
      if (r.childFile && !seen.has(r.childFile)) { seen.add(r.childFile); walk(rawRoutes.get(r.childFile) ?? [], full, depth + 1, seen); seen.delete(r.childFile); }
    }
  };
  for (const [f, list] of rawRoutes) if (!referenced.has(f)) walk(list, '', 0, new Set([f]));
  // one screen per path: the first declaration wins (later ones are fallbacks)
  const byPath = new Map<string, Route>();
  for (const r of routes) if (!byPath.has(r.path)) byPath.set(r.path, r);

  const ngDirs = new Set(ngFiles.map((f) => f.split('/').slice(0, -1).join('/')));
  const html = snap.files.filter((f) => /\.html$/.test(f) && ngDirs.has(f.split('/').slice(0, -1).join('/')));
  // the app shell: bootstrapApplication(App, appConfig) and everything they import, before any lazy route
  const shell = new Map<string, { from: string; line: number }>();
  for (const f of files) {
    const fi = idx.get(f);
    if (!fi || !/\bbootstrapApplication\s*\(|\bplatformBrowserDynamic\s*\(\s*\)\s*\.\s*bootstrapModule\s*\(/.test(fi.sf.text)) continue;
    shell.set(f, { from: f, line: 1 });
    const queue = [f];
    while (queue.length) {
      const cur = queue.shift()!;
      // what a routes file imports (guards, resolvers, eager screens) runs for the routes that name it, not before every screen
      if (cur !== f && rawRoutes.has(cur)) continue;
      const c = components.get(cur);
      for (const d of c?.deps ?? []) {
        if (shell.has(d) || !components.has(d) && !/\.(html|s?css|less)$/.test(d)) continue;
        shell.set(d, { from: c?.depFiles?.[d] ?? cur, line: c?.depLines[d] ?? 1 });
        if (components.has(d)) queue.push(d);
      }
    }
    // components drawn by the root component's template are on every screen, like a named outlet
    for (const [file, info] of shell) {
      const tpl = templateOf.get(file);
      if (!tpl || !tpl.uses.length || file === f) continue;
      if (!tpl.uses.includes('router-outlet')) continue;
      for (const tag of tpl.uses) {
        const comp = selectors.get(tag);
        if (comp && comp !== file && !globals.some((g) => g.file === comp)) globals.push({ tag, file: comp, root: tpl.file, line: tpl.useLines.get(tag) ?? info.line });
      }
    }
  }
  // a file that defines routes is not the shell itself: its changes are read per route
  for (const f of rawRoutes.keys()) shell.delete(f);
  return { routes: [...byPath.values()], calls, components, globals, files: [...files, ...html], unread: [], ...(shell.size ? { shell } : {}), ...(memberCalls.size ? { memberCalls } : {}) };
}
