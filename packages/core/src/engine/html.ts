import type { ImpactReport, Case, Hop } from './model.js';
import type { PrMeta } from './markdown.js';
import { brief, known, unnamed, SKIP_RULE, KNOWN_WORD, PROVING, type Area, type Module, type Brief } from './areas.js';

/**
 * The cockpit: one HTML file a tester opens from the run's artifact, or
 * locally. It answers one question first: which areas of the application to
 * test, which to skip, and why each answer can be trusted.
 *
 * The overview is the decision: test, skip and unclear in equal weight, how
 * sure Teslon is in words, what the PR changes, and the application map with
 * every area Teslon read, grouped by module. A module opens to its areas, an
 * area to its cases or its proof. On a wide screen the map is also the
 * sidebar.
 *
 * It is complete as static HTML and reads the same with scripts off; the
 * script adds one view at a time, Pass / Fail marks kept in this browser per
 * commit, progress, the estimate and copy-out. It loads nothing from
 * anywhere, and a content security policy holds it to that. Every string from
 * the repository is escaped; the data block cannot close its own script tag.
 */

export interface HtmlOptions {
  /** Leave out the document wrapper, for hosts that add their own. */
  readonly fragment?: boolean;
  /** When the brief was made, for the audit line. */
  readonly at?: string;
}

const x = (s: unknown): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fileName = (p: string): string => p.split('/').pop() ?? p;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function hash(s: string): string {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}
/** A short, stable key for a case, so a mark survives a re-render of the same commit. */
const key = (c: Case): string => hash(`${c.surface}\u241f${c.delta}\u241f${c.do}\u241f${c.field ?? ''}`);
const checkKey = (a: Area): string => hash(`check\u241f${a.id}`);
const aid = (a: Area): string => `a-${hash(a.id)}`;
const mid = (m: Module | string): string => `m-${hash(typeof m === 'string' ? m : m.name)}`;

const KIND_WORD: Record<string, string> = {
  screen: 'Screen', widget: 'On every screen', api: 'API', data: 'Data', dashboard: 'Dashboard',
  job: 'Job', 'test-plan': 'Load test plan', module: 'Service', deploy: 'Deployment',
};
const TIER_WORD: Record<string, string> = { 'test-first': 'Test first', 'test-next': 'Test', watch: 'Watch after release' };
const LEDGER_WORD: Record<string, string> = {
  explained: 'Explained', followed: 'Followed', 'test-only': 'Tests only', 'not-modelled': 'Not followed',
  'no-runtime-effect': 'No app effect', deleted: 'Deleted',
};

/* Small glyphs, drawn here: no icon font, no network. */
const ICON = {
  warn: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18.5 17h-17z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.6" r="1.05" fill="currentColor"/></svg>',
  check: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m6.4 10.2 2.4 2.4 4.8-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  question: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="3 2.2"/><path d="M7.8 7.7a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.6v.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="14.4" r="1" fill="currentColor"/></svg>',
  test: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="3.6" fill="currentColor"/></svg>',
  shield: '<svg class="i" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2 16.5 4.6v4.9c0 4-2.7 6.9-6.5 8.3-3.8-1.4-6.5-4.3-6.5-8.3V4.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m7 10 2.1 2.1 4-4.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};
const STATE_ICON = { test: ICON.test, skip: ICON.check, unclear: ICON.question } as const;
const stateWord = (a: Area): string => (a.state === 'skip' ? 'Safe to skip' : a.state === 'unclear' ? 'Unclear' : TIER_WORD[a.tier ?? 'test-next'] ?? 'Test');

function hopLink(h: Hop, r: ImpactReport, meta: PrMeta): string {
  const label = `${fileName(h.file)}:${h.line}`;
  const tip = `${h.file}${h.side === 'base' ? ' (before the change)' : ''}${h.quote ? ` · the line says: ${h.quote}` : ''}`;
  if (!meta.repoUrl || !/^https?:\/\//.test(meta.repoUrl)) return `<code class="loc" title="${x(tip)}">${x(label)}</code>`;
  const sha = h.side === 'base' ? r.base : r.head;
  const href = `${meta.repoUrl}/blob/${sha}/${h.file.split('/').map(encodeURIComponent).join('/')}#L${h.line}`;
  return `<a class="loc" href="${x(href)}" target="_blank" rel="noopener noreferrer" title="${x(tip)}">${x(label)}</a>`;
}

/** The chain behind a claim, as a path of steps. */
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

function knownTag(r: ImpactReport, c: Case): string {
  const k = known(r, c);
  return `<span class="kn kn-${k}" title="${x(`${KNOWN_WORD[k].word}: ${KNOWN_WORD[k].means}`)}">${KNOWN_WORD[k].word}</span>`;
}

function caseRow(c: Case, r: ImpactReport, meta: PrMeta): string {
  const field = [c.section, c.field].filter(Boolean).join(' › ');
  const { expect, risk } = split(c.expect);
  return `<li class="case" data-key="${key(c)}">
<div class="case-body"><p class="field">${field ? `${x(field)} ` : ''}${knownTag(r, c)}</p>
<p class="do"><span class="lbl">Do</span>${x(c.do)}</p>
<p class="expect"><span class="lbl">Expect</span>${x(expect)}</p>${risk ? `\n<p class="risk">${ICON.warn}<span><b>Risk</b> ${x(risk)}</span></p>` : ''}${c.before && c.before !== '—' ? `\n<p class="before"><span class="lbl">Before</span>${x(c.before)}</p>` : ''}${c.hole ? '\n<p class="risk">' + ICON.warn + '<span><b>Rule hole</b> the rule still lets this through, though its name suggests it stops it.</span></p>' : ''}
<details class="why"><summary>${ICON.chevron}How Teslon knows · ${plural(c.hops.length, 'step')}</summary>${hops(c.hops, r, meta)}</details>
</div>${marks(field || c.do)}</li>`;
}

/** The little squares of a module tile: one per area, in its state. */
function cells(m: Module): string {
  const max = 40;
  const out = m.areas.slice(0, max).map((a) => `<i class="c-${a.state}${a.tier === 'test-first' ? ' c-first' : ''}"></i>`).join('');
  return `${out}${m.areas.length > max ? `<span class="more">+${m.areas.length - max}</span>` : ''}`;
}

function counts(m: { test: number; skip: number; unclear: number }): string {
  return [m.test ? `${m.test} to test` : '', m.unclear ? `${m.unclear} unclear` : '', m.skip ? `${m.skip} skip` : ''].filter(Boolean).join(' · ');
}

const STYLE = `
:root {
  --bg: #f2f2f7; --card: #ffffff; --fill: rgba(118, 118, 128, 0.12); --fill-2: rgba(118, 118, 128, 0.07);
  --label: #1c1c1e; --label-2: rgba(60, 60, 67, 0.66); --label-3: rgba(60, 60, 67, 0.36); --sep: rgba(60, 60, 67, 0.18);
  --tint: #0a66d6; --test: #0a66d6; --skip: #248a3d; --unclear: #b45a06; --risk: #b45a06; --fail: #d70015; --pass: #248a3d;
  --tint-soft: rgba(10, 102, 214, 0.1); --skip-soft: rgba(36, 138, 61, 0.11); --pass-soft: rgba(36, 138, 61, 0.1); --fail-soft: rgba(215, 0, 21, 0.08); --risk-soft: rgba(196, 97, 10, 0.1);
  --font: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --r: 14px; --r-s: 9px;
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #000000; --card: #1c1c1e; --fill: rgba(118, 118, 128, 0.24); --fill-2: rgba(118, 118, 128, 0.14);
  --label: #ffffff; --label-2: rgba(235, 235, 245, 0.64); --label-3: rgba(235, 235, 245, 0.34); --sep: rgba(84, 84, 88, 0.6);
  --tint: #0a84ff; --test: #0a84ff; --skip: #30d158; --unclear: #ff9f0a; --risk: #ff9f0a; --fail: #ff453a; --pass: #30d158;
  --tint-soft: rgba(10, 132, 255, 0.18); --skip-soft: rgba(48, 209, 88, 0.16); --pass-soft: rgba(48, 209, 88, 0.14); --fail-soft: rgba(255, 69, 58, 0.14); --risk-soft: rgba(255, 159, 10, 0.12);
  color-scheme: dark; } }
:root[data-theme="dark"] {
  --bg: #000000; --card: #1c1c1e; --fill: rgba(118, 118, 128, 0.24); --fill-2: rgba(118, 118, 128, 0.14);
  --label: #ffffff; --label-2: rgba(235, 235, 245, 0.64); --label-3: rgba(235, 235, 245, 0.34); --sep: rgba(84, 84, 88, 0.6);
  --tint: #0a84ff; --test: #0a84ff; --skip: #30d158; --unclear: #ff9f0a; --risk: #ff9f0a; --fail: #ff453a; --pass: #30d158;
  --tint-soft: rgba(10, 132, 255, 0.18); --skip-soft: rgba(48, 209, 88, 0.16); --pass-soft: rgba(48, 209, 88, 0.14); --fail-soft: rgba(255, 69, 58, 0.14); --risk-soft: rgba(255, 159, 10, 0.12);
  color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--label); font: 400 16px/1.47 var(--font); letter-spacing: -0.01em; -webkit-font-smoothing: antialiased;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 0 64px; }
body::before { content: ""; position: fixed; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); z-index: 10; background: var(--bg); }
a { color: var(--tint); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 3px solid var(--tint); outline-offset: 2px; border-radius: 6px; }
/* a heading takes focus when a view opens, for screen readers; it is not a control, so it draws no ring */
[tabindex="-1"]:focus { outline: none; }
code, .loc { font-family: var(--mono); font-size: 13px; letter-spacing: 0; }
h1, h2, h3 { margin: 0; text-wrap: balance; }
p { margin: 0; }
.i { width: 18px; height: 18px; flex: none; }
.st-test { color: var(--test); } .st-skip { color: var(--skip); } .st-unclear { color: var(--unclear); }
.st-test, .st-skip, .st-unclear { display: inline-flex; }

/* master and detail: the map on the side, one view in the pane */
.app { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 36px; }
.app > * { min-width: 0; }
.side { display: none; }
.pane { display: grid; gap: 24px; padding-top: 32px; max-width: 780px; width: 100%; align-self: start; align-content: start; }
.view { display: grid; gap: 24px; min-width: 0; align-content: start; }
.js .view[hidden] { display: none; }
.js .view.enter { animation: enter 0.26s var(--ease); }
@keyframes enter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (min-width: 1000px) {
  .app { grid-template-columns: 272px minmax(0, 1fr); }
  .side { display: block; position: sticky; top: env(safe-area-inset-top, 0px); align-self: start; max-height: 100vh; overflow-y: auto; padding: 28px 4px 28px 0; }
  .pane .back.to-overview { display: none; }
}
.side nav { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
.side { overflow-x: hidden; }
.side .h { font-size: 12px; font-weight: 600; color: var(--label-2); padding: 16px 10px 4px; letter-spacing: 0.01em; display: flex; justify-content: space-between; }
.side a { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; color: var(--label); font-size: 14px; text-decoration: none; transition: background-color 0.15s ease; }
.side a:hover { background: var(--fill-2); }
.side a[aria-current="true"] { background: var(--tint-soft); color: var(--tint); font-weight: 600; }
.side a .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side a .k { font-size: 12px; color: var(--label-2); font-variant-numeric: tabular-nums; }
.side a .k.done { color: var(--pass); } .side a .k.bad { color: var(--fail); }
.side a .w { color: var(--label-2); font-family: var(--mono); font-size: 12px; flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side a .i { width: 14px; height: 14px; }
.side a.mod { font-weight: 600; margin-top: 6px; }
.side a.area { padding-left: 18px; }
.side a.skips { padding-left: 18px; color: var(--label-2); font-size: 13px; }
.side .brand { padding: 0 10px 8px; font-size: 13px; color: var(--label-2); }
.side .brand b { display: block; font-size: 15px; color: var(--label); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lvl { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
.lvl-high { background: var(--skip); } .lvl-partial { background: var(--unclear); } .lvl-low { background: var(--fail); }

/* the decision */
.kicker { font-size: 13px; font-weight: 600; color: var(--label-2); }
.hero { display: grid; gap: 8px; }
.hero h1 { font-size: clamp(26px, 3.6vw, 32px); line-height: 1.15; font-weight: 700; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: 14px; color: var(--label-2); }
.meta code { color: var(--label); }
.pill { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--fill); color: var(--label); }
.card { background: var(--card); border-radius: var(--r); padding: 20px; display: grid; gap: 18px; min-width: 0; }
.tri { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.v { display: grid; gap: 2px; align-content: start; padding: 14px 14px 12px; border-radius: 12px; background: var(--fill-2); color: var(--label); text-decoration: none; transition: background-color 0.15s ease, transform 0.12s ease; }
.v:hover { text-decoration: none; background: var(--fill); }
.v:active { transform: scale(0.985); }
.v .w { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; }
.v .w .i { width: 16px; height: 16px; }
.v .n { font-size: 44px; line-height: 1.05; font-weight: 700; letter-spacing: -0.035em; font-variant-numeric: tabular-nums; }
.v .s { font-size: 13px; color: var(--label-2); }
.v-test .w, .v-test .n { color: var(--test); } .v-skip .w, .v-skip .n { color: var(--skip); } .v-unclear .w, .v-unclear .n { color: var(--unclear); }
.v.zero .n { color: var(--label-3); }
.bar { display: flex; gap: 2px; height: 8px; border-radius: 4px; overflow: hidden; background: var(--fill); }
.bar i { display: block; height: 100%; }
.bar .b-test { background: var(--test); } .bar .b-unclear { background: var(--unclear); } .bar .b-skip { background: var(--skip); }
.conf { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; color: var(--label); text-decoration: none; }
.conf:hover { text-decoration: none; }
.conf .i { margin-top: 1px; }
.conf .t { flex: 1; display: grid; gap: 2px; min-width: 0; }
.conf .t b { font-size: 15px; }
.conf .t span { font-size: 14px; color: var(--label-2); }
.conf .chev { margin-top: 5px; color: var(--label-3); }
.conf-high { background: var(--skip-soft); } .conf-high .i, .conf-high b { color: var(--skip); }
.conf-partial { background: var(--risk-soft); } .conf-partial .i, .conf-partial b { color: var(--unclear); }
.conf-low { background: var(--fail-soft); } .conf-low .i, .conf-low b { color: var(--fail); }
.meterrow { display: grid; gap: 8px; padding-top: 16px; border-top: 0.5px solid var(--sep); }
.meterline { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 16px; font-size: 14px; color: var(--label-2); align-items: center; }
.meterline b { color: var(--label); font-weight: 600; }
.est { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.est b { min-width: 4.5em; }
.meter { height: 6px; border-radius: 3px; background: var(--fill); display: flex; overflow: hidden; }
.meter i { display: block; height: 100%; width: 0; transition: width 0.45s var(--ease); }
.meter .p { background: var(--pass); } .meter .f { background: var(--fail); }
.stepper { display: inline-flex; align-items: center; background: var(--fill); border-radius: var(--r-s); overflow: hidden; vertical-align: middle; }
.stepper button { width: 32px; height: 30px; border: 0; background: none; color: var(--label); font: 500 17px/1 var(--font); cursor: pointer; }
.stepper input { width: 42px; height: 30px; border: 0; background: none; color: var(--label); font: 600 14px var(--font); text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; appearance: textfield; }
.stepper input::-webkit-inner-spin-button, .stepper input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.tools { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: -6px 0 -6px -10px; }
.tbtn { font: 600 14px var(--font); color: var(--tint); background: none; border: 0; padding: 7px 10px; border-radius: var(--r-s); cursor: pointer; }
.tbtn:hover { background: var(--tint-soft); }
.tbtn:active { opacity: 0.6; }
#copied { font-size: 13px; color: var(--pass); }
#copybox { width: 100%; min-height: 8em; font: 12px var(--mono); color: var(--label); background: var(--card); border: 0.5px solid var(--sep); border-radius: var(--r-s); padding: 10px; }
.note { background: var(--fail-soft); border-radius: var(--r-s); padding: 12px 14px; font-size: 15px; display: flex; gap: 10px; align-items: flex-start; }
.note .i { color: var(--fail); margin-top: 2px; }

/* sections */
.sec { display: grid; gap: 10px; min-width: 0; }
.sh { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding-inline: 4px; }
.sh h2 { font-size: 20px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; }
.sh .c { font-size: 14px; color: var(--label-2); }
.sub { font-size: 14px; color: var(--label-2); padding-inline: 4px; max-width: 66ch; }
.group { background: var(--card); border-radius: var(--r); overflow: hidden; min-width: 0; }
.rows { list-style: none; margin: 0; padding: 0; }
.rows > li, .rows > a { position: relative; }
.rows > li + li::before, .rows > a + a::before { content: ""; position: absolute; top: 0; left: 16px; right: 0; border-top: 0.5px solid var(--sep); }

/* what the PR changes, and what its author says */
.chg { display: flex; gap: 12px; padding: 12px 16px; align-items: flex-start; }
.chg .t { flex: 1; display: grid; gap: 2px; min-width: 0; }
.chg .t b { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.chg .t span { font-size: 13px; color: var(--label-2); overflow-wrap: anywhere; }
.kn { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase; padding: 2px 7px; border-radius: 6px; vertical-align: 2px; white-space: nowrap; }
.kn-proven { background: var(--tint-soft); color: var(--tint); }
.kn-followed { background: var(--fill); color: var(--label-2); }
.chg .kn, .line .kn { margin-top: 2px; min-width: 78px; text-align: center; flex: none; }
.said { padding: 14px 16px; display: grid; gap: 10px; }
.said blockquote { margin: 0; padding: 0 0 0 12px; border-left: 3px solid var(--sep); color: var(--label); font-size: 15px; overflow-wrap: anywhere; }
.said .lbl2 { font-size: 13px; font-weight: 600; color: var(--label-2); }
.gap { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; background: var(--risk-soft); border-radius: var(--r-s); padding: 8px 10px; }
.gap .i { color: var(--risk); margin-top: 1px; width: 16px; height: 16px; }

/* the application map: one tile per module, one square per area */
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; }
.tile { display: grid; gap: 10px; align-content: start; padding: 14px 16px; border-radius: var(--r); background: var(--card); color: var(--label); text-decoration: none; transition: transform 0.12s ease, box-shadow 0.2s ease; }
.tile:hover { text-decoration: none; box-shadow: 0 0 0 1.5px var(--sep) inset; }
.tile:active { transform: scale(0.985); }
.tile .tn { font-size: 16px; font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.tile .tn .chev { margin-top: 6px; color: var(--label-3); }
.tile .ts { font-size: 13px; color: var(--label-2); }
.cellrow { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.cellrow i { width: 13px; height: 13px; border-radius: 3.5px; display: block; }
.cellrow .more { font-size: 12px; color: var(--label-2); margin-left: 3px; }
.c-test { background: var(--test); }
.c-test.c-first { box-shadow: 0 0 0 1.5px var(--card), 0 0 0 3px var(--test); margin: 0 2px; }
.c-unclear { background: repeating-linear-gradient(135deg, var(--unclear) 0 2.5px, transparent 2.5px 5px); box-shadow: 0 0 0 1.2px var(--unclear) inset; }
.c-skip { background: var(--skip-soft); box-shadow: 0 0 0 1.2px var(--skip) inset; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--label-2); padding-inline: 4px; align-items: center; }
.legend > span { display: inline-flex; gap: 7px; align-items: center; }
.legend .cellrow { display: inline-flex; }

/* rows that open something */
.nav-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: var(--label); text-decoration: none; transition: background-color 0.15s ease; }
.nav-row:hover { background: var(--fill-2); text-decoration: none; }
.nav-row:active { background: var(--fill); }
.nav-row .t { flex: 1; display: grid; gap: 1px; min-width: 0; }
.nav-row .t b { font-weight: 600; font-size: 16px; overflow-wrap: anywhere; }
.nav-row .t b span { font-weight: 400; color: var(--label-2); font-size: 14px; }
.nav-row .t > span { font-size: 13px; color: var(--label-2); overflow-wrap: anywhere; }
.nav-row .k { font-size: 14px; color: var(--label-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.nav-row .k.done { color: var(--pass); } .nav-row .k.bad { color: var(--fail); }
.nav-row .chev { color: var(--label-3); width: 12px; height: 12px; flex: none; }
.nav-row.skipped .t b { font-weight: 500; }
.start .num { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-content: center; background: var(--tint-soft); color: var(--tint); font-size: 13px; font-weight: 700; }
.risk-line { display: flex; gap: 6px; align-items: flex-start; color: var(--label); font-size: 14px; }
.risk-line .i { width: 15px; height: 15px; color: var(--risk); margin-top: 2px; }

/* a module, an area */
.back { font-size: 15px; font-weight: 500; display: inline-flex; align-items: center; gap: 4px; justify-self: start; }
.back .chev { transform: rotate(180deg); width: 12px; height: 12px; }
.ph { display: grid; gap: 6px; align-content: start; }
.ph .kind { font-size: 13px; font-weight: 600; color: var(--label-2); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ph .kind .i { width: 16px; height: 16px; }
.ph h1 { font-size: clamp(24px, 3.2vw, 30px); line-height: 1.15; font-weight: 700; letter-spacing: -0.025em; overflow-wrap: anywhere; }
.ph .where { font-size: 14px; color: var(--label-2); overflow-wrap: anywhere; }
.verdict-box { display: grid; gap: 10px; padding: 16px; border-radius: var(--r); }
.verdict-box.vb-skip { background: var(--skip-soft); } .verdict-box.vb-unclear { background: var(--risk-soft); }
.verdict-box .vh { display: flex; gap: 8px; align-items: center; font-weight: 700; font-size: 17px; }
.verdict-box.vb-skip .vh { color: var(--skip); } .verdict-box.vb-unclear .vh { color: var(--unclear); }
.verdict-box p { font-size: 15px; overflow-wrap: anywhere; }
.verdict-box .rulep { font-size: 13px; color: var(--label-2); }
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
details[open] > .path, details[open] > .rows, details[open] > .tablewrap { animation: reveal 0.24s var(--ease); }
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
.pager a { display: grid; gap: 1px; max-width: 48%; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.pager a span { font-size: 12px; color: var(--label-2); font-weight: 500; }
.pager a.next { text-align: right; margin-left: auto; }

/* lists: not visible, files, how sure */
.line { display: flex; gap: 12px; padding: 12px 16px; align-items: flex-start; }
.line .i { margin-top: 2px; }
.line .t { display: grid; gap: 2px; min-width: 0; }
.line .t b { font-weight: 600; overflow-wrap: anywhere; }
.line .t span { font-size: 14px; color: var(--label-2); overflow-wrap: anywhere; }
.gsum { list-style: none; display: flex; align-items: center; gap: 8px; padding: 14px 16px; cursor: pointer; font-size: 16px; font-weight: 600; }
.gsum::-webkit-details-marker { display: none; }
.gsum .c { margin-left: auto; font-weight: 400; font-size: 14px; color: var(--label-2); }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 10px 16px; }
thead th { font-size: 12px; font-weight: 600; color: var(--label-2); padding-block: 8px; }
tbody tr + tr td { border-top: 0.5px solid var(--sep); }
td code { overflow-wrap: anywhere; font-size: 12.5px; }
.lst { font-size: 13px; font-weight: 600; white-space: nowrap; }
.lst-not-followed { color: var(--risk); } .lst-no-app-effect, .lst-tests-only, .lst-deleted { color: var(--label-2); }
.empty { background: var(--card); border-radius: var(--r); padding: 36px 24px; text-align: center; display: grid; gap: 8px; justify-items: center; }
.empty .i { width: 44px; height: 44px; color: var(--skip); }
.empty h2 { font-size: 22px; font-weight: 700; }
.empty p { color: var(--label-2); max-width: 52ch; }
footer { color: var(--label-2); font-size: 13px; display: grid; gap: 4px; padding: 8px 4px 0; overflow-wrap: anywhere; }

@media (max-width: 640px) {
  .card { padding: 16px; gap: 16px; }
  .tri { gap: 6px; }
  .v { padding: 12px 10px 10px; }
  .v .n { font-size: 34px; }
  .v .s { font-size: 12px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tile { padding: 12px 14px; }
  .mark { width: 100%; }
  .mark button { flex: 1; justify-content: center; min-height: 44px; font-size: 15px; }
  .chg { flex-direction: column; gap: 6px; }
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
  var total = data.items.length;

  function paint() {
    var pass = 0, fail = 0;
    rows.forEach(function (r) {
      var v = marks[r.getAttribute('data-key')] || '';
      r.setAttribute('data-state', v);
      Array.prototype.forEach.call(r.querySelectorAll('button[data-v]'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === v)); });
    });
    data.items.forEach(function (c) { if (marks[c.key] === 'pass') pass++; else if (marks[c.key] === 'fail') fail++; });
    var done = document.getElementById('done'); if (done) done.textContent = (pass + fail) + ' of ' + total + ' marked' + (fail ? ' · ' + fail + ' failed' : '');
    var p = document.querySelector('.meter .p'), f = document.querySelector('.meter .f');
    if (p) p.style.width = (total ? 100 * pass / total : 0) + '%';
    if (f) f.style.width = (total ? 100 * fail / total : 0) + '%';
    // every link to an area or module shows how far it is
    Array.prototype.forEach.call(document.querySelectorAll('[data-place]'), function (a) {
      var keys = (a.getAttribute('data-place') || '').split(' ').filter(Boolean);
      var k = a.querySelector('.k');
      if (!k || !keys.length) return;
      var m = 0, bad = 0;
      keys.forEach(function (x) { if (marks[x]) m++; if (marks[x] === 'fail') bad++; });
      k.textContent = m ? m + '/' + keys.length : (k.getAttribute('data-n') || String(keys.length));
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

  // the estimate: what there is to run x the team's own minutes for each
  var mpc = document.getElementById('mpc'), hours = document.getElementById('hours');
  function estimate() {
    if (!mpc || !hours) return;
    var m = Number(mpc.value);
    hours.textContent = m > 0 ? '≈ ' + (Math.round(total * m / 6) / 10) + ' h' : 'for an estimate';
    try { if (m > 0) localStorage.setItem('teslon:v1:mpc', String(m)); } catch (e) { /* fine */ }
  }
  if (mpc) {
    if (!mpc.value) { try { var saved = localStorage.getItem('teslon:v1:mpc'); if (saved) mpc.value = saved; } catch (e) { /* fine */ } }
    mpc.addEventListener('input', estimate);
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (b) {
      b.addEventListener('click', function () { mpc.value = String(Math.max(1, Math.min(600, (Number(mpc.value) || 0) + Number(b.getAttribute('data-step'))))); estimate(); });
    });
  }

  // one view at a time, named in the address
  var views = Array.prototype.slice.call(document.querySelectorAll('[data-view]'));
  var first = true;
  function show() {
    var id = (location.hash || '#overview').slice(1);
    var v = views.filter(function (x) { return x.id === id; })[0] || views[0];
    views.forEach(function (x) { x.hidden = x !== v; x.classList.remove('enter'); });
    if (!first) { void v.offsetWidth; v.classList.add('enter'); window.scrollTo(0, 0); var h = v.querySelector('h1, h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
    // the sidebar marks this view, or its module when the view has no link of its own there
    var own = document.querySelector('.side a[href="#' + v.id + '"]');
    var mod = v.getAttribute('data-module');
    Array.prototype.forEach.call(document.querySelectorAll('.side a[href^="#"]'), function (a) {
      var h = a.getAttribute('href');
      a.setAttribute('aria-current', String(h === '#' + v.id || (!own && !!mod && h === '#' + mod && a.classList.contains('mod'))));
    });
    first = false;
  }
  window.addEventListener('hashchange', show);
  show();

  // copy out
  function word(k) { return marks[k] === 'pass' ? 'Pass' : marks[k] === 'fail' ? 'Fail' : ''; }
  function checklist() {
    var out = ['Teslon test plan · ' + data.title + ' · ' + data.head.slice(0, 7), ''], last = '';
    data.items.forEach(function (c) {
      var place = c.module + ' › ' + c.area + (c.where && c.where !== c.area ? ' (' + c.where + ')' : '');
      if (place !== last) { out.push((last ? '\\n' : '') + '### ' + place); last = place; }
      var w = word(c.key);
      out.push('- [' + (marks[c.key] ? 'x' : ' ') + '] ' + (c.field ? c.field + ': ' : '') + c.do + ' → Expect ' + c.expect + (w ? ' (' + w + ')' : ''));
    });
    if (data.skipped.length) { out.push('', '### Safe to skip, each with proof'); data.skipped.forEach(function (s) { out.push('- ' + s.module + ' › ' + s.area + ': ' + s.why); }); }
    return out.join('\\n');
  }
  function csv() {
    var q = function (s) { s = String(s == null ? '' : s); return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var out = ['module,area,kind,where,state,known,field,do,expect,before,result'];
    data.items.forEach(function (c) { out.push([c.module, c.area, c.kind, c.where, c.state, c.known, c.field, c.do, c.expect, c.before, word(c.key)].map(q).join(',')); });
    data.skipped.forEach(function (s) { out.push([s.module, s.area, s.kind, s.where, 'skip', '', '', '', s.why, '', ''].map(q).join(',')); });
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

/** The end of a route that tells two screens apart: new, :id/edit. */
const tail = (where: string): string => { const p = where.split('/').filter(Boolean); return (p.length > 1 && p[p.length - 2]!.startsWith(':') ? p.slice(-2) : p.slice(-1)).join('/'); };

/** The keys of what there is to run in an area: its cases, or one check for an unclear area. */
const keysOf = (a: Area): string[] => (a.cover ? [] : a.state === 'unclear' ? [checkKey(a)] : a.cases.map(key));

/** One area as a row, in a module or in a list of one state. */
function areaRow(a: Area): string {
  const n = a.state === 'test' ? (a.cover ? 'covered' : plural(a.cases.length, 'case')) : a.state === 'unclear' ? 'check once' : 'skip';
  const sub = a.state === 'test'
    ? `${stateWord(a)} · ${KIND_WORD[a.kind] ?? a.kind}${a.where && a.where !== a.name ? ` · ${a.where}` : ''}${a.cover ? ' · covered by Every screen' : ''}`
    : a.why ?? '';
  const keys = keysOf(a).join(' ');
  return `<a class="nav-row${a.state === 'skip' ? ' skipped' : ''}" href="#${aid(a)}"${keys ? ` data-place="${keys}"` : ''}><span class="st-${a.state}">${STATE_ICON[a.state]}</span><span class="t"><b>${x(a.name)}</b><span>${x(sub)}</span></span><span class="k" data-n="${x(n)}">${x(n)}</span>${ICON.chevron}</a>`;
}

/** The cockpit for one report. Complete as static HTML; the script adds one view at a time, marks, progress, the estimate and copy-out. */
export function renderHtml(r: ImpactReport, meta: PrMeta, opts: HtmlOptions = {}): string {
  const b: Brief = brief(r);
  const pr = meta.number ? `PR #${meta.number}` : 'This change';
  const title = meta.number ? `${pr} test brief` : 'Test brief';
  const repoName = meta.repoName ?? meta.repoUrl?.split('/').slice(-2).join('/') ?? r.repo.split('/').pop() ?? '';
  const byId = new Map(b.areas.map((a) => [a.id, a]));
  // the order to work in: what may break first, then the rest, what to watch last, then what to check once
  const rank = (a: Area): number => (a.tier === 'test-first' ? 0 : a.tier === 'watch' ? 2 : 1);
  const work = b.areas.filter((a) => a.state === 'test' && !a.cover).sort((p, q) => rank(p) - rank(q));
  const workAll = [...work, ...b.areas.filter((a) => a.state === 'unclear')];
  const total = work.reduce((n, a) => n + a.cases.length, 0) + b.unclear;
  const ok = r.verification.hops - r.verification.failed.length;
  const said = (meta.says ?? '').trim();
  const missing = said || meta.title ? unnamed(b, `${meta.title ?? ''} ${said}`) : [];
  const unfollowed = r.ledger.some((l) => l.status === 'not-modelled');

  // ---- the sidebar: the application map, module by module
  const S: string[] = [`<p class="brand">Test brief<b>${x(repoName || pr)}</b></p><nav aria-label="Application map">`, `<a href="#overview"><span class="nm">Overview</span></a>`, `<a href="#how"><span class="lvl lvl-${b.confidence.level}"></span><span class="nm">How sure: ${x(b.confidence.title)}</span></a>`];
  if (!b.none && b.modules.length) {
    S.push(`<p class="h"><span>Application map</span><span>${plural(b.areas.length, 'area')}</span></p>`);
    for (const m of b.modules) {
      const runKeys = m.areas.filter((a) => a.state !== 'skip').flatMap(keysOf);
      const n = m.test + m.unclear ? String(runKeys.length || m.test + m.unclear) : '✓';
      S.push(`<a class="mod" href="#${mid(m)}"${runKeys.length ? ` data-place="${runKeys.join(' ')}"` : ''}><span class="nm">${x(m.name)}</span><span class="k" data-n="${n}">${n}</span></a>`);
      const listed = m.areas.filter((y) => y.state !== 'skip');
      for (const a of listed) {
        const keys = keysOf(a);
        const kn = a.cover ? '·' : String(keys.length);
        // two screens with one title (new and edit) are told apart by their route
        const dup = listed.filter((o) => o.name === a.name).length > 1 && a.where && a.where !== a.name;
        S.push(`<a class="area" href="#${aid(a)}"${keys.length ? ` data-place="${keys.join(' ')}"` : ''} title="${x(`${stateWord(a)}: ${a.name}${a.where && a.where !== a.name ? ` · ${a.where}` : ''}`)}"><span class="st-${a.state}">${STATE_ICON[a.state]}</span><span class="nm">${x(a.name)}</span>${dup ? `<span class="w">${x(tail(a.where))}</span>` : ''}<span class="k" data-n="${kn}">${kn}</span></a>`);
      }
      if (m.skip) S.push(`<a class="skips" href="#${mid(m)}"><span class="st-skip">${ICON.check}</span><span class="nm">${m.skip} safe to skip</span></a>`);
    }
  }
  S.push(`<p class="h"><span>Evidence</span></p>`);
  if (b.unseen.length) S.push(`<a href="#unseen"><span class="st-unclear">${ICON.question}</span><span class="nm">Could not see</span><span class="k">${b.unseen.length}</span></a>`);
  S.push(`<a href="#ledger"><span class="st-skip">${ICON.shield}</span><span class="nm">Changed files</span><span class="k">${r.ledger.length}</span></a></nav>`);

  // ---- view: the overview, which is the decision
  const O: string[] = [];
  const h1 = meta.title ? (meta.number ? `${x(pr)}: ${x(meta.title)}` : x(meta.title)) : `What ${meta.number ? x(pr) : 'this change'} asks QA to test`;
  O.push(`<header class="hero"><p class="kicker">Test brief${repoName ? ` · ${x(repoName)}` : ''}</p>
<h1>${h1}</h1>
<p class="meta"><code>${x(r.base.slice(0, 7))}..${x(r.head.slice(0, 7))}</code><span class="pill">${meta.state === 'merged' ? 'Merged' : 'Open'}</span><span>${plural(r.ledger.length, 'file')} changed</span><span>against <code>${x(meta.baseRef)}</code></span>${meta.author ? `<span>by ${x(meta.author)}</span>` : ''}${meta.url && /^https?:\/\//.test(meta.url) ? `<a href="${x(meta.url)}" target="_blank" rel="noopener noreferrer">Open the pull request</a>` : ''}</p></header>`);
  const conf = `<a class="conf conf-${b.confidence.level}" href="#how">${b.confidence.level === 'high' ? ICON.shield : ICON.warn}<span class="t"><b>${b.confidence.level === 'low' ? 'Not proven' : `${x(b.confidence.title)} confidence`}</b><span>${x(b.confidence.detail)}</span></span>${ICON.chevron}</a>`;
  if (b.none) {
    O.push(`<div class="empty">${ICON.check}<h2>Nothing to test in the app</h2><p>${x(r.triage.summary)}</p></div>`);
    O.push(conf);
  } else {
    const seg = (cls: string, n: number): string => (n ? `<i class="${cls}" style="flex:${n}"></i>` : '');
    const est = meta.minutesPerCase ? `≈ ${Math.round((total * meta.minutesPerCase) / 6) / 10} h` : 'for an estimate';
    const skipSub = b.skip ? 'each with proof' : unfollowed ? 'none until every line is followed' : 'nothing could be ruled out';
    O.push(`<section class="card" aria-label="The decision">
<div class="tri">
<a class="v v-test${b.test ? '' : ' zero'}" href="#test"><span class="w">${ICON.test}Test</span><span class="n">${b.test}</span><span class="s">${b.test ? `${plural(b.cases, 'case')}${b.first ? ` · ${b.first} first` : ''}` : 'nothing to run'}</span></a>
<a class="v v-skip${b.skip ? '' : ' zero'}" href="#skip"><span class="w">${ICON.check}Skip</span><span class="n">${b.skip}</span><span class="s">${skipSub}</span></a>
<a class="v v-unclear${b.unclear ? '' : ' zero'}" href="#unclear"><span class="w">${ICON.question}Unclear</span><span class="n">${b.unclear}</span><span class="s">${b.unclear ? 'open each once' : 'none'}</span></a>
</div>
<div class="bar" role="img" aria-label="${b.test} areas to test, ${b.unclear} unclear, ${b.skip} safe to skip, of ${b.areas.length}">${seg('b-test', b.test)}${seg('b-unclear', b.unclear)}${seg('b-skip', b.skip)}</div>
${conf}
<div class="meterrow"><div class="meterline"><span id="done" aria-live="polite">0 of ${total} marked</span><span class="est"><span class="stepper"><button type="button" data-step="-1" aria-label="Fewer minutes">−</button><input id="mpc" type="number" min="1" max="600" inputmode="numeric" value="${meta.minutesPerCase ?? ''}" placeholder="—" aria-label="Minutes for each case"><button type="button" data-step="1" aria-label="More minutes">+</button></span> min a case <b id="hours">${est}</b></span></div>
<div class="meter" role="img" aria-label="Marked"><i class="p"></i><i class="f"></i></div></div>
<div class="tools"><button type="button" class="tbtn" id="copy-plan">Copy checklist</button><button type="button" class="tbtn" id="copy-csv">Copy as CSV</button><span id="copied" aria-live="polite"></span><textarea id="copybox" hidden aria-label="Copied text"></textarea></div>
</section>`);
    if (r.verification.failed.length) O.push(`<p class="note">${ICON.warn}<span><b>${plural(r.verification.failed.length, 'cited line')} did not re-check.</b> Those steps are not proven. This is a Teslon bug; please report it.</span></p>`);

    // what the PR changes, and what its author says
    if (b.changes.length || (said && said !== meta.title) || missing.length) {
      const shown = b.changes.slice(0, 6);
      O.push(`<section class="sec"><div class="sh"><h2>What this PR changes</h2>${b.changes.length ? `<span class="c">${plural(b.changes.length, 'change')} in behaviour</span>` : ''}</div>
${shown.length ? `<ul class="group rows">${shown.map((c) => `<li class="chg"><span class="kn kn-${c.known}" title="${x(KNOWN_WORD[c.known].means)}">${KNOWN_WORD[c.known].word}</span><span class="t"><b>${x(c.title)}</b><span>${c.areas ? `reaches ${plural(c.areas, 'area')}` : 'reaches no area to test'}${c.cause ? ` · ${hopLink(c.cause, r, meta)}` : ''}</span></span></li>`).join('')}${b.changes.length > shown.length ? `<li class="chg"><span class="t"><span><a href="#ledger">${b.changes.length - shown.length} more under Changed files</a></span></span></li>` : ''}</ul>` : ''}
${(said && said !== meta.title) || missing.length ? `<div class="group said">${said && said !== meta.title ? `<p class="lbl2">${meta.saysFrom === 'commits' ? 'The commits say' : 'The PR says'}</p><blockquote>${x(said.length > 320 ? `${said.slice(0, 320).trimEnd()}…` : said)}</blockquote>` : ''}${missing.length ? `<p class="gap">${ICON.warn}<span><b>Not named in the PR:</b> ${x(missing.join(', '))}. This change reaches ${missing.length === 1 ? 'it' : 'them'} too.</span></p>` : ''}</div>` : ''}
</section>`);
    }

    // the application map
    O.push(`<section class="sec"><div class="sh"><h2>Application map</h2><span class="c">${plural(b.areas.length, 'area')} in ${plural(b.modules.length, 'module')}</span></div>
<div class="tiles">${b.modules.map((m) => `<a class="tile" href="#${mid(m)}"><span class="tn">${x(m.name)}${ICON.chevron}</span><span class="cellrow" role="img" aria-label="${x(counts(m))}">${cells(m)}</span><span class="ts">${x(counts(m))}</span></a>`).join('')}</div>
<p class="legend"><span><span class="cellrow"><i class="c-test c-first"></i></span>Test first</span><span><span class="cellrow"><i class="c-test"></i></span>Test</span><span><span class="cellrow"><i class="c-unclear"></i></span>Unclear</span><span><span class="cellrow"><i class="c-skip"></i></span>Safe to skip</span></p>
</section>`);

    // start here: the first case of each of the first few areas
    const picks = work.slice(0, 5).map((a) => ({ a, c: a.cases[0] })).filter((p): p is { a: Area; c: Case } => !!p.c);
    if (picks.length) {
      O.push(`<section class="sec"><div class="sh"><h2>Start here</h2><span class="c">in this order</span></div><ol class="group rows start">${picks.map(({ a, c }, i) => {
        const field = [c.section, c.field].filter(Boolean).join(' › ');
        const { risk } = split(c.expect);
        return `<li><a class="nav-row" href="#${aid(a)}"><span class="num">${i + 1}</span><span class="t"><b>${x(a.name)}${field ? ` · ${x(field)}` : ''}</b><span>${x(a.module)} · ${x(c.do)}</span>${risk ? `<span class="risk-line">${ICON.warn}<span>${x(risk)}</span></span>` : ''}</span>${ICON.chevron}</a></li>`;
      }).join('')}</ol></section>`);
    }
  }
  const at = opts.at ?? meta.at;
  O.push(`<footer><p>${x(pr)} · <code>${x(r.base.slice(0, 7))}..${x(r.head.slice(0, 7))}</code> against ${x(meta.baseRef)} · ${x(meta.how)}</p><p>Every claim cites the code: ${ok} of ${r.verification.hops} cited lines re-checked at <code>${x(r.head.slice(0, 7))}</code>. Cases follow from the code; they were not run. Marks are kept in this browser, for this commit only.</p><p>Teslon ${x(meta.version)} · ${x(r.schema)}${at ? ` · ${x(at)}` : ''}${meta.runUrl && /^https?:\/\//.test(meta.runUrl) ? ` · <a href="${x(meta.runUrl)}" target="_blank" rel="noopener noreferrer">The run</a>` : ''}</p></footer>`);

  const V: string[] = [`<section class="view" id="overview" data-view>${O.join('\n')}</section>`];
  const backTo = (href: string, label: string, cls = ''): string => `<a class="back${cls ? ` ${cls}` : ''}" href="${href}">${ICON.chevron}${x(label)}</a>`;

  // ---- views: one per module
  for (const m of b.modules) {
    V.push(`<section class="view" id="${mid(m)}" data-view>${backTo('#overview', 'Overview', 'to-overview')}
<header class="ph"><p class="kind">Module · ${x(counts(m))}</p><h1>${x(m.name)}</h1></header>
<div class="group rows">${m.areas.map((a) => areaRow(a)).join('')}</div></section>`);
  }

  // ---- views: one per area
  for (const a of b.areas) {
    const i = workAll.indexOf(a);
    const prev = i > 0 ? workAll[i - 1] : undefined, next = i >= 0 ? workAll[i + 1] : undefined;
    const head = `${backTo(`#${mid(a.module)}`, a.module)}
<header class="ph"><p class="kind"><span class="st-${a.state}">${STATE_ICON[a.state]}</span><span class="st-${a.state}">${x(stateWord(a))}</span> · ${x(KIND_WORD[a.kind] ?? a.kind)} · ${x(a.module)}</p><h1>${x(a.name)}</h1>${a.where && a.where !== a.name ? `<code class="where">${x(a.where)}</code>` : ''}</header>`;
    let body = '';
    if (a.state === 'test' && a.cover) {
      const c = byId.get(a.cover);
      body = `<div class="card"><p>A change reaches every screen, this one included. Its cases are under ${c ? `<a href="#${aid(c)}">${x(c.name)}</a>` : 'Every screen'}.</p>${hops(a.evidence, r, meta)}</div>`;
    } else if (a.state === 'test') {
      body = `<ol class="group rows">${a.cases.map((c) => caseRow(c, r, meta)).join('\n')}</ol>`;
      if (a.notes.length) body += `<section class="sec"><div class="sh"><h2>Checked, unchanged</h2><span class="c">no need to test</span></div><ul class="group rows">${a.notes.map((c) => `<li class="line"><span class="st-skip">${ICON.check}</span><span class="t"><b>${x([c.section, c.field].filter(Boolean).join(' › ') || c.do)}</b><span>${x(c.expect)}</span></span></li>`).join('')}</ul></section>`;
    } else if (a.state === 'skip') {
      body = `<div class="verdict-box vb-skip"><p class="vh">${ICON.check}Safe to skip</p><p>${x(a.why ?? '')}</p>${a.evidence.length ? hops(a.evidence, r, meta) : ''}<p class="rulep">${x(SKIP_RULE)}</p></div>`;
      if (a.notes.length) body += `<ul class="group rows">${a.notes.map((c) => `<li class="line"><span class="st-skip">${ICON.check}</span><span class="t"><b>${x([c.section, c.field].filter(Boolean).join(' › ') || c.do)}</b><span>${x(c.expect)}</span></span></li>`).join('')}</ul>`;
    } else {
      body = `<div class="verdict-box vb-unclear"><p class="vh">${ICON.question}Teslon cannot rule this out</p><p>${x(a.why ?? '')}</p>${a.evidence.length ? hops(a.evidence, r, meta) : ''}</div>
<ol class="group rows"><li class="case" data-key="${checkKey(a)}"><div class="case-body"><p class="field">Check it once</p><p class="do"><span class="lbl">Do</span>Open ${x(a.name)} and use what it does most.</p><p class="expect"><span class="lbl">Expect</span>It works and shows what it showed before this change.</p></div>${marks(a.name)}</li></ol>`;
    }
    const pager = i >= 0 ? `<nav class="pager" aria-label="Areas">${prev ? `<a href="#${aid(prev)}"><span>‹ Previous</span>${x(prev.name)}</a>` : ''}${next ? `<a class="next" href="#${aid(next)}"><span>Next ›</span>${x(next.name)}</a>` : '<a class="next" href="#overview"><span>Done ›</span>Overview</a>'}</nav>` : '';
    V.push(`<section class="view" id="${aid(a)}" data-view data-module="${mid(a.module)}">${head}\n${body}\n${pager}</section>`);
  }

  // ---- views: the verdict, one answer at a time, across modules
  const stateView = (id: 'test' | 'skip' | 'unclear', h: string, sub: string): void => {
    const list = id === 'test' ? work : b.areas.filter((a) => a.state === id);
    const mods = b.modules.map((m) => ({ m, as: list.filter((a) => a.module === m.name) })).filter((g) => g.as.length);
    V.push(`<section class="view" id="${id}" data-view>${backTo('#overview', 'Overview', 'to-overview')}<header class="ph"><p class="kind"><span class="st-${id}">${STATE_ICON[id]}</span>${plural(list.length, 'area')}</p><h1>${x(h)}</h1></header><p class="sub">${x(sub)}</p>
${mods.length ? mods.map(({ m, as }) => `<section class="sec"><div class="sh"><h2>${x(m.name)}</h2><span class="c">${as.length}</span></div><div class="group rows">${as.map((a) => areaRow(a)).join('')}</div></section>`).join('') : `<div class="empty"><p>None.</p></div>`}</section>`);
  };
  if (!b.none) {
    stateView('test', 'To test', 'Module by module. Inside each, what may break comes first, then what runs changed code, then what to watch after release.');
    stateView('skip', 'Safe to skip', `${SKIP_RULE}${b.skip ? '' : unfollowed ? ' Some changed lines were not followed, so nothing is skipped until they are read.' : ''}`);
    stateView('unclear', 'Unclear', 'The change may reach these, but nothing on them was traced to a visible change, or some changed lines were not followed. They are never called safe. Open each one once.');
  }

  // ---- view: how sure
  V.push(`<section class="view" id="how" data-view>${backTo('#overview', 'Overview', 'to-overview')}<header class="ph"><p class="kind"><span class="lvl lvl-${b.confidence.level}"></span>How sure</p><h1>${b.confidence.level === 'low' ? 'Not proven' : `${x(b.confidence.title)} confidence`}</h1></header>
<p class="sub">${x(b.confidence.detail)}</p>
<section class="sec"><div class="sh"><h2>How each answer is known</h2></div><ul class="group rows">
<li class="line"><span class="kn kn-proven">Proven</span><span class="t"><b>A typed rule says what changes</b><span>A validation rule, a JSON field the page reads, a removed endpoint, or a column the database now refuses. The case names the rule and its line.</span></span></li>
<li class="line"><span class="kn kn-followed">Followed</span><span class="t"><b>The changed code runs here</b><span>The change was followed through the code to this area. What it does differently is not typed, so the case asks to check it works as before.</span></span></li>
<li class="line"><span class="st-skip">${ICON.check}</span><span class="t"><b>Safe to skip</b><span>${x(SKIP_RULE)}</span></span></li>
<li class="line"><span class="st-unclear">${ICON.question}</span><span class="t"><b>Unclear</b><span>The change may reach the area, but Teslon could not trace it to anything visible, or could not follow some changed lines. It is never called safe.</span></span></li>
</ul></section>
<section class="sec"><div class="sh"><h2>Checked for this PR</h2></div><ul class="group rows">
<li class="line"><span class="st-${r.verification.failed.length ? 'unclear' : 'skip'}">${r.verification.failed.length ? ICON.warn : ICON.check}</span><span class="t"><b>${ok} of ${r.verification.hops} cited lines re-checked</b><span>Each step names a file, a line and the text that must be on it. All were read again at ${x(r.head.slice(0, 7))} (or at ${x(r.base.slice(0, 7))} for code the PR removed) before this page was made.</span></span></li>
<li class="line"><span class="st-${unfollowed ? 'unclear' : 'skip'}">${unfollowed ? ICON.warn : ICON.check}</span><span class="t"><b>${r.ledger.filter((l) => l.status !== 'not-modelled').length} of ${plural(r.ledger.length, 'changed file')} accounted for</b><span>${unfollowed ? 'The rest have lines Teslon did not follow; each is named under Could not see. ' : ''}<a href="#ledger">Changed files</a> lists each with what was done with it.</span></span></li>
<li class="line"><span class="st-skip">${ICON.shield}</span><span class="t"><b>This build passed the Teslon proving ground</b><span>${x(PROVING)}</span></span></li>
</ul></section>
<section class="sec"><div class="sh"><h2>Not followed by this build</h2><span class="c">said, not guessed</span></div><ul class="group rows">${r.notModelled.map((n) => `<li class="line"><span class="st-unclear">${ICON.question}</span><span class="t"><span>${x(n)}</span></span></li>`).join('')}</ul></section></section>`);

  // ---- views: could not see, changed files
  if (b.unseen.length) V.push(`<section class="view" id="unseen" data-view>${backTo('#overview', 'Overview', 'to-overview')}<header class="ph"><p class="kind"><span class="st-unclear">${ICON.question}</span>Said out loud</p><h1>Could not see</h1></header><p class="sub">What this change may reach that Teslon cannot read. Each says how to close it.</p><ul class="group rows">${b.unseen.map((u) => `<li class="line"><span class="st-unclear">${ICON.question}</span><span class="t"><b>${x(u.what)}</b><span>${x(u.why)}</span><span>To close it: ${x(u.resolve)}</span></span></li>`).join('')}</ul></section>`);
  V.push(`<section class="view" id="ledger" data-view>${backTo('#overview', 'Overview', 'to-overview')}<header class="ph"><p class="kind"><span class="st-skip">${ICON.shield}</span>Every one accounted for</p><h1>Changed files</h1></header>
${b.changes.length ? `<details class="group"${b.none ? '' : ' open'}><summary class="gsum">${ICON.chevron}What changed in behaviour<span class="c">${b.changes.length}</span></summary><ul class="rows">${b.changes.map((c) => `<li class="chg"><span class="kn kn-${c.known}">${KNOWN_WORD[c.known].word}</span><span class="t"><b>${x(c.title)}</b>${c.cause ? `<span>${hopLink(c.cause, r, meta)}</span>` : ''}</span></li>`).join('')}</ul></details>` : ''}
<div class="group tablewrap"><table><thead><tr><th>File</th><th>Status</th><th>Why</th></tr></thead><tbody>${r.ledger.map((l) => { const w = LEDGER_WORD[l.status] ?? l.status; return `<tr><td><code>${x(l.file)}</code></td><td class="lst lst-${w.toLowerCase().replace(/ /g, '-')}">${x(w)}</td><td>${x(l.reason ?? '')}${l.lines.length ? ` <span class="rule">lines ${x(l.lines.slice(0, 12).join(', '))}${l.lines.length > 12 ? '…' : ''}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div></section>`);

  const item = (a: Area, c: Case | null): Record<string, string> => ({
    key: c ? key(c) : checkKey(a), module: a.module, area: a.name, kind: KIND_WORD[a.kind] ?? a.kind, where: a.where,
    state: c ? (a.tier === 'test-first' ? 'test first' : a.tier === 'watch' ? 'watch' : 'test') : 'unclear',
    known: c ? KNOWN_WORD[known(r, c)].word : '', field: c ? [c.section, c.field].filter(Boolean).join(' › ') : '',
    do: c ? c.do : `Open ${a.name} and use what it does most.`, expect: c ? c.expect : 'It works and shows what it showed before this change.', before: c?.before ?? '',
  });
  const data = {
    repo: repoName || r.repo, head: r.head, title: meta.title ? `${pr}: ${meta.title}` : pr,
    items: [...work.flatMap((a) => a.cases.map((c) => item(a, c))), ...b.areas.filter((a) => a.state === 'unclear').map((a) => item(a, null))],
    skipped: b.areas.filter((a) => a.state === 'skip').map((a) => ({ module: a.module, area: a.name, kind: KIND_WORD[a.kind] ?? a.kind, where: a.where, why: a.why ?? '' })),
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
