// Dependency-level blast radius: a version change with no source change behind it.
import { execFileSync } from 'node:child_process';
import { at, services, providers, gateway, frontend, javaConsumers, upstream, concretes } from './mech.mjs';

const [repo, baseRef, headRef] = process.argv.slice(2);
const B = at(repo, baseRef), H = at(repo, headRef);
const parentVer = (snap) => /<parent>[\s\S]*?<artifactId>spring-boot-starter-parent<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/.exec(snap.read('pom.xml') ?? '')?.[1];
const props = (snap) => Object.fromEntries([...(snap.read('pom.xml') ?? '').matchAll(/<([\w.-]+\.version)>([^<]+)<\//g)].map((m) => [m[1], m[2]]));
const before = parentVer(B), after = parentVer(H);
const major = (v) => Number(String(v).split('.')[0]);
console.log(`Spring Boot ${before} → ${after}`);

const svcH = services(H);
const affectedServices = new Map();
// Every third-party starter the modules pull in: what framework major was it built for?
const deps = new Set();
for (const f of H.list.filter((f) => /\/pom\.xml$/.test(f))) {
  for (const m of (H.read(f) ?? '').matchAll(/<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)) {
    if (/^org\.springframework/.test(m[1])) continue; // managed by the framework itself
    deps.add(`${m[1]}:${m[2]}:${f.split('/')[0]}`);
  }
}
const P = props(H);
const checked = new Map();
for (const d of deps) {
  const [g, a, module] = d.split(':');
  const ver = P[`${a}.version`];
  if (!ver) continue;
  const id = `${g}:${a}:${ver}`;
  if (!checked.has(id)) {
    const url = `https://repo1.maven.org/maven2/${g.replace(/\./g, '/')}/${a}/${ver}/${a}-${ver}.pom`;
    let pom = '';
    try { pom = execFileSync('curl', ['-sS', '-L', '--max-time', '20', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { console.log('  FETCH FAILED', url, String(e.stderr || e.message).split('\n')[0]); }
    const built = /<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot[\w-]*<\/artifactId>\s*<version>([^<]+)</.exec(pom)?.[1];
    checked.set(id, { built, url });
  }
  const { built, url } = checked.get(id);
  if (built && major(built) !== major(after)) {
    const svc = svcH.get(module);
    if (svc) affectedServices.set(svc, `${a} ${ver} was built against Spring Boot ${built} (${url.replace('https://repo1.maven.org/maven2/', 'maven central: ')}); this change moves the app to ${after}`);
  }
}
for (const [s, why] of affectedServices) console.log(`  SKEW  ${s}: ${why}`);

// Every way a page reaches one of those services.
const gw = gateway(H, svcH), fe = frontend(H), eps = providers(H, svcH), jc = javaConsumers(H, svcH);
const pages = new Map();
const add = (file, how) => {
  const surf = fe.pages.get(file)?.map((p) => `PAGE ${p}`) ?? (fe.globals.has(file) ? [`GLOBAL <${fe.globals.get(file).tag}> on every page`] : []);
  for (const s of surf) { if (!pages.has(s)) pages.set(s, new Set()); pages.get(s).add(how); }
};
for (const c of fe.calls) {
  for (const p of concretes(c.tpl)) {
    const land = gw.resolve(p);
    if (affectedServices.has(land.service)) { add(c.file, `${c.verbs.join('/')} ${c.tpl} → ${land.service}`); break; }
    if (land.service && /gateway/.test(land.service)) {
      // the gateway answers this itself: follow its own clients to the services behind it
      const ep = eps.find((e) => e.service === land.service && new RegExp('^' + e.path.split('/').map((s) => (/^\{.*\}$/.test(s) || s === '*' ? '[^/]+' : s)).join('/') + '$').test(land.path));
      if (!ep) continue;
      for (const j of jc.filter((j) => j.svc === land.service && affectedServices.has(j.service))) {
        if (upstream(H, svcH, eps, j).some((ch) => ch.at(-1).ep.handler === ep.handler)) add(c.file, `${c.tpl} → gateway ${ep.handler} → ${j.cls}.${j.method}() → ${j.service}`);
      }
      break;
    }
  }
}
console.log(`\npages a QA engineer has to verify after this upgrade:`);
for (const [p, hows] of [...pages].sort()) { console.log(`  ${p}`); for (const h of hows) console.log(`      via ${h}`); }
const allPages = new Set([...fe.pages.values()].flat());
const untouched = [...allPages].filter((p) => ![...pages.keys()].some((k) => k === `PAGE ${p}`));
console.log(`\nnot reached by any skewed service: ${untouched.join(', ') || 'none'}`);
