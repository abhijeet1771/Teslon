import ts from 'typescript';
import * as ng from '@angular/compiler';
import type { Snapshot } from './snapshot.js';
import { makeResolver, decoratorArgs, prop, str, isNgFile, norm, join } from './angular.js';

/**
 * What each Angular template reads, typed by the TypeScript checker.
 *
 * Angular's own compiler type-checks a template by turning it into a
 * TypeScript "type-check block": a function over the component in which every
 * binding is an ordinary expression. This does the same, then asks the checker
 * which declaration each property read lands on. So `{{ op.bankAccount?.name }}`
 * resolves through `IOperation.bankAccount: Pick<IBankAccount, 'id' | 'name'>`
 * to `IBankAccount.name`, and `formControlName="name"` through the form's
 * `FormControl<IBankAccount['name']>` to the same field.
 *
 * Framework packages are not in the repository, so a small declaration of the
 * parts that carry types (signals, inputs, inject, HttpClient, forms, RxJS) is
 * given to the checker; everything else from a package is `any`, which can
 * only lose a read, never invent one.
 */

export interface TypedRead {
  /** The template file and line of the read. */
  readonly file: string;
  readonly line: number;
  /** The expression as written: `bankAccount.name`. */
  readonly expr: string;
  /** Where the read lands: `IBankAccount`, declared at typeFile:declLine. */
  readonly type: string;
  readonly typeFile: string;
  readonly declLine: number;
  readonly prop: string;
  readonly kind: 'show' | 'control' | 'option' | 'attr' | 'condition' | 'loop';
  /** What a tester sees it as: the column header, the field label, the term. */
  readonly label: string;
  /** The component's TypeScript file. */
  readonly component: string;
}

const STUBS = `
declare module '@angular/core' {
  export interface Signal<T> { (): T; }
  export interface WritableSignal<T> extends Signal<T> { set(v: T): void; update(fn: (v: T) => T): void; asReadonly(): Signal<T>; }
  export function signal<T>(v: T, o?: any): WritableSignal<T>;
  export function computed<T>(fn: () => T, o?: any): Signal<T>;
  export function linkedSignal<T>(fn: () => T, o?: any): WritableSignal<T>;
  export interface InputSignal<T> extends Signal<T> {}
  export interface ModelSignal<T> extends WritableSignal<T> {}
  export const input: { <T>(): InputSignal<T | undefined>; <T>(v: T, o?: any): InputSignal<T>; required<T>(o?: any): InputSignal<T> };
  export const model: { <T>(): ModelSignal<T | undefined>; <T>(v: T, o?: any): ModelSignal<T>; required<T>(o?: any): ModelSignal<T> };
  export class InjectionToken<T> { constructor(d: string, o?: any); }
  export function inject<T>(token: InjectionToken<T> | (abstract new (...a: any[]) => T), o?: any): T;
  export class EventEmitter<T> { emit(v?: T): void; subscribe(f?: any): any; }
  export function output<T = void>(o?: any): { emit(v: T): void };
  export function effect(fn: any, o?: any): any;
  export function untracked<T>(fn: () => T): T;
  export const Component: any; export const Directive: any; export const Pipe: any; export const Injectable: any; export const Service: any;
  export const Input: any; export const Output: any; export const HostListener: any; export const HostBinding: any; export const ViewChild: any; export const NgModule: any;
}
declare module '@angular/common/http' {
  import { Observable } from 'rxjs';
  import { Signal } from '@angular/core';
  export class HttpResponse<T> { body: T | null; status: number; headers: any; }
  export class HttpHeaders { constructor(o?: any); get(k: string): string | null; set(k: string, v: any): HttpHeaders; }
  export class HttpParams { constructor(o?: any); set(k: string, v: any): HttpParams; append(k: string, v: any): HttpParams; }
  export class HttpClient {
    get<T>(url: string, o: { observe: 'response'; [k: string]: any }): Observable<HttpResponse<T>>;
    get<T>(url: string, o?: any): Observable<T>;
    post<T>(url: string, body: any, o: { observe: 'response'; [k: string]: any }): Observable<HttpResponse<T>>;
    post<T>(url: string, body?: any, o?: any): Observable<T>;
    put<T>(url: string, body: any, o: { observe: 'response'; [k: string]: any }): Observable<HttpResponse<T>>;
    put<T>(url: string, body?: any, o?: any): Observable<T>;
    patch<T>(url: string, body: any, o: { observe: 'response'; [k: string]: any }): Observable<HttpResponse<T>>;
    patch<T>(url: string, body?: any, o?: any): Observable<T>;
    delete<T>(url: string, o?: any): Observable<T>;
    request<T>(method: string, url: string, o?: any): Observable<T>;
  }
  export interface HttpResourceRef<T> { value: Signal<T>; hasValue(): boolean; isLoading: Signal<boolean>; error: Signal<unknown>; reload(): boolean; headers: Signal<any>; }
  export function httpResource<T>(req: any, o?: any): HttpResourceRef<T | undefined>;
}
declare module '@angular/forms' {
  export class AbstractControl<T = any> { value: T; valid: boolean; invalid: boolean; getRawValue(): T; setValue(v: T): void; patchValue(v: any): void; reset(v?: any): void; }
  export class FormControl<T = any> extends AbstractControl<T> { constructor(v?: any, o?: any); }
  export class FormGroup<T extends { [k: string]: AbstractControl<any> } = any> extends AbstractControl<any> { controls: T; constructor(c: T, o?: any); get(k: string): AbstractControl | null; }
  export class FormArray<T extends AbstractControl<any> = any> extends AbstractControl<any> { controls: T[]; constructor(c: T[], o?: any); }
  export const Validators: any; export const ReactiveFormsModule: any; export const FormsModule: any; export const FormBuilder: any; export const NonNullableFormBuilder: any;
}
declare module 'rxjs' {
  export class Observable<T> {
    subscribe(o?: ((v: T) => void) | { next?: (v: T) => void; error?: (e: any) => void; complete?: () => void }): any;
    pipe(...ops: any[]): Observable<any>;
  }
  export class Subject<T> extends Observable<T> { next(v: T): void; }
  export class BehaviorSubject<T> extends Subject<T> { constructor(v: T); getValue(): T; value: T; }
  export function of<T>(...v: T[]): Observable<T>;
}
declare module '@angular/core/rxjs-interop' {
  import { Observable } from 'rxjs';
  import { Signal } from '@angular/core';
  export function toSignal<T>(o: Observable<T>, opts?: any): Signal<T | undefined>;
}
declare module '*';
declare function __pipe(...a: any[]): any;
`;

const STUB_FILE = '/__teslon__/ng-stubs.d.ts';

interface Probe { pos: number; name: string; line: number; kind: TypedRead['kind']; label: string; expr: string; control?: boolean }
interface Tcb { file: string; text: string; probes: Probe[]; tplFile: string; component: string }

const lineAt = (text: string, i: number): number => { let n = 1; for (let k = 0; k < i && k < text.length; k++) if (text.charCodeAt(k) === 10) n++; return n; };

/** Visible text of elements, with bindings dropped: a column header, a label. */
function plainText(nodes: readonly ng.TmplAstNode[]): string {
  const out: string[] = [];
  const walk = (ns: readonly ng.TmplAstNode[]): void => {
    for (const n of ns) {
      if (n instanceof ng.TmplAstText) out.push(n.value);
      else if (n instanceof ng.TmplAstElement) { if (!/^(button|select|input|fa-icon)$/.test(n.name)) walk(n.children); }
      else if (n instanceof ng.TmplAstTemplate) walk(n.children);
      else if (n instanceof ng.TmplAstIfBlock) for (const b of n.branches) walk(b.children);
    }
  };
  walk(nodes);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Turn one template into a type-check block, recording where each property read lands in it. */
function buildTcb(tplText: string, tplFile: string, lineOffset: number, component: string, cls: string, isDefault: boolean): Tcb | null {
  let parsed: ReturnType<typeof ng.parseTemplate>;
  try { parsed = ng.parseTemplate(tplText, tplFile, { preserveWhitespaces: false }); } catch { return null; }
  const base = component.slice(component.lastIndexOf('/') + 1).replace(/\.ts$/, '');
  const file = `${component.slice(0, component.lastIndexOf('/') + 1)}__teslon_tcb_${base}.ts`;
  let buf = `import ${isDefault ? '__C' : `{ ${cls} as __C }`} from './${base}';\nfunction __tcb(ctx: __C) {\n`;
  const probes: Probe[] = [];
  const w = (s: string): void => { buf += s; };

  // labels: <label for="id">, table headers by column, <dt> before <dd>
  const labelFor = new Map<string, string>();
  const headers = new Map<ng.TmplAstElement, string[]>();
  const pre = (ns: readonly ng.TmplAstNode[], table: ng.TmplAstElement | null): void => {
    for (const n of ns) {
      if (n instanceof ng.TmplAstElement) {
        if (n.name === 'label') { const f = n.attributes.find((a) => a.name === 'for')?.value; if (f) labelFor.set(f, plainText(n.children)); }
        const t = n.name === 'table' ? n : table;
        if (n.name === 'table') headers.set(n, []);
        if (n.name === 'th' && t) headers.get(t)!.push(plainText(n.children));
        pre(n.children, t);
      } else if (n instanceof ng.TmplAstTemplate) pre(n.children, table);
      else if (n instanceof ng.TmplAstIfBlock) for (const b of n.branches) pre(b.children, table);
      else if (n instanceof ng.TmplAstForLoopBlock) { pre(n.children, table); if (n.empty) pre(n.empty.children, table); }
      else if (n instanceof ng.TmplAstSwitchBlock) for (const g of n.groups) pre(g.children, table);
      else if (n instanceof ng.TmplAstDeferredBlock) pre(n.children, table);
    }
  };
  pre(parsed.nodes, null);

  interface Ctx { scope: Set<string>; label: string; kind: TypedRead['kind']; formGroup: string | null; table: ng.TmplAstElement | null; select: string }
  const exprText = (a: ng.AST): string => (a instanceof ng.ASTWithSource ? a.source ?? '' : '');

  const postfix = (a: ng.AST): boolean => a instanceof ng.ImplicitReceiver || a instanceof ng.PropertyRead || a instanceof ng.SafePropertyRead || a instanceof ng.Call || a instanceof ng.SafeCall || a instanceof ng.KeyedRead || a instanceof ng.SafeKeyedRead || a instanceof ng.NonNullAssert;
  const ex = (a: ng.AST, c: Ctx, probe: boolean, src: string): void => {
    if (a instanceof ng.ASTWithSource) return ex(a.ast, c, probe, a.source ?? src);
    if (a instanceof ng.ImplicitReceiver) { w('ctx'); return; }
    if (a instanceof ng.PropertyRead || a instanceof ng.SafePropertyRead) {
      if (a.receiver instanceof ng.ImplicitReceiver && !(a.receiver instanceof ng.ThisReceiver) && c.scope.has(a.name)) { w(a.name); return; }
      if (!postfix(a.receiver)) w('(');
      ex(a.receiver, c, probe, src);
      if (!postfix(a.receiver)) w(')');
      w(a instanceof ng.SafePropertyRead ? '?.' : '.');
      if (probe) probes.push({ pos: buf.length, name: a.name, line: lineAt(tplText, a.sourceSpan.start) + lineOffset, kind: c.kind, label: c.label, expr: src.trim() });
      w(a.name);
      return;
    }
    if (a instanceof ng.KeyedRead || a instanceof ng.SafeKeyedRead) { ex(a.receiver, c, probe, src); w(a instanceof ng.SafeKeyedRead ? '?.[' : '['); ex(a.key, c, probe, src); w(']'); return; }
    if (a instanceof ng.Call || a instanceof ng.SafeCall) {
      ex(a.receiver, c, probe, src); w(a instanceof ng.SafeCall ? '?.(' : '(');
      a.args.forEach((x, i) => { if (i) w(', '); ex(x, c, probe, src); });
      w(')'); return;
    }
    if (a instanceof ng.LiteralPrimitive) { w(a.value === undefined ? 'undefined' : JSON.stringify(a.value)); return; }
    if (a instanceof ng.LiteralArray) { w('['); a.expressions.forEach((x, i) => { if (i) w(', '); ex(x, c, probe, src); }); w(']'); return; }
    if (a instanceof ng.LiteralMap) { w('({'); a.keys.forEach((k, i) => { if (i) w(', '); w(k.kind === 'spread' ? '...' : `${JSON.stringify(k.key)}: `); ex(a.values[i]!, c, probe, src); }); w('})'); return; }
    if (a instanceof ng.Unary) { w(`(${a.operator}`); ex(a.expr, c, probe, src); w(')'); return; }
    if (a instanceof ng.Binary) {
      // assignments only happen in event handlers, which are not read here
      if (/^(=|\+=|-=|\*=|\/=|%=|\?\?=|&&=|\|\|=|\*\*=)$/.test(a.operation)) { w('(null as any)'); return; }
      w('('); ex(a.left, c, probe, src); w(` ${a.operation} `); ex(a.right, c, probe, src); w(')'); return;
    }
    if (a instanceof ng.PrefixNot) { w('(!'); ex(a.expression, c, probe, src); w(')'); return; }
    if (a instanceof ng.TypeofExpression) { w('(typeof '); ex(a.expression, c, probe, src); w(')'); return; }
    if (a instanceof ng.VoidExpression) { w('(void '); ex(a.expression, c, probe, src); w(')'); return; }
    if (a instanceof ng.NonNullAssert) { w('('); ex(a.expression, c, probe, src); w(')!'); return; }
    if (a instanceof ng.ParenthesizedExpression) { w('('); ex(a.expression, c, probe, src); w(')'); return; }
    if (a instanceof ng.Conditional) { w('('); ex(a.condition, c, probe, src); w(' ? '); ex(a.trueExp, c, probe, src); w(' : '); ex(a.falseExp, c, probe, src); w(')'); return; }
    if (a instanceof ng.BindingPipe) { w('__pipe('); ex(a.exp, c, probe, src); for (const x of a.args) { w(', '); ex(x, c, probe, src); } w(')'); return; }
    if (a instanceof ng.Interpolation) { w('['); a.expressions.forEach((x, i) => { if (i) w(', '); ex(x, c, probe, src); }); w(']'); return; }
    if (a instanceof ng.TemplateLiteral) { w('['); a.expressions.forEach((x, i) => { if (i) w(', '); ex(x, c, probe, src); }); w('].join("")'); return; }
    if (a instanceof ng.ArrowFunction) {
      const inner = new Set(c.scope);
      for (const p of a.parameters) inner.add(p.name);
      w(`((${a.parameters.map((p) => `${p.name}: any`).join(', ')}) => `); ex(a.body, { ...c, scope: inner }, probe, src); w(')'); return;
    }
    w('(null as any)');
  };
  const stmt = (a: ng.AST, c: Ctx, probe = true): void => { w('  ('); ex(a, c, probe, exprText(a)); w(');\n'); };

  const walk = (ns: readonly ng.TmplAstNode[], c: Ctx): void => {
    let lastDt = '';
    const tdIndex = { n: 0 };
    for (const n of ns) {
      if (n instanceof ng.TmplAstElement) {
        let label = c.label, kind = c.kind;
        let table = c.table, select = c.select, formGroup = c.formGroup;
        if (n.name === 'table') table = n;
        if (n.name === 'tr') tdIndex.n = 0;
        if (n.name === 'dt') lastDt = plainText(n.children);
        if (n.name === 'dd') label = lastDt;
        if (n.name === 'td' || n.name === 'th') { if (n.name === 'td' && table) label = headers.get(table)?.[tdIndex.n] ?? label; tdIndex.n++; }
        const id = n.attributes.find((a) => a.name === 'id')?.value ?? '';
        if (n.name === 'select') select = labelFor.get(id) ?? n.attributes.find((a) => a.name === 'formControlName')?.value ?? '';
        if (n.name === 'option') { label = select; kind = 'option'; }
        const fg = n.inputs.find((i) => i.name === 'formGroup');
        if (fg) {
          // the form group expression, printed without probes, to type its controls
          const before = buf;
          ex(fg.value, c, false, exprText(fg.value));
          formGroup = buf.slice(before.length);
          buf = before;
        }
        const ctrl = n.attributes.find((a) => a.name === 'formControlName')?.value;
        if (ctrl && formGroup && /^[A-Za-z_$][\w$]*$/.test(ctrl)) {
          w(`  ((${formGroup}).controls.`);
          probes.push({ pos: buf.length, name: ctrl, line: lineAt(tplText, n.sourceSpan.start.offset) + lineOffset, kind: 'control', label: labelFor.get(id) ?? ctrl, expr: `formControlName="${ctrl}"`, control: true });
          w(`${ctrl});\n`);
        }
        const inner: Ctx = { ...c, label, kind: kind === 'option' ? 'option' : 'show', table, select, formGroup };
        for (const i of n.inputs) if (i.name !== 'formGroup') stmt(i.value, { ...inner, kind: kind === 'option' ? 'option' : 'attr' });
        const refs = new Set(c.scope);
        for (const r of n.references) refs.add(r.name);
        walk(n.children, { ...inner, scope: refs });
        // the tr counted its cells; a following row starts again
        continue;
      }
      if (n instanceof ng.TmplAstBoundText) { stmt(n.value, { ...c, kind: c.kind === 'option' ? 'option' : 'show' }); continue; }
      if (n instanceof ng.TmplAstIfBlock) {
        for (const b of n.branches) {
          const scope = new Set(c.scope);
          w('  {\n');
          if (b.expression) stmt(b.expression, { ...c, kind: 'condition' });
          if (b.expression && b.expressionAlias) { w(`  const ${b.expressionAlias.name} = (`); ex(b.expression, c, false, ''); w(')!;\n'); scope.add(b.expressionAlias.name); }
          walk(b.children, { ...c, scope });
          w('  }\n');
        }
        continue;
      }
      if (n instanceof ng.TmplAstForLoopBlock) {
        const scope = new Set(c.scope);
        w(`  for (const ${n.item.name} of (`); ex(n.expression, { ...c, kind: 'loop' }, true, exprText(n.expression)); w(') ?? []) {\n');
        scope.add(n.item.name);
        for (const v of n.contextVariables) { w(`  const ${v.name}: any = 0;\n`); scope.add(v.name); }
        walk(n.children, { ...c, scope });
        w('  }\n');
        if (n.empty) walk(n.empty.children, c);
        continue;
      }
      if (n instanceof ng.TmplAstSwitchBlock) {
        stmt(n.expression, { ...c, kind: 'condition' });
        for (const g of n.groups) { for (const k of g.cases) if (k.expression) stmt(k.expression, { ...c, kind: 'condition' }); w('  {\n'); walk(g.children, c); w('  }\n'); }
        continue;
      }
      if (n instanceof ng.TmplAstDeferredBlock) { walk(n.children, c); continue; }
      if (n instanceof ng.TmplAstLetDeclaration) {
        w(`  const ${n.name} = (`); ex(n.value, c, true, exprText(n.value)); w(');\n');
        c.scope.add(n.name);
        continue;
      }
      if (n instanceof ng.TmplAstTemplate) {
        // *ngIf="x as y" / *ngFor="let a of list" / <ng-template let-v>
        const scope = new Set(c.scope);
        const forOf = n.templateAttrs.find((a) => a.name === 'ngForOf');
        const ifExpr = n.templateAttrs.find((a) => a.name === 'ngIf');
        w('  {\n');
        for (const v of n.variables) {
          if (forOf && v.value === '$implicit' && forOf instanceof ng.TmplAstBoundAttribute) { w(`  for (const ${v.name} of (`); ex(forOf.value, { ...c, kind: 'loop' }, true, exprText(forOf.value)); w(') ?? []) {\n'); }
          else if (ifExpr && v.value === 'ngIf' && ifExpr instanceof ng.TmplAstBoundAttribute) { w(`  { const ${v.name} = (`); ex(ifExpr.value, c, false, ''); w(')!;\n'); }
          else w(`  { const ${v.name}: any = null;\n`);
          scope.add(v.name);
        }
        for (const a of n.templateAttrs) if (a instanceof ng.TmplAstBoundAttribute && a.name !== 'ngForOf') stmt(a.value, { ...c, kind: a.name === 'ngIf' ? 'condition' : 'attr' });
        walk(n.children, { ...c, scope });
        w('  }\n'.repeat(n.variables.length));
        w('  }\n');
        continue;
      }
    }
  };
  walk(parsed.nodes, { scope: new Set(), label: '', kind: 'show', formGroup: null, table: null, select: '' });
  w('}\n');
  return { file, text: buf, probes, tplFile, component };
}

/** The interface, class or type alias a property declaration belongs to. */
function ownerOf(decl: ts.Declaration): string | null {
  const p = decl.parent;
  if (!p) return null;
  if ((ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text;
  if (ts.isTypeLiteralNode(p) && p.parent && ts.isTypeAliasDeclaration(p.parent)) return p.parent.name.text;
  return null;
}

/** `name: FormControl<IBankAccount['name']>`: the model field a form control holds. */
function controlModel(decl: ts.Declaration, checker: ts.TypeChecker): { decl: ts.Declaration; owner: string; prop: string } | null {
  const tn = (decl as ts.PropertySignature).type;
  if (!tn) return null;
  let hit: { decl: ts.Declaration; owner: string; prop: string } | null = null;
  const look = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isIndexedAccessTypeNode(n) && ts.isLiteralTypeNode(n.indexType) && ts.isStringLiteral(n.indexType.literal)) {
      const t = checker.getTypeFromTypeNode(n.objectType);
      const p = t.getProperty(n.indexType.literal.text);
      const d = p?.declarations?.[0];
      const owner = d ? ownerOf(d) : null;
      if (d && owner) hit = { decl: d, owner, prop: n.indexType.literal.text };
    }
    ts.forEachChild(n, look);
  };
  look(tn);
  return hit;
}

/** Every typed read in every Angular template of the snapshot. */
export function angularReads(snap: Snapshot): TypedRead[] {
  const files = snap.files.filter(isNgFile);
  const resolve = makeResolver(snap);
  const tcbs: Tcb[] = [];
  for (const f of files) {
    const raw = snap.read(f);
    if (!raw || !raw.includes('@Component')) continue;
    const sf = ts.createSourceFile(f, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const st of sf.statements) {
      if (!ts.isClassDeclaration(st) || !st.name) continue;
      const meta = decoratorArgs(st, 'Component');
      if (!meta) continue;
      const mods = ts.getModifiers(st) ?? [];
      const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (!exported) continue;
      const tu = str(prop(meta, 'templateUrl'));
      const inline = prop(meta, 'template');
      if (tu) {
        const t = norm(join(f.slice(0, f.lastIndexOf('/')), tu));
        const txt = snap.read(t);
        const tcb = txt !== null ? buildTcb(txt, t, 0, f, st.name.text, isDefault) : null;
        if (tcb) tcbs.push(tcb);
      } else if (inline && (ts.isNoSubstitutionTemplateLiteral(inline) || ts.isStringLiteral(inline))) {
        const tcb = buildTcb(inline.text, f, sf.getLineAndCharacterOfPosition(inline.getStart(sf)).line, f, st.name.text, isDefault);
        if (tcb) tcbs.push(tcb);
      }
    }
  }
  if (!tcbs.length) return [];

  const abs = (p: string): string => `/${p}`;
  const rel = (p: string): string => p.replace(/^\//, '');
  const virtual = new Map<string, string>([[STUB_FILE, STUBS], ...tcbs.map((t) => [abs(t.file), t.text] as [string, string])]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noEmit: true, skipLibCheck: true,
    lib: ['lib.es2022.d.ts'], types: [], experimentalDecorators: true, allowJs: false, noResolve: false,
  };
  const base = ts.createCompilerHost(options, true);
  const libDir = base.getDefaultLibLocation?.() ?? '';
  const read = (fileName: string): string | undefined => virtual.get(fileName) ?? (fileName.startsWith(libDir) ? base.readFile(fileName) : (snap.read(rel(fileName)) ?? undefined));
  const host: ts.CompilerHost = {
    ...base,
    getCurrentDirectory: () => '/',
    fileExists: (f) => read(f) !== undefined,
    readFile: read,
    getSourceFile: (fileName, lang) => {
      if (fileName.startsWith(libDir)) return base.getSourceFile(fileName, lang);
      const text = read(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, lang, true, ts.ScriptKind.TS);
    },
    resolveModuleNames: (names, containing) => names.map((spec) => {
      const from = rel(containing);
      const hit = spec.startsWith('.') && from.includes('__teslon_tcb_')
        ? resolve(from, spec)
        : resolve(from, spec);
      return hit ? { resolvedFileName: abs(hit), extension: ts.Extension.Ts, isExternalLibraryImport: false } : undefined;
    }),
    writeFile: () => undefined,
  };
  const program = ts.createProgram({ rootNames: [STUB_FILE, ...tcbs.map((t) => abs(t.file))], options, host });
  const checker = program.getTypeChecker();

  const out: TypedRead[] = [];
  const seen = new Set<string>();
  for (const t of tcbs) {
    const sf = program.getSourceFile(abs(t.file));
    if (!sf) continue;
    const at = new Map(t.probes.map((p) => [p.pos, p]));
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const p = at.get(n.getStart(sf));
        if (p && n.text === p.name) {
          const sym = checker.getSymbolAtLocation(n);
          for (const d0 of sym?.declarations ?? []) {
            let d: ts.Declaration = d0, owner = ownerOf(d0), propName = p.name;
            if (p.control) { const m = controlModel(d0, checker); if (!m) continue; d = m.decl; owner = m.owner; propName = m.prop; }
            const file = d.getSourceFile().fileName;
            if (!owner || file === STUB_FILE || file.startsWith(libDir)) continue;
            const r: TypedRead = {
              file: t.tplFile, line: p.line, expr: p.expr, type: owner, typeFile: rel(file),
              declLine: d.getSourceFile().getLineAndCharacterOfPosition(d.getStart()).line + 1,
              prop: propName, kind: p.kind, label: p.label, component: t.component,
            };
            const k = `${r.file}:${r.line}:${r.type}.${r.prop}:${r.kind}`;
            if (!seen.has(k)) { seen.add(k); out.push(r); }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
