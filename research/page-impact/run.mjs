import { at, services, providers, dtoConstraints, gateway, frontend, javaConsumers, upstream, concretes } from './mech.mjs';

const [repo, baseRef, headRef] = process.argv.slice(2);
const B = at(repo, baseRef), H = at(repo, headRef);
const svcH = services(H), svcB = services(B);
const epsH = providers(H, svcH), epsB = providers(B, svcB);
const gw = gateway(H, svcH);
const fe = frontend(H);
const jc = javaConsumers(H, svcH);

const key = (e) => `${e.service} ${e.verb} ${e.path}`;
const enforced = (snap, e) => (e.body?.valid ? dtoConstraints(snap, e.svcDir, e.body.type) : []);
const rule = (c) => `${c.field} ${c.rule}`;

// 1. what changed about each endpoint's request contract
const tightened = [];
for (const e of epsH) {
  const before = epsB.find((x) => key(x) === key(e) || x.handler === e.handler);
  const now = enforced(H, e).map(rule);
  const was = before ? enforced(B, before).map(rule) : [];
  const added = now.filter((r) => !was.includes(r));
  if (added.length) tightened.push({ ep: e, added, wasValid: !!before?.body?.valid, constraints: enforced(H, e) });
}

const ext = (svc, path) => { const r = gw.routes.find((x) => x.service === svc && x.prefix.split('/').filter(Boolean).length === x.strip); return r ? { path: r.prefix + path, route: r } : null; };
const surfacesOf = (file) => fe.pages.has(file) ? fe.pages.get(file).map((p) => ({ kind: 'page', id: p })) : fe.globals.has(file) ? [{ kind: 'global', id: `<${fe.globals.get(file).tag}> on every page`, root: fe.globals.get(file).root }] : [];

function frontendCallersOf(ep) {
  const hits = [];
  for (const c of fe.calls) {
    for (const p of concretes(c.tpl)) {
      const land = gw.resolve(p);
      if (land.service !== ep.service) continue;
      const re = new RegExp('^' + ep.path.split('/').map((s) => (s === '*' || /^\{.*\}$/.test(s) ? '[^/]+' : s)).join('/') + '$');
      if (re.test(land.path)) { hits.push({ call: c, writes: c.verbs.includes(ep.verb), land, sample: p }); break; }
    }
  }
  return hits;
}

console.log(`\n=== ${headRef} vs ${baseRef} ===`);
const found = [];
for (const t of tightened) {
  const e = t.ep;
  console.log(`\n■ REQUEST CONTRACT TIGHTENED  ${e.service}  ${e.verb} ${e.path}   [${e.handler}, ${e.file.split('/').pop()}:${e.line}]`);
  console.log(`    newly enforced: ${t.added.join(' · ')}${!t.wasValid ? '   ← @Valid was added here, so EVERY rule on the body is new, not only the one in the diff' : ''}`);
  const x = ext(e.service, e.path);
  if (x) console.log(`    [gateway rule] exposed as ${e.verb} ${x.path}   (Path=${x.route.prefix}/** StripPrefix=${x.route.strip}, ${x.route.file.split('/').slice(-1)}:${x.route.line})`);

  // direction rule: a request-body rule only reaches code that SENDS that body
  for (const h of frontendCallersOf(e)) {
    const tag = h.writes ? 'AFFECTED' : 'excluded';
    const surf = surfacesOf(h.call.file);
    console.log(`    ${tag.padEnd(8)} [contract match] ${h.call.file.split('/').slice(-2).join('/')}:${h.call.line}  ${h.call.verbs.join('/')} ${h.call.tpl}`);
    if (!h.writes) { console.log(`             └ reads only: a request-body rule cannot change what this ${h.call.verbs.join('/')} returns`); continue; }
    for (const s of surf) { console.log(`             └ [router rule] ${s.kind.toUpperCase()} ${s.id}`); found.push(s.id); }
    found.push(h.call.file.split('/').pop());
  }
  for (const c of jc.filter((c) => c.service === e.service && c.verb === e.verb && concretes(c.tpl).some((p) => new RegExp('^' + e.path.split('/').map((s) => (s === '*' || /^\{.*\}$/.test(s) ? '[^/]+' : s)).join('/') + '$').test(p)))) {
    console.log(`    AFFECTED [contract match] ${c.svc}: ${c.cls}.${c.method}()  ${c.verb} ${c.tpl}   (${c.how}, ${c.file.split('/').pop()}:${c.line})`);
    found.push(c.file.split('/').pop());
    for (const chain of upstream(H, svcH, epsH, { ...c })) {
      const end = chain.at(-1).ep;
      for (const s of chain.slice(1, -1)) console.log(`             └ [${s.kind === 'tool' ? 'Spring AI rule: @Tool' : s.kind === 'wiring' ? 'Spring AI rule' : 'compiler-level call'}] ${s.cls}${s.method ? '.' + s.method + '()' : ''} ${s.detail ?? ''} (${s.file.split('/').pop()}${s.line ? ':' + s.line : ''})`);
      if (chain.some((s) => s.kind === 'tool')) found.push('PetclinicTools.java');
      const xe = ext(end.service, end.path);
      console.log(`             └ [Spring rule] ${end.service} ${end.verb} ${end.path}${xe ? `  → [gateway rule] ${end.verb} ${xe.path}` : ''}`);
      if (xe) for (const h of frontendCallersOf(end)) for (const s of surfacesOf(h.call.file)) {
        console.log(`             └ [contract match] ${h.call.file.split('/').slice(-2).join('/')}:${h.call.line} → [${s.kind === 'global' ? 'Vue rule: registered component rendered beside <router-view>' : 'router rule'}] ${s.kind.toUpperCase()} ${s.id}`);
        found.push(h.call.file.split('/').pop(), s.id);
      }
    }
  }
  // data rule: a new rule on an update path locks out existing rows that break it
  if (['PUT', 'PATCH'].includes(e.verb)) {
    const entity = e.body.type.replace(/(Request|DTO|Dto|Form)$/, '');
    const ent = H.list.find((f) => f.startsWith(e.svcDir + '/') && f.endsWith(`/${entity}.java`));
    const src = ent ? H.read(ent) : '';
    const table = /@Table\s*\(\s*name\s*=\s*"(\w+)"/.exec(src)?.[1];
    for (const c of t.constraints.filter((c) => t.added.includes(`${c.field} ${c.rule}`))) {
      const col = new RegExp(`@Column\\s*\\(\\s*name\\s*=\\s*"(\\w+)"\\s*\\)[^;]*\\b${c.field}\\s*;`).exec(src)?.[1];
      if (!table || !col) continue;
      const where = /PastOrPresent|Past\b/.test(c.rule) ? `${col} > CURRENT_DATE` : /Size\(min\s*=\s*(\d+)/.test(c.rule) ? `${col} IS NULL OR CHAR_LENGTH(${col}) < ${/min\s*=\s*(\d+)/.exec(c.rule)[1]}` : null;
      if (where) { console.log(`    DATA RISK [entity rule] rows already breaking "${c.field} ${c.rule}" can no longer be edited through ${e.verb}:  SELECT id FROM ${table} WHERE ${where};`); found.push(`data:${c.field}`); }
    }
  }
}
export const result = found;
console.log(`\nfound: ${[...new Set(found)].join(', ')}`);
