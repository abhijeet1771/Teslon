import type { ImpactReport, Surface, Case, Hop, Tier } from './model.js';

/**
 * Plain text for a terminal or a PR comment. One block per place to test,
 * the steps under it, and the chain that puts it there. Evidence lines are
 * short (file:line and what is on it); `evidence: true` prints every hop.
 */

const TIERS: readonly [Tier, string][] = [
  ['test-first', 'TEST FIRST'],
  ['test-next', 'TEST NEXT'],
  ['watch', 'WATCH AFTER RELEASE'],
];

const at = (h: Hop): string => `${h.file.split('/').pop()}:${h.line}`;

const mark = (h: Hop): string => (h.verified === false ? '✗' : '✓');

function where(s: Surface): string {
  if (s.kind === 'screen') return s.where;
  if (s.kind === 'widget') return s.where;
  if (s.kind === 'dashboard' || s.kind === 'test-plan' || s.kind === 'job') return s.where.split('/').pop() ?? s.where;
  return s.where;
}

/** Hops shared by every case on a surface (printed once) and those particular to each case. */
function split(cases: readonly Case[], causes: ReadonlySet<Hop>, all: boolean): { shared: Hop[]; own: Map<Case, Hop[]> } {
  const key = (h: Hop): string => `${h.file}:${h.line}:${h.label}`;
  const keep = (h: Hop): boolean => all || !causes.has(h);
  const lists = cases.map((c) => c.hops.filter(keep));
  const sharedKeys = lists.length ? new Set(lists[0]!.map(key).filter((k) => lists.every((l) => l.some((h) => key(h) === k)))) : new Set<string>();
  const shared = lists.length ? lists[0]!.filter((h) => sharedKeys.has(key(h))) : [];
  const own = new Map<Case, Hop[]>();
  cases.forEach((c, i) => own.set(c, lists[i]!.filter((h) => !sharedKeys.has(key(h)))));
  return { shared, own };
}

const short = (hs: readonly Hop[]): string => hs.map((h) => `${mark(h)} ${h.label.toLowerCase()} ${at(h)}`).join(' → ');
const long = (hs: readonly Hop[], pad: string): string[] => hs.map((h) => `${pad}${mark(h)} ${h.label.padEnd(24)} ${at(h).padEnd(34)} ${h.rule}`);

export function renderText(r: ImpactReport, opts: { evidence?: boolean; repoName?: string } = {}): string {
  const L: string[] = [];
  const causes = new Set(r.deltas.flatMap((d) => d.causes));
  const active = r.surfaces.filter((s) => s.tier !== 'skip');
  const skipped = r.surfaces.filter((s) => s.tier === 'skip');
  const ok = r.verification.hops - r.verification.failed.length;
  const notModelled = r.ledger.filter((l) => l.status === 'not-modelled');

  L.push(`Teslon impact  ${r.base.slice(0, 7)}..${r.head.slice(0, 7)}${opts.repoName ? `  ${opts.repoName}` : ''}`);
  L.push(r.triage.appEffect === 'none' ? `✓ ${r.triage.summary} Nothing to test in the app.` : r.triage.summary);
  L.push(`${r.deltas.length} behaviour change${r.deltas.length === 1 ? '' : 's'} · ${active.length} to test · ${skipped.length} skipped with proof · ${r.unseen.length} not visible · evidence ${ok}/${r.verification.hops} lines re-read at head${r.verification.failed.length ? '  ✗ SOME EVIDENCE FAILED' : ''}`);
  if (notModelled.length) L.push(`⚠ ${notModelled.length} changed file${notModelled.length === 1 ? '' : 's'} with lines no rule explains — see LEDGER`);
  L.push('');

  if (!r.deltas.length) {
    if (r.triage.appEffect !== 'none') L.push('No behaviour change this build can model or follow was found.');
    L.push('');
  } else {
    L.push('WHAT CHANGED');
    const typed = r.deltas.filter((d) => d.kind.startsWith('request-rules'));
    const followed = r.deltas.filter((d) => !d.kind.startsWith('request-rules'));
    typed.forEach((d, i) => {
      L.push(` ${i + 1}. ${d.title}`);
      if (d.endpoint) L.push(`    ${d.endpoint}`);
      L.push(`    ${d.causes.map((h) => `${mark(h)} ${h.label.toLowerCase()} ${at(h)}`).join(' · ')}`);
    });
    if (followed.length) {
      L.push(`${typed.length ? '' : ' '}${typed.length ? ' ' : ''}Followed to where it runs (what it does is not typed):`);
      for (const d of followed.slice(0, 12)) L.push(`  · ${d.title}${d.causes[0] ? `  ${mark(d.causes[0])} ${at(d.causes[0])}` : ''}`);
      if (followed.length > 12) L.push(`  · … ${followed.length - 12} more`);
    }
    L.push('');
  }

  // a change that many places run is one regression list, not one block per place
  const byDelta = new Map<string, Set<string>>();
  for (const c of r.cases) if (c.tier === 'test-next') { if (!byDelta.has(c.delta)) byDelta.set(c.delta, new Set()); byDelta.get(c.delta)!.add(c.surface); }
  const broad = new Set([...byDelta].filter(([id, ss]) => ss.size > 4 && !r.deltas.find((d) => d.id === id)?.kind.startsWith('request-rules')).map(([id]) => id));
  const grouped = (c: Case): boolean => c.tier === 'test-next' && broad.has(c.delta);
  if (broad.size) {
    L.push('REGRESSION (changed code that many places run; check each still works)');
    for (const id of broad) {
      const d = r.deltas.find((x) => x.id === id);
      const ss = [...byDelta.get(id)!].map((sid) => r.surfaces.find((x) => x.id === sid)!).filter(Boolean);
      L.push(` ▸ ${d?.title ?? id}`);
      for (const [kind, label] of [['screen', 'Screens'], ['widget', 'On every screen'], ['api', 'APIs'], ['job', 'Jobs'], ['module', 'Services']] as const) {
        const of = ss.filter((x) => x.kind === kind);
        if (!of.length) continue;
        const names = of.map((x) => (kind === 'screen' ? `${x.name} (${x.where})` : x.name));
        L.push(`     ${label} (${of.length}): ${names.slice(0, 12).join(' · ')}${names.length > 12 ? ` · +${names.length - 12}` : ''}`);
      }
      const one = r.cases.find((c) => c.delta === id && grouped(c));
      const eg = one ? one.hops.filter((h) => !causes.has(h)) : [];
      if (eg.length) L.push(`     path, e.g.: ${short(eg)}`);
    }
    L.push('');
  }

  for (const [tier, title] of TIERS) {
    const list = active.filter((s) => s.tier === tier && r.cases.some((c) => c.surface === s.id && !grouped(c)));
    if (!list.length) continue;
    L.push(title);
    for (const s of list) {
      const cs = r.cases.filter((c) => c.surface === s.id && !grouped(c));
      const run = cs.filter((c) => c.tier !== 'skip');
      const not = cs.filter((c) => c.tier === 'skip');
      L.push(` ▸ ${s.name}${s.kind === 'screen' || s.kind === 'widget' ? `  (${where(s)})` : s.kind === 'api' ? '' : `  ${where(s)}`}`);
      if (s.kind === 'api' && !cs.length) {
        L.push(`     Every rule in the change applies here; callers outside the repo are listed under NOT VISIBLE.`);
      }
      const { shared, own } = split(cs, causes, !!opts.evidence);
      for (const c of run) {
        const field = [c.section, c.field].filter(Boolean).join(' › ');
        L.push(`   □ ${field ? `${field}: ` : ''}${c.do}`);
        L.push(`       expect ${c.expect}${c.before !== '—' ? `   (before: ${c.before})` : ''}${c.hole ? '   [rule hole]' : ''}`);
        const mine = own.get(c) ?? [];
        if (mine.length) {
          if (opts.evidence) L.push(...long(mine, '         '));
          else L.push(`       because ${short(mine)}`);
        }
      }
      for (const c of not) L.push(`   – ${[c.section, c.field].filter(Boolean).join(' › ')}: not affected, ${c.expect}`);
      if (shared.length) {
        if (opts.evidence) { L.push('     path:'); L.push(...long(shared, '       ')); }
        else L.push(`     path: ${short(shared)}`);
      }
    }
    L.push('');
  }

  if (skipped.length) {
    L.push('SKIP (checked, not affected)');
    for (const s of skipped) {
      const ev = s.evidence ?? [];
      L.push(` – ${s.name}${s.kind === 'screen' ? `  (${s.where})` : ''}: ${s.reason ?? ''}  ${ev.slice(0, 3).map((h) => `${mark(h)} ${at(h)}`).join(' ')}${ev.length > 3 ? ` +${ev.length - 3}` : ''}`);
    }
    L.push('');
  }

  if (r.unseen.length) {
    L.push('NOT VISIBLE TO TESLON');
    for (const u of r.unseen) L.push(` ? ${u.what}\n     ${u.why}\n     to close it: ${u.resolve}`);
    L.push('');
  }

  L.push(`LEDGER  ${r.ledger.length} changed file${r.ledger.length === 1 ? '' : 's'}`);
  for (const l of r.ledger) {
    const tag = ({ explained: 'explained', followed: 'followed', 'test-only': 'test only', 'not-modelled': 'NOT MODELLED', 'no-runtime-effect': 'no app effect', deleted: 'deleted' } as const)[l.status];
    L.push(` ${l.status === 'not-modelled' ? '!' : '·'} ${tag.padEnd(17)} ${l.file}${l.lines.length ? `  lines ${l.lines.slice(0, 12).join(', ')}${l.lines.length > 12 ? ' …' : ''}` : ''}${l.reason && l.status !== 'explained' ? `  (${l.reason})` : ''}`);
  }
  L.push('');
  L.push(`Typed end to end: request rules (Bean Validation). Followed to where they run: changed Java methods and types, front-end files, dependencies, deployment files. Not typed yet: ${r.notModelled.join('; ')}.`);
  if (r.verification.failed.length) {
    L.push('');
    L.push('EVIDENCE THAT FAILED RE-READING');
    for (const h of r.verification.failed) L.push(` ✗ ${at(h)} expected "${h.quote}" — ${h.rule}`);
  }
  L.push(`(${r.ms} ms)`);
  return L.join('\n');
}
