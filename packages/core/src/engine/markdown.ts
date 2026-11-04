import type { ImpactReport, Case, Hop } from './model.js';
import { brief, known, unnamed, SKIP_RULE, KNOWN_WORD, type Area, type Brief, type State } from './areas.js';

/**
 * Markdown for where QA already looks: a short PR comment, and the full brief
 * for the run's summary page. Both lead with the same decision as the
 * cockpit (test, skip, unclear, how sure, and the application map), built
 * from the same brief; nothing here decides anything.
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
  /** How people call the repository, when there is no repository URL to take it from. */
  readonly repoName?: string;
  /** What the developer said the PR does: its description, or its commit messages when there is none. */
  readonly says?: string;
  readonly saysFrom?: 'pr' | 'commits';
  /** When the brief was made (ISO time), for the audit line. */
  readonly at?: string;
}

export const COMMENT_MARKER = '<!-- teslon:impact -->';

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

function step(c: Case): string {
  const field = [c.section, c.field].filter(Boolean).join(' › ');
  return `${field ? `**${esc(field)}**: ` : ''}${esc(c.do)} → **Expect** ${esc(c.expect)}${c.before && c.before !== '—' ? ` _Before: ${esc(c.before)}_` : ''}${c.hole ? ' (still lets this through)' : ''}`;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
const STATE_MARK: Record<State, string> = { test: '🔵', skip: '✅', unclear: '⚠️' };

/** An area, named the way a tester finds it. */
function areaName(a: Area): string {
  if (a.kind === 'screen') return a.name === a.where || a.id === 'screen:*' ? `**${esc(a.name)}**` : `**${esc(a.name)}** ${code(a.where)}`;
  if (a.kind === 'api' || a.kind === 'job') return code(a.name);
  if (a.kind === 'widget') return `**${esc(a.name)}** (on every screen)`;
  return `**${esc(a.name)}**`;
}

/** The decision, the same in the comment and the summary: test, skip and unclear, and how sure. */
function header(r: ImpactReport, b: Brief, meta: PrMeta, full: boolean): string[] {
  const L: string[] = [];
  const pr = meta.number ? `PR #${meta.number}` : 'This change';
  L.push(`### Teslon · ${pr} test brief`);
  const files = r.ledger.length;
  L.push(`${meta.title ? `**${esc(meta.title)}** · ` : ''}\`${r.base.slice(0, 7)}..${r.head.slice(0, 7)}\` · ${plural(files, 'file')} · ${meta.state === 'merged' ? 'merged' : 'open'} · ${esc(meta.how)}`);
  L.push('');
  if (b.none) {
    L.push(`✅ **Nothing to test in the app.** ${esc(r.triage.summary)}`);
    return L;
  }
  const checks = b.cases + b.unclear;
  const effort = meta.minutesPerCase ? ` · about ${Math.max(0.1, Math.round((checks * meta.minutesPerCase) / 6) / 10)} h at ${meta.minutesPerCase} min each` : '';
  const unfollowed = r.ledger.some((l) => l.status === 'not-modelled');
  L.push('| | Areas | |', '|---|---|---|');
  L.push(`| ${STATE_MARK.test} **Test** | **${b.test}** | ${b.test ? `${plural(b.cases, 'case')}${b.first ? `, ${b.first} first` : ''}${effort}` : 'nothing to run'} |`);
  L.push(`| ${STATE_MARK.skip} **Safe to skip** | **${b.skip}** | ${b.skip ? 'each with proof' : unfollowed ? 'none until every changed line is followed' : 'nothing could be ruled out'} |`);
  L.push(`| ${STATE_MARK.unclear} **Unclear** | **${b.unclear}** | ${b.unclear ? 'not ruled out: open each once' : 'none'} |`);
  L.push('');
  L.push(`**${b.confidence.level === 'low' ? 'Not proven' : `${b.confidence.title} confidence`}.** ${esc(b.confidence.detail)}`);
  const said = `${meta.title ?? ''} ${meta.says ?? ''}`.trim();
  const missing = said ? unnamed(b, said) : [];
  if (missing.length) L.push('', `> ⚠️ **Not named in the PR:** ${esc(missing.join(', '))}. This change reaches ${missing.length === 1 ? 'it' : 'them'} too.`);

  // the application map: one line per module
  const max = full ? b.modules.length : 12;
  L.push('', '**Application map**', '', '| Module | Test | Unclear | Safe to skip |', '|---|---|---|---|');
  for (const m of b.modules.slice(0, max)) {
    const cases = m.areas.reduce((n, a) => n + a.cases.length, 0);
    L.push(`| ${esc(m.name)} | ${m.test ? `**${m.test}**${cases ? ` · ${plural(cases, 'case')}` : ''}` : '—'} | ${m.unclear || '—'} | ${m.skip || '—'} |`);
  }
  if (b.modules.length > max) L.push(`| …${b.modules.length - max} more | | | |`);
  return L;
}

function startRows(b: Brief, n: number): string[] {
  const rank = (a: Area): number => (a.tier === 'test-first' ? 0 : a.tier === 'watch' ? 2 : 1);
  return b.areas.filter((a) => a.state === 'test' && a.cases.length).sort((p, q) => rank(p) - rank(q)).slice(0, n)
    .map((a, i) => `${i + 1}. ${esc(a.module)} › ${areaName(a)}: ${step(a.cases[0]!)}`);
}

/** The PR comment: the decision, the map, where to start, and the link to the rest. */
export function renderComment(r: ImpactReport, meta: PrMeta): string {
  const b = brief(r);
  const L: string[] = [COMMENT_MARKER, ...header(r, b, meta, false)];
  if (!b.none) {
    const picks = startRows(b, 5);
    if (picks.length) L.push('', '**Start here**', ...picks);
    if (b.unseen.length) {
      L.push('');
      L.push(`**Teslon could not see** (${b.unseen.length}): ${b.unseen.slice(0, 3).map((u) => esc(u.what.length > 90 ? `${u.what.slice(0, 87)}…` : u.what)).join(' · ')}${b.unseen.length > 3 ? ' · …' : ''}`);
    }
  }
  L.push('');
  const ok = r.verification.hops - r.verification.failed.length;
  L.push(`${meta.runUrl ? `[Open the full brief](${meta.runUrl}) (the cockpit is in the run's artifacts) · ` : ''}every claim cites the code: ${ok}/${r.verification.hops} cited lines re-checked at \`${r.head.slice(0, 7)}\`${r.verification.failed.length ? ' · **some evidence failed**' : ''} · Teslon ${meta.version}`);
  // GitHub refuses comments over 65,536 characters; bytes are a safe bound
  return fit(L.join('\n'), 60_000, `…cut to fit a comment.${meta.runUrl ? ` [Full brief](${meta.runUrl})` : ''}`);
}

/** The full brief for the run's summary page: the decision, then every module, area by area. */
export function renderSummary(r: ImpactReport, meta: PrMeta): string {
  const b = brief(r);
  const L: string[] = [...header(r, b, meta, true)];
  if (b.none) return L.join('\n');
  const why = (hs: readonly Hop[]): string => hs.map((h) => `${link(h, r, meta)} ${esc(h.label.toLowerCase())}: ${esc(h.rule)}${h.verified === false ? ' **(did not re-check)**' : ''}`).join('<br>');

  const picks = startRows(b, 5);
  if (picks.length) L.push('', '## Start here', '', ...picks);

  for (const m of b.modules) {
    L.push('', `## ${esc(m.name)}`, '');
    for (const a of m.areas.filter((y) => y.state === 'test')) {
      const tier = a.tier === 'test-first' ? 'test first' : a.tier === 'watch' ? 'watch after release' : 'test';
      if (a.cover) { L.push(`- ${STATE_MARK.test} ${areaName(a)}: ${tier}, covered by the Every screen cases`); continue; }
      L.push(`#### ${STATE_MARK.test} ${areaName(a)} · ${tier}`, '');
      for (const c of a.cases) {
        L.push(`- [ ] ${step(c)} _(${KNOWN_WORD[known(r, c)].word})_`);
        L.push(`  <details><summary>How Teslon knows (${c.hops.length} steps)</summary>${why(c.hops)}</details>`);
      }
      for (const c of a.notes) L.push(`- ~~${esc([c.section, c.field].filter(Boolean).join(' › ') || c.do)}~~ unchanged: ${esc(c.expect)}`);
      L.push('');
    }
    const unclear = m.areas.filter((y) => y.state === 'unclear');
    if (unclear.length) {
      L.push('| Unclear | Why it is not ruled out | Check |', '|---|---|---|');
      for (const a of unclear) L.push(`| ${STATE_MARK.unclear} ${areaName(a)} | ${esc(a.why ?? '')} | open it once and check it works as before |`);
      L.push('');
    }
    const skips = m.areas.filter((y) => y.state === 'skip');
    if (skips.length) {
      L.push('| Safe to skip | Why | Proof |', '|---|---|---|');
      for (const a of skips) L.push(`| ${STATE_MARK.skip} ${areaName(a)} | ${esc(a.why ?? '')} | ${a.evidence.slice(0, 3).map((h) => link(h, r, meta)).join(' ')} |`);
      L.push('');
    }
  }
  L.push('', `_The skip rule: ${esc(SKIP_RULE)}_`);
  if (b.unseen.length) {
    L.push('', '## Teslon could not see', '');
    for (const u of b.unseen) L.push(`- **${esc(u.what)}**: ${esc(u.why)}. _To close it: ${esc(u.resolve)}._`);
  }
  if (b.changes.length) {
    L.push('', '<details><summary><b>What changed in behaviour</b></summary>', '');
    for (const c of b.changes) L.push(`- ${esc(c.title)} _(${KNOWN_WORD[c.known].word})_${c.cause ? ` (${link(c.cause, r, meta)})` : ''}`);
    L.push('', '</details>');
  }
  L.push('', '<details><summary><b>Every changed file, accounted for</b></summary>', '', '| File | Status | |', '|---|---|---|');
  for (const l of r.ledger) {
    const status = { explained: 'explained', followed: 'followed', 'test-only': 'test only', 'not-modelled': '**not followed**', 'no-runtime-effect': 'no app effect', deleted: 'deleted' }[l.status];
    L.push(`| ${code(l.file).replace(/\|/g, '\\|')} | ${status} | ${esc(l.reason ?? '')}${l.lines.length ? ` lines ${l.lines.slice(0, 10).join(', ')}` : ''} |`);
  }
  L.push('', '</details>', '');
  const ok = r.verification.hops - r.verification.failed.length;
  L.push(`Every claim cites the code: ${ok}/${r.verification.hops} cited lines re-checked at \`${r.head.slice(0, 7)}\`. Not followed by this build: ${esc(r.notModelled.join('; '))}. Teslon ${meta.version} · ${r.schema}${meta.at ? ` · ${meta.at}` : ''}.`);
  // the step summary takes up to 1 MiB
  return fit(L.join('\n'), 1_000_000, '…cut to fit the summary page; the run artifact has everything.');
}
