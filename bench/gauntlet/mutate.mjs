#!/usr/bin/env node
/**
 * One behaviour mutant per method of the app, each proven by the compiler.
 *
 *   node bench/gauntlet/mutate.mjs <app> <built-dir> <out.json>
 *
 * For every method with a body in the app's own source (not a constructor, not generated), the line
 *   if (Thread.interrupted()) throw new IllegalStateException("teslon mutant");
 * is put right after the method's opening brace, on the same line, so no other line moves. A mutant is kept
 * only when javac compiles it and the compiled class differs from the original in that one method and no
 * other. Its truth is the oracle's: the areas whose flows run the method.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { buildOracle } from './oracle.mjs';
import { appConfig } from './apps.mjs';

export const STATEMENT = 'if (Thread.interrupted()) throw new IllegalStateException("teslon mutant");';
// a comment only: the compiled class must not change at all, and nothing is reached
export const COMMENT = '/* teslon: a comment only, nothing runs differently */';

/** Where a method's body opens in its source: the character right after its `{`, or null. */
export function bodyOpen(text, name, firstLine, paramCount) {
  const lines = text.split('\n');
  const starts = [0]; for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  const re = new RegExp(`([\\w>\\]])\\s+${name.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
  for (let ln = firstLine; ln >= Math.max(1, firstLine - 40); ln--) {
    const line = lines[ln - 1];
    re.lastIndex = 0;
    let m;
    const found = [];
    while ((m = re.exec(line))) found.push(m);
    for (const f of found.reverse()) {
      const before = line.slice(0, f.index + 1).trim().split(/\s+/).pop();
      if (/^(return|new|throw|else|case|yield)$/.test(before)) continue;
      if (/\/\//.test(line.slice(0, f.index))) continue;
      // balance the parameter list, then the next `{` opens the body (a `;` first means no body)
      let i = starts[ln - 1] + f.index + f[0].length - 1;
      let depth = 0, params = 0, any = false;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
        else if (depth === 1 && ch === ',') params++;
        else if (depth >= 1 && !/\s/.test(ch)) any = true;
      }
      if (any) params++;
      if (params !== paramCount) continue;
      for (i++; i < text.length; i++) {
        if (text[i] === '{') return i + 1;
        if (text[i] === ';' || text[i] === '}') return null;
      }
    }
  }
  return null;
}

const paramCount = (desc) => { const p = desc.slice(1, desc.indexOf(')')); let n = 0, i = 0; while (i < p.length) { while (p[i] === '[') i++; if (p[i] === 'L') i = p.indexOf(';', i) + 1; else i++; n++; } return n; };

// javap -c -p of one class, as { methodKey: normalised code }
function bodies(classDir, cls) {
  const txt = execFileSync('javap', ['-c', '-p', '-cp', classDir, cls], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  const out = {};
  let key = null;
  for (const l of txt.split('\n')) {
    if (/^  \S.*;$/.test(l)) { key = l.trim(); out[key] = ''; continue; }
    if (key) out[key] += l.replace(/#\d+(,\s*\d+)?/g, '#').replace(/^\s+\d+:/, '').replace(/\bldc_w\b/, 'ldc').replace(/\s+/g, ' ') + '\n';
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const ki = argv.indexOf('--kind');
  const kind = ki >= 0 ? argv.splice(ki, 2)[1] : 'behaviour';
  const [app, built, outFile] = argv;
  const cfg = appConfig(app, built);
  const o = buildOracle(cfg);
  const cand = [];
  for (const m of o.methods.values()) {
    const c = m.cls;
    if (/ACC_ABSTRACT|ACC_SYNTHETIC|ACC_BRIDGE|ACC_NATIVE/.test(m.flags) || /^(<init>|<clinit>)$/.test(m.name) || m.name.startsWith('lambda$') || !m.lines.length) continue;
    if (c.synthetic || /\$\d+$/.test(c.name)) continue;
    const mod = cfg.modules.find((x) => x.name === c.module);
    const pkg = c.name.replace(/\$.*$/, '').split('.').slice(0, -1).join('/');
    const rel = join(mod.srcRoot, pkg, c.source);
    const abs = join(built, rel);
    if (!existsSync(abs)) continue;
    cand.push({ m, mod, rel, abs });
  }
  if (kind === 'route') return routeMutants(o, cfg, built, outFile);
  // group by source file: one temp copy and one javac per mutant
  const work = mkdtempSync(join(tmpdir(), 'mutants-'));
  const cps = new Map(cfg.modules.map((x) => {
    const f = join(built, x.dir, 'cp.txt');
    const sib = cfg.modules.map((y) => y.classDir).join(':');
    return [x.name, `${existsSync(f) ? readFileSync(f, 'utf8').trim() + ':' : ''}${sib}`];
  }));
  const kept = [], dropped = [];
  const jobs = cand.map((k, i) => async () => {
    const text = readFileSync(k.abs, 'utf8');
    const at = bodyOpen(text, k.m.name, Math.min(...k.m.lines), paramCount(k.m.desc));
    if (at == null) { dropped.push({ id: k.m.id, why: 'no body in source (generated)' }); return; }
    const insert = kind === 'comment' ? COMMENT : STATEMENT;
    const mutated = text.slice(0, at) + ' ' + insert + text.slice(at);
    const d = join(work, `m${i}`);
    mkdirSync(join(d, 'src', dirname(k.rel)), { recursive: true });
    writeFileSync(join(d, 'src', k.rel), mutated);
    mkdirSync(join(d, 'out')); mkdirSync(join(d, 'gen'));
    try {
      await new Promise((res, rej) => {
        import('node:child_process').then(({ execFile }) => execFile('javac', ['-nowarn', '-parameters', '-cp', cps.get(k.mod.name), '-d', join(d, 'out'), '-s', join(d, 'gen'), join(d, 'src', k.rel)], { maxBuffer: 1 << 24 }, (err, so, se) => (err ? rej(new Error(String(se).split('\n').filter((l) => /error/.test(l)).slice(0, 2).join(' '))) : res())));
      });
    } catch (e) { dropped.push({ id: k.m.id, why: `javac: ${e.message.slice(0, 160)}` }); return; }
    const outer = k.m.cls.name;
    const a = bodies(k.mod.classDir, outer), b = bodies(join(d, 'out'), outer);
    const diff = Object.keys({ ...a, ...b }).filter((x) => a[x] !== b[x]);
    if (diff.length !== (kind === 'comment' ? 0 : 1)) { dropped.push({ id: k.m.id, why: `bytecode differs in ${diff.length} methods: ${diff.slice(0, 2).join(' | ')}` }); return; }
    const r = kind === 'comment' ? { hard: new Map(), content: new Map() } : o.reach(k.m.id);
    kept.push({
      id: `${k.m.cls.module}:${k.m.cls.name.split('.').pop()}.${k.m.name}${paramCount(k.m.desc) ? `/${paramCount(k.m.desc)}` : ''}`.replace(/^orderdesk:/, ''),
      method: k.m.id, file: k.rel, at, insert, kind, line: text.slice(0, at).split('\n').length, changed: diff[0] ?? null,
      hard: Object.fromEntries(r.hard), content: Object.fromEntries(r.content),
    });
  });
  const N = Math.max(2, Math.min(8, cpus().length));
  let next = 0;
  await Promise.all(Array.from({ length: N }, async () => { while (next < jobs.length) await jobs[next++](); }));
  rmSync(work, { recursive: true, force: true });
  kept.sort((x, y) => x.id.localeCompare(y.id));
  // two overloads can share an id: number them
  const seen = new Map(); for (const k of kept) { const n = seen.get(k.id) ?? 0; seen.set(k.id, n + 1); if (n) k.id += `#${n + 1}`; }
  writeFileSync(outFile, JSON.stringify({ app, kind, candidates: cand.length, kept, dropped }, null, 1));
  console.log(`${app} (${kind}): ${cand.length} methods with a body, ${kept.length} mutants compiled and proven, ${dropped.length} dropped`);
  const why = {}; for (const x of dropped) { const k = x.why.replace(/:.*$/, ''); why[k] = (why[k] ?? 0) + 1; } console.log(why);
}

/**
 * Route mutants: each endpoint's path, and each controller's prefix, moved by "/v2". The callers now get a 404.
 * Truth: every area that calls the endpoint, from a screen or through a Feign client.
 */
function routeMutants(o, cfg, built, outFile) {
  const kept = [];
  const byHandler = new Map();
  for (const e of o.endpoints) { if (!byHandler.has(e.handler)) byHandler.set(e.handler, []); byHandler.get(e.handler).push(e); }
  const union = (eps) => { const hard = {}, content = {}; for (const e of eps) { const r = o.reach(e.id); for (const [a, p] of r.hard) hard[a] = p; for (const [a, p] of r.content) if (!hard[a]) content[a] = p; } return { hard, content }; };
  const seenCls = new Set();
  for (const [h, eps] of byHandler) {
    const m = o.methods.get(h);
    const mod = cfg.modules.find((x) => x.name === m.cls.module);
    const rel = join(mod.srcRoot, m.cls.name.split('.').slice(0, -1).join('/'), m.cls.source);
    const text = readFileSync(join(built, rel), 'utf8');
    const lines = text.split('\n');
    const starts = [0]; for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
    const first = Math.min(...m.lines);
    // the mapping annotation: the nearest one above the method's first line
    for (let ln = first - 1; ln >= Math.max(1, first - 8); ln--) {
      const am = /@(Get|Post|Put|Delete|Patch|Request)Mapping(\("([^"]*)")?/.exec(lines[ln - 1]);
      if (!am) continue;
      const at = am[2] ? starts[ln - 1] + am.index + am[0].length - 1 : starts[ln - 1] + am.index + am[0].length;
      const insert = am[2] ? '/v2' : '("/v2")';
      kept.push({ id: `route:${eps[0].verb} ${eps[0].path}`.replace(/^/, m.cls.module === 'orderdesk' ? '' : `${m.cls.module}:`), method: h, file: rel, at, insert, raw: true, kind: 'route', line: ln, ...union(eps) });
      break;
    }
    // the controller's prefix, once per controller
    if (seenCls.has(m.cls.name)) continue;
    seenCls.add(m.cls.name);
    const cm = /@RequestMapping\("([^"]*)"\)/.exec(text);
    if (cm) {
      const at = cm.index + cm[0].length - 2;
      const all = o.endpoints.filter((e) => o.methods.get(e.handler).cls === m.cls);
      kept.push({ id: `prefix:${m.cls.module === 'orderdesk' ? '' : `${m.cls.module}:`}${cm[1]}`, method: m.cls.name, file: rel, at, insert: '/v2', raw: true, kind: 'route', line: text.slice(0, at).split('\n').length, ...union(all) });
    }
  }
  kept.sort((x, y) => x.id.localeCompare(y.id));
  writeFileSync(outFile, JSON.stringify({ app: cfg.app, kind: 'route', candidates: kept.length, kept, dropped: [] }, null, 1));
  console.log(`${cfg.app} (route): ${kept.length} route mutants`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
