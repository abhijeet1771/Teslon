import type { ImpactReport, Surface, Case, Hop, Tier } from './model.js';
import { type PrMeta, KIND_ORDER, broadDeltas, counts, startHere } from './markdown.js';

/**
 * The cockpit: one HTML file a tester opens from the run's artifact, or
 * locally. It is rendered complete on the server side, so it reads the same
 * with scripts off; the script only adds Pass / Fail marks (kept in this
 * browser, per commit), the estimate, and copy-out.
 *
 * It loads nothing from anywhere: no fonts, no scripts, no images. A content
 * security policy holds it to that. Every string from the repository is
 * escaped; the data block cannot close its own script tag.
 */

export interface HtmlOptions {
  /** Leave out the document wrapper, for hosts that add their own. */
  readonly fragment?: boolean;
}

const x = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fileName = (p: string): string => p.split('/').pop() ?? p;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A short, stable key for a case, so a mark survives a re-render of the same commit. */
function key(c: Case): string {
  let h = 5381;
  for (const ch of `${c.surface}␟${c.delta}␟${c.do}␟${c.field ?? ''}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

const KIND_WORD: Record<string, string> = {
  screen: 'Screen', widget: 'On every screen', api: 'API', data: 'Data', dashboard: 'Dashboard',
  job: 'Job', 'test-plan': 'Load test plan', module: 'Service', deploy: 'Deployment',
};
const TIER: Record<Tier | 'unseen', { title: string; glyph: string; id: string }> = {
  'test-first': { title: 'Test first', glyph: '▲', id: 'test-first' },
  'test-next': { title: 'Test next', glyph: '△', id: 'test-next' },
  watch: { title: 'Watch after release', glyph: '◇', id: 'watch' },
  skip: { title: 'Safe to skip', glyph: '✓', id: 'skip' },
  unseen: { title: 'Teslon could not see', glyph: '?', id: 'unseen' },
};
const LEDGER_WORD: Record<string, string> = {
  explained: 'explained', followed: 'followed', 'test-only': 'test only', 'not-modelled': 'not followed',
  'no-runtime-effect': 'no app effect', deleted: 'deleted',
};

function hopLink(h: Hop, r: ImpactReport, meta: PrMeta): string {
  const label = `${fileName(h.file)}:${h.line}`;
  const tip = `${h.file}${h.side === 'base' ? ' (before the change)' : ''}${h.quote ? ` · the line says: ${h.quote}` : ''}`;
  if (!meta.repoUrl || !/^https?:\/\//.test(meta.repoUrl)) return `<code class="loc" title="${x(tip)}">${x(label)}</code>`;
  const sha = h.side === 'base' ? r.base : r.head;
  const href = `${meta.repoUrl}/blob/${sha}/${h.file.split('/').map(encodeURIComponent).join('/')}#L${h.line}`;
  return `<a class="loc" href="${x(href)}" target="_blank" rel="noopener noreferrer" title="${x(tip)}">${x(label)}</a>`;
}

function hops(hs: readonly Hop[], r: ImpactReport, meta: PrMeta): string {
  return `<ol class="hops">${hs.map((h) => `<li><span class="chk ${h.verified === false ? 'no' : 'yes'}" title="${h.verified === false ? 'did not re-check' : 're-checked at the commit'}">${h.verified === false ? '✗' : '✓'}</span> <span class="hl">${x(h.label)}</span> ${hopLink(h, r, meta)} <span class="rule">${x(h.rule)}</span></li>`).join('')}</ol>`;
}

function placeHead(s: Surface, n: number): string {
  const where = s.where && s.where !== s.name ? `<code class="where">${x(s.where)}</code>` : '';
  return `<header class="place-head"><span class="kind">${x(KIND_WORD[s.kind] ?? s.kind)}</span><h3>${x(s.name)}</h3>${where}<span class="n">${plural(n, 'case')}</span></header>`;
}

function marks(): string {
  return `<div class="mark" role="group" aria-label="Result"><button type="button" data-v="pass" aria-pressed="false">Pass</button><button type="button" data-v="fail" aria-pressed="false">Fail</button></div>`;
}

function caseRow(c: Case, r: ImpactReport, meta: PrMeta): string {
  const field = [c.section, c.field].filter(Boolean).join(' › ');
  return `<li class="case" data-key="${key(c)}">
<div class="case-body">${field ? `<p class="field">${x(field)}</p>` : ''}
<p class="do"><span class="lbl">Do</span>${x(c.do)}</p>
<p class="expect"><span class="lbl">Expect</span>${x(c.expect)}</p>${c.before && c.before !== '—' ? `\n<p class="before"><span class="lbl">Before</span>${x(c.before)}</p>` : ''}${c.hole ? '\n<p class="hole">The rule still lets this through, though its name suggests it stops it.</p>' : ''}
<details class="why"><summary>Why · ${plural(c.hops.length, 'step')}</summary>${hops(c.hops, r, meta)}</details>
</div>${marks()}</li>`;
}

const STYLE = `
/* Layout: verdict first, then the work in the order a tester does it: one reading column of places and cases, with a slim sticky index on wide screens. */
:root {
  --paper: #f3f5f7; --surface: #ffffff; --ink: #18212b; --muted: #576473; --rule: #d8dee6;
  --act: #0d5466; --act-ink: #ffffff; --act-soft: #e1eef1;
  --watch: #8a5600; --watch-soft: #fbf0d9;
  --ok: #2c6b38; --ok-soft: #e3f1e5; --bad: #b3261e; --bad-soft: #fcebe9;
  --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-data: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --r: 6px;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #0f1419; --surface: #161d24; --ink: #e5eaf0; --muted: #9ba7b5; --rule: #2a343f;
  --act: #69c0d3; --act-ink: #08262d; --act-soft: #12313a;
  --watch: #e3b45e; --watch-soft: #382a10; --ok: #7fc68c; --ok-soft: #16301f; --bad: #ff8b7e; --bad-soft: #3b1714;
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --paper: #0f1419; --surface: #161d24; --ink: #e5eaf0; --muted: #9ba7b5; --rule: #2a343f;
  --act: #69c0d3; --act-ink: #08262d; --act-soft: #12313a;
  --watch: #e3b45e; --watch-soft: #382a10; --ok: #7fc68c; --ok-soft: #16301f; --bad: #ff8b7e; --bad-soft: #3b1714;
  color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--font-ui);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 56px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--paper); }
a { color: var(--act); }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid var(--act); outline-offset: 2px; }
code { font-family: var(--font-data); font-size: 13px; }
h1, h2, h3 { text-wrap: balance; margin: 0; }
.wrap { max-width: 1180px; margin: 0 auto; display: grid; gap: 28px; }
.top { padding-block: 28px 4px; display: grid; gap: 8px; min-width: 0; }
.eyebrow { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.top h1 { font-size: clamp(22px, 3.2vw, 30px); line-height: 1.2; font-weight: 700; letter-spacing: -.01em; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 13px; align-items: baseline; }
.facts code { color: var(--ink); }
.chip { display: inline-block; border: 1px solid var(--rule); border-radius: 999px; padding: 1px 9px; font-size: 12px; color: var(--ink); }
.how { color: var(--muted); font-size: 13px; max-width: 80ch; margin: 0; }
.verdict { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.tile { display: grid; gap: 2px; align-content: start; padding: 14px 16px; border: 1px solid var(--rule); border-radius: var(--r); background: var(--surface); color: var(--ink); text-decoration: none; min-width: 0; }
.tile:hover { border-color: var(--act); }
.tile .t { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 600; display: flex; gap: 6px; align-items: center; }
.tile .big { font-size: 34px; line-height: 1.05; font-weight: 750; font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
.tile .sub { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.tile.first { background: var(--act); border-color: var(--act); color: var(--act-ink); }
.tile.first .t, .tile.first .sub { color: var(--act-ink); opacity: .85; }
.tile.watch .t { color: var(--watch); }
.tile.skip .t { color: var(--ok); }
.tile.unseen { border-style: dashed; }
.note { margin: 0; padding: 10px 14px; border-radius: var(--r); background: var(--watch-soft); color: var(--ink); font-size: 14px; }
.note.bad { background: var(--bad-soft); }
.bar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 5; background: var(--paper); border-bottom: 1px solid var(--rule); padding-block: 10px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.progress { display: flex; gap: 10px; align-items: center; font-size: 13px; font-variant-numeric: tabular-nums; flex: 1 1 260px; min-width: 0; }
.meter { flex: 1 1 120px; height: 6px; border-radius: 3px; background: var(--rule); overflow: hidden; display: flex; max-width: 240px; }
.meter i { display: block; height: 100%; }
.meter .p { background: var(--ok); } .meter .f { background: var(--bad); }
#failed { color: var(--bad); font-weight: 600; }
.est { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); }
.est input { width: 4.5em; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 2px 6px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 4px; border: 1px solid var(--rule); background: var(--surface); color: var(--ink); cursor: pointer; }
.btn:hover { border-color: var(--act); }
#copied { font-size: 13px; color: var(--ok); }
#copybox { width: 100%; min-height: 8em; font-family: var(--font-data); font-size: 12px; color: var(--ink); background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; }
.cols { display: grid; gap: 28px; }
.index { display: none; }
main { display: grid; gap: 36px; min-width: 0; }
section { display: grid; gap: 14px; min-width: 0; }
section > h2 { font-size: 19px; font-weight: 700; display: flex; gap: 8px; align-items: baseline; }
section > h2 .g { color: var(--act); font-size: 15px; }
section#watch > h2 .g { color: var(--watch); } section#skip > h2 .g { color: var(--ok); } section#unseen > h2 .g { color: var(--muted); }
section > h2 .c { font-size: 13px; color: var(--muted); font-weight: 500; }
.lead { margin: 0; color: var(--muted); font-size: 14px; max-width: 72ch; }
.start { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; counter-reset: s; }
.start li { counter-increment: s; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r); }
.start li::before { content: counter(s); font-weight: 750; color: var(--act); font-variant-numeric: tabular-nums; font-size: 18px; line-height: 1.2; }
.start .where-line { font-size: 13px; color: var(--muted); }
.start .where-line b { color: var(--ink); }
.start p { margin: 0; }
.place { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r); min-width: 0; }
.place-head { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 12px 16px; border-bottom: 1px solid var(--rule); }
.place-head h3 { font-size: 16px; font-weight: 650; }
.place-head .where { color: var(--muted); overflow-wrap: anywhere; }
.place-head .n { margin-left: auto; font-size: 12px; color: var(--muted); }
.kind { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--act); font-weight: 650; }
.cases { list-style: none; margin: 0; padding: 0; }
.case { display: flex; flex-wrap: wrap; gap: 8px 16px; padding: 12px 16px; border-top: 1px solid var(--rule); }
.case:first-child { border-top: 0; }
.case[data-state="pass"] { background: var(--ok-soft); }
.case[data-state="fail"] { background: var(--bad-soft); }
.case-body { flex: 1 1 320px; min-width: 0; display: grid; gap: 3px; }
.case p { margin: 0; overflow-wrap: anywhere; }
.field { font-weight: 650; }
.lbl { display: inline-block; min-width: 4.6em; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.expect { font-weight: 600; }
.before { color: var(--muted); }
.hole { color: var(--watch); font-size: 14px; }
.skipline { color: var(--muted); font-size: 14px; }
.mark { display: flex; gap: 6px; align-self: start; }
.mark button { font: inherit; font-size: 13px; padding: 4px 12px; border-radius: 4px; border: 1px solid var(--rule); background: var(--surface); color: var(--ink); cursor: pointer; }
.mark button[data-v="pass"][aria-pressed="true"] { background: var(--ok); border-color: var(--ok); color: var(--surface); }
.mark button[data-v="fail"][aria-pressed="true"] { background: var(--bad); border-color: var(--bad); color: var(--surface); }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.why { margin-top: 4px; }
.hops { margin: 6px 0 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; }
.hops li { overflow-wrap: anywhere; }
.chk.yes { color: var(--ok); } .chk.no { color: var(--bad); font-weight: 700; }
.hl { font-weight: 600; }
.rule { color: var(--muted); }
.loc { font-family: var(--font-data); font-size: 12px; }
.group { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r); padding: 12px 16px; display: grid; gap: 8px; }
.group > summary { font-size: 15px; color: var(--ink); }
.group > summary b { font-weight: 650; }
.reg { list-style: none; margin: 0; padding: 0; }
.reg .case { padding: 8px 0; }
.tablewrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: var(--r); background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-top: 1px solid var(--rule); }
thead th { border-top: 0; font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
td code { overflow-wrap: anywhere; }
.unseen-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.unseen-list li { border: 1px dashed var(--rule); border-radius: var(--r); padding: 10px 14px; background: var(--surface); display: grid; gap: 2px; }
.unseen-list p { margin: 0; }
.close { color: var(--muted); font-size: 14px; }
.status-not-followed { color: var(--watch); font-weight: 600; }
.status-deleted, .status-no-app-effect, .status-test-only { color: var(--muted); }
.empty { padding: 24px; background: var(--surface); border: 1px solid var(--rule); border-radius: var(--r); display: grid; gap: 6px; }
.empty h2 { font-size: 22px; }
footer { color: var(--muted); font-size: 13px; display: grid; gap: 4px; border-top: 1px solid var(--rule); padding-top: 14px; }
footer p { margin: 0; }
@media (max-width: 760px) {
  .verdict { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile.first { grid-column: 1 / -1; }
  .tile .big { font-size: 28px; }
}
@media (min-width: 1100px) {
  .cols { grid-template-columns: 210px minmax(0, 1fr); }
  .index { display: block; position: sticky; top: calc(env(safe-area-inset-top, 0px) + 64px); align-self: start; max-height: calc(100vh - 90px); overflow: auto; font-size: 13px; }
  .index ol { list-style: none; margin: 0 0 12px; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .index .nm { min-width: 0; overflow-wrap: anywhere; }
  .index .h { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 10px 0 4px; display: block; text-decoration: none; }
  .index a { text-decoration: none; color: var(--ink); display: flex; gap: 6px; padding: 2px 4px; border-radius: 3px; }
  .index a:hover { background: var(--act-soft); }
  .index a .k { color: var(--muted); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
}
@media (prefers-reduced-motion: no-preference) { .case { transition: background-color .15s ease; } }
`;

const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById('teslon-data').textContent);
  var KEY = 'teslon:v1:' + data.repo + ':' + data.head;
  var marks = {};
  try { marks = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { marks = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(marks)); } catch (e) { /* this browser keeps nothing */ } }
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-key]'));
  var total = data.cases.length;
  function paint() {
    var pass = 0, fail = 0;
    rows.forEach(function (r) {
      var v = marks[r.getAttribute('data-key')] || '';
      r.setAttribute('data-state', v);
      Array.prototype.forEach.call(r.querySelectorAll('button[data-v]'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); });
    });
    data.cases.forEach(function (c) { if (marks[c.key] === 'pass') pass++; else if (marks[c.key] === 'fail') fail++; });
    var done = document.getElementById('done'); if (done) done.textContent = (pass + fail) + ' of ' + total + ' cases marked';
    var failed = document.getElementById('failed'); if (failed) failed.textContent = fail ? fail + ' failed' : '';
    var p = document.querySelector('.meter .p'), f = document.querySelector('.meter .f');
    if (p) p.style.width = (total ? 100 * pass / total : 0) + '%';
    if (f) f.style.width = (total ? 100 * fail / total : 0) + '%';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-v]') : null;
    if (!b) return;
    var row = b.closest('[data-key]');
    var k = row.getAttribute('data-key'), v = b.getAttribute('data-v');
    if (marks[k] === v) delete marks[k]; else marks[k] = v;
    save(); paint();
  });
  var mpc = document.getElementById('mpc'), hours = document.getElementById('hours');
  function estimate() {
    if (!mpc || !hours) return;
    var m = Number(mpc.value);
    hours.textContent = m > 0 ? '≈ ' + (Math.round(total * m / 6) / 10) + ' h' : '';
    try { if (m > 0) localStorage.setItem('teslon:v1:mpc', String(m)); } catch (e) { /* fine */ }
  }
  if (mpc) {
    if (!mpc.value) { try { var saved = localStorage.getItem('teslon:v1:mpc'); if (saved) mpc.value = saved; } catch (e) { /* fine */ } }
    mpc.addEventListener('input', estimate);
  }
  function word(k) { return marks[k] === 'pass' ? 'Pass' : marks[k] === 'fail' ? 'Fail' : ''; }
  function checklist() {
    var out = ['Teslon test plan · ' + data.title + ' · ' + data.head.slice(0, 7), ''], last = '';
    data.cases.forEach(function (c) {
      var place = c.kind + ': ' + c.place + (c.where && c.where !== c.place ? ' ' + c.where : '');
      if (place !== last) { out.push((last ? '\\n' : '') + '### ' + place); last = place; }
      var w = word(c.key);
      out.push('- [' + (marks[c.key] ? 'x' : ' ') + '] ' + (c.field ? c.field + ': ' : '') + c.do + ' → Expect ' + c.expect + (w ? ' (' + w + ')' : ''));
    });
    return out.join('\\n');
  }
  function csv() {
    var q = function (s) { s = String(s == null ? '' : s); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var out = ['tier,kind,place,where,field,do,expect,before,result'];
    data.cases.forEach(function (c) { out.push([c.tier, c.kind, c.place, c.where, c.field, c.do, c.expect, c.before, word(c.key)].map(q).join(',')); });
    return out.join('\\n');
  }
  function copy(text) {
    var said = document.getElementById('copied'), box = document.getElementById('copybox');
    function shown() { if (said) { said.textContent = 'Copied'; setTimeout(function () { said.textContent = ''; }, 2000); } }
    function fallback() { if (box) { box.hidden = false; box.value = text; box.focus(); box.select(); } if (said) said.textContent = 'Select all and copy'; }
    try { navigator.clipboard.writeText(text).then(shown, fallback); } catch (e) { fallback(); }
  }
  var a = document.getElementById('copy-plan'); if (a) a.addEventListener('click', function () { copy(checklist()); });
  var b2 = document.getElementById('copy-csv'); if (b2) b2.addEventListener('click', function () { copy(csv()); });
  paint(); estimate();
})();
`;

/** The cockpit for one report. Complete as static HTML; the script only adds marks, the estimate and copy-out. */
export function renderHtml(r: ImpactReport, meta: PrMeta, opts: HtmlOptions = {}): string {
  const k = counts(r);
  const pr = meta.number ? `PR #${meta.number}` : 'This change';
  const title = `${pr} test brief`;
  const repoName = meta.repoUrl?.split('/').slice(-2).join('/') ?? r.repo.split('/').pop() ?? '';
  const broad = broadDeltas(r);
  const grouped = (c: Case): boolean => c.tier === 'test-next' && broad.has(c.delta);
  const surf = new Map(r.surfaces.map((s) => [s.id, s]));
  const B: string[] = [];
  const ok = r.verification.hops - r.verification.failed.length;

  // ---- header and verdict
  B.push(`<header class="top"><span class="eyebrow">Teslon · what to test${repoName ? ` · ${x(repoName)}` : ''}</span>
<h1>${meta.title ? `${x(pr)}: ${x(meta.title)}` : `What ${x(pr.toLowerCase() === 'this change' ? 'this change' : pr)} asks QA to test`}</h1>
<div class="facts"><code>${x(r.base.slice(0, 7))}..${x(r.head.slice(0, 7))}</code><span class="chip">${meta.state === 'merged' ? 'merged' : 'open'}</span><span>${plural(r.ledger.length, 'file')} changed</span><span>base <code>${x(meta.baseRef)}</code></span>${meta.author ? `<span>by ${x(meta.author)}</span>` : ''}${meta.url && /^https?:\/\//.test(meta.url) ? `<a href="${x(meta.url)}" target="_blank" rel="noopener noreferrer">open the PR</a>` : ''}</div>
<p class="how">${x(meta.how)}</p></header>`);

  const actionable = r.cases.filter((c) => c.tier !== 'skip');
  if (r.triage.appEffect === 'none') {
    B.push(`<div class="empty"><h2>Nothing to test in the app</h2><p class="lead">${x(r.triage.summary)}</p></div>`);
  } else {
    const tile = (cls: string, t: Tier | 'unseen', big: number, sub: string): string =>
      `<a class="tile ${cls}" href="#${TIER[t].id}"><span class="t"><span aria-hidden="true">${TIER[t].glyph}</span>${TIER[t].title}</span><span class="big">${big}</span><span class="sub">${sub}</span></a>`;
    B.push(`<nav class="verdict" aria-label="Verdict">
${tile('first', 'test-first', k['test-first'].places, `${k['test-first'].places === 1 ? 'place' : 'places'} · ${plural(k['test-first'].cases, 'case')}`)}
${tile('next', 'test-next', k['test-next'].places, `${k['test-next'].places === 1 ? 'place' : 'places'} · ${plural(k['test-next'].cases, 'case')}`)}
${tile('watch', 'watch', k.watch.places, k.watch.places === 1 ? 'place' : 'places')}
${tile('skip', 'skip', k.skip.places, 'each with proof')}
${tile('unseen', 'unseen', k.unseen.places, k.unseen.places === 1 ? 'thing, said out loud' : 'things, said out loud')}
</nav>`);
    if (r.triage.appEffect === 'unknown') B.push(`<p class="note">Some changed lines were not followed, so nothing outside the places below is ruled out. They are listed under <a href="#unseen">Teslon could not see</a> and in <a href="#ledger">every changed file</a>.</p>`);
  }
  if (r.verification.failed.length) B.push(`<p class="note bad"><b>${plural(r.verification.failed.length, 'cited line')} did not re-check.</b> The steps marked ✗ below are not proven. This is a Teslon bug; please report it.</p>`);

  // ---- toolbar
  if (actionable.length) {
    B.push(`<div class="bar"><div class="progress"><span id="done">0 of ${actionable.length} cases marked</span><span class="meter" aria-hidden="true"><i class="p"></i><i class="f"></i></span><span id="failed"></span></div>
<label class="est" for="mpc">min a case <input id="mpc" type="number" min="1" max="600" inputmode="numeric" value="${meta.minutesPerCase ?? ''}" placeholder="—"> <span id="hours"></span></label>
<div class="actions"><button type="button" class="btn" id="copy-plan">Copy checklist</button><button type="button" class="btn" id="copy-csv">Copy as CSV</button><span id="copied" aria-live="polite"></span></div>
<textarea id="copybox" hidden aria-label="Copied text"></textarea></div>`);
  }

  // ---- index (wide screens) and main column
  const tiers = (['test-first', 'test-next', 'watch'] as const).map((t) => ({
    t,
    list: r.surfaces.filter((s) => s.tier === t && r.cases.some((c) => c.surface === s.id && !grouped(c))).sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)),
  }));
  const pid = (s: Surface): string => `p-${key({ surface: s.id, delta: '', do: '' } as Case)}`;
  const idx: string[] = [];
  if (r.triage.appEffect !== 'none') {
    idx.push(`<a class="h" href="#start">Start here</a>`);
    if (broad.size) idx.push(`<a class="h" href="#regression">Regression lists · ${broad.size}</a>`);
    for (const { t, list } of tiers) {
      if (!list.length) continue;
      idx.push(`<a class="h" href="#${t}">${TIER[t].glyph} ${TIER[t].title}</a><ol>${list.map((s) => `<li><a href="#${pid(s)}"><span class="nm">${x(s.name)}</span><span class="k">${r.cases.filter((c) => c.surface === s.id && !grouped(c) && c.tier !== 'skip').length}</span></a></li>`).join('')}</ol>`);
    }
    if (k.skip.places) idx.push(`<a class="h" href="#skip">✓ Safe to skip · ${k.skip.places}</a>`);
    if (r.unseen.length) idx.push(`<a class="h" href="#unseen">? Could not see · ${r.unseen.length}</a>`);
  }
  idx.push(`<a class="h" href="#ledger">Every changed file · ${r.ledger.length}</a>`);

  const M: string[] = [];
  if (r.triage.appEffect !== 'none') {
    const picks = startHere(r, 5);
    if (picks.length) {
      M.push(`<section id="start"><h2>Start here</h2><p class="lead">One case from each of the riskiest places, in the order to run them.</p><ol class="start">${picks.map(({ s, c }) => {
        const field = [c.section, c.field].filter(Boolean).join(' › ');
        return `<li><div><p class="where-line">${x(KIND_WORD[s.kind] ?? s.kind)} · <b>${x(s.name)}</b>${s.where && s.where !== s.name ? ` <code>${x(s.where)}</code>` : ''}${field ? ` · ${x(field)}` : ''}</p><p>${x(c.do)} <b>Expect: ${x(c.expect)}</b></p></div></li>`;
      }).join('')}</ol></section>`);
    }

    if (broad.size) {
      M.push(`<section id="regression"><h2>Regression lists <span class="c">${broad.size}</span></h2><p class="lead">Changed code that many places run. Check each still works as before.</p>`);
      for (const [id, ss] of broad) {
        const d = r.deltas.find((dd) => dd.id === id);
        const cs = r.cases.filter((c) => c.delta === id && grouped(c)).sort((a, b) => (KIND_ORDER[surf.get(a.surface)?.kind ?? ''] ?? 9) - (KIND_ORDER[surf.get(b.surface)?.kind ?? ''] ?? 9));
        const first = cs[0];
        M.push(`<details class="group"><summary><b>${x(d?.title ?? id)}</b> · ${plural(ss.size, 'place')}</summary>
${first ? `<p><span class="lbl">Do</span>${x(first.do)}</p><p class="expect"><span class="lbl">Expect</span>${x(first.expect)}</p>` : ''}${d?.causes[0] ? `<p class="close">Because ${hopLink(d.causes[0], r, meta)} ${x(d.causes[0].rule)}</p>` : ''}
<ul class="reg">${cs.map((c) => { const s = surf.get(c.surface); return `<li class="case" data-key="${key(c)}"><div class="case-body"><p><span class="kind">${x(KIND_WORD[s?.kind ?? ''] ?? '')}</span> ${x(s?.name ?? c.surface)}${s?.where && s.where !== s.name ? ` <code>${x(s.where)}</code>` : ''}</p>${first && c.do !== first.do ? `<p class="before">${x(c.do)}</p>` : ''}</div>${marks()}</li>`; }).join('')}</ul></details>`);
      }
      M.push(`</section>`);
    }

    for (const { t, list } of tiers) {
      if (!list.length) continue;
      const n = list.reduce((a, s) => a + r.cases.filter((c) => c.surface === s.id && !grouped(c) && c.tier !== 'skip').length, 0);
      M.push(`<section id="${t}"><h2><span class="g" aria-hidden="true">${TIER[t].glyph}</span>${TIER[t].title} <span class="c">${plural(list.length, 'place')} · ${plural(n, 'case')}</span></h2>`);
      for (const s of list) {
        const cs = r.cases.filter((c) => c.surface === s.id && !grouped(c));
        const run = cs.filter((c) => c.tier !== 'skip');
        M.push(`<article class="place" id="${pid(s)}">${placeHead(s, run.length)}<ol class="cases">${run.map((c) => caseRow(c, r, meta)).join('\n')}${cs.filter((c) => c.tier === 'skip').map((c) => `<li class="case"><p class="skipline">${x([c.section, c.field].filter(Boolean).join(' › '))}: not affected. ${x(c.expect)}</p></li>`).join('')}</ol></article>`);
      }
      M.push(`</section>`);
    }

    const skips = r.surfaces.filter((s) => s.tier === 'skip');
    if (skips.length) {
      M.push(`<section id="skip"><h2><span class="g" aria-hidden="true">✓</span>Safe to skip <span class="c">${plural(skips.length, 'place')}, each with proof</span></h2><div class="tablewrap"><table><thead><tr><th>Place</th><th>Why it is not affected</th><th>Proof</th></tr></thead><tbody>${skips.map((s) => `<tr><td><span class="kind">${x(KIND_WORD[s.kind] ?? s.kind)}</span><br>${x(s.name)}${s.where && s.where !== s.name ? `<br><code>${x(s.where)}</code>` : ''}</td><td>${x(s.reason ?? '')}</td><td>${(s.evidence ?? []).slice(0, 3).map((h) => hopLink(h, r, meta)).join('<br>')}</td></tr>`).join('')}</tbody></table></div></section>`);
    }
    if (r.unseen.length) {
      M.push(`<section id="unseen"><h2><span class="g" aria-hidden="true">?</span>Teslon could not see <span class="c">${r.unseen.length}</span></h2><p class="lead">Places this change may reach that are outside what Teslon can read. Each says how to close it.</p><ul class="unseen-list">${r.unseen.map((u) => `<li><p><b>${x(u.what)}</b></p><p>${x(u.why)}</p><p class="close">To close it: ${x(u.resolve)}</p></li>`).join('')}</ul></section>`);
    }
    if (r.deltas.length) {
      M.push(`<section id="changes"><details class="group"><summary><b>What changed in behaviour</b> · ${r.deltas.length}</summary><ul class="hops">${r.deltas.map((d) => `<li>${x(d.title)}${d.causes[0] ? ` · ${hopLink(d.causes[0], r, meta)}` : ''}</li>`).join('')}</ul></details></section>`);
    }
  }
  M.push(`<section id="ledger"><details class="group"${r.triage.appEffect === 'none' ? ' open' : ''}><summary><b>Every changed file, accounted for</b> · ${r.ledger.length}</summary><div class="tablewrap"><table><thead><tr><th>File</th><th>Status</th><th>Why</th></tr></thead><tbody>${r.ledger.map((l) => { const w = LEDGER_WORD[l.status] ?? l.status; return `<tr><td><code>${x(l.file)}</code></td><td class="status-${w.replace(/ /g, '-')}">${x(w)}</td><td>${x(l.reason ?? '')}${l.lines.length ? ` <span class="rule">lines ${x(l.lines.slice(0, 12).join(', '))}${l.lines.length > 12 ? '…' : ''}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div></details></section>`);

  B.push(`<div class="cols"><nav class="index" aria-label="Places">${idx.join('')}</nav><main>${M.join('\n')}</main></div>`);
  B.push(`<footer><p>Every claim cites the code: ${ok} of ${r.verification.hops} cited lines re-checked at <code>${x(r.head.slice(0, 7)) }</code>. Cases follow from the code; they were not run.</p><p>Marks are kept in this browser, for this commit only.${meta.runUrl && /^https?:\/\//.test(meta.runUrl) ? ` <a href="${x(meta.runUrl)}" target="_blank" rel="noopener noreferrer">The run</a>.` : ''} Teslon ${x(meta.version)} · ${x(r.schema)}</p></footer>`);

  const data = {
    repo: repoName || r.repo, head: r.head, title: meta.title ? `${pr}: ${meta.title}` : pr,
    cases: [...tiers.flatMap(({ list }) => list.flatMap((s) => r.cases.filter((c) => c.surface === s.id && !grouped(c) && c.tier !== 'skip'))), ...r.cases.filter((c) => grouped(c))].map((c) => {
      const s = surf.get(c.surface);
      return { key: key(c), tier: c.tier, kind: KIND_WORD[s?.kind ?? ''] ?? '', place: s?.name ?? c.surface, where: s?.where ?? '', field: [c.section, c.field].filter(Boolean).join(' › '), do: c.do, expect: c.expect, before: c.before };
    }),
  };
  // inert in a script tag: no "</script>", no "<!--", no line separators
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  const body = `<div class="wrap">\n${B.join('\n')}\n</div>\n<script type="application/json" id="teslon-data">${json}</script>\n<script>${SCRIPT}</script>`;
  const head = `<title>${x(title)}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style>${STYLE}</style>`;
  if (opts.fragment) return `${head}\n${body}\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
${head}
</head>
<body>
${body}
</body>
</html>
`;
}
