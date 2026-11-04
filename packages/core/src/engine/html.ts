import type { ImpactReport, Surface, Case, Hop, Tier } from './model.js';
import { type PrMeta, KIND_ORDER, broadDeltas, counts, startHere } from './markdown.js';

/**
 * The cockpit: one HTML file a tester opens from the run's artifact, or
 * locally. It is rendered complete on the server side, so it reads the same
 * with scripts off; the script only adds Pass / Fail marks (kept in this
 * browser, per commit), the progress ring, the estimate, the section control
 * and copy-out.
 *
 * Design: one readable column; a large title; the summary in one grouped
 * card; a translucent bar with a segmented control; inset grouped lists with
 * hairline separators; system text styles; semantic colours for risk, pass
 * and fail; motion only where it explains a change, and none with Reduce
 * Motion.
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
  for (const ch of `${c.surface}\u241f${c.delta}\u241f${c.do}\u241f${c.field ?? ''}`) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

const KIND_WORD: Record<string, string> = {
  screen: 'Screen', widget: 'On every screen', api: 'API', data: 'Data', dashboard: 'Dashboard',
  job: 'Job', 'test-plan': 'Load test plan', module: 'Service', deploy: 'Deployment',
};
const KIND_GROUP: Record<string, string> = { screen: 'Screens', widget: 'On every screen', api: 'APIs', data: 'Data', dashboard: 'Dashboards', job: 'Jobs', 'test-plan': 'Load test plans', module: 'Services', deploy: 'Deployment' };
const LEDGER_WORD: Record<string, string> = {
  explained: 'Explained', followed: 'Followed', 'test-only': 'Tests only', 'not-modelled': 'Not followed',
  'no-runtime-effect': 'No app effect', deleted: 'Deleted',
};

/* Small glyphs, drawn here: no icon font, no network. */
const ICON = {
  warn: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18.5 17h-17z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.05" fill="currentColor"/></svg>',
  check: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m6.4 10.2 2.4 2.4 4.8-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  question: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.2"/><path d="M7.8 7.7a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.6v.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="14.4" r="1" fill="currentColor"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

function hopLink(h: Hop, r: ImpactReport, meta: PrMeta): string {
  const label = `${fileName(h.file)}:${h.line}`;
  const tip = `${h.file}${h.side === 'base' ? ' (before the change)' : ''}${h.quote ? ` · the line says: ${h.quote}` : ''}`;
  if (!meta.repoUrl || !/^https?:\/\//.test(meta.repoUrl)) return `<code class="loc" title="${x(tip)}">${x(label)}</code>`;
  const sha = h.side === 'base' ? r.base : r.head;
  const href = `${meta.repoUrl}/blob/${sha}/${h.file.split('/').map(encodeURIComponent).join('/')}#L${h.line}`;
  return `<a class="loc" href="${x(href)}" target="_blank" rel="noopener noreferrer" title="${x(tip)}">${x(label)}</a>`;
}

/** The chain behind a case, as a path of steps. */
function hops(hs: readonly Hop[], r: ImpactReport, meta: PrMeta): string {
  return `<ol class="path">${hs.map((h) => `<li class="${h.verified === false ? 'bad' : ''}"><span class="step">${x(h.label)}</span> ${hopLink(h, r, meta)}${h.verified === false ? ' <span class="unchecked">did not re-check</span>' : ''}<span class="rule">${x(h.rule)}</span></li>`).join('')}</ol>`;
}

/** "Expect X. Risk: Y" reads as two lines: what should happen, and what may happen instead. */
function split(expect: string): { expect: string; risk: string | null } {
  const i = expect.search(/\s*Risk:\s*/);
  if (i < 0) return { expect, risk: null };
  return { expect: expect.slice(0, i).trim(), risk: expect.slice(i).replace(/^\s*Risk:\s*/, '').trim() };
}

function marks(label: string): string {
  return `<div class="mark" role="group" aria-label="Result: ${x(label)}"><button type="button" data-v="pass" aria-pressed="false">${ICON.ok}<span>Pass</span></button><button type="button" data-v="fail" aria-pressed="false">${ICON.no}<span>Fail</span></button></div>`;
}

function caseRow(c: Case, r: ImpactReport, meta: PrMeta): string {
  const field = [c.section, c.field].filter(Boolean).join(' › ');
  const { expect, risk } = split(c.expect);
  return `<li class="case" data-key="${key(c)}">
<div class="case-body">${field ? `<p class="field">${x(field)}</p>` : ''}
<p class="do"><span class="lbl">Do</span>${x(c.do)}</p>
<p class="expect"><span class="lbl">Expect</span>${x(expect)}</p>${risk ? `\n<p class="risk">${ICON.warn}<span><b>Risk</b> ${x(risk)}</span></p>` : ''}${c.before && c.before !== '—' ? `\n<p class="before"><span class="lbl">Before</span>${x(c.before)}</p>` : ''}${c.hole ? '\n<p class="risk">' + ICON.warn + '<span><b>Rule hole</b> the rule still lets this through, though its name suggests it stops it.</span></p>' : ''}
<details class="why"><summary>${ICON.chevron}Why · ${plural(c.hops.length, 'step')}</summary>${hops(c.hops, r, meta)}</details>
</div>${marks(field || c.do)}</li>`;
}


const STYLE = `
/* Layout: master and detail. A sidebar lists the places to test; the pane shows one thing at a time: the overview, one place, what is safe to skip, what could not be seen, or the files. On a phone the list lives in the overview and a place opens on its own, with a way back. */
:root {
  --bg: #f2f2f7; --card: #ffffff; --fill: rgba(118, 118, 128, 0.12); --fill-2: rgba(118, 118, 128, 0.07);
  --label: #1c1c1e; --label-2: rgba(60, 60, 67, 0.64); --label-3: rgba(60, 60, 67, 0.36); --sep: rgba(60, 60, 67, 0.18);
  --tint: #0a66d6; --first: #0a66d6; --next: #5856d6; --watch: #0e8fa7; --skip: #248a3d; --risk: #b45a06; --fail: #d70015; --pass: #248a3d;
  --tint-soft: rgba(10, 102, 214, 0.1); --pass-soft: rgba(36, 138, 61, 0.1); --fail-soft: rgba(215, 0, 21, 0.08); --risk-soft: rgba(196, 97, 10, 0.1);
  --side: rgba(242, 242, 247, 0.9); --thumb: #ffffff;
  --font: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --r: 14px; --r-s: 9px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #000000; --card: #1c1c1e; --fill: rgba(118, 118, 128, 0.24); --fill-2: rgba(118, 118, 128, 0.14);
  --label: #ffffff; --label-2: rgba(235, 235, 245, 0.64); --label-3: rgba(235, 235, 245, 0.34); --sep: rgba(84, 84, 88, 0.6);
  --tint: #0a84ff; --first: #0a84ff; --next: #7d7aff; --watch: #40c8e0; --skip: #30d158; --risk: #ff9f0a; --fail: #ff453a; --pass: #30d158;
  --tint-soft: rgba(10, 132, 255, 0.18); --pass-soft: rgba(48, 209, 88, 0.14); --fail-soft: rgba(255, 69, 58, 0.14); --risk-soft: rgba(255, 159, 10, 0.12);
  --side: rgba(28, 28, 30, 0.6); --thumb: #636366;
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #000000; --card: #1c1c1e; --fill: rgba(118, 118, 128, 0.24); --fill-2: rgba(118, 118, 128, 0.14);
  --label: #ffffff; --label-2: rgba(235, 235, 245, 0.64); --label-3: rgba(235, 235, 245, 0.34); --sep: rgba(84, 84, 88, 0.6);
  --tint: #0a84ff; --first: #0a84ff; --next: #7d7aff; --watch: #40c8e0; --skip: #30d158; --risk: #ff9f0a; --fail: #ff453a; --pass: #30d158;
  --tint-soft: rgba(10, 132, 255, 0.18); --pass-soft: rgba(48, 209, 88, 0.14); --fail-soft: rgba(255, 69, 58, 0.14); --risk-soft: rgba(255, 159, 10, 0.12);
  --side: rgba(28, 28, 30, 0.6); --thumb: #636366;
  color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--label); font: 400 16px/1.47 var(--font); letter-spacing: -0.01em; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 64px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
a { color: var(--tint); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 3px solid var(--tint); outline-offset: 2px; border-radius: 6px; }
code, .loc { font-family: var(--mono); font-size: 13px; letter-spacing: 0; }
h1, h2, h3 { margin: 0; text-wrap: balance; }
p { margin: 0; }
.i { width: 18px; height: 18px; flex: none; }

/* master and detail */
.app { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 36px; }
.app > * { min-width: 0; }
.side { display: none; }
.pane { display: grid; gap: 24px; padding-top: 32px; max-width: 760px; width: 100%; align-self: start; align-content: start; }
.view { display: grid; gap: 24px; min-width: 0; align-content: start; }
.js .view[hidden] { display: none; }
.js .view.enter { animation: enter 0.26s var(--ease); }
@keyframes enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (min-width: 1000px) {
  .app { grid-template-columns: 270px minmax(0, 1fr); }
  .side { display: block; position: sticky; top: env(safe-area-inset-top, 0px); align-self: start; max-height: 100vh; overflow-y: auto; padding: 28px 4px 28px 0; }
  .inline-list { display: none; }
  .back { display: none; }
}
.side nav { display: grid; gap: 2px; }
.side .h { font-size: 12px; font-weight: 600; color: var(--label-2); padding: 14px 10px 4px; letter-spacing: 0.01em; display: flex; justify-content: space-between; }
.side a { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; color: var(--label); font-size: 14px; text-decoration: none; transition: background-color 0.15s ease; }
.side a:hover { background: var(--fill-2); }
.side a[aria-current="true"] { background: var(--tint-soft); color: var(--tint); font-weight: 600; }
.side a .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side a .k { font-size: 12px; color: var(--label-2); font-variant-numeric: tabular-nums; }
.side a .w { color: var(--label-2); font-family: var(--mono); font-size: 12px; }
.side a .k.done { color: var(--pass); }
.side a .k.bad { color: var(--fail); }
.side .sub-h { font-size: 12px; font-weight: 500; color: var(--label-3); padding: 6px 10px 2px 26px; }
.side .brand { padding: 0 10px 8px; font-size: 13px; color: var(--label-2); }
.side .brand b { display: block; font-size: 15px; color: var(--label); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.d-first { background: var(--first); } .d-next { background: var(--next); } .d-watch { background: var(--watch); } .d-skip { background: var(--skip); } .d-unseen { background: var(--risk); } .d-none { background: var(--label-3); }

/* the overview */
.kicker { font-size: 13px; font-weight: 600; color: var(--label-2); letter-spacing: 0; }
.hero { display: grid; gap: 8px; }
.hero h1 { font-size: clamp(26px, 3.6vw, 32px); line-height: 1.15; font-weight: 700; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 14px; color: var(--label-2); }
.meta code { color: var(--label); }
.pill { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--fill); color: var(--label); letter-spacing: 0; }
.how { font-size: 13px; color: var(--label-2); max-width: 68ch; }
.card { background: var(--card); border-radius: var(--r); padding: 20px; display: grid; gap: 16px; }
.lead { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 4px 14px; }
.lead .fig { font-size: 56px; line-height: 1; font-weight: 700; letter-spacing: -0.035em; color: var(--label); }
.lead .cap { display: grid; gap: 2px; padding-bottom: 6px; }
.lead .cap b { font-size: 17px; font-weight: 600; }
.lead .cap span { font-size: 14px; color: var(--label-2); }
.split { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; }
.split i { display: block; height: 100%; }
.split .s-first { background: var(--first); } .split .s-next { background: var(--next); } .split .s-watch { background: var(--watch); } .split .s-skip { background: var(--skip); }
.kpis { list-style: none; margin: 0; padding: 0; display: grid; }
.kpis a { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto auto; align-items: center; gap: 10px; padding: 9px 2px; color: var(--label); text-decoration: none; border-top: 0.5px solid var(--sep); }
.kpis li:first-child a { border-top: 0; }
.kpis a:hover .t { text-decoration: underline; }
.kpis .t { font-size: 15px; font-weight: 500; }
.kpis .v { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.kpis .s { font-size: 13px; color: var(--label-2); min-width: 7.5em; text-align: right; font-variant-numeric: tabular-nums; }
.kpis .i { width: 14px; height: 14px; }
.meterrow { display: grid; gap: 8px; padding-top: 14px; border-top: 0.5px solid var(--sep); }
.meterline { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; font-size: 14px; color: var(--label-2); align-items: center; }
.meterline b { color: var(--label); font-weight: 600; }
.meter { height: 6px; border-radius: 3px; background: var(--fill); display: flex; overflow: hidden; }
.meter i { display: block; height: 100%; width: 0; transition: width 0.45s var(--ease); }
.meter .p { background: var(--pass); } .meter .f { background: var(--fail); }
.stepper { display: inline-flex; align-items: center; background: var(--fill); border-radius: var(--r-s); overflow: hidden; vertical-align: middle; }
.stepper button { width: 32px; height: 30px; border: 0; background: none; color: var(--label); font: 500 17px/1 var(--font); cursor: pointer; }
.stepper input { width: 42px; height: 30px; border: 0; background: none; color: var(--label); font: 600 14px var(--font); text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
.stepper input::-webkit-inner-spin-button, .stepper input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.tbtn { font: 600 14px var(--font); color: var(--tint); background: none; border: 0; padding: 7px 10px; border-radius: var(--r-s); cursor: pointer; }
.tbtn:hover { background: var(--tint-soft); }
.tbtn:active { opacity: 0.6; }
#copied { font-size: 13px; color: var(--pass); }
#copybox { width: 100%; min-height: 8em; font: 12px var(--mono); color: var(--label); background: var(--card); border: 0.5px solid var(--sep); border-radius: var(--r-s); padding: 10px; }
.note { background: var(--risk-soft); border-radius: var(--r-s); padding: 12px 14px; font-size: 15px; display: flex; gap: 10px; align-items: flex-start; }
.note .i { color: var(--risk); margin-top: 2px; }
.note.bad { background: var(--fail-soft); } .note.bad .i { color: var(--fail); }

/* sections inside a view */
.sec { display: grid; gap: 10px; }
.sh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding-inline: 4px; }
.sh h2 { font-size: 20px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; }
.sh .c { font-size: 14px; color: var(--label-2); }
.sh .more { margin-left: auto; font-size: 14px; font-weight: 500; }
.sub { font-size: 14px; color: var(--label-2); padding-inline: 4px; max-width: 64ch; }
.group { background: var(--card); border-radius: var(--r); overflow: hidden; min-width: 0; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li { position: relative; }
.rows > li + li::before { content: ""; position: absolute; top: 0; left: 16px; right: 0; border-top: 0.5px solid var(--sep); }

/* rows that open a place: a list with chevrons */
.nav-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: var(--label); text-decoration: none; transition: background-color 0.15s ease; }
.nav-row:hover { background: var(--fill-2); text-decoration: none; }
.nav-row:active { background: var(--fill); }
.nav-row .t { flex: 1; display: grid; gap: 1px; min-width: 0; }
.nav-row .t b { font-weight: 600; font-size: 16px; overflow-wrap: anywhere; }
.nav-row .t span { font-size: 13px; color: var(--label-2); overflow-wrap: anywhere; }
.nav-row .k { font-size: 14px; color: var(--label-2); font-variant-numeric: tabular-nums; }
.nav-row .chev { color: var(--label-3); width: 12px; height: 12px; }
.start .num { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-content: center; background: var(--tint-soft); color: var(--tint); font-size: 13px; font-weight: 700; }
.start .t .risk-line { display: flex; gap: 6px; align-items: flex-start; color: var(--label); font-size: 14px; }
.start .t .risk-line .i { width: 15px; height: 15px; color: var(--risk); margin-top: 2px; }

/* a place */
.back { font-size: 15px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; justify-self: start; }
@media (min-width: 1000px) { .pane .back { display: none; } }
.back .chev { transform: rotate(180deg); width: 12px; height: 12px; }
.ph { display: grid; gap: 6px; align-content: start; }
.ph .kind { font-size: 13px; font-weight: 600; color: var(--label-2); display: flex; align-items: center; gap: 8px; }
.ph h1 { font-size: clamp(24px, 3.2vw, 30px); line-height: 1.15; font-weight: 700; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.ph .where { font-size: 14px; color: var(--label-2); overflow-wrap: anywhere; }
.case { display: flex; flex-wrap: wrap; gap: 10px 16px; padding: 14px 16px 16px; transition: background-color 0.25s ease; }
.case[data-state="pass"] { background: var(--pass-soft); }
.case[data-state="fail"] { background: var(--fail-soft); }
.case-body { flex: 1 1 360px; min-width: 0; display: grid; gap: 4px; }
.case p { overflow-wrap: anywhere; max-width: 70ch; }
.field { font-size: 17px; font-weight: 600; letter-spacing: -0.015em; }
.lbl { display: inline-block; min-width: 4.4em; font-size: 13px; font-weight: 600; color: var(--label-2); }
.risk { display: flex; gap: 8px; align-items: flex-start; font-size: 15px; background: var(--risk-soft); border-radius: var(--r-s); padding: 8px 10px; margin-top: 2px; }
.risk .i { color: var(--risk); margin-top: 1px; }
.risk b { color: var(--risk); font-weight: 600; margin-right: 2px; }
.before { font-size: 14px; color: var(--label-2); }
.mark { display: inline-flex; align-self: flex-start; gap: 2px; padding: 2px; border-radius: var(--r-s); background: var(--fill); }
.mark button { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 12px; border: 0; border-radius: 7px; background: none; color: var(--label); font: 600 13px var(--font); cursor: pointer; transition: background-color 0.2s ease, color 0.2s ease, transform 0.12s ease; }
.mark button svg { width: 12px; height: 12px; opacity: 0.55; transition: opacity 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.mark button:active { transform: scale(0.96); }
.mark button[data-v="pass"][aria-pressed="true"] { background: var(--pass); color: #fff; }
.mark button[data-v="fail"][aria-pressed="true"] { background: var(--fail); color: #fff; }
.mark button[aria-pressed="true"] svg { opacity: 1; transform: scale(1.15); }
.why { margin-top: 4px; }
.why > summary { list-style: none; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--tint); padding: 4px 0; }
.why > summary::-webkit-details-marker { display: none; }
.chev { width: 12px; height: 12px; transition: transform 0.22s var(--ease); }
details[open] > summary .chev { transform: rotate(90deg); }
details[open] > .path, details[open] > .gbody, details[open] > .rows, details[open] > .tablewrap { animation: reveal 0.24s var(--ease); }
@keyframes reveal { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.path { list-style: none; margin: 6px 0 2px; padding: 0 0 0 18px; position: relative; display: grid; gap: 10px; font-size: 14px; }
.path::before { content: ""; position: absolute; left: 5px; top: 6px; bottom: 6px; width: 1.5px; background: var(--sep); border-radius: 1px; }
.path li { position: relative; display: grid; gap: 1px; overflow-wrap: anywhere; }
.path li::before { content: ""; position: absolute; left: -17px; top: 5px; width: 9px; height: 9px; border-radius: 50%; background: var(--card); border: 2px solid var(--pass); }
.path li.bad::before { border-color: var(--fail); }
.step { font-weight: 600; }
.rule { color: var(--label-2); }
.unchecked { color: var(--fail); font-weight: 600; font-size: 13px; }
.loc { color: var(--tint); font-size: 12.5px; }
.pager { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.pager a { display: grid; gap: 1px; max-width: 48%; font-size: 15px; font-weight: 600; }
.pager a span { font-size: 12px; color: var(--label-2); font-weight: 500; }
.pager a.next { text-align: right; margin-left: auto; }

/* lists: skipped, not visible, files */
.line { display: flex; gap: 12px; padding: 12px 16px; align-items: flex-start; }
.line .i { margin-top: 2px; }
.line .t { display: grid; gap: 2px; min-width: 0; }
.line .t b { font-weight: 600; overflow-wrap: anywhere; }
.line .t span { font-size: 14px; color: var(--label-2); overflow-wrap: anywhere; }
.skip-i { color: var(--skip); } .unseen-i { color: var(--risk); }
.gsum { list-style: none; display: flex; align-items: center; gap: 8px; padding: 14px 16px; cursor: pointer; font-size: 16px; font-weight: 600; }
.gsum::-webkit-details-marker { display: none; }
.gsum .c { margin-left: auto; font-weight: 400; font-size: 14px; color: var(--label-2); }
.gbody { padding: 0 16px 14px; display: grid; gap: 8px; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 10px 16px; }
thead th { font-size: 12px; font-weight: 600; color: var(--label-2); padding-block: 8px; }
tbody tr + tr td { border-top: 0.5px solid var(--sep); }
td code { overflow-wrap: anywhere; font-size: 12.5px; }
.st { font-size: 13px; font-weight: 600; }
.st-not-followed { color: var(--risk); } .st-no-app-effect, .st-tests-only, .st-deleted { color: var(--label-2); }
.empty { background: var(--card); border-radius: var(--r); padding: 36px 24px; text-align: center; display: grid; gap: 8px; justify-items: center; }
.empty .i { width: 44px; height: 44px; color: var(--skip); }
.empty h2 { font-size: 22px; font-weight: 700; }
.empty p { color: var(--label-2); max-width: 52ch; }
footer { color: var(--label-2); font-size: 13px; display: grid; gap: 4px; padding: 8px 4px 0; }

@media (max-width: 640px) {
  .card { padding: 16px; }
  .lead .fig { font-size: 48px; }
  .kpis .s { display: none; }
  .mark { width: 100%; }
  .mark button { flex: 1; justify-content: center; min-height: 44px; font-size: 15px; }
}
@media (pointer: coarse) { .mark button { min-height: 44px; } .stepper button, .stepper input { height: 44px; } .nav-row { min-height: 52px; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

const SCRIPT = `
(function () {
  document.documentElement.classList.add('js');
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
    var done = document.getElementById('done'); if (done) done.textContent = (pass + fail) + ' of ' + total + ' cases marked' + (fail ? ' · ' + fail + ' failed' : '');
    var p = document.querySelector('.meter .p'), f = document.querySelector('.meter .f');
    if (p) p.style.width = (total ? 100 * pass / total : 0) + '%';
    if (f) f.style.width = (total ? 100 * fail / total : 0) + '%';
    // each place in the list shows how far it is
    Array.prototype.forEach.call(document.querySelectorAll('[data-place]'), function (a) {
      var keys = (a.getAttribute('data-place') || '').split(' ').filter(Boolean);
      var m = 0, bad = 0;
      keys.forEach(function (k) { if (marks[k]) m++; if (marks[k] === 'fail') bad++; });
      var k = a.querySelector('.k');
      if (!k) return;
      k.textContent = m ? m + '/' + keys.length : String(keys.length);
      k.className = 'k' + (bad ? ' bad' : m === keys.length && m ? ' done' : '');
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-v]') : null;
    if (!b) return;
    var row = b.closest('[data-key]');
    var k = row.getAttribute('data-key'), v = b.getAttribute('data-v');
    if (marks[k] === v) delete marks[k]; else marks[k] = v;
    save(); paint();
  });

  // the estimate: cases x the team's own minutes per case
  var mpc = document.getElementById('mpc'), hours = document.getElementById('hours');
  function estimate() {
    if (!mpc || !hours) return;
    var m = Number(mpc.value);
    hours.textContent = m > 0 ? '≈ ' + (Math.round(total * m / 6) / 10) + ' h' : 'no estimate yet';
    try { if (m > 0) localStorage.setItem('teslon:v1:mpc', String(m)); } catch (e) { /* fine */ }
  }
  if (mpc) {
    if (!mpc.value) { try { var saved = localStorage.getItem('teslon:v1:mpc'); if (saved) mpc.value = saved; } catch (e) { /* fine */ } }
    mpc.addEventListener('input', estimate);
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (b) {
      b.addEventListener('click', function () { mpc.value = String(Math.max(1, Math.min(600, (Number(mpc.value) || 0) + Number(b.getAttribute('data-step'))))); estimate(); });
    });
  }

  // one view at a time, named in the address: #overview, #p-…, #skip, #unseen, #ledger
  var views = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
  var first = true;
  function show() {
    var id = (location.hash || '#overview').slice(1);
    var v = views.filter(function (x) { return x.id === id; })[0] || views[0];
    views.forEach(function (x) { x.hidden = x !== v; x.classList.remove('enter'); });
    if (!first) { void v.offsetWidth; v.classList.add('enter'); window.scrollTo(0, 0); var h = v.querySelector('h1, h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
    Array.prototype.forEach.call(document.querySelectorAll('.side a[href^="#"]'), function (a) { a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + v.id)); });
    first = false;
  }
  window.addEventListener('hashchange', show);
  show();

  // copy out
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
    function shown() { if (said) { said.textContent = 'Copied'; setTimeout(function () { said.textContent = ''; }, 1800); } }
    function fallback() { if (box) { box.hidden = false; box.value = text; box.focus(); box.select(); } if (said) said.textContent = 'Select all and copy'; }
    try { navigator.clipboard.writeText(text).then(shown, fallback); } catch (e) { fallback(); }
  }
  var a = document.getElementById('copy-plan'); if (a) a.addEventListener('click', function () { copy(checklist()); });
  var b2 = document.getElementById('copy-csv'); if (b2) b2.addEventListener('click', function () { copy(csv()); });
  paint(); estimate();
})();
`;

/** The cockpit for one report. Complete as static HTML; the script adds one-view-at-a-time, marks, the meter, the estimate and copy-out. */
export function renderHtml(r: ImpactReport, meta: PrMeta, opts: HtmlOptions = {}): string {
  const k = counts(r);
  const pr = meta.number ? `PR #${meta.number}` : 'This change';
  const title = meta.number ? `${pr} test brief` : 'Test brief';
  const repoName = meta.repoName ?? meta.repoUrl?.split('/').slice(-2).join('/') ?? r.repo.split('/').pop() ?? '';
  const broad = broadDeltas(r);
  const grouped = (c: Case): boolean => c.tier === 'test-next' && broad.has(c.delta);
  const surf = new Map(r.surfaces.map((s) => [s.id, s]));
  const ok = r.verification.hops - r.verification.failed.length;
  const actionable = r.cases.filter((c) => c.tier !== 'skip');
  const none = r.triage.appEffect === 'none';
  const pid = (s: Surface): string => `p-${key({ surface: s.id, delta: '', do: '' } as Case)}`;
  const TITLE: Record<string, string> = { 'test-first': 'Test first', 'test-next': 'Test next', watch: 'Watch after release' };
  const DOT: Record<string, string> = { 'test-first': 'd-first', 'test-next': 'd-next', watch: 'd-watch' };
  const tiers = (['test-first', 'test-next', 'watch'] as const).map((t) => ({
    t,
    list: r.surfaces.filter((s) => s.tier === t && r.cases.some((c) => c.surface === s.id && !grouped(c))).sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9)),
  }));
  const casesOf = (s: Surface): Case[] => r.cases.filter((c) => c.surface === s.id && !grouped(c));
  const runOf = (s: Surface): Case[] => casesOf(s).filter((c) => c.tier !== 'skip');
  const skips = r.surfaces.filter((s) => s.tier === 'skip');
  const order = tiers.flatMap(({ t, list }) => list.map((s) => ({ s, t })));
  const regs = [...broad].map(([id, ss]) => ({ id, ss, d: r.deltas.find((dd) => dd.id === id), cs: r.cases.filter((c) => c.delta === id && grouped(c)) }));
  const rid = (id: string): string => `r-${key({ surface: id, delta: '', do: '' } as Case)}`;
  const placeRow = (s: Surface, t: string, cls = 'nav-row'): string => {
    const keys = runOf(s).map(key).join(' ');
    return `<a class="${cls}" href="#${pid(s)}" data-place="${keys}"><span class="dot ${DOT[t]}"></span><span class="t"><b>${x(s.name)}</b><span>${x(KIND_WORD[s.kind] ?? s.kind)}${s.where && s.where !== s.name ? ` · ${x(s.where)}` : ''}</span></span><span class="k">${runOf(s).length}</span>${ICON.chevron}</a>`;
  };

  // ---- the sidebar: every place, in the order to test them
  const S: string[] = [`<p class="brand">Test brief<b>${x(repoName || pr)}</b></p><nav aria-label="Places">`, `<a href="#overview"><span class="nm">Overview</span></a>`];
  if (!none) {
    for (const { t, list } of tiers) {
      if (!list.length) continue;
      S.push(`<p class="h" id="${t}"><span>${TITLE[t]}</span><span>${list.length}</span></p>`);
      // screens first, then APIs, then the rest: each under its own small heading when a tier mixes them
      const kinds = [...new Set(list.map((s) => s.kind))];
      let lastKind = '';
      for (const s of list) {
        if (kinds.length > 1 && s.kind !== lastKind) { S.push(`<p class="sub-h">${x(KIND_GROUP[s.kind] ?? KIND_WORD[s.kind] ?? s.kind)}</p>`); lastKind = s.kind; }
        const dup = list.filter((o) => o.name === s.name).length > 1 && s.where !== s.name;
        S.push(`<a href="#${pid(s)}" data-place="${runOf(s).map(key).join(' ')}" title="${x(s.name)}${s.where && s.where !== s.name ? ` · ${x(s.where)}` : ''}"><span class="dot ${DOT[t]}"></span><span class="nm">${x(s.name)}${dup ? ` <span class="w">${x(s.where.split('/').filter(Boolean).slice(-2).join('/'))}</span>` : ''}</span><span class="k">${runOf(s).length}</span></a>`);
      }
    }
    if (regs.length) {
      S.push(`<p class="h"><span>Regression lists</span><span>${regs.length}</span></p>`);
      for (const g of regs) S.push(`<a href="#${rid(g.id)}" data-place="${g.cs.map(key).join(' ')}"><span class="dot d-next"></span><span class="nm">${x(g.d?.title ?? g.id)}</span><span class="k">${g.cs.length}</span></a>`);
    }
    S.push(`<p class="h"><span>Also</span></p>`);
    if (skips.length) S.push(`<a href="#skip"><span class="dot d-skip"></span><span class="nm">Safe to skip</span><span class="k">${skips.length}</span></a>`);
    if (r.unseen.length) S.push(`<a href="#unseen"><span class="dot d-unseen"></span><span class="nm">Could not see</span><span class="k">${r.unseen.length}</span></a>`);
  }
  S.push(`<a href="#ledger"><span class="dot d-none"></span><span class="nm">Changed files</span><span class="k">${r.ledger.length}</span></a></nav>`);

  // ---- view: overview
  const O: string[] = [];
  const h1 = meta.title ? (meta.number ? `${x(pr)}: ${x(meta.title)}` : x(meta.title)) : `What ${meta.number ? x(pr) : 'this change'} asks QA to test`;
  O.push(`<header class="hero"><p class="kicker">Test brief${repoName ? ` · ${x(repoName)}` : ''}</p>
<h1>${h1}</h1>
<p class="meta"><code>${x(r.base.slice(0, 7))}..${x(r.head.slice(0, 7))}</code><span class="pill">${meta.state === 'merged' ? 'Merged' : 'Open'}</span><span>${plural(r.ledger.length, 'file')} changed</span><span>base <code>${x(meta.baseRef)}</code></span>${meta.author ? `<span>by ${x(meta.author)}</span>` : ''}${meta.url && /^https?:\/\//.test(meta.url) ? `<a href="${x(meta.url)}" target="_blank" rel="noopener noreferrer">Open the pull request</a>` : ''}</p>
<p class="how">${x(meta.how)}</p></header>`);
  if (none) {
    O.push(`<div class="empty">${ICON.check}<h2>Nothing to test in the app</h2><p>${x(r.triage.summary)}</p></div>`);
  } else {
    // one hero figure: the cases to test now; the split of places beside its figures; progress as a meter
    const places = k['test-first'].places + k['test-next'].places + k.watch.places + k.skip.places;
    const seg = (cls: string, n: number): string => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
    const est = meta.minutesPerCase ? `≈ ${Math.round((actionable.length * meta.minutesPerCase) / 6) / 10} h` : 'no estimate yet';
    O.push(`<section class="card" aria-label="Summary">
<div class="lead"><span class="fig">${actionable.length}</span><span class="cap"><b>${actionable.length === 1 ? 'case' : 'cases'} to test</b><span>${plural(k['test-first'].cases, 'case')} first, across ${plural(k['test-first'].places, 'place')}</span></span></div>
<div class="split" role="img" aria-label="${k['test-first'].places} places to test first, ${k['test-next'].places} next, ${k.watch.places} to watch, ${k.skip.places} safe to skip, of ${places}">${seg('s-first', k['test-first'].places)}${seg('s-next', k['test-next'].places)}${seg('s-watch', k.watch.places)}${seg('s-skip', k.skip.places)}</div>
<ul class="kpis">
${k['test-first'].places ? `<li><a href="#${order.find((o) => o.t === 'test-first') ? pid(order.find((o) => o.t === 'test-first')!.s) : 'overview'}"><span class="dot d-first"></span><span class="t">Test first</span><span class="v">${plural(k['test-first'].places, 'place')}</span><span class="s">${plural(k['test-first'].cases, 'case')}</span></a></li>` : ''}
${k['test-next'].places ? `<li><a href="#${order.find((o) => o.t === 'test-next') ? pid(order.find((o) => o.t === 'test-next')!.s) : 'overview'}"><span class="dot d-next"></span><span class="t">Test next</span><span class="v">${plural(k['test-next'].places, 'place')}</span><span class="s">${plural(k['test-next'].cases, 'case')}</span></a></li>` : ''}
${k.watch.places ? `<li><a href="#${pid(order.find((o) => o.t === 'watch')!.s)}"><span class="dot d-watch"></span><span class="t">Watch after release</span><span class="v">${plural(k.watch.places, 'place')}</span><span class="s"></span></a></li>` : ''}
${skips.length ? `<li><a href="#skip"><span class="skip-i">${ICON.check}</span><span class="t">Safe to skip</span><span class="v">${plural(skips.length, 'place')}</span><span class="s">each with proof</span></a></li>` : ''}
${r.unseen.length ? `<li><a href="#unseen"><span class="unseen-i">${ICON.question}</span><span class="t">Could not see</span><span class="v">${r.unseen.length}</span><span class="s">said out loud</span></a></li>` : ''}
</ul>
<div class="meterrow"><div class="meterline"><span id="done" aria-live="polite">0 of ${actionable.length} cases marked</span><span>Estimate <b id="hours">${est}</b> at <span class="stepper"><button type="button" data-step="-1" aria-label="Fewer minutes">−</button><input id="mpc" type="number" min="1" max="600" inputmode="numeric" value="${meta.minutesPerCase ?? ''}" placeholder="—" aria-label="Minutes per case"><button type="button" data-step="1" aria-label="More minutes">+</button></span> min a case</span></div>
<div class="meter" role="img" aria-label="Cases marked"><i class="p"></i><i class="f"></i></div></div>
<div class="tools"><button type="button" class="tbtn" id="copy-plan">Copy checklist</button><button type="button" class="tbtn" id="copy-csv">Copy as CSV</button><span id="copied" aria-live="polite"></span><textarea id="copybox" hidden aria-label="Copied text"></textarea></div>
</section>`);
    if (r.triage.appEffect === 'unknown') O.push(`<p class="note">${ICON.warn}<span>Some changed lines were not followed, so nothing outside the places listed is ruled out. See <a href="#unseen">Could not see</a> and <a href="#ledger">Changed files</a>.</span></p>`);
    if (r.verification.failed.length) O.push(`<p class="note bad">${ICON.warn}<span><b>${plural(r.verification.failed.length, 'cited line')} did not re-check.</b> Those steps are not proven. This is a Teslon bug; please report it.</span></p>`);

    const picks = startHere(r, 5);
    if (picks.length) {
      O.push(`<section class="sec"><div class="sh"><h2>Start here</h2><span class="c">in this order</span></div><ol class="group rows start">${picks.map(({ s, c }, i) => {
        const field = [c.section, c.field].filter(Boolean).join(' › ');
        const { risk } = split(c.expect);
        return `<li><a class="nav-row" href="#${pid(s)}"><span class="num">${i + 1}</span><span class="t"><b>${x(s.name)}${field ? ` · ${x(field)}` : ''}</b><span>${x(c.do)}</span>${risk ? `<span class="risk-line">${ICON.warn}<span>${x(risk)}</span></span>` : ''}</span>${ICON.chevron}</a></li>`;
      }).join('')}</ol></section>`);
    }
    // on a phone there is no sidebar: the places are a list here
    O.push(`<div class="inline-list">${tiers.filter(({ list }) => list.length).map(({ t, list }) => `<section class="sec"><div class="sh"><h2>${TITLE[t]}</h2><span class="c">${plural(list.length, 'place')}</span></div><div class="group rows">${list.map((s) => placeRow(s, t)).join('')}</div></section>`).join('')}${regs.length ? `<section class="sec"><div class="sh"><h2>Regression lists</h2></div><div class="group rows">${regs.map((g) => `<a class="nav-row" href="#${rid(g.id)}" data-place="${g.cs.map(key).join(' ')}"><span class="dot d-next"></span><span class="t"><b>${x(g.d?.title ?? g.id)}</b><span>${plural(g.ss.size, 'place')}</span></span><span class="k">${g.cs.length}</span>${ICON.chevron}</a>`).join('')}</div></section>` : ''}<section class="sec"><div class="group rows">${skips.length ? `<a class="nav-row" href="#skip"><span class="skip-i">${ICON.check}</span><span class="t"><b>Safe to skip</b><span>each with proof</span></span><span class="k">${skips.length}</span>${ICON.chevron}</a>` : ''}${r.unseen.length ? `<a class="nav-row" href="#unseen"><span class="unseen-i">${ICON.question}</span><span class="t"><b>Could not see</b><span>said out loud</span></span><span class="k">${r.unseen.length}</span>${ICON.chevron}</a>` : ''}<a class="nav-row" href="#ledger"><span class="dot d-none"></span><span class="t"><b>Changed files</b><span>every one accounted for</span></span><span class="k">${r.ledger.length}</span>${ICON.chevron}</a></div></section></div>`);
  }
  O.push(`<footer><p>Every claim cites the code: ${ok} of ${r.verification.hops} cited lines re-checked at <code>${x(r.head.slice(0, 7))}</code>. Cases follow from the code; they were not run.</p><p>Marks are kept in this browser, for this commit only.${meta.runUrl && /^https?:\/\//.test(meta.runUrl) ? ` <a href="${x(meta.runUrl)}" target="_blank" rel="noopener noreferrer">The run</a>.` : ''} Teslon ${x(meta.version)} · ${x(r.schema)}</p></footer>`);

  const V: string[] = [`<section class="view" id="overview" data-view>${O.join('\n')}</section>`];
  const back = `<a class="back" href="#overview">${ICON.chevron}Overview</a>`;

  // ---- views: one per place, with the way to the previous and next place
  order.forEach(({ s, t }, i) => {
    const run = runOf(s);
    const prev = order[i - 1], next = order[i + 1];
    V.push(`<section class="view" id="${pid(s)}" data-view>${back}
<header class="ph"><p class="kind"><span class="dot ${DOT[t]}"></span>${TITLE[t]} · ${x(KIND_WORD[s.kind] ?? s.kind)}</p><h1>${x(s.name)}</h1>${s.where && s.where !== s.name ? `<code class="where">${x(s.where)}</code>` : ''}</header>
<ol class="group rows">${run.map((c) => caseRow(c, r, meta)).join('\n')}${casesOf(s).filter((c) => c.tier === 'skip').map((c) => `<li class="line"><span class="skip-i">${ICON.check}</span><span class="t"><b>${x([c.section, c.field].filter(Boolean).join(' › ') || 'Not affected')}</b><span>${x(c.expect)}</span></span></li>`).join('')}</ol>
<nav class="pager" aria-label="Places">${prev ? `<a href="#${pid(prev.s)}"><span>‹ Previous</span>${x(prev.s.name)}</a>` : ''}${next ? `<a class="next" href="#${pid(next.s)}"><span>Next ›</span>${x(next.s.name)}</a>` : '<a class="next" href="#overview"><span>Done ›</span>Overview</a>'}</nav></section>`);
  });
  for (const g of regs) {
    const first = g.cs[0];
    V.push(`<section class="view" id="${rid(g.id)}" data-view>${back}
<header class="ph"><p class="kind"><span class="dot d-next"></span>Regression list · ${plural(g.ss.size, 'place')}</p><h1>${x(g.d?.title ?? g.id)}</h1></header>
${first ? `<div class="card"><p><span class="lbl">Do</span>${x(first.do)}</p><p><span class="lbl">Expect</span>${x(first.expect)}</p>${g.d?.causes[0] ? `<p class="before">Because ${hopLink(g.d.causes[0], r, meta)} ${x(g.d.causes[0].rule)}</p>` : ''}</div>` : ''}
<ul class="group rows">${g.cs.map((c) => { const s = surf.get(c.surface); return `<li class="case" data-key="${key(c)}"><div class="case-body"><p class="field">${x(s?.name ?? c.surface)}</p>${s?.where && s.where !== s.name ? `<p class="before">${x(KIND_WORD[s.kind] ?? '')} · ${x(s.where)}</p>` : ''}${first && c.do !== first.do ? `<p class="before">${x(c.do)}</p>` : ''}</div>${marks(s?.name ?? c.surface)}</li>`; }).join('')}</ul></section>`);
  }

  // ---- views: safe to skip, could not see, changed files
  if (skips.length) V.push(`<section class="view" id="skip" data-view>${back}<header class="ph"><p class="kind"><span class="dot d-skip"></span>Each with proof</p><h1>Safe to skip</h1></header><ul class="group rows">${skips.map((s) => `<li class="line"><span class="skip-i">${ICON.check}</span><span class="t"><b>${x(s.name)}${s.where && s.where !== s.name ? ` <code>${x(s.where)}</code>` : ''}</b><span>${x(s.reason ?? '')}</span><span>${(s.evidence ?? []).slice(0, 3).map((h) => hopLink(h, r, meta)).join(' · ')}</span></span></li>`).join('')}</ul></section>`);
  if (r.unseen.length) V.push(`<section class="view" id="unseen" data-view>${back}<header class="ph"><p class="kind"><span class="dot d-unseen"></span>Said out loud</p><h1>Could not see</h1></header><p class="sub">What this change may reach that Teslon cannot read. Each says how to close it.</p><ul class="group rows">${r.unseen.map((u) => `<li class="line"><span class="unseen-i">${ICON.question}</span><span class="t"><b>${x(u.what)}</b><span>${x(u.why)}</span><span>To close it: ${x(u.resolve)}</span></span></li>`).join('')}</ul></section>`);
  V.push(`<section class="view" id="ledger" data-view>${back}<header class="ph"><p class="kind"><span class="dot d-none"></span>Every one accounted for</p><h1>Changed files</h1></header>
${r.deltas.length ? `<details class="group"${none ? '' : ' open'}><summary class="gsum">${ICON.chevron}What changed in behaviour<span class="c">${r.deltas.length}</span></summary><ul class="rows">${r.deltas.map((d) => `<li class="line"><span class="t"><b>${x(d.title)}</b>${d.causes[0] ? `<span>${hopLink(d.causes[0], r, meta)}</span>` : ''}</span></li>`).join('')}</ul></details>` : ''}
<div class="group tablewrap"><table><thead><tr><th>File</th><th>Status</th><th>Why</th></tr></thead><tbody>${r.ledger.map((l) => { const w = LEDGER_WORD[l.status] ?? l.status; return `<tr><td><code>${x(l.file)}</code></td><td class="st st-${w.toLowerCase().replace(/ /g, '-')}">${x(w)}</td><td>${x(l.reason ?? '')}${l.lines.length ? ` <span class="rule">lines ${x(l.lines.slice(0, 12).join(', '))}${l.lines.length > 12 ? '…' : ''}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div></section>`);

  const data = {
    repo: repoName || r.repo, head: r.head, title: meta.title ? `${pr}: ${meta.title}` : pr,
    cases: [...order.flatMap(({ s }) => runOf(s)), ...r.cases.filter((c) => grouped(c))].map((c) => {
      const s = surf.get(c.surface);
      return { key: key(c), tier: c.tier, kind: KIND_WORD[s?.kind ?? ''] ?? '', place: s?.name ?? c.surface, where: s?.where ?? '', field: [c.section, c.field].filter(Boolean).join(' › '), do: c.do, expect: c.expect, before: c.before };
    }),
  };
  // inert in a script tag: no "</script>", no "<!--", no line separators
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  const body = `<div class="app"><aside class="side">${S.join('')}</aside><div class="pane">${V.join('\n')}</div></div>\n<script type="application/json" id="teslon-data">${json}</script>\n<script>${SCRIPT}</script>`;
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
