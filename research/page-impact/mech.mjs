// Prototype of the page-level impact mechanisms, run on a real repository.
// Reads any commit straight from git — no checkout, no build.
import { execFileSync } from 'node:child_process';

export function at(repo, ref) {
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...a], { encoding: 'utf8', maxBuffer: 1 << 27 });
  const list = git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
  const cache = new Map();
  const read = (p) => { if (!cache.has(p)) { try { cache.set(p, git('show', `${ref}:${p}`)); } catch { cache.set(p, null); } } return cache.get(p); };
  return { ref, list, read };
}

// String-aware: a Spring path like "/owners/*/pets" contains "/*", and a naive
// stripper reads it as the start of a block comment and swallows the code after it.
// and it must keep every newline, or every line number quoted as evidence is wrong.
function stripC(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { out += '  '; i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; } out += src[i]; i++; }
      if (i < src.length) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const lineOf = (src, i) => src.slice(0, i).split('\n').length;
function balanced(src, open) { // src[open] === '('
  let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i] === '(') d++; else if (src[i] === ')') { d--; if (d === 0) return src.slice(open + 1, i); } }
  return '';
}
// split a + b + (c || 0) at top level only
function splitPlus(e) { const out = []; let d = 0, q = null, cur = ''; for (const c of e) { if (q) { cur += c; if (c === q) q = null; continue; } if (c === '"' || c === "'") { q = c; cur += c; continue; } if (c === '(') d++; if (c === ')') d--; if (c === '+' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur.trim()); return out; }
function splitTop(s) { const out = []; let d = 0, cur = ''; for (const c of s) { if ('(<['.includes(c)) d++; if (')>]'.includes(c)) d--; if (c === ',' && d === 0) { out.push(cur); cur = ''; } else cur += c; } if (cur.trim()) out.push(cur); return out.map((x) => x.trim()); }
const joinPath = (a, b) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const firstStr = (args) => /"([^"]*)"/.exec(args)?.[1] ?? '';

// ---------------------------------------------------------------- services --
export function services(snap) {
  const out = new Map(); // module dir -> service name
  for (const f of snap.list) {
    const m = /^(.*?)\/src\/main\/resources\/application\.ya?ml$/.exec(f);
    if (!m) continue;
    const name = /application:\s*\n\s*name:\s*([\w-]+)/.exec(snap.read(f) ?? '')?.[1];
    if (name) out.set(m[1], name);
  }
  return out;
}
const serviceOf = (svcs, file) => { for (const [dir, n] of svcs) if (file.startsWith(dir + '/')) return n; return null; };

// ------------------------------------------------- Spring providers (rules) --
const CONSTRAINTS = /^(NotNull|NotBlank|NotEmpty|Size|Min|Max|Past|PastOrPresent|Future|FutureOrPresent|Pattern|Email|Positive|PositiveOrZero|Negative|Digits|DecimalMin|DecimalMax|AssertTrue|AssertFalse)$/;
export function dtoConstraints(snap, svcDir, type) {
  for (const f of snap.list) {
    if (!f.startsWith(svcDir + '/src/main/java/') || !f.endsWith(`/${type}.java`)) continue;
    const src = stripC(snap.read(f) ?? '');
    const out = [];
    const rec = new RegExp(`record\\s+${type}\\s*\\(`).exec(src);
    const parts = rec ? splitTop(balanced(src, rec.index + rec[0].length - 1)) : [...src.matchAll(/((?:@\w+(?:\([^)]*\))?\s+)+)(?:private|protected|public)?\s*[\w<>]+\s+(\w+)\s*;/g)].map((m) => m[0]);
    for (const p of parts) {
      const name = /(\w+)\s*;?\s*$/.exec(p.trim())?.[1];
      for (const a of p.matchAll(/@(\w+)(\(([^)]*)\))?/g)) if (CONSTRAINTS.test(a[1])) out.push({ field: name, rule: `@${a[1]}${a[2] ?? ''}`, file: f });
    }
    return out;
  }
  return [];
}

export function providers(snap, svcs) {
  const eps = [];
  for (const f of snap.list) {
    if (!/\/src\/main\/java\/.*\.java$/.test(f)) continue;
    const raw = snap.read(f); if (!raw || !/@(Rest)?Controller\b/.test(raw)) continue;
    const src = stripC(raw);
    const svcDir = [...svcs.keys()].find((d) => f.startsWith(d + '/'));
    const service = svcDir ? svcs.get(svcDir) : null;
    const cls = /class\s+(\w+)/.exec(src)?.[1];
    const classAt = src.search(/class\s+\w+/);
    const base = firstStr(/@RequestMapping\s*\(([^)]*)\)/.exec(src.slice(0, classAt))?.[1] ?? '');
    for (const m of src.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\s*(\(([^)]*)\))?/g)) {
      const verb = m[1].toUpperCase();
      const path = joinPath(base, firstStr(m[3] ?? ''));
      const rest = src.slice(m.index + m[0].length);
      const sig = /\b(\w+)\s*\(/.exec(rest.replace(/@\w+(\s*\([^()]*(\([^()]*\))*[^()]*\))?/g, (x) => ' '.repeat(x.length)));
      if (!sig) continue;
      const params = splitTop(balanced(rest, sig.index + sig[0].length - 1));
      const bodyP = params.find((p) => /@RequestBody\b/.test(p));
      const body = bodyP ? { type: /(\w+)(?:<[^>]*>)?\s+\w+\s*$/.exec(bodyP)?.[1], valid: /@(Valid|Validated)\b/.test(bodyP) } : null;
      eps.push({ service, svcDir, verb, path, handler: `${cls}.${sig[1]}`, method: sig[1], cls, file: f, line: lineOf(src, m.index), body });
    }
  }
  return eps;
}

// ----------------------------------------------------- gateway (algebra) --
export function gateway(snap, svcs) {
  const routes = [];
  for (const f of snap.list) {
    if (!/api-gateway\/src\/main\/resources\/application\.ya?ml$/.test(f)) continue;
    const y = snap.read(f) ?? '';
    for (const blk of y.split(/\n\s*-\s+id:\s*/).slice(1)) {
      const uri = /uri:\s*lb:\/\/([\w-]+)/.exec(blk)?.[1];
      const pathPat = /-\s*Path=([^\s,]+)/.exec(blk)?.[1];
      const strip = Number(/StripPrefix=(\d+)/.exec(blk)?.[1] ?? 0);
      if (uri && pathPat) routes.push({ service: uri, prefix: pathPat.replace(/\/\*\*$/, ''), strip, file: f, line: lineOf(y, y.indexOf(pathPat)) });
    }
  }
  const gwName = [...svcs.values()].find((n) => /gateway/.test(n));
  return {
    routes,
    // external path -> where it really lands
    resolve(extPath) {
      for (const r of routes) if (extPath === r.prefix || extPath.startsWith(r.prefix + '/')) {
        const segs = extPath.split('/').filter(Boolean).slice(r.strip);
        return { service: r.service, path: '/' + segs.join('/'), via: r };
      }
      return { service: gwName, path: extPath, via: null }; // handled by the gateway itself
    },
  };
}

// ------------------------------------------------ template unification --
const provRe = (path) => new RegExp('^' + path.split('/').map((s) => (s === '*' || /^\{.*\}$/.test(s) ? '[^/]+' : s.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))).join('/') + '$');
// A consumer template has holes whose shape is unknown (`/pets${petPath}` may be
// "" or "/7"). Each hole is tried as an id, as a path segment, and as empty —
// the value classes a URL piece can take — and every concrete path is matched.
function concretes(tpl) {
  const holes = tpl.split('{*}').length - 1;
  let out = [tpl];
  for (let i = 0; i < holes; i++) out = out.flatMap((t) => ['7', '/7', ''].map((v) => t.replace('{*}', v)));
  return [...new Set(out.map((p) => p.replace(/\/+/g, '/').replace(/\?.*$/, '')))];
}

// ------------------------------------------------------ frontend consumers --
export function frontend(snap) {
  const js = snap.list.filter((f) => /\/static\/scripts\/.*\.js$/.test(f));
  const calls = [];
  for (const f of js) {
    const src = snap.read(f) ?? '';
    for (const m of src.matchAll(/\brequest\s*\(/g)) {
      const args = splitTop(balanced(src, m.index + m[0].length - 1));
      let u = args[0] ?? '';
      if (/^\w+$/.test(u)) u = new RegExp(`(?:const|let)\\s+${u}\\s*=\\s*([^;\\n]+)`).exec(src)?.[1] ?? u;
      const tpl = /^['`"]/.test(u) ? u.slice(1, -1).replace(/\$\{[^}]*\}/g, '{*}') : null;
      if (!tpl || !tpl.startsWith('/')) continue;
      const opts = args.slice(1).join(',');
      let verbs = ['GET'];
      const jr = /jsonRequest\s*\(([^,]+)/.exec(opts)?.[1] ?? /method:\s*([^,}]+)/.exec(opts)?.[1];
      if (jr) verbs = [...jr.matchAll(/'(GET|POST|PUT|DELETE|PATCH)'/g)].map((x) => x[1]);
      calls.push({ file: f, line: lineOf(src, m.index), tpl, verbs, code: src.split('\n')[lineOf(src, m.index) - 1].trim() });
    }
  }
  // pages: Vue Router routes -> component -> file
  const pages = new Map(); // file -> [route paths]
  let globals = new Map(); // file -> tag
  for (const f of js) {
    const src = snap.read(f) ?? '';
    const imports = new Map([...src.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'([^']+)'/g)].map((m) => [m[1], resolveRel(f, m[2])]));
    if (/createRouter\s*\(/.test(src)) {
      for (const r of src.matchAll(/path:\s*'([^']+)'\s*,\s*component:\s*(\w+)/g)) {
        const file = imports.get(r[2]); if (!file) continue;
        pages.set(file, [...(pages.get(file) ?? []), r[1]]);
      }
    }
    // a component registered on the app and rendered next to <router-view> is on every page
    for (const r of src.matchAll(/\.component\(\s*'([\w-]+)'\s*,\s*(\w+)\s*\)/g)) {
      const file = imports.get(r[2]); if (!file) continue;
      const root = js.find((x) => new RegExp(`<router-view`).test(snap.read(x) ?? '') && new RegExp(`<${r[1]}[\\s>]`).test(snap.read(x) ?? ''));
      if (root) globals.set(file, { tag: r[1], root });
    }
  }
  // AngularJS (this repository's frontend until it moved to Vue) — one adapter per
  // framework and per era, because the same repo changes framework over time.
  const ng = angularJS(snap, js);
  for (const c of ng.calls) calls.push(c);
  for (const [k, v] of ng.pages) pages.set(k, v);
  for (const [k, v] of ng.globals) globals.set(k, v);
  return { calls, pages, globals };
}
const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
function angularJS(snap, js) {
  const calls = [], pages = new Map(), globals = new Map();
  const states = []; // { url, tag, file, line }
  for (const f of js) {
    const src = snap.read(f) ?? '';
    for (const st of src.matchAll(/\.state\(\s*'(\w+)'\s*,\s*\{([^}]*)\}/g)) {
      const url = /url:\s*'([^']*)'/.exec(st[2])?.[1];
      const tag = /template:\s*'<([\w-]+)/.exec(st[2])?.[1];
      if (url && tag) states.push({ url, tag });
    }
    // $http.get('api/customer/owners/' + $stateParams.ownerId) and friends
    for (const m of src.matchAll(/\$http\.(get|post|put|delete|patch)\s*\(/g)) {
      let arg = splitTop(balanced(src, m.index + m[0].length - 1))[0] ?? '';
      if (/^\w+$/.test(arg)) arg = new RegExp(`(?:var|let|const)\\s+${arg}\\s*=\\s*([^;\\n]+)`).exec(src)?.[1] ?? arg;
      const tpl = splitPlus(arg).map((p) => (/^['"]/.test(p) ? p.slice(1, -1) : '{*}')).join('').replace(/(\{\*\})+/g, '{*}');
      if (!/^\/?api\//.test(tpl)) continue;
      calls.push({ file: f, line: lineOf(src, m.index), tpl: tpl.startsWith('/') ? tpl : '/' + tpl, verbs: [m[1].toUpperCase()], code: src.split('\n')[lineOf(src, m.index) - 1].trim() });
    }
    // plain fetch('/api/...', { method: 'POST' })
    for (const m of src.matchAll(/\bfetch\s*\(\s*'(\/api\/[^']+)'\s*(?:,\s*\{([\s\S]{0,200}?)\})?/g)) {
      const verb = /method:\s*'(\w+)'/.exec(m[2] ?? '')?.[1]?.toUpperCase() ?? 'GET';
      calls.push({ file: f, line: lineOf(src, m.index), tpl: m[1], verbs: [verb], code: src.split('\n')[lineOf(src, m.index) - 1].trim() });
    }
  }
  // a call lives in angular.module('ownerList') -> <owner-list> -> the state that renders it
  for (const f of js) {
    const mod = /angular\.module\(\s*'(\w+)'/.exec(snap.read(f) ?? '')?.[1];
    if (!mod) continue;
    const urls = states.filter((s) => s.tag === kebab(mod)).map((s) => s.url);
    if (urls.length) pages.set(f, urls);
  }
  // a script index.html loads directly, drawing outside <div ui-view>, is on every page
  for (const h of snap.list.filter((x) => /static\/index\.html$/.test(x))) {
    const html = snap.read(h) ?? '';
    const view = html.indexOf('ui-view');
    for (const m of html.matchAll(/<script\s+src="\/?(scripts\/[^"]+\.js)"/g)) {
      const file = js.find((x) => x.endsWith(m[1]));
      if (file && !/angular\.module/.test(snap.read(file) ?? '') && view > 0) globals.set(file, { tag: m[1].split('/').pop(), root: h });
    }
  }
  return { calls, pages, globals };
}
function resolveRel(from, spec) {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const s of spec.replace(/\?.*$/, '').split('/')) { if (s === '..') parts.pop(); else if (s !== '.') parts.push(s); }
  return parts.join('/');
}

// ---------------------------------------------------------- Java consumers --
export function javaConsumers(snap, svcs) {
  const out = [];
  for (const f of snap.list) {
    if (!/\/src\/main\/java\/.*\.java$/.test(f)) continue;
    const raw = snap.read(f); if (!raw || !/RestClient|WebClient|RestTemplate/.test(raw)) continue;
    const src = stripC(raw);
    const cls = /class\s+(\w+)/.exec(src)?.[1];
    const svcOfMethod = new Map([...src.matchAll(/(\w+)\s*\([^)]*\)\s*\{[^}]*getInstances\(\s*"([\w-]+)"/g)].map((m) => [m[1], m[2]]));
    const consts = new Map([...src.matchAll(/\bString\s+(\w+)\s*=\s*"([^"]*)"\s*;/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/\.uri\s*\(/g)) {
      const expr = splitTop(balanced(src, m.index + m[0].length - 1))[0] ?? '';
      const verb = /\.(get|post|put|delete|patch)\s*\(\s*\)\s*$/.exec(src.slice(Math.max(0, m.index - 80), m.index).replace(/\s+/g, ' '))?.[1]?.toUpperCase() ?? 'GET';
      let service = null, how = null, tpl = '';
      for (let part of splitPlus(expr)) {
        if (consts.has(part)) part = `"${consts.get(part)}"`; // a field holding a constant URL
        const call = /^(\w+)\(\)$/.exec(part);
        if (call && svcOfMethod.has(call[1])) { service = svcOfMethod.get(call[1]); how = `${call[1]}() → DiscoveryClient.getInstances("${service}")`; continue; }
        const lit = /^"(.*)"$/.exec(part);
        if (lit) { const u = /^(?:https?|lb):\/\/([\w-]+)(\/.*)?$/.exec(lit[1]); if (u) { service = u[1]; how = `URL names the service ${service}`; tpl += (u[2] ?? '').replace(/\{[^}]*\}/g, '{*}'); } else tpl += lit[1].replace(/\{[^}]*\}/g, '{*}'); continue; }
        tpl += '{*}';
      }
      if (!service) continue;
      const before = src.slice(0, m.index);
      const enclosing = [...before.matchAll(/\b(?:public|private|protected)?\s*[\w<>,\s]+\s+(\w+)\s*\([^;{]*\)\s*\{/g)].pop()?.[1];
      out.push({ file: f, cls, method: enclosing, verb, service, tpl: tpl.replace(/\{\*\}\{\*\}/g, '{*}'), line: lineOf(src, m.index), how, svc: serviceOf(svcs, f) });
    }
  }
  return out;
}

// Inside one service: who calls this method, up to an endpoint or an AI tool.
export function upstream(snap, svcs, eps, start) {
  const chains = [];
  const javaFiles = snap.list.filter((f) => f.startsWith([...svcs.keys()].find((d) => svcs.get(d) === start.svc) + '/src/main/java/') && f.endsWith('.java'));
  const walk = (cls, method, chain, depth) => {
    const ep = eps.find((e) => e.cls === cls && e.method === method);
    if (ep) return chains.push([...chain, { kind: 'endpoint', ep }]);
    if (depth > 6) return;
    for (const f of javaFiles) {
      const src = stripC(snap.read(f) ?? '');
      const caller = /class\s+(\w+)/.exec(src)?.[1];
      for (const fld of src.matchAll(new RegExp(`\\b${cls}\\s+(\\w+)\\s*[;=,)]`, 'g'))) {
        for (const c of src.matchAll(new RegExp(`\\b${fld[1]}\\s*\\.\\s*${method}\\s*\\(`, 'g'))) {
          const enc = [...src.slice(0, c.index).matchAll(/\b(?:public|private|protected)?\s*[\w<>,\s]+\s+(\w+)\s*\([^;{]*\)\s*\{/g)].pop()?.[1];
          const isTool = new RegExp(`@Tool\\b[\\s\\S]{0,400}?\\b${enc}\\s*\\(`).test(src);
          const step = { kind: isTool ? 'tool' : 'call', cls: caller, method: enc, file: f, line: lineOf(src, c.index) };
          if (isTool) {
            // Spring AI: a tools object handed to .defaultTools(...) is callable by every endpoint of that class
            for (const g of javaFiles) {
              const s2 = stripC(snap.read(g) ?? '');
              const holder = /class\s+(\w+)/.exec(s2)?.[1];
              const fieldName = new RegExp(`\\b${caller}\\s+(\\w+)`).exec(s2)?.[1];
              if (fieldName && new RegExp(`\\.(?:default)?[Tt]ools\\s*\\(\\s*${fieldName}\\b`).test(s2)) {
                for (const ep of eps.filter((e) => e.cls === holder)) chains.push([...chain, step, { kind: 'wiring', cls: holder, file: g, detail: `.defaultTools(${fieldName})` }, { kind: 'endpoint', ep }]);
              }
            }
          } else walk(caller, enc, [...chain, step], depth + 1);
        }
      }
    }
  };
  walk(start.cls, start.method, [{ kind: 'client', ...start }], 0);
  const seen = new Set();
  return chains.filter((c) => { const k = c.map((s) => `${s.kind}:${s.cls ?? s.ep?.handler}:${s.method ?? ''}`).join('>'); if (seen.has(k)) return false; seen.add(k); return true; });
}

export function unify(consumerTpl, consumerVerbs, ep) {
  const re = provRe(ep.path);
  return consumerVerbs.includes(ep.verb) && concretes(consumerTpl).some((p) => re.test(p));
}
export { concretes };
