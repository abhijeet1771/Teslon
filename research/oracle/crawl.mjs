// Differential runtime oracle, part 1: crawl a running app and record, for
// every page reachable by clicking, what a person would see and what the page
// asked the server for.
//
//   node research/oracle/crawl.mjs <baseUrl> <out.json> [user] [password] [--submit-unchanged]
//
// --submit-unchanged: on every edit page, press the enabled submit button
// without touching anything and record what the server said. A request-side
// change (a renamed or newly required property) shows up here and nowhere else.
//
// Deliberately knows nothing about Teslon or the app's source. Pages are found
// by following links in the rendered app, not by reading its router, so the
// truth it produces cannot share a blind spot with Teslon's rules.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const SUBMIT = argv.includes('--submit-unchanged');
const [base, out, user = 'admin', pass = 'admin'] = argv.filter((x) => !x.startsWith('--'));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const ctx = await b.newContext();
const p = await ctx.newPage();

// path ids become {id} so before/after compare the same page, not the same row
const norm = (u) => new URL(u, base).pathname.replace(/\/\d+(?=\/|$)/g, '/{id}');
let calls = [];
p.on('response', (r) => {
  const u = new URL(r.url());
  if (u.origin === new URL(base).origin && u.pathname.startsWith('/api/')) calls.push(`${r.request().method()} ${norm(r.url())}${u.search ? '?' + [...u.searchParams.keys()].sort().join('&') : ''} → ${r.status()}`);
});

async function settle() {
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForTimeout(300);
}

// log in through the UI, like a person would
await p.goto(base + '/login'); await settle();
await p.waitForSelector('#username, input[name="username"]', { timeout: 30000 });
await p.fill('#username, input[name="username"]', user);
await p.fill('#password, input[name="password"]', pass);
await p.click('button[type="submit"]'); await settle();
// a crawl that silently stayed logged out would report "no difference" for
// every protected page — fail loudly instead
const who = await p.evaluate(async () => { const t = localStorage.getItem('jhi-authenticationToken') || sessionStorage.getItem('jhi-authenticationToken'); return t ? 'token' : ''; });
if (!who) { console.error('login failed — refusing to crawl as anonymous'); process.exit(2); }

async function snapshot() {
  return p.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const main = document.querySelector('main, #main, .container-fluid, body');
    const text = (main?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
      // clock-dependent text is not a difference a change made
      .map((s) => s.replace(/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\b/g, '<time>'));
    const fields = [...document.querySelectorAll('input, select, textarea')].filter(vis).map((e) => {
      const label = e.id ? document.querySelector(`label[for="${e.id}"]`)?.innerText.trim() : '';
      const value = e.tagName === 'SELECT' ? [...e.options].map((o) => o.text.trim()).join(' | ') : e.type === 'password' ? '' : e.value;
      return `${label || e.name || e.id || e.type}: ${e.tagName.toLowerCase()}=${value}`;
    });
    const controls = [...document.querySelectorAll('button')].filter(vis).map((e) => `${e.innerText.trim() || e.getAttribute('aria-label') || e.type}${e.disabled ? ' [disabled]' : ''}`).filter(Boolean);
    fields.push(...controls.map((c) => `button: ${c}`));
    const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => h && h.startsWith('/') && !h.startsWith('//'));
    return { text, fields, links };
  });
}

const seen = new Map();
const queue = ['/'];
const SKIP = /logout|\/api\/|swagger|h2-console|\.(png|svg|ico)$|\/delete/;
while (queue.length && seen.size < 120) {
  const path = queue.shift();
  const key = norm(path);
  if (seen.has(key) || SKIP.test(path)) continue;
  calls = [];
  await p.goto(base + path).catch(() => {}); await settle();
  const s = await snapshot();
  const entry = { url: path, calls: [...new Set(calls)].sort(), text: s.text, fields: s.fields };
  if (SUBMIT && /\/edit$/.test(path)) {
    const btn = await p.$('form button[type="submit"]:not([disabled])');
    calls = [];
    if (btn) { await btn.click(); await settle(); entry.submit = [...new Set(calls)].sort(); }
    else entry.submit = ['submit not possible: no enabled submit button'];
    entry.fields = [...entry.fields, ...entry.submit.map((c) => `save unchanged: ${c}`)];
  }
  seen.set(key, entry);
  for (const l of s.links) if (!seen.has(norm(l))) queue.push(l);
}
writeFileSync(out, JSON.stringify(Object.fromEntries([...seen].sort()), null, 1));
console.log(`crawled ${seen.size} pages → ${out}`);
await b.close();
