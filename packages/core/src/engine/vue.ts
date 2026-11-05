import ts from 'typescript';
import type { Snapshot } from './snapshot.js';
import { readTemplate, readSfc, type TplElement, type TplShow, type TplLink } from './vue-template.js';

/**
 * The browser side of a Vue app: which screen is which route, what each
 * screen draws (headings, fields, buttons, values it shows, and the conditions
 * each is drawn under), and which API calls it makes with what payload.
 * Scripts are read with the TypeScript compiler, templates with Vue's own
 * parser.
 */

export interface Route {
  readonly path: string;
  readonly component: string;
  readonly file: string;
  readonly line: number;
  /** Text on that line that names the route, when the full path is not written there (a child route file). */
  readonly quote?: string;
  /** Keys of the route's `meta` (`requiresAdmin`): what a navigation guard can test it by. */
  readonly meta?: readonly string[];
}

/** `router.beforeEach(…)`: runs on every navigation. The route meta keys it reads say which screens it stops. */
export interface Guard { readonly file: string; readonly line: number; readonly endLine: number; readonly meta: readonly string[] }

/** What the route's line must say, for its hop to re-check. */
export const routeQuote = (r: Route): string => r.quote ?? r.path.split('/').filter(Boolean)[0] ?? "'/'";

export interface Payload {
  readonly name: string;
  readonly props: readonly { readonly key: string; readonly value: string; readonly line: number }[];
  /** The whole form model is sent (`this.pet`, `{ ...form }`): key k comes from `<whole>.k`. */
  readonly whole?: string;
  readonly line?: number;
}

export interface ApiCall {
  readonly file: string;
  readonly line: number;
  readonly tpl: string;
  readonly verbs: readonly string[];
  /** `petId ? 'PUT' : 'POST'` — which verb depends on a route param. */
  readonly verbChoice?: { readonly param: string; readonly ifTrue: string; readonly ifFalse: string; readonly line: number };
  readonly payload?: Payload;
  readonly code: string;
  /** The response type the code declares: `http.get<IBankAccount>(…)`. */
  readonly resultType?: string;
  /** The URL starts with a base this reader cannot resolve (`${SERVER_API_URL}api/x`); taken as the server root. */
  readonly baseAssumed?: boolean;
  /** The class and member the call is made in (`OrderService.cancel`), when known; `eager` when it runs on construction. */
  readonly owner?: string;
  readonly member?: string;
  readonly eager?: boolean;
}

export type El = TplElement;

export interface Component {
  readonly file: string;
  readonly elements: readonly El[];
  /** `{{ … }}` and bound attributes: values the screen shows. */
  readonly shows: readonly TplShow[];
  /** `const petId = route.params.petId` */
  readonly routeParams: ReadonlyMap<string, string>;
  /** router.push(...) targets, as templates. */
  readonly pushes: readonly { readonly target: string; readonly line: number }[];
  /** <router-link :to> targets, with the link text. */
  readonly links: readonly TplLink[];
  /** Local modules it imports or draws: child components, services, stores, a split SFC's script. */
  readonly deps: readonly string[];
  /** Line of the import (or of the tag that draws it, or of `<script src>`) for each dep. */
  readonly depLines: Readonly<Record<string, number>>;
  /** The file that line is in, when it is not the component's own (a route's resolver, in the routes file). */
  readonly depFiles?: Readonly<Record<string, string>>;
  /** Packages it imports by name: `vue`, `axios`, `chart.js`. */
  readonly packages: readonly string[];
  /** Ways data reaches it that this reader does not follow; a screen with any of these is never ruled out. */
  readonly opaque: readonly { readonly what: string; readonly line: number }[];
  /** Members of app classes this file uses (`OrderService.list`), and the app classes it injects. */
  readonly uses?: readonly string[];
  readonly injects?: readonly string[];
  /** App classes whose instance this file hands on whole (an argument, a copy, a template binding): its members are not all seen. */
  readonly escapes?: readonly string[];
  /** A module's named members and the lines each spans: `ordersApi.cancel`, a store's `open` getter, `formatDate`. */
  readonly members?: readonly { readonly owner: string; readonly member: string; readonly start: number; readonly end: number }[];
}

export interface Global {
  readonly tag: string; readonly file: string; readonly root: string; readonly line: number;
  /** What the cited line says, and how it puts the component on every screen, when that is not a tag in a template: a route in a named outlet. */
  readonly quote?: string; readonly how?: string;
}

export interface FrontendFacts {
  readonly routes: readonly Route[];
  readonly calls: readonly ApiCall[];
  readonly components: ReadonlyMap<string, Component>;
  readonly globals: readonly Global[];
  readonly files: readonly string[];
  /** Front-end code in a framework this reader does not read, by framework. */
  readonly unread: readonly { readonly framework: string; readonly files: number; readonly example: string; readonly paths: readonly string[] }[];
  /**
   * The app shell: what the entry point loads before any route (root component, app config, interceptors,
   * guards of the root routes). It runs on every screen. Each file with the line that pulls it in.
   */
  readonly shell?: ReadonlyMap<string, { readonly from: string; readonly line: number }>;
  /** `Cls.m` → members of the same class it uses through `this.` */
  readonly memberCalls?: ReadonlyMap<string, readonly string[]>;
  /** Navigation guards registered on the router. */
  readonly guards?: readonly Guard[];
}

/**
 * Does a screen whose code is `files` make this call? When the call's class and member are known, only if
 * something on the screen uses that member (or, for a call made on construction, injects the class). Without
 * that knowledge, any screen that runs the file is taken to make it. This is for claims; whether a screen can be
 * ruled out stays with the wider file-level answer.
 */
export function callMadeBy(ui: FrontendFacts, files: ReadonlySet<string>, c: ApiCall): boolean {
  if (!files.has(c.file)) return false;
  if (!c.owner || !c.member) return true;
  const comp = ui.components.get(c.file);
  // a component's own method: its template and lifecycle call it
  if (comp && comp.elements.length + comp.shows.length + comp.links.length > 0) return true;
  const uses = new Set<string>();
  const injects = new Set<string>();
  for (const f of files) {
    const k = ui.components.get(f);
    for (const u of k?.uses ?? []) uses.add(u);
    for (const i of k?.injects ?? []) injects.add(i);
  }
  if (c.eager) return injects.has(c.owner) || uses.has(`${c.owner}.${c.member}`) || [...uses].some((u) => u.startsWith(`${c.owner}.`));
  // members reach other members of the same class through `this.`
  const want = `${c.owner}.${c.member}`;
  const queue = [...uses].filter((u) => u.startsWith(`${c.owner}.`));
  const seen = new Set(queue);
  while (queue.length) {
    const u = queue.shift()!;
    if (u === want) return true;
    for (const n of ui.memberCalls?.get(u) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  }
  return false;
}

/** Do these files (other than the module itself) use any of these members of it, or hand its owner on whole? */
export function usesMembers(ui: FrontendFacts, files: ReadonlySet<string>, file: string, members: readonly { readonly owner: string; readonly member: string }[]): boolean {
  for (const f of files) {
    if (f === file) continue;
    const k = ui.components.get(f);
    if (!k) continue;
    for (const m of members) {
      if (k.escapes?.includes(m.owner)) return true;
      if (m.member === '()' ? (k.uses ?? []).some((x) => x.startsWith(`${m.owner}.`)) : (k.uses ?? []).includes(`${m.owner}.${m.member}`) || (k.uses ?? []).includes(`${m.owner}.()`) && !(k.uses ?? []).some((x) => x.startsWith(`${m.owner}.`) && x !== `${m.owner}.()`)) return true;
    }
  }
  return false;
}

/** Every use of `owner` on these files is a member access Teslon read: none hands the instance on. */
export function usesSeen(ui: FrontendFacts, files: ReadonlySet<string>, owner: string, ownerFile: string): boolean {
  for (const f of files) {
    const k = ui.components.get(f);
    if (k?.escapes?.includes(owner)) return false;
    // a file that imports the owner's file but injects no instance of it reaches it some other way: a subclass, a token, a type
    if (f !== ownerFile && k?.deps.includes(ownerFile) && !k.injects?.includes(owner)) return false;
  }
  return true;
}

/** Members of `owner` used on these files. */
export function membersUsed(ui: FrontendFacts, files: ReadonlySet<string>, owner: string): string[] {
  const out = new Set<string>();
  for (const f of files) for (const u of ui.components.get(f)?.uses ?? []) if (u.startsWith(`${owner}.`)) out.add(u.slice(owner.length + 1));
  return [...out].sort();
}

const HTTP_CALL = /^(fetch|axios(\.(get|post|put|patch|delete|request))?|http\.(get|post|put|patch|delete)|\$http\.(get|post|put|patch|delete)|api\.(get|post|put|patch|delete))$/;

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

/** The function a node sits in, its name, and whether the expression uses that function's parameters. */
function enclosing(n: ts.Node, e: ts.Expression): { name: string | null; usesParam: boolean } | null {
  let f: ts.Node | undefined = n.parent;
  while (f && !isFn(f)) f = f.parent;
  if (!f || !isFn(f)) return null;
  const params = new Set(f.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
  let usesParam = false;
  const look = (x: ts.Node): void => { if (ts.isIdentifier(x) && params.has(x.text)) usesParam = true; ts.forEachChild(x, look); };
  look(e);
  const name = f.name && ts.isIdentifier(f.name) ? f.name.text
    : f.parent && ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name) ? f.parent.name.text : null;
  return { name, usesParam };
}

/** Calls that move data through code this reader does not follow. */
const OPAQUE_CALL = /^(?:(?:this\.)?\$?store\.(?:dispatch|commit)|dispatch|commit|useStore|use[A-Z]\w*Store|inject|mapActions|mapState|mapGetters|\$\.(?:ajax|get|post|getJSON)|useFetch|useAsyncData|\$fetch|ofetch|ky(?:\.\w+)?|useQuery|useMutation)$/;

const lineAt = (text: string, i: number): number => text.slice(0, i).split('\n').length;

function resolveRel(from: string, spec: string, files: ReadonlySet<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  // `./ChatBox.js?v=explicit-esm-dependencies` is still ./ChatBox.js
  for (const s of spec.replace(/[?#].*$/, '').split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  const base = parts.join('/');
  for (const c of [base, `${base}.js`, `${base}.ts`, `${base}.vue`, `${base}/index.js`, `${base}/index.ts`]) if (files.has(c)) return c;
  return null;
}

/** URL template from a string, template literal or `a + b` expression. */
function urlTemplate(e: ts.Expression, consts: ReadonlyMap<string, ts.Expression>, depth = 0): string | null {
  if (depth > 4) return null;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) {
      const inner = ts.isIdentifier(span.expression) && consts.has(span.expression.text) ? urlTemplate(consts.get(span.expression.text)!, consts, depth + 1) : null;
      out += (inner ?? '{*}') + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = urlTemplate(e.left, consts, depth + 1) ?? '{*}';
    const r = urlTemplate(e.right, consts, depth + 1) ?? '{*}';
    return l + r;
  }
  if (ts.isIdentifier(e) && consts.has(e.text)) return urlTemplate(consts.get(e.text)!, consts, depth + 1);
  if (ts.isParenthesizedExpression(e)) return urlTemplate(e.expression, consts, depth + 1);
  return null;
}

export function readVue(snap: Snapshot): FrontendFacts {
  const files = snap.files.filter((f) => /\.(m?js|ts|vue|jsx|tsx)$/.test(f) && !/(^|\/)(node_modules|dist|build|target|test|tests|__tests__|e2e|cypress)\//.test(f) && !/\.(spec|test|d)\.\w+$/.test(f) && /(src|static|scripts|app|webapp)\//.test(f));
  const fileSet = new Set(files);
  const routes: Route[] = [];
  const calls: ApiCall[] = [];
  const components = new Map<string, Component>();
  const registered: { tag: string; file: string }[] = [];
  const roots: { file: string; template: string; line: number }[] = [];
  const guards: Guard[] = [];
  /** Components each file draws in its template, by the tag written there. */
  const drawnBy = new Map<string, { tag: string; file: string }[]>();
  const foreign = new Map<string, string[]>();
  const usesByFile = new Map<string, readonly string[]>();
  let vueSeen = files.some((f) => f.endsWith('.vue'));
  const wrappers = new Set<string>();
  // axios instances: `export const http = axios.create({ baseURL: '/api' })`, by file and exported name, with their base
  const instances = new Map<string, Map<string, { base: string; assumed: boolean }>>();
  for (const f of files) {
    if (f.endsWith('.vue')) continue;
    const raw = snap.read(f);
    if (!raw || !/\b(fetch|axios|http)\b/.test(raw)) continue;
    const sf0 = ts.createSourceFile(f, raw, ts.ScriptTarget.Latest, true, f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const baseOf = (call: ts.CallExpression): { base: string; assumed: boolean } => {
      const o = call.arguments[0];
      const p = o && ts.isObjectLiteralExpression(o) ? o.properties.find((x) => ts.isPropertyAssignment(x) && x.name.getText(sf0) === 'baseURL') : undefined;
      if (!p || !ts.isPropertyAssignment(p)) return { base: '', assumed: false };
      const v = p.initializer;
      if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) return { base: v.text.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''), assumed: false };
      // `import.meta.env.VITE_API ?? '/api'`: the literal is the fallback
      const lit = /['"`](\/[^'"`]*)['"`]/.exec(v.getText(sf0));
      return { base: lit ? lit[1]!.replace(/\/$/, '') : '', assumed: true };
    };
    const isCreate = (e: ts.Expression | undefined): e is ts.CallExpression => !!e && ts.isCallExpression(e) && /^axios\.create$/.test(e.expression.getText(sf0));
    const visit0 = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isCreate(n.initializer)) {
        if (!instances.has(f)) instances.set(f, new Map());
        instances.get(f)!.set(n.name.text, baseOf(n.initializer));
      }
      if (ts.isExportAssignment(n) && isCreate(n.expression)) {
        if (!instances.has(f)) instances.set(f, new Map());
        instances.get(f)!.set('default', baseOf(n.expression));
      }
      if (ts.isCallExpression(n) && n.arguments[0] && HTTP_CALL.test(n.expression.getText(sf0).replace(/^this\./, ''))) {
        const enc = enclosing(n, n.arguments[0]);
        // a wrapper takes the URL itself: `get(url)`, `${base}${path}`; a call that only fills a hole (`/orders/${id}`) is a call
        const tpl = urlTemplate(n.arguments[0], new Map());
        if (enc?.usesParam && enc.name && (!tpl || tpl.startsWith('{*}'))) wrappers.add(enc.name);
      }
      ts.forEachChild(n, visit0);
    };
    visit0(sf0);
  }

  for (const f of files) {
    const raw = snap.read(f);
    if (raw === null) continue;
    // a file of another framework is not read as Vue: its routes and calls work differently
    // JSX needs no import of React any more, so the extension alone says it is not Vue
    const other = /from\s+['"]@angular\//.test(raw) ? 'Angular' : /from\s+['"]react(?:-dom)?['"]/.test(raw) || /\.(jsx|tsx)$/.test(f) ? 'React' : /from\s+['"]svelte/.test(raw) ? 'Svelte' : /\bangular\s*\.\s*module\s*\(/.test(raw) ? 'AngularJS' : null;
    if (other) { if (!foreign.has(other)) foreign.set(other, []); foreign.get(other)!.push(f); continue; }
    if (/from\s+['"]vue['"]|\bVue\.createApp\b|\bnew\s+Vue\(/.test(raw)) vueSeen = true;
    const text = raw;
    let scriptStart = 0;
    let templateRange: [number, number] | null = null;
    let scriptSrc: string | null = null;
    let scriptText = raw;
    let scriptTs = f.endsWith('.ts');
    if (f.endsWith('.vue')) {
      const sfc = readSfc(raw);
      if (sfc.template) templateRange = [sfc.template.start, sfc.template.end];
      scriptStart = sfc.script ? sfc.script.start : raw.length;
      scriptText = sfc.script ? sfc.script.content : '';
      scriptTs = sfc.script?.lang === 'ts' || sfc.script?.lang === 'tsx';
      // `<script src="./x.component.ts">`: the logic lives in another file, read on its own
      if (sfc.script?.src) scriptSrc = resolveRel(f, sfc.script.src.startsWith('.') ? sfc.script.src : `./${sfc.script.src}`, fileSet);
    }
    const sf = ts.createSourceFile(f, scriptText, ts.ScriptTarget.Latest, true, scriptTs ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const off = f.endsWith('.vue') ? scriptStart : 0;
    const lineOfNode = (n: ts.Node): number => lineAt(text, off + n.getStart(sf));
    const imports = new Map<string, string>();
    /** Local name → the name its module exports it under ('default' for a default import). */
    const importName = new Map<string, string>();
    const importLine = new Map<string, number>();
    const packages = new Set<string>();
    const consts = new Map<string, ts.Expression>();
    const routeParams = new Map<string, string>();
    const pushes: { target: string; line: number }[] = [];
    const localCalls: ApiCall[] = [];
    const opaque: { what: string; line: number }[] = [];
    // absolute offsets into the file, whichever way the template is written
    let template: { start: number; end: number } | null = templateRange ? { start: templateRange[0], end: templateRange[1] } : null;

    const ownerOf = (n: ts.Node): { owner: string; member: string } | null => {
      let member: string | null = null;
      for (let x: ts.Node | undefined = n.parent; x; x = x.parent) {
        if ((ts.isPropertyAssignment(x) || ts.isMethodDeclaration(x)) && x.name && !member) member = x.name.getText(sf);
        if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && ts.isSourceFile(x.parent.parent.parent)) {
          // a store: `defineStore('orders', { actions: { load() {…} } })` or a setup function
          return member ? { owner: x.name.text, member } : { owner: x.name.text, member: '()' };
        }
        if (ts.isFunctionDeclaration(x) && x.name && ts.isSourceFile(x.parent)) return { owner: x.name.text, member: '()' };
      }
      return null;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        const target = resolveRel(f, spec, fileSet);
        if (target && !importLine.has(target)) importLine.set(target, lineOfNode(n));
        if (!spec.startsWith('.') && !spec.startsWith('/')) packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
        // a side-effect import (`import './styles.scss'`) is a dependency too
        if (target && !n.importClause) imports.set(`#side:${target}`, target);
        const cl = n.importClause;
        if (target && cl) {
          if (cl.name) { imports.set(cl.name.text, target); importName.set(cl.name.text, 'default'); }
          if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) for (const el of cl.namedBindings.elements) { imports.set(el.name.text, target); importName.set(el.name.text, el.propertyName?.text ?? el.name.text); }
        }
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        consts.set(n.name.text, n.initializer);
        // const petId = route.params.petId
        const t = n.initializer.getText(sf);
        const rp = /^(?:route|this\.\$route|useRoute\(\))\.params\.(\w+)$/.exec(t);
        if (rp) routeParams.set(n.name.text, rp[1]!);
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'template' && !templateRange) {
        const init = n.initializer;
        if (ts.isNoSubstitutionTemplateLiteral(init) || ts.isTemplateExpression(init) || ts.isStringLiteral(init)) {
          template = { start: off + init.getStart(sf) + 1, end: off + init.getEnd() - 1 };
        }
      }
      // routes: { path: '...', component: X }
      if (ts.isObjectLiteralExpression(n)) {
        let path: ts.StringLiteral | null = null, comp: string | null = null;
        let meta: string[] | undefined;
        for (const p of n.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (p.name.text === 'meta' && ts.isObjectLiteralExpression(p.initializer)) meta = p.initializer.properties.flatMap((x) => (x.name ? [x.name.getText(sf).replace(/^['"]|['"]$/g, '')] : []));
          if (p.name.text === 'path' && ts.isStringLiteral(p.initializer)) path = p.initializer;
          if (p.name.text === 'component' && ts.isIdentifier(p.initializer)) comp = p.initializer.text;
          // a lazy route: `component: () => import('../views/Orders.vue')`, also through defineAsyncComponent
          if (p.name.text === 'component' && !ts.isIdentifier(p.initializer)) {
            const spec = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/.exec(p.initializer.getText(sf))?.[1];
            const target = spec ? resolveRel(f, spec, fileSet) : null;
            if (target) comp = target;
          }
        }
        if (path && comp) routes.push({ path: path.text, component: comp, file: f, line: lineOfNode(path), ...(meta?.length ? { meta } : {}) });
      }
      if (ts.isNewExpression(n) && /^(XMLHttpRequest|WebSocket|EventSource)$/.test(n.expression.getText(sf))) opaque.push({ what: `new ${n.expression.getText(sf)}()`, line: lineOfNode(n) });
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf).replace(/^this\./, '');
        // a store defined in this app (`useCartStore` from '../stores/cart') is read like any module; one from a package is not
        const localStore = /^use[A-Z]\w*Store$/.test(callee) && imports.has(callee);
        if (OPAQUE_CALL.test(callee) && !localStore) opaque.push({ what: `${callee}()`, line: lineOfNode(n) });
        // app.component('chat-box', ChatBox)
        if (/\.component$/.test(callee) && n.arguments.length === 2 && ts.isStringLiteral(n.arguments[0]!) && ts.isIdentifier(n.arguments[1]!)) {
          registered.push({ tag: (n.arguments[0] as ts.StringLiteral).text, file: `${f}#${(n.arguments[1] as ts.Identifier).text}` });
        }
        if (/^\w*router\.(beforeEach|beforeResolve|afterEach)$/i.test(callee) && n.arguments[0]) {
          const body = n.arguments[0].getText(sf);
          guards.push({ file: f, line: lineOfNode(n), endLine: lineAt(text, off + n.getEnd()), meta: [...new Set([...body.matchAll(/\.meta\??\.(\w+)|\.meta\[['"](\w+)['"]\]/g)].map((m) => m[1] ?? m[2]!))] });
        }
        if (/(^|\.)push$/.test(callee) && /router/.test(callee) && n.arguments[0]) {
          const tp = urlTemplate(n.arguments[0], consts);
          if (tp) pushes.push({ target: tp, line: lineOfNode(n) });
        }
        // `http.get(…)` on an axios instance made here or imported: its base comes first
        const inst = /^(\w+)\.(get|post|put|patch|delete|request)$/.exec(callee);
        const instance = inst ? (instances.get(f)?.get(inst[1]!) ?? (imports.has(inst[1]!) ? instances.get(imports.get(inst[1]!)!)?.get(importName.get(inst[1]!)!) : undefined)) : undefined;
        const isApi = HTTP_CALL.test(callee) || wrappers.has(callee) || !!instance;
        // inside a wrapper, the URL is the wrapper's parameter: its callers are the calls
        const tpl0 = isApi && n.arguments[0] ? urlTemplate(n.arguments[0], consts) : null;
        const insideWrapper = isApi && n.arguments[0] ? enclosing(n, n.arguments[0])?.usesParam === true && (!tpl0 || tpl0.startsWith('{*}')) : false;
        if (isApi && n.arguments[0] && !insideWrapper) {
          const raw0 = tpl0;
          const tpl = instance && raw0 !== null && !/^https?:/.test(raw0) ? `${instance.base}/${raw0.replace(/^\//, '')}`.replace(/\/$/, '') || '/' : raw0;
          if (!tpl || !tpl.startsWith('/')) opaque.push({ what: `${callee}() to a URL this reader cannot resolve`, line: lineOfNode(n) });
          if (tpl && tpl.startsWith('/')) {
            let verbs = ['GET'];
            const fromCallee = /\.(get|post|put|patch|delete)$/.exec(callee)?.[1];
            if (fromCallee) verbs = [fromCallee.toUpperCase()];
            let verbChoice: ApiCall['verbChoice'];
            let payload: Payload | undefined;
            const model = (x: ts.Expression): string => x.getText(sf).replace(/^this\./, '').replace(/\.value$/, '');
            const payloadOf = (e: ts.Expression | undefined): Payload | undefined => {
              if (!e) return undefined;
              let x = e;
              if (ts.isCallExpression(x) && /JSON\.stringify$/.test(x.expression.getText(sf)) && x.arguments[0]) x = x.arguments[0];
              if (ts.isIdentifier(x) && consts.has(x.text)) {
                const init = consts.get(x.text)!;
                if (ts.isObjectLiteralExpression(init)) return { ...fromObject(init), name: x.text };
              }
              if (ts.isObjectLiteralExpression(x)) return { ...fromObject(x), name: '' };
              const m = model(x);
              return /^[\w$.]+$/.test(m) ? { name: m, props: [], whole: m, line: lineOfNode(x) } : undefined;
            };
            const fromObject = (o: ts.ObjectLiteralExpression): Payload => {
              const props = o.properties.filter(ts.isPropertyAssignment).map((p) => ({ key: p.name.getText(sf).replace(/^['"]|['"]$/g, ''), value: p.initializer.getText(sf), line: lineOfNode(p) }));
              for (const p of o.properties.filter(ts.isShorthandPropertyAssignment)) props.push({ key: p.name.text, value: p.name.text, line: lineOfNode(p) });
              const spread = o.properties.find(ts.isSpreadAssignment);
              return { name: '', props, ...(spread ? { whole: model(spread.expression), line: lineOfNode(spread) } : {}) };
            };
            // axios.post(url, data, config): the data is the second argument
            const dataFirst = fromCallee && /^(post|put|patch)$/.test(fromCallee) && !/^(request|fetch)$/.test(callee);
            if (dataFirst) payload = payloadOf(n.arguments[1]);
            const opts = dataFirst ? n.arguments[2] : n.arguments[1];
            const scan = (e: ts.Node): void => {
              if (ts.isCallExpression(e) && /jsonRequest$/.test(e.expression.getText(sf))) {
                const v = e.arguments[0];
                if (v && ts.isStringLiteral(v)) verbs = [v.text.toUpperCase()];
                if (v && ts.isConditionalExpression(v) && ts.isStringLiteral(v.whenTrue) && ts.isStringLiteral(v.whenFalse)) {
                  verbs = [v.whenTrue.text, v.whenFalse.text];
                  const cond = v.condition.getText(sf);
                  verbChoice = { param: routeParams.get(cond) ?? cond, ifTrue: v.whenTrue.text, ifFalse: v.whenFalse.text, line: lineOfNode(v) };
                }
                payload = payloadOf(e.arguments[1]) ?? payload;
              }
              if (ts.isPropertyAssignment(e) && e.name.getText(sf) === 'method' && ts.isStringLiteral(e.initializer)) verbs = [e.initializer.text.toUpperCase()];
              // the fetch API with { method, body: JSON.stringify(x) }, and wrappers taking { data: x }
              if (ts.isPropertyAssignment(e) && /^(body|data|json)$/.test(e.name.getText(sf))) payload = payloadOf(e.initializer) ?? payload;
              ts.forEachChild(e, scan);
            };
            if (opts) scan(opts);
            const line = lineOfNode(n);
            const own = ownerOf(n);
            localCalls.push({ file: f, line, tpl: tpl.replace(/\$\{[^}]*\}/g, '{*}').replace(/(\{\*\})+/g, '{*}'), verbs, ...(verbChoice ? { verbChoice } : {}), ...(payload ? { payload } : {}), code: (text.split('\n')[line - 1] ?? '').trim(), ...(instance?.assumed ? { baseAssumed: true } : {}), ...(own && !f.endsWith('.vue') ? own : {}) });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // second pass: variables declared after use (e.g. `url`) are now known
    for (const c of localCalls) calls.push(c);
    const tr = template as { start: number; end: number } | null;
    const tplInfo = tr ? readTemplate(text.slice(tr.start, tr.end), lineAt(text, tr.start) - 1) : { elements: [], shows: [], links: [], uses: [], errors: [] };
    for (const e of tplInfo.errors.slice(0, 1)) opaque.push({ what: `a template Vue could not fully parse (${e})`, line: tr ? lineAt(text, tr.start) : 1 });
    // components drawn in the template are part of the screen too, imported or not
    const drawnTags = tplInfo.uses.map((tag) => ({ tag, file: imports.get(tag) ?? imports.get(tag.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())) ?? null })).filter((x): x is { tag: string; file: string } => !!x.file);
    drawnBy.set(f, drawnTags);
    const drawn = drawnTags.map((x) => x.file);
    usesByFile.set(f, tplInfo.uses);
    // a module's members, by the lines they span: top-level functions and consts, and the named parts inside them
    const members: { owner: string; member: string; start: number; end: number }[] = [];
    if (!f.endsWith('.vue')) {
      const span = (n: ts.Node): [number, number] => [lineOfNode(n), lineAt(text, off + n.getEnd())];
      const inner = (owner: string, n: ts.Node): void => {
        const visitM = (x: ts.Node): void => {
          if ((ts.isPropertyAssignment(x) || ts.isMethodDeclaration(x) || ts.isShorthandPropertyAssignment(x)) && x.name && !(ts.isPropertyAssignment(x) && ts.isObjectLiteralExpression(x.initializer))) { const [a, b] = span(x); members.push({ owner, member: x.name.getText(sf), start: a, end: b }); return; }
          if (ts.isFunctionDeclaration(x) && x.name) { const [a, b] = span(x); members.push({ owner, member: x.name.text, start: a, end: b }); return; }
          if (ts.isVariableStatement(x)) for (const d of x.declarationList.declarations) if (ts.isIdentifier(d.name)) { const [a, b] = span(x); members.push({ owner, member: d.name.text, start: a, end: b }); }
          ts.forEachChild(x, visitM);
        };
        ts.forEachChild(n, visitM);
      };
      for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) { const [a, b] = span(st); members.push({ owner: st.name.text, member: '()', start: a, end: b }); }
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          const [a, b] = span(st);
          const before = members.length;
          inner(d.name.text, d.initializer);
          // a member's span is the whole statement when nothing inside is named (`export const http = axios.create(…)`)
          if (members.length === before) members.push({ owner: d.name.text, member: '()', start: a, end: b });
        }
      }
    }
    const uses = new Set<string>();
    const escapes = new Set<string>();
    // `const orders = useOrdersStore()`: orders.open is the store's open
    const aliases = new Map<string, string>();
    const findAliases = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && importName.has(n.initializer.expression.text)) aliases.set(n.name.text, importName.get(n.initializer.expression.text)!);
      ts.forEachChild(n, findAliases);
    };
    findAliases(sf);
    const walkAlias = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && aliases.has(n.text) && !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        const name = aliases.get(n.text)!;
        if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) uses.add(`${name}.${n.parent.name.text}`);
        else escapes.add(name);
      }
      ts.forEachChild(n, walkAlias);
    };
    walkAlias(sf);
    const walkUses = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n) && importName.has(n.text) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) {
        const name = importName.get(n.text)!;
        if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n) uses.add(`${name}.${n.parent.name.text}`);
        else {
          uses.add(`${name}.()`);
          // handed on whole (an argument, a spread, a shorthand): which members it reaches is not seen
          if (!(ts.isCallExpression(n.parent) && n.parent.expression === n)) escapes.add(name);
        }
      }
      ts.forEachChild(n, walkUses);
    };
    walkUses(sf);
    if (tr) {
      // only expressions name script values: {{ … }} and bound attributes (:x, v-*, @x, #slot). A static
      // attribute or plain text is a string, so `class="cart"` is not the cart store
      const raw = text.slice(tr.start, tr.end);
      const tt = [...raw.matchAll(/\{\{([\s\S]*?)\}\}/g), ...raw.matchAll(/(?:^|\s)(?::|v-[\w:.\[\]-]*|@|#)[\w.:\[\]-]*\s*=\s*"([^"]*)"/g), ...raw.matchAll(/(?:^|\s)(?::|v-[\w:.\[\]-]*|@|#)[\w.:\[\]-]*\s*=\s*'([^']*)'/g)].map((m) => m[1]!).join('\n');
      for (const [local, name] of aliases) {
        for (const m of tt.matchAll(new RegExp(`(?<![\\w.$])${local}\\??\\.(\\w+)`, 'g'))) uses.add(`${name}.${m[1]}`);
        if (new RegExp(`(?<![\\w.$])${local}(?![\\w$]|\\s*\\??\\.)`).test(tt)) escapes.add(name);
      }
      for (const [local, name] of importName) {
        for (const m of tt.matchAll(new RegExp(`(?<![\\w.$])${local}\\??\\.(\\w+)`, 'g'))) uses.add(`${name}.${m[1]}`);
        if (new RegExp(`(?<![\\w.$])${local}(?![\\w$]|\\s*\\??\\.)`).test(tt)) uses.add(`${name}.()`);
      }
    }
    const depLines: Record<string, number> = Object.fromEntries(importLine);
    if (scriptSrc) depLines[scriptSrc] = lineAt(text, scriptStart);
    components.set(f, { file: f, elements: tplInfo.elements, shows: tplInfo.shows, routeParams, pushes, links: tplInfo.links, deps: [...new Set([...imports.values(), ...drawn, ...(scriptSrc ? [scriptSrc] : [])])], depLines, packages: [...packages], opaque, uses: [...uses], injects: [...new Set(importName.values())], ...(escapes.size ? { escapes: [...escapes] } : {}), ...(members.length ? { members } : {}) });
    if (tr) {
      const tt = text.slice(tr.start, tr.end);
      if (/<(router-view|RouterView)\b/.test(tt)) roots.push({ file: f, template: tt, line: lineAt(text, tr.start) });
    }
    // resolve route components to files
    for (const r of routes) if (r.file === f && imports.has(r.component)) (r as { component: string }).component = imports.get(r.component)!;
    for (const g of registered) if (g.file.startsWith(`${f}#`)) { const id = g.file.split('#')[1]!; if (imports.has(id)) g.file = imports.get(id)!; }
  }

  for (const [f, tags] of usesByFile) {
    const comp = components.get(f);
    if (!comp) continue;
    const extra = registered.filter((g) => tags.includes(g.tag) && fileSet.has(g.file));
    if (!extra.length) continue;
    const lines: Record<string, number> = { ...comp.depLines };
    for (const g of extra) if (!(g.file in lines)) lines[g.file] = comp.elements.find((e) => e.tag === g.tag)?.line ?? 1;
    components.set(f, { ...comp, deps: [...new Set([...comp.deps, ...extra.map((g) => g.file)])], depLines: lines });
  }
  // a registered component drawn beside <router-view> is on every screen
  const globals: Global[] = [];
  for (const g of registered) {
    for (const r of roots) {
      const at = r.template.search(new RegExp(`<${g.tag}[\\s>/]`));
      if (at >= 0) globals.push({ tag: g.tag, file: g.file, root: r.file, line: r.line + r.template.slice(0, at).split('\n').length - 1 });
    }
  }
  // a component the root draws beside <RouterView> (imported there, not registered by name) is on every screen too
  for (const r of roots) for (const d of drawnBy.get(r.file) ?? []) {
    if (globals.some((g) => g.file === d.file && g.root === r.file)) continue;
    const at = r.template.search(new RegExp(`<${d.tag}[\\s>/]`));
    if (at >= 0) globals.push({ tag: d.tag, file: d.file, root: r.file, line: r.line + r.template.slice(0, at).split('\n').length - 1 });
  }
  // member uses are read the Vue way only in a Vue app: in another app, a plain module's imports are not instances it holds
  if (!vueSeen) for (const [f, c] of components) { const { uses: _u, injects: _i, escapes: _e, members: _m, ...rest } = c; components.set(f, rest); }
  // without a Vue app, objects shaped like { path, component } are not screens
  const unread = [...foreign].map(([framework, fs]) => {
    const dirs = new Set(fs.map((f) => f.slice(0, f.lastIndexOf('/') + 1)));
    const html = snap.files.filter((f) => /\.html?$/.test(f) && dirs.has(f.slice(0, f.lastIndexOf('/') + 1)));
    return { framework, files: fs.length, example: fs[0]!, paths: [...fs, ...html] };
  });
  // a route is a screen only when its component was read here: one drawn by another framework is that framework's (named as unread)
  return { routes: vueSeen ? routes.filter((r) => fileSet.has(r.component) && components.has(r.component)) : [], calls, components, globals, files, unread, ...(guards.length ? { guards } : {}) };
}

/** Does a link or push target land on this route path? */
export function targetsRoute(target: string, routePath: string): boolean {
  const t = target.trim();
  // `a/${x}`, 'a/' + x + '/b', or a plain path
  const pattern = /^`[\s\S]*`$/.test(t) ? t.slice(1, -1).replace(/\$\{[^}]*\}/g, '*')
    : t.includes('+') ? t.split('+').map((p) => p.trim()).map((p) => (/^'.*'$|^".*"$/.test(p) ? p.slice(1, -1) : '*')).join('')
    : t.replace(/^['"`]|['"`]$/g, '').replace(/\$\{[^}]*\}|\{\*\}/g, '*');
  const re = new RegExp('^' + routePath.replace(/:\w+/g, '[^/]+') + '$');
  return re.test(pattern.replace(/\*/g, 'x1'));
}
