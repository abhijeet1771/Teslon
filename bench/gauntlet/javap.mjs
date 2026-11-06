/**
 * Read compiled classes through `javap -c -p -v` into plain facts: classes, supertypes with generic arguments,
 * fields, methods, annotations, the instructions that call, read, write, create and load constants, the lambdas
 * each method makes, and the source lines of each method. These are the compiler's facts. Nothing here shares
 * code with Teslon's own readers.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.class') ? [p] : []; });

/* ---------- JVM signatures: Lpkg/A<Lpkg/B;>; → { name: 'pkg.A', args: [{ name: 'pkg.B', args: [] }] } ---------- */
function sigParser(s) {
  let i = 0;
  const peek = () => s[i];
  function typeParams() { if (peek() !== '<') return; let depth = 0; do { if (s[i] === '<') depth++; else if (s[i] === '>') depth--; i++; } while (depth > 0 && i < s.length); }
  function ref() {
    const c = s[i];
    if (c === 'L') {
      i++; let name = ''; const args = [];
      while (i < s.length && s[i] !== ';') {
        if (s[i] === '<') { i++; while (s[i] !== '>') args.push(typeArg()); i++; }
        else if (s[i] === '.') { name += '$'; i++; args.length = 0; }
        else name += s[i++];
      }
      i++;
      return { name: name.replace(/\//g, '.'), args };
    }
    if (c === 'T') { i++; let n = ''; while (s[i] !== ';') n += s[i++]; i++; return { name: `T:${n}`, args: [] }; }
    if (c === '[') { i++; const t = ref(); return { name: 'array', args: [t] }; }
    i++; return { name: { B: 'byte', C: 'char', D: 'double', F: 'float', I: 'int', J: 'long', S: 'short', Z: 'boolean', V: 'void' }[c] ?? c, args: [] };
  }
  function typeArg() { const c = s[i]; if (c === '*') { i++; return { name: 'java.lang.Object', args: [] }; } if (c === '+' || c === '-') i++; return ref(); }
  return {
    cls() { typeParams(); const out = []; while (i < s.length) out.push(ref()); return out; },
    method() { typeParams(); const params = []; i++; while (s[i] !== ')') params.push(ref()); i++; const ret = ref(); return { params, ret }; },
    field() { return ref(); },
  };
}
export const parseClassSig = (s) => sigParser(s).cls();
export const parseMethodSig = (s) => sigParser(s).method();
export const parseFieldSig = (s) => sigParser(s).field();

/* ---------- annotations, from javap's readable form ---------- */
function readAnnotations(lines, i, indent) {
  // lines[i] is the "RuntimeVisibleAnnotations:" line; entries follow at a deeper indent
  const out = [];
  let j = i + 1;
  const ind = (l) => l.length - l.trimStart().length;
  let target = '';
  while (j < lines.length && (ind(lines[j]) > indent || !lines[j].trim())) {
    const l = lines[j];
    const t = l.trim();
    const ix = /^\d+: #\d+\(.*?\)(?::\s*(.*))?$/.exec(t);
    if (ix) { target = ix[1] ?? ''; j++; continue; }
    const m = /^([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)(\()?$/.exec(t);
    if (m) {
      const a = { type: m[1], values: {}, target };
      if (m[2]) {
        const base = ind(l);
        j++;
        let body = '';
        while (j < lines.length && !(ind(lines[j]) === base && lines[j].trim() === ')')) { body += lines[j].trim() + '\n'; j++; }
        // element lines: name=value, at one level; nested annotations are kept as text
        for (const em of body.matchAll(/^([\w$]+)=(.*)$/gm)) a.values[em[1]] = em[2];
      }
      out.push(a);
    }
    j++;
  }
  return { list: out, next: j };
}
export const strings = (v) => (v == null ? [] : [...v.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]));
export const classes = (v) => (v == null ? [] : [...v.matchAll(/class L([\w/$]+);/g)].map((m) => m[1].replace(/\//g, '.')));
export const enums = (v) => (v == null ? [] : [...v.matchAll(/L[\w/$]+;\.(\w+)/g)].map((m) => m[1]));

/* ---------- one javap run per module ---------- */
export function readModule(classDir, module) {
  const files = walk(classDir);
  if (!files.length) return [];
  const names = files.map((f) => relative(classDir, f).replace(/\.class$/, '').replace(/[\\/]/g, '.'));
  const out = [];
  for (let k = 0; k < names.length; k += 60) {
    const txt = execFileSync('javap', ['-c', '-p', '-v', '-cp', classDir, ...names.slice(k, k + 60)], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    out.push(...parse(txt, module));
  }
  return out;
}

function parse(txt, module) {
  const lines = txt.split('\n');
  const out = [];
  let c = null, m = null, inBody = false, section = '', bsm = null;
  const ind = (l) => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const t = l.trim();
    if (l.startsWith('Classfile ')) { c = { module, name: '', source: '', flags: '', super: null, ifaces: [], supers: [], ann: [], fields: [], methods: [], bootstrap: [], record: [] }; out.push(c); inBody = false; m = null; section = ''; continue; }
    if (!c) continue;
    if (!inBody) {
      if (/^\s+Compiled from "(.*)"/.test(l)) { c.source = /"(.*)"/.exec(l)[1]; continue; }
      if (/^[a-z].*\b(class|interface|enum)\b/.test(l) && !c.name) {
        const h = /\b(?:class|interface|enum)\s+([\w.$]+)/.exec(l);
        c.name = h[1];
        c.kind = /\binterface\b/.test(l) ? (/@interface|ACC_ANNOTATION/.test(l) ? 'annotation' : 'interface') : /\benum\b/.test(l) ? 'enum' : 'class';
        const imp = /\bimplements\s+(.*)$/.exec(l);
        if (imp && !/</.test(imp[1])) c.ifaces = imp[1].split(',').map((x) => x.trim());
        if (c.kind === 'interface') { const ex = /\bextends\s+(.*)$/.exec(l); if (ex && !/</.test(ex[1])) c.ifaces = ex[1].split(',').map((x) => x.trim()); }
        continue;
      }
      if (/^\s+flags: /.test(l)) { c.flags = t; if (/ACC_ANNOTATION/.test(t)) c.kind = 'annotation'; if (/ACC_ENUM/.test(t)) c.kind = 'enum'; if (/ACC_SYNTHETIC/.test(t)) c.synthetic = true; continue; }
      if (/^\s+super_class: /.test(l)) { const s = /\/\/\s*(\S+)/.exec(l); c.super = s ? s[1].replace(/\//g, '.') : null; continue; }
      if (t === '{') { inBody = true; continue; }
      continue;
    }
    // class attributes after the members
    if (l === '}') { inBody = 'after'; m = null; continue; }
    if (inBody === 'after') {
      if (/^Signature: /.test(l)) { const s = /\/\/\s*(.*)$/.exec(l)[1].trim(); const sup = parseClassSig(s); c.supers = sup; c.super = sup[0]?.name ?? c.super; if (c.kind === 'interface') c.ifaces = sup.slice(1).map((x) => x.name); else c.ifaces = sup.slice(1).map((x) => x.name); continue; }
      if (/^RuntimeVisibleAnnotations:/.test(l)) { const r = readAnnotations(lines, i, 0); c.ann.push(...r.list); i = r.next - 1; continue; }
      if (/^BootstrapMethods:/.test(l)) { section = 'bsm'; continue; }
      if (/^Record:/.test(l)) { section = 'record'; continue; }
      if (/^[A-Z]\w+:/.test(l)) { section = ''; continue; }
      if (section === 'bsm') {
        const e = /^\s+(\d+): #\d+ (\S+) (\S+)/.exec(l);
        if (e) { bsm = { factory: e[3], handles: [] }; c.bootstrap[Number(e[1])] = bsm; continue; }
        const h = /^\s+#\d+ REF_(\w+) ([\w/$]+)\.([\w$<>"]+):(\S+)/.exec(l);
        if (h && bsm) bsm.handles.push({ ref: h[1], owner: h[2].replace(/\//g, '.'), name: h[3].replace(/"/g, ''), desc: h[4] });
        continue;
      }
      if (section === 'record') { const r = /^  ([\w.$<>,\[\] ]+) (\w+);$/.exec(l); if (r) c.record.push(r[2]); continue; }
      continue;
    }
    // members
    if (ind(l) === 2 && t.endsWith(';') && !t.startsWith('//')) {
      const decl = t.slice(0, -1);
      const isMethod = decl.includes('(') || decl === 'static {}';
      if (isMethod) {
        let name;
        if (decl === 'static {}') name = '<clinit>';
        else { const nm = /([\w.$]+)\((?:[^()]*)\)(?:\s+throws\s+[\w.$, ]+)?$/.exec(decl); name = nm ? nm[1] : '?'; if (name === c.name) name = '<init>'; }
        m = { name, desc: '', flags: '', decl, sig: null, ann: [], pann: [], tann: [], calls: [], fieldsRead: [], fieldsWritten: [], news: [], ldc: [], indy: [], lines: [], code: [] };
        c.methods.push(m);
      } else {
        const fm = /([\w$]+)$/.exec(decl.replace(/\s*=.*$/, ''));
        m = { field: true, name: fm ? fm[1] : '?', desc: '', flags: '', decl, sig: null, ann: [], tann: [], constant: null };
        c.fields.push(m);
      }
      section = '';
      continue;
    }
    if (!m) continue;
    if (ind(l) === 4) {
      if (t.startsWith('descriptor: ')) { m.desc = t.slice(12); continue; }
      if (t.startsWith('flags: ')) { m.flags = t; continue; }
      if (t.startsWith('Signature: ')) { m.sig = /\/\/\s*(.*)$/.exec(t)[1].trim(); continue; }
      if (t.startsWith('ConstantValue: ')) { m.constant = t.slice(15); continue; }
      if (t === 'Code:') { section = 'code'; continue; }
      if (t === 'RuntimeVisibleAnnotations:') { const r = readAnnotations(lines, i, 4); m.ann.push(...r.list); i = r.next - 1; section = ''; continue; }
      if (t === 'RuntimeVisibleTypeAnnotations:') { const r = readAnnotations(lines, i, 4); m.tann.push(...r.list); i = r.next - 1; section = ''; continue; }
      if (t === 'RuntimeVisibleParameterAnnotations:') {
        m.pann = [];
        let k = i + 1, cur = -1;
        while (k < lines.length && (ind(lines[k]) > 4 || !lines[k].trim())) {
          const pm = /^\s+parameter (\d+):/.exec(lines[k]);
          if (pm) { cur = Number(pm[1]); m.pann[cur] = []; k++; continue; }
          const am = /^\s+([a-zA-Z_$][\w$]*(?:\.[\w$]+)+)(\()?$/.exec(lines[k]);
          if (am && cur >= 0) m.pann[cur].push({ type: am[1], values: {} });
          k++;
        }
        i = k - 1;
        section = '';
        continue;
      }
      section = t.endsWith(':') ? t.slice(0, -1) : '';
      continue;
    }
    if (section === 'code') {
      const ins = /^\s+(\d+): (\w+)\s*(.*)$/.exec(l);
      if (ins) {
        const op = ins[2];
        const cm = /\/\/\s*(.*)$/.exec(ins[3]);
        const com = cm ? cm[1] : '';
        m.code.push(op);
        if (/^invoke(virtual|interface|static|special)$/.test(op)) {
          const r = /^(?:Interface)?Method ([\w/$]+\.)?("?[\w$<>]+"?):(\S+)/.exec(com);
          if (r) m.calls.push({ op, owner: r[1] ? r[1].slice(0, -1).replace(/\//g, '.') : c.name, name: r[2].replace(/"/g, ''), desc: r[3] });
        } else if (op === 'invokedynamic') {
          const r = /InvokeDynamic #(\d+):([\w$]+):(\S+)/.exec(com);
          if (r) m.indy.push({ bsm: Number(r[1]), name: r[2], desc: r[3] });
        } else if (/^(get|put)(field|static)$/.test(op)) {
          const r = /^Field ([\w/$]+\.)?([\w$]+):(\S+)/.exec(com);
          if (r) (op.startsWith('get') ? m.fieldsRead : m.fieldsWritten).push({ owner: r[1] ? r[1].slice(0, -1).replace(/\//g, '.') : c.name, name: r[2], desc: r[3], static: op.endsWith('static') });
        } else if (op === 'new') {
          const r = /^class ([\w/$]+)/.exec(com);
          if (r) m.news.push(r[1].replace(/\//g, '.'));
        } else if (/^ldc/.test(op)) {
          const s = /^String (.*)$/.exec(com);
          if (s) m.ldc.push(s[1]);
          const k2 = /^class ([\w/$]+)/.exec(com);
          if (k2) m.ldc.push(`class:${k2[1].replace(/\//g, '.')}`);
        } else if (op === 'checkcast' || op === 'instanceof' || op === 'anewarray') {
          const r = /^class ([\w/$]+)/.exec(com);
          if (r) m.news.push(`ref:${r[1].replace(/\//g, '.')}`);
        }
        continue;
      }
      if (/^\s+LineNumberTable:/.test(l)) { section = 'lines'; continue; }
    }
    if (section === 'lines') {
      const ln = /^\s+line (\d+): \d+/.exec(l);
      if (ln) { m.lines.push(Number(ln[1])); continue; }
      if (/^\s+\w+:/.test(l)) section = /LocalVariableTable|LocalVariableTypeTable|StackMapTable/.test(l) ? 'skip' : '';
    }
  }
  return out.filter((x) => x.name);
}
