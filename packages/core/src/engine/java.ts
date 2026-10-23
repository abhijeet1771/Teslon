import { parse } from 'java-parser';

/**
 * Java, as declarations with line numbers.
 *
 * java-parser does the lexing, which is the part that has to be exactly
 * right: a string such as "/owners/*\/pets" is one token, and a comment is no
 * token at all. Earlier prototypes stripped comments with regular expressions
 * and twice ate real code that followed a "/*" inside a string. On top of the
 * token stream a small scanner recovers what the rules need: types, fields,
 * record components, methods, parameters and annotations, each with its line.
 * Method bodies are kept as tokens, so call sites can be read without a
 * second parser.
 */

export interface Tok {
  readonly t: string;
  readonly line: number;
}

export interface JAnnotation {
  readonly name: string;
  readonly line: number;
  /** Tokens between the parentheses, if any. */
  readonly args: readonly Tok[];
}

export interface JVar {
  readonly name: string;
  readonly type: string;
  readonly line: number;
  readonly annotations: readonly JAnnotation[];
}

export interface JField extends JVar {
  /** Tokens after `=`, if the field is initialised. */
  readonly init: readonly Tok[];
}

export interface JMethod {
  readonly name: string;
  readonly line: number;
  readonly returnType: string;
  readonly annotations: readonly JAnnotation[];
  readonly params: readonly JVar[];
  readonly body: readonly Tok[];
  readonly endLine: number;
}

export interface JType {
  readonly kind: 'class' | 'interface' | 'enum' | 'record' | 'annotation';
  readonly name: string;
  readonly line: number;
  readonly endLine: number;
  readonly annotations: readonly JAnnotation[];
  readonly supertypes: readonly string[];
  /** Fields, plus a record's components. */
  readonly fields: readonly JField[];
  readonly methods: readonly JMethod[];
  /** Enum constants, in order. */
  readonly constants: readonly string[];
}

export interface JavaFile {
  readonly path: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly pkg: string;
  readonly imports: readonly string[];
  readonly types: readonly JType[];
}

interface Leaf { image: string; startOffset: number; startLine: number; children?: undefined }
interface Node { children?: Record<string, (Node | Leaf)[]>; image?: string }

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'transient', 'volatile', 'strictfp', 'default', 'sealed', 'non-sealed']);

function tokenize(src: string): Tok[] {
  const cst = parse(src) as unknown as Node;
  const leaves: Leaf[] = [];
  const walk = (n: Node | Leaf): void => {
    if ((n as Leaf).image !== undefined && (n as Leaf).startOffset !== undefined) { leaves.push(n as Leaf); return; }
    const ch = (n as Node).children;
    if (!ch) return;
    for (const k of Object.keys(ch)) for (const c of ch[k] ?? []) walk(c);
  };
  walk(cst);
  leaves.sort((a, b) => a.startOffset - b.startOffset);
  return leaves.map((l) => ({ t: l.image, line: l.startLine }));
}

/** Index of the token that closes the bracket opened at `i`. */
function close(toks: readonly Tok[], i: number, open: string, shut: string): number {
  let d = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k]!.t;
    if (t === open) d++;
    else if (t === shut) { d--; if (d === 0) return k; }
  }
  return toks.length - 1;
}

const isIdent = (t: string | undefined): boolean => !!t && /^[A-Za-z_$][\w$]*$/.test(t);

export function readJavaFile(path: string, src: string): JavaFile {
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch (e) {
    return { path, ok: false, error: (e as Error).message.split('\n')[0] ?? 'parse error', pkg: '', imports: [], types: [] };
  }
  let pkg = '';
  const imports: string[] = [];
  const types: JType[] = [];
  let i = 0;

  const readAnnotation = (k: number): [JAnnotation, number] => {
    const line = toks[k]!.line;
    let j = k + 1;
    let name = toks[j]?.t ?? '';
    j++;
    while (toks[j]?.t === '.' && isIdent(toks[j + 1]?.t)) { name = toks[j + 1]!.t; j += 2; }
    let args: Tok[] = [];
    if (toks[j]?.t === '(') {
      const e = close(toks, j, '(', ')');
      args = toks.slice(j + 1, e);
      j = e + 1;
    }
    return [{ name, line, args }, j];
  };

  const readPrefix = (k: number): [JAnnotation[], number] => {
    const anns: JAnnotation[] = [];
    for (;;) {
      const t = toks[k]?.t;
      if (t === '@' && toks[k + 1]?.t !== 'interface') { const [a, n] = readAnnotation(k); anns.push(a); k = n; continue; }
      if (t !== undefined && MODIFIERS.has(t)) { k++; continue; }
      if (t === 'non' && toks[k + 1]?.t === '-' && toks[k + 2]?.t === 'sealed') { k += 3; continue; }
      return [anns, k];
    }
  };

  /** `<…>` starting at k, returns the index after it. */
  const skipGenerics = (k: number): number => {
    if (toks[k]?.t !== '<') return k;
    let d = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j]!.t;
      if (t === '<') d++;
      else if (t === '>') { d--; if (d === 0) return j + 1; }
      else if (t === '>>') { d -= 2; if (d <= 0) return j + 1; }
    }
    return toks.length;
  };

  const readVars = (from: number, to: number): JVar[] => {
    const out: JVar[] = [];
    let start = from, d = 0;
    const flush = (end: number): void => {
      if (end <= start) return;
      const [anns, k] = readPrefix(start);
      const seg = toks.slice(k, end).filter((x) => x.t !== '...');
      const name = seg[seg.length - 1];
      if (name && isIdent(name.t)) out.push({ name: name.t, type: seg.slice(0, -1).map((x) => x.t).join(''), line: name.line, annotations: anns });
    };
    for (let j = from; j < to; j++) {
      const t = toks[j]!.t;
      if (t === '<' || t === '(' || t === '[') d++;
      else if (t === '>' || t === ')' || t === ']') d--;
      else if (t === ',' && d === 0) { flush(j); start = j + 1; }
    }
    flush(to);
    return out;
  };

  const readType = (k: number, anns: JAnnotation[], outer: string): number => {
    const kw = toks[k]!.t;
    const line = toks[k]!.line;
    const kind: JType['kind'] = kw === '@' ? 'annotation' : (kw as JType['kind']);
    if (kw === '@') k++; // @interface
    const name = toks[k + 1]?.t ?? '';
    let j = skipGenerics(k + 2);
    const fields: JField[] = [];
    const methods: JMethod[] = [];
    const supertypes: string[] = [];
    const constants: string[] = [];
    if (kind === 'record' && toks[j]?.t === '(') {
      const e = close(toks, j, '(', ')');
      for (const v of readVars(j + 1, e)) fields.push({ ...v, init: [] });
      j = e + 1;
    }
    let mode = '';
    while (j < toks.length && toks[j]!.t !== '{') {
      const t = toks[j]!.t;
      if (t === 'extends' || t === 'implements' || t === 'permits') mode = t;
      else if (isIdent(t) && mode && mode !== 'permits' && toks[j - 1]?.t !== '.') {
        let full = t, m = j;
        while (toks[m + 1]?.t === '.' && isIdent(toks[m + 2]?.t)) { full += '.' + toks[m + 2]!.t; m += 2; }
        supertypes.push(full);
        j = skipGenerics(m + 1) - 1;
      }
      j++;
    }
    const bodyOpen = j;
    const bodyClose = close(toks, bodyOpen, '{', '}');
    j = bodyOpen + 1;
    const qualified = outer ? `${outer}.${name}` : name;
    if (kind === 'enum') {
      // constants come first, up to the first `;` at depth 0
      let d = 0;
      for (; j < bodyClose; j++) {
        const t = toks[j]!.t;
        if (t === '(' || t === '{') d++;
        else if (t === ')' || t === '}') d--;
        else if (d === 0 && t === ';') { j++; break; }
        else if (d === 0 && isIdent(t) && (toks[j - 1]?.t === '{' || toks[j - 1]?.t === ',' || j === bodyOpen + 1)) constants.push(t);
      }
    }
    while (j < bodyClose) {
      const t = toks[j]!.t;
      if (t === ';') { j++; continue; }
      if (t === '{') { j = close(toks, j, '{', '}') + 1; continue; } // initialiser
      const [manns, k2] = readPrefix(j);
      const t2 = toks[k2]?.t;
      if (t2 === 'class' || t2 === 'interface' || t2 === 'enum' || (t2 === '@' && toks[k2 + 1]?.t === 'interface') || (t2 === 'record' && isIdent(toks[k2 + 1]?.t) && (toks[k2 + 2]?.t === '(' || toks[k2 + 2]?.t === '<'))) {
        j = readType(k2, manns, qualified);
        continue;
      }
      // member: find the first ( = ; { at depth 0
      let m = skipGenerics(k2), d = 0, stop = -1;
      for (let q = m; q < bodyClose; q++) {
        const x = toks[q]!.t;
        if (x === '<') d++;
        else if (x === '>') d--;
        else if (x === '>>') d -= 2;
        else if (d <= 0 && (x === '(' || x === '=' || x === ';' || x === '{' || x === ',')) { stop = q; break; }
      }
      if (stop < 0) break;
      const stopT = toks[stop]!.t;
      // a record's compact constructor: `Name { ... }`, no parameter list
      if (stopT === '{' && stop === k2 + 1 && toks[k2]?.t === name) {
        const be = close(toks, stop, '{', '}');
        methods.push({ name, line: toks[k2]!.line, returnType: '', annotations: manns, params: [], body: toks.slice(stop + 1, be), endLine: toks[be]!.line });
        j = be + 1;
        continue;
      }
      if (stopT === '(') {
        const nameTok = toks[stop - 1]!;
        const pe = close(toks, stop, '(', ')');
        const params = readVars(stop + 1, pe);
        let q = pe + 1;
        while (q < bodyClose && toks[q]!.t !== '{' && toks[q]!.t !== ';') q++;
        let body: Tok[] = [];
        let endLine = toks[q]?.line ?? nameTok.line;
        if (toks[q]?.t === '{') {
          const be = close(toks, q, '{', '}');
          body = toks.slice(q + 1, be);
          endLine = toks[be]!.line;
          q = be + 1;
        } else q++;
        methods.push({ name: nameTok.t, line: nameTok.line, returnType: toks.slice(m, stop - 1).map((x) => x.t).join(''), annotations: manns, params, body, endLine });
        j = q;
        continue;
      }
      // field(s): Type a = …, b;
      const typeToks = toks.slice(m, stop - 1).map((x) => x.t).join('');
      let q = stop - 1;
      for (;;) {
        const nameTok = toks[q]!;
        let r = q + 1;
        let init: Tok[] = [];
        if (toks[r]?.t === '=') {
          let dd = 0, e = r + 1;
          for (; e < bodyClose; e++) {
            const x = toks[e]!.t;
            if (x === '(' || x === '{' || x === '[') dd++;
            else if (x === ')' || x === '}' || x === ']') dd--;
            else if (dd === 0 && (x === ';' || x === ',')) break;
          }
          init = toks.slice(r + 1, e);
          r = e;
        }
        if (isIdent(nameTok.t)) fields.push({ name: nameTok.t, type: typeToks, line: nameTok.line, annotations: manns, init });
        if (toks[r]?.t === ',' && isIdent(toks[r + 1]?.t)) { q = r + 1; continue; }
        j = r + 1;
        break;
      }
    }
    types.push({ kind, name: qualified, line, endLine: toks[bodyClose]?.line ?? line, annotations: anns, supertypes, fields, methods, constants });
    return bodyClose + 1;
  };

  while (i < toks.length) {
    const t = toks[i]!.t;
    if (t === 'package') {
      let e = i + 1;
      while (e < toks.length && toks[e]!.t !== ';') e++;
      pkg = toks.slice(i + 1, e).map((x) => x.t).join('');
      i = e + 1;
      continue;
    }
    if (t === 'import') {
      let e = i + 1;
      while (e < toks.length && toks[e]!.t !== ';') e++;
      imports.push(toks.slice(i + 1, e).map((x) => x.t).filter((x) => x !== 'static').join(''));
      i = e + 1;
      continue;
    }
    if (t === ';') { i++; continue; }
    const [anns, k] = readPrefix(i);
    const kw = toks[k]?.t;
    if (kw === 'class' || kw === 'interface' || kw === 'enum' || kw === 'record' || (kw === '@' && toks[k + 1]?.t === 'interface')) {
      i = readType(k, anns, '');
      continue;
    }
    i = k + 1;
  }
  return { path, ok: true, pkg, imports, types };
}

/* ---------- small readers used by the rules ---------- */

/** String literals among an annotation's arguments, unquoted. */
export function annStrings(a: JAnnotation): string[] {
  return a.args.filter((x) => /^"/.test(x.t)).map((x) => x.t.slice(1, -1));
}

/** `key = value` pairs at the top level of an annotation's arguments. */
export function annPairs(a: JAnnotation): Map<string, string> {
  const out = new Map<string, string>();
  let d = 0;
  const args = a.args;
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.t;
    if (t === '(' || t === '{') d++;
    else if (t === ')' || t === '}') d--;
    else if (d === 0 && t === '=' && isIdent(args[k - 1]?.t)) {
      let e = k + 1, dd = 0;
      for (; e < args.length; e++) {
        const x = args[e]!.t;
        if (x === '(' || x === '{') dd++;
        else if (x === ')' || x === '}') dd--;
        else if (dd === 0 && x === ',') break;
      }
      out.set(args[k - 1]!.t, args.slice(k + 1, e).map((x) => x.t).join(' '));
    }
  }
  return out;
}

/** `@Size(min = 1)` as written, for display. */
export function annText(a: JAnnotation): string {
  if (!a.args.length) return `@${a.name}`;
  const parts: string[] = [];
  for (const x of a.args) {
    if (x.t === ',' ) { parts.push(', '); continue; }
    if (x.t === '=') { parts.push(' = '); continue; }
    parts.push(x.t);
  }
  return `@${a.name}(${parts.join('')})`;
}

export function hasAnn(list: readonly JAnnotation[], ...names: string[]): JAnnotation | undefined {
  return list.find((a) => names.includes(a.name));
}
