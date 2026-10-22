import ts from 'typescript';
import type { Snapshot } from './snapshot.js';

/**
 * The browser side of a Vue app: which screen is which route, what each
 * screen draws (headings, fields, buttons, values it shows), and which API
 * calls it makes with what payload. Scripts are read with the TypeScript
 * compiler; templates, which are HTML, with a small tag reader that keeps
 * line numbers.
 */

export interface Route { readonly path: string; readonly component: string; readonly file: string; readonly line: number }

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
}

export interface El {
  readonly tag: string;
  readonly line: number;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
}

export interface Component {
  readonly file: string;
  readonly elements: readonly El[];
  /** `{{ … }}` and bound attributes: values the screen shows. */
  readonly shows: readonly { readonly expr: string; readonly line: number; readonly label: string }[];
  /** `const petId = route.params.petId` */
  readonly routeParams: ReadonlyMap<string, string>;
  /** router.push(...) targets, as templates. */
  readonly pushes: readonly { readonly target: string; readonly line: number }[];
  /** <router-link :to> targets, with the link text. */
  readonly links: readonly { readonly target: string; readonly line: number; readonly text: string }[];
  /** Local modules it imports: child components, services, stores. */
  readonly deps: readonly string[];
  /** Ways data reaches it that this reader does not follow; a screen with any of these is never ruled out. */
  readonly opaque: readonly { readonly what: string; readonly line: number }[];
}

export interface Global { readonly tag: string; readonly file: string; readonly root: string; readonly line: number }

export interface FrontendFacts {
  readonly routes: readonly Route[];
  readonly calls: readonly ApiCall[];
  readonly components: ReadonlyMap<string, Component>;
  readonly globals: readonly Global[];
  readonly files: readonly string[];
  /** Front-end code in a framework this reader does not read, by framework. */
  readonly unread: readonly { readonly framework: string; readonly files: number; readonly example: string }[];
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

function readTemplate(text: string, start: number, end: number): { elements: El[]; shows: Component['shows']; links: Component['links'] } {
  const tpl = text.slice(start, end);
  const elements: El[] = [];
  const shows: { expr: string; line: number; label: string }[] = [];
  const links: { target: string; line: number; text: string }[] = [];
  const tagRe = /<(input|select|textarea|label|h[1-6]|button|router-link|dt|th|td|dd|div|span|a)\b([^>]*)>/g;
  for (const m of tpl.matchAll(tagRe)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([:@\w.#-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? '';
    const after = tpl.slice(m.index! + m[0].length);
    const closeAt = after.search(new RegExp(`</${m[1]}>`));
    const inner = closeAt >= 0 ? after.slice(0, closeAt) : '';
    const plain = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const line = lineAt(text, start + m.index!);
    if (/^(input|select|textarea|label|h[1-6]|button|dt|th)$/.test(m[1]!)) elements.push({ tag: m[1]!, line, attrs, text: plain.slice(0, 80) });
    if (m[1] === 'router-link') links.push({ target: attrs[':to'] ?? attrs['to'] ?? '', line, text: plain.slice(0, 60) });
  }
  for (const m of tpl.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const line = lineAt(text, start + m.index!);
    // the label of a value is the nearest <dt>/<th>/<label> above it on the screen
    const before = tpl.slice(0, m.index!);
    const lab = [...before.matchAll(/<(?:dt|th|label)[^>]*>([^<]+)</g)].pop()?.[1]?.trim() ?? '';
    shows.push({ expr: m[1]!.trim(), line, label: lab });
  }
  return { elements, shows, links };
}

export function readVue(snap: Snapshot): FrontendFacts {
  const files = snap.files.filter((f) => /\.(m?js|ts|vue)$/.test(f) && !/(^|\/)(node_modules|dist|build|target|test|tests|__tests__|e2e|cypress)\//.test(f) && !/\.(spec|test|d)\.\w+$/.test(f) && /(src|static|scripts|app|webapp)\//.test(f));
  const fileSet = new Set(files);
  const routes: Route[] = [];
  const calls: ApiCall[] = [];
  const components = new Map<string, Component>();
  const registered: { tag: string; file: string }[] = [];
  const roots: { file: string; template: string; line: number }[] = [];
  const foreign = new Map<string, string[]>();
  let vueSeen = files.some((f) => f.endsWith('.vue'));
  const wrappers = new Set<string>();
  for (const f of files) {
    if (f.endsWith('.vue')) continue;
    const raw = snap.read(f);
    if (!raw || !/\b(fetch|axios|http)\b/.test(raw)) continue;
    const sf0 = ts.createSourceFile(f, raw, ts.ScriptTarget.Latest, true, f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit0 = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments[0] && HTTP_CALL.test(n.expression.getText(sf0).replace(/^this\./, ''))) {
        const enc = enclosing(n, n.arguments[0]);
        if (enc?.usesParam && enc.name) wrappers.add(enc.name);
      }
      ts.forEachChild(n, visit0);
    };
    visit0(sf0);
  }

  for (const f of files) {
    const raw = snap.read(f);
    if (raw === null) continue;
    // a file of another framework is not read as Vue: its routes and calls work differently
    const other = /from\s+['"]@angular\//.test(raw) ? 'Angular' : /from\s+['"]react(?:-dom)?['"]/.test(raw) ? 'React' : /from\s+['"]svelte/.test(raw) ? 'Svelte' : null;
    if (other) { if (!foreign.has(other)) foreign.set(other, []); foreign.get(other)!.push(f); continue; }
    if (/from\s+['"]vue['"]|\bVue\.createApp\b|\bnew\s+Vue\(/.test(raw)) vueSeen = true;
    let text = raw;
    let scriptStart = 0;
    let templateRange: [number, number] | null = null;
    if (f.endsWith('.vue')) {
      const t = /<template[^>]*>([\s\S]*)<\/template>/.exec(raw);
      if (t) templateRange = [t.index + t[0].indexOf('>') + 1, t.index + t[0].length - '</template>'.length];
      const s = /<script[^>]*>([\s\S]*?)<\/script>/.exec(raw);
      scriptStart = s ? s.index + s[0].indexOf('>') + 1 : raw.length;
      text = raw;
    }
    const scriptText = f.endsWith('.vue') ? raw.slice(scriptStart, raw.indexOf('</script>', scriptStart) >= 0 ? raw.indexOf('</script>', scriptStart) : raw.length) : raw;
    const sf = ts.createSourceFile(f, scriptText, ts.ScriptTarget.Latest, true, f.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const off = f.endsWith('.vue') ? scriptStart : 0;
    const lineOfNode = (n: ts.Node): number => lineAt(text, off + n.getStart(sf));
    const imports = new Map<string, string>();
    const consts = new Map<string, ts.Expression>();
    const routeParams = new Map<string, string>();
    const pushes: { target: string; line: number }[] = [];
    const localCalls: ApiCall[] = [];
    const opaque: { what: string; line: number }[] = [];
    // absolute offsets into the file, whichever way the template is written
    let template: { start: number; end: number } | null = templateRange ? { start: templateRange[0], end: templateRange[1] } : null;

    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const target = resolveRel(f, n.moduleSpecifier.text, fileSet);
        const cl = n.importClause;
        if (target && cl) {
          if (cl.name) imports.set(cl.name.text, target);
          if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) for (const el of cl.namedBindings.elements) imports.set(el.name.text, target);
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
        let path: ts.StringLiteral | null = null, comp: ts.Identifier | null = null;
        for (const p of n.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          if (p.name.text === 'path' && ts.isStringLiteral(p.initializer)) path = p.initializer;
          if (p.name.text === 'component' && ts.isIdentifier(p.initializer)) comp = p.initializer;
        }
        if (path && comp) routes.push({ path: path.text, component: comp.text, file: f, line: lineOfNode(path) });
      }
      if (ts.isNewExpression(n) && /^(XMLHttpRequest|WebSocket|EventSource)$/.test(n.expression.getText(sf))) opaque.push({ what: `new ${n.expression.getText(sf)}()`, line: lineOfNode(n) });
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf).replace(/^this\./, '');
        if (OPAQUE_CALL.test(callee)) opaque.push({ what: `${callee}()`, line: lineOfNode(n) });
        // app.component('chat-box', ChatBox)
        if (/\.component$/.test(callee) && n.arguments.length === 2 && ts.isStringLiteral(n.arguments[0]!) && ts.isIdentifier(n.arguments[1]!)) {
          registered.push({ tag: (n.arguments[0] as ts.StringLiteral).text, file: `${f}#${(n.arguments[1] as ts.Identifier).text}` });
        }
        if (/(^|\.)push$/.test(callee) && /router/.test(callee) && n.arguments[0]) {
          const tp = urlTemplate(n.arguments[0], consts);
          if (tp) pushes.push({ target: tp, line: lineOfNode(n) });
        }
        const isApi = HTTP_CALL.test(callee) || wrappers.has(callee);
        // inside a wrapper, the URL is the wrapper's parameter: its callers are the calls
        const insideWrapper = isApi && n.arguments[0] ? enclosing(n, n.arguments[0])?.usesParam === true : false;
        if (isApi && n.arguments[0] && !insideWrapper) {
          const tpl = urlTemplate(n.arguments[0], consts);
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
            localCalls.push({ file: f, line, tpl: tpl.replace(/\$\{[^}]*\}/g, '{*}').replace(/(\{\*\})+/g, '{*}'), verbs, ...(verbChoice ? { verbChoice } : {}), ...(payload ? { payload } : {}), code: (text.split('\n')[line - 1] ?? '').trim() });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    // second pass: variables declared after use (e.g. `url`) are now known
    for (const c of localCalls) calls.push(c);
    const tr = template as { start: number; end: number } | null;
    const tplInfo = tr ? readTemplate(text, tr.start, tr.end) : { elements: [], shows: [], links: [] };
    components.set(f, { file: f, elements: tplInfo.elements, shows: tplInfo.shows, routeParams, pushes, links: tplInfo.links, deps: [...new Set(imports.values())], opaque });
    if (tr) {
      const tt = text.slice(tr.start, tr.end);
      if (/<router-view/.test(tt)) roots.push({ file: f, template: tt, line: lineAt(text, tr.start) });
    }
    // resolve route components to files
    for (const r of routes) if (r.file === f && imports.has(r.component)) (r as { component: string }).component = imports.get(r.component)!;
    for (const g of registered) if (g.file.startsWith(`${f}#`)) { const id = g.file.split('#')[1]!; if (imports.has(id)) g.file = imports.get(id)!; }
  }

  // a registered component drawn beside <router-view> is on every screen
  const globals: Global[] = [];
  for (const g of registered) {
    for (const r of roots) {
      const at = r.template.search(new RegExp(`<${g.tag}[\\s>/]`));
      if (at >= 0) globals.push({ tag: g.tag, file: g.file, root: r.file, line: r.line + r.template.slice(0, at).split('\n').length - 1 });
    }
  }
  // without a Vue app, objects shaped like { path, component } are not screens
  const unread = [...foreign].map(([framework, fs]) => ({ framework, files: fs.length, example: fs[0]! }));
  return { routes: vueSeen ? routes.filter((r) => fileSet.has(r.component)) : [], calls, components, globals, files, unread };
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
