import type { ImpactReport, Surface, Case, Hop, Tier } from './model.js';

/**
 * Markdown for where QA already looks: a short PR comment, and the full brief
 * for the run's summary page. Both are built from the same report as the
 * terminal text; nothing here decides anything.
 *
 * The comment is capped: a 400-file PR gets the same short comment as a
 * 3-file PR, with the detail one click away. Every evidence line links to the
 * exact line at the commit it was read from.
 */

export interface PrMeta {
  readonly number?: number;
  readonly title?: string;
  readonly url?: string;
  readonly author?: string;
  readonly baseRef: string;
  readonly state: 'open' | 'merged';
  readonly how: string;
  /** https://github.com/owner/repo, to link evidence to lines. */
  readonly repoUrl?: string;
  /** The run's summary page, where the full brief is. */
  readonly runUrl?: string;
  /** Minutes one case takes this team, if they said; otherwise effort is shown in cases only. */
  readonly minutesPerCase?: number;
  readonly version: string;
}

export const COMMENT_MARKER = '<!-- teslon:impact -->';

/** The order a tester works in: pages, then what sits behind them. */
export const KIND_ORDER: Readonly<Record<string, number>> = { screen: 0, widget: 1, 'test-plan': 2, data: 3, api: 4, job: 5, dashboard: 6, module: 7, deploy: 8 };

const TIER_TITLE: Record<Exclude<Tier, 'skip'>, string> = { 'test-first': 'Test first', 'test-next': 'Test next', watch: 'Watch after release' };
const fileName = (p: string): string => p.split('/').pop() ?? p;
/**
 * Text from the repository, made inert in a comment: no markup, no table
 * breaks, and no @mentions. Code says `@NotBlank`; GitHub would ping a user
 * called NotBlank, so an at-word is shown as code instead.
 */
export const esc = (s: string): string =>
  s.replace(/[\\`*_[\]]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    .replace(/(^|[^\w`])@([A-Za-z][\w.-]*)/g, '$1`@$2`');
/** A code span that holds any text, backticks included. Mentions do not fire inside one. */
export const code = (s: string): string => {
  const t = s.replace(/\r?\n/g, ' ');
  if (!t.includes('`')) return `\`${t}\``;
  const run = Math.max(...(t.match(/`+/g) ?? ['']).map((m) => m.length)) + 1;
  const fence = '`'.repeat(run);
  return `${fence} ${t} ${fence}`;
};
/**
 * Cut at a line, close any <details> left open, and say so. `max` is in
 * bytes, which is how GitHub counts the summary page.
 */
function fit(out: string, max: number, note: string): string {
  if (Buffer.byteLength(out, 'utf8') <= max) return out;
  let cut = out;
  while (Buffer.byteLength(cut, 'utf8') > max - 2000) cut = cut.slice(0, Math.floor(cut.length * 0.9));
  cut = cut.slice(0, Math.max(0, cut.lastIndexOf('\n')));
  const open = (cut.match(/<details>/g) ?? []).length - (cut.match(/<\/details>/g) ?? []).length;
  return `${cut}\n${'\n</details>'.repeat(Math.max(0, open))}\n\n${note}`;
}

function link(h: Hop, r: ImpactReport, meta: PrMeta): string {
  const label = code(`${fileName(h.file)}:${h.line}`);
  if (!meta.repoUrl) return label;
  const sha = h.side === 'base' ? r.base : r.head;
  return `[${label}](${meta.repoUrl}/blob/${sha}/${h.file.split('/').map(encodeURIComponent).join('/')}#L${h.line})`;
}

function place(s: Surface): string {
  if (s.kind === 'screen') return s.name === s.where ? code(s.where) : `**${esc(s.name)}** ${code(s.where)}`;
  if (s.kind === 'widget') return `**${esc(s.name)}** (on every screen)`;
  if (s.kind === 'api') return `API ${code(s.name)}`;
  if (s.kind === 'data') return `Data: **${esc(s.name)}**`;
  if (s.kind === 'module') return `Service **${esc(s.name)}**`;
  if (s.kind === 'job') return `Job ${code(s.name)}`;
  if (s.kind === 'dashboard') return `Dashboard **${esc(s.name)}**`;
  if (s.kind === 'deploy') return `**${esc(s.name)}**`;
  return `**${esc(s.name)}**`;
}

function step(c: Case): string {
  const field = [c.section, c.field].filter(Boolean).join(' › ');
  return `${field ? `**${esc(field)}**: ` : ''}${esc(c.do)} → **Expect** ${esc(c.expect)}${c.before && c.before !== '—' ? ` _Before: ${esc(c.before)}_` : ''}${c.hole ? ' (still lets this through)' : ''}`;
}

/** Surfaces a broad change reaches, so they render as one regression list. */
export function broadDeltas(r: ImpactReport): Map<string, Set<string>> {
  const byDelta = new Map<string, Set<string>>();
  for (const c of r.cases) if (c.tier === 'test-next') { if (!byDelta.has(c.delta)) byDelta.set(c.delta, new Set()); byDelta.get(c.delta)!.add(c.surface); }
  return new Map([...byDelta].filter(([id, ss]) => ss.size > 4 && !r.deltas.find((d) => d.id === id)?.kind.startsWith('request-rules')));
}

export interface Counts { places: number; cases: number }

export function counts(r: ImpactReport): Record<Tier | 'unseen', Counts> {
  const out = { 'test-first': { places: 0, cases: 0 }, 'test-next': { places: 0, cases: 0 }, watch: { places: 0, cases: 0 }, skip: { places: 0, cases: 0 }, unseen: { places: r.unseen.length, cases: 0 } };
  for (const s of r.surfaces) out[s.tier].places++;
  for (const c of r.cases) if (c.tier !== 'skip') out[c.tier].cases++;
  return out;
}

/** The cases to run first: one per place, riskiest first. */
export function startHere(r: ImpactReport, n: number): { s: Surface; c: Case }[] {
  const order = KIND_ORDER;
  const rank: Record<Tier, number> = { 'test-first': 0, 'test-next': 1, watch: 2, skip: 3 };
  const picks: { s: Surface; c: Case }[] = [];
  const surfaces = [...r.surfaces].filter((s) => s.tier !== 'skip').sort((a, b) => rank[a.tier] - rank[b.tier] || (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  for (const s of surfaces) {
    const c = r.cases.find((x) => x.surface === s.id && x.tier !== 'skip');
    if (c) picks.push({ s, c });
    if (picks.length >= n) break;
  }
  return picks;
}

function header(r: ImpactReport, meta: PrMeta): string[] {
  const k = counts(r);
  const L: string[] = [];
  const pr = meta.number ? `PR #${meta.number}` : 'This change';
  L.push(`### Teslon · what ${pr} changes for QA`);
  const files = r.ledger.length;
  L.push(`${meta.title ? `**${esc(meta.title)}** · ` : ''}\`${r.base.slice(0, 7)}..${r.head.slice(0, 7)}\` · ${files} file${files === 1 ? '' : 's'} · ${meta.state === 'merged' ? 'merged' : 'open'} · ${esc(meta.how)}`);
  L.push('');
  if (r.triage.appEffect === 'none') {
    L.push(`**Nothing to test in the app.** ${esc(r.triage.summary)}`);
    return L;
  }
  const cases = k['test-first'].cases + k['test-next'].cases + k.watch.cases;
  const effort = meta.minutesPerCase ? ` (about ${Math.max(1, Math.round((cases * meta.minutesPerCase) / 6) / 10)} h at ${meta.minutesPerCase} min a case)` : '';
  L.push('| Test first | Test next | Watch after release | Safe to skip | Teslon could not see |');
  L.push('|---|---|---|---|---|');
  const n = (x: number, w: string): string => `${x} ${w}${x === 1 ? '' : 's'}`;
  L.push(`| **${n(k['test-first'].places, 'place')}** · ${n(k['test-first'].cases, 'case')} | ${n(k['test-next'].places, 'place')} · ${n(k['test-next'].cases, 'case')} | ${n(k.watch.places, 'place')} | ${n(k.skip.places, 'place')}, each with proof | ${n(k.unseen.places, 'thing')} |`);
  L.push('');
  L.push(`${cases} case${cases === 1 ? '' : 's'} in all${effort}.${r.triage.appEffect === 'unknown' ? ` Some changed lines were not followed, so nothing outside the places below is ruled out (see "Could not see").` : ''}`);
  return L;
}

/** The PR comment: verdict, where to start, what is safe to skip, what was not seen, and the link. */
export function renderComment(r: ImpactReport, meta: PrMeta): string {
  const L: string[] = [COMMENT_MARKER, ...header(r, meta)];
  if (r.triage.appEffect !== 'none') {
    const picks = startHere(r, 5);
    if (picks.length) {
      L.push('');
      L.push('**Start here**');
      picks.forEach(({ s, c }, i) => L.push(`${i + 1}. ${place(s)}: ${step(c)}`));
    }
    const broad = broadDeltas(r);
    if (broad.size) {
      L.push('');
      for (const [id, ss] of [...broad].slice(0, 3)) {
        const d = r.deltas.find((x) => x.id === id);
        const screens = [...ss].map((x) => r.surfaces.find((s) => s.id === x)!).filter((s) => s?.kind === 'screen').length;
        L.push(`**Regression:** ${esc(d?.title ?? id)}, reaching ${ss.size} places${screens ? ` (${screens} screens)` : ''}.`);
      }
    }
    const skips = r.surfaces.filter((s) => s.tier === 'skip');
    if (skips.length) {
      L.push('');
      L.push(`**Safe to skip** (${skips.length}): ${skips.slice(0, 10).map((s) => (s.kind === 'screen' ? `${esc(s.name)} ${code(s.where)}` : esc(s.name))).join(' · ')}${skips.length > 10 ? ' · …' : ''}`);
    }
    if (r.unseen.length) {
      L.push('');
      L.push(`**Teslon could not see** (${r.unseen.length}): ${r.unseen.slice(0, 3).map((u) => esc(u.what.length > 90 ? `${u.what.slice(0, 87)}…` : u.what)).join(' · ')}${r.unseen.length > 3 ? ' · …' : ''}`);
    }
  }
  L.push('');
  const ok = r.verification.hops - r.verification.failed.length;
  L.push(`${meta.runUrl ? `[Full report](${meta.runUrl}) · ` : ''}every claim cites the code: ${ok}/${r.verification.hops} cited lines re-checked at \`${r.head.slice(0, 7)}\`${r.verification.failed.length ? ' · **some evidence failed**' : ''} · Teslon ${meta.version}`);
  // GitHub refuses comments over 65,536 characters; bytes are a safe bound
  return fit(L.join('\n'), 60_000, `…cut to fit a comment.${meta.runUrl ? ` [Full report](${meta.runUrl})` : ''}`);
}

/** The full brief for the run's summary page. */
export function renderSummary(r: ImpactReport, meta: PrMeta): string {
  const L: string[] = [...header(r, meta)];
  if (r.triage.appEffect === 'none') return L.join('\n');
  const why = (hs: readonly Hop[]): string => hs.map((h) => `${link(h, r, meta)} ${esc(h.label.toLowerCase())}: ${esc(h.rule)}${h.verified === false ? ' **(did not re-check)**' : ''}`).join('<br>');

  const picks = startHere(r, 5);
  if (picks.length) {
    L.push('', '## Start here', '');
    picks.forEach(({ s, c }, i) => L.push(`${i + 1}. ${place(s)}: ${step(c)}`));
  }

  const broad = broadDeltas(r);
  const grouped = (c: Case): boolean => c.tier === 'test-next' && broad.has(c.delta);
  if (broad.size) {
    L.push('', '## Regression lists', '', 'Changed code that many places run. Check each still works as before.', '');
    for (const [id, ss] of broad) {
      const d = r.deltas.find((x) => x.id === id);
      const list = [...ss].map((x) => r.surfaces.find((s) => s.id === x)!).filter(Boolean);
      L.push(`<details><summary><b>${esc(d?.title ?? id)}</b>: ${list.length} places</summary>`, '');
      for (const kind of ['screen', 'widget', 'api', 'job', 'module'] as const) {
        const of = list.filter((s) => s.kind === kind);
        if (of.length) L.push(`- ${kind === 'screen' ? 'Screens' : kind === 'widget' ? 'On every screen' : kind === 'api' ? 'APIs' : kind === 'job' ? 'Jobs' : 'Services'}: ${of.map((s) => (kind === 'screen' ? `${esc(s.name)} ${code(s.where)}` : code(s.name))).join(', ')}`);
      }
      if (d?.causes[0]) L.push(`- Because: ${link(d.causes[0], r, meta)} ${esc(d.causes[0].rule)}`);
      L.push('', '</details>', '');
    }
  }

  for (const tier of ['test-first', 'test-next', 'watch'] as const) {
    // screens first: a tester starts from a page, then the APIs behind it
    const list = r.surfaces.filter((s) => s.tier === tier && r.cases.some((c) => c.surface === s.id && !grouped(c))).sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
    if (!list.length) continue;
    L.push('', `## ${TIER_TITLE[tier]}`, '');
    for (const s of list) {
      const cs = r.cases.filter((c) => c.surface === s.id && !grouped(c));
      L.push(`#### ${place(s)}`, '');
      for (const c of cs.filter((x) => x.tier !== 'skip')) {
        L.push(`- [ ] ${step(c)}`);
        L.push(`  <details><summary>Why (${c.hops.length} steps)</summary>${why(c.hops)}</details>`);
      }
      for (const c of cs.filter((x) => x.tier === 'skip')) L.push(`- ~~${esc([c.section, c.field].filter(Boolean).join(' › '))}~~ not affected: ${esc(c.expect)}`);
      L.push('');
    }
  }

  const skips = r.surfaces.filter((s) => s.tier === 'skip');
  if (skips.length) {
    L.push('', '## Safe to skip, with proof', '', '| Place | Why it is not affected | Proof |', '|---|---|---|');
    for (const s of skips) L.push(`| ${place(s)} | ${esc(s.reason ?? '')} | ${(s.evidence ?? []).slice(0, 3).map((h) => link(h, r, meta)).join(' ')} |`);
  }
  if (r.unseen.length) {
    L.push('', '## Teslon could not see', '');
    for (const u of r.unseen) L.push(`- **${esc(u.what)}**: ${esc(u.why)}. _To close it: ${esc(u.resolve)}._`);
  }
  if (r.deltas.length) {
    L.push('', '<details><summary><b>What changed in behaviour</b></summary>', '');
    for (const d of r.deltas) L.push(`- ${esc(d.title)}${d.causes[0] ? ` (${link(d.causes[0], r, meta)})` : ''}`);
    L.push('', '</details>');
  }
  L.push('', '<details><summary><b>Every changed file, accounted for</b></summary>', '', '| File | Status | |', '|---|---|---|');
  for (const l of r.ledger) {
    const status = { explained: 'explained', followed: 'followed', 'test-only': 'test only', 'not-modelled': '**not followed**', 'no-runtime-effect': 'no app effect', deleted: 'deleted' }[l.status];
    L.push(`| ${code(l.file).replace(/\|/g, '\\|')} | ${status} | ${esc(l.reason ?? '')}${l.lines.length ? ` lines ${l.lines.slice(0, 10).join(', ')}` : ''} |`);
  }
  L.push('', '</details>', '');
  const ok = r.verification.hops - r.verification.failed.length;
  L.push(`Every claim cites the code: ${ok}/${r.verification.hops} cited lines re-checked at \`${r.head.slice(0, 7)}\`. Not typed yet: ${esc(r.notModelled.join('; '))}. Teslon ${meta.version}.`);
  // the step summary takes up to 1 MiB
  return fit(L.join('\n'), 1_000_000, '…cut to fit the summary page; the run artifact has everything.');
}
