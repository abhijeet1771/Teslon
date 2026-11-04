import { isTyped, type ImpactReport, type Surface, type Case, type Hop, type Tier, type SurfaceKind, type Unseen, type DeltaKind } from './model.js';

/**
 * The report as QA decides on it: every area of the application, each with
 * exactly one answer (test, skip, or unclear), grouped by module the way the
 * team talks about the app. The cockpit, the PR comment and the run summary
 * all render this, so they never disagree.
 *
 * Nothing here decides impact. It only arranges what the engine found. The
 * module an area sits in is taken from its route or path; that is for
 * grouping only, and no claim rests on it.
 */

export type State = 'test' | 'skip' | 'unclear';
/** How a case is known. proven: a typed rule says what changes. followed: the changed code runs there; what it does differently is not typed. */
export type Known = 'proven' | 'followed';

export interface Area {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly where: string;
  readonly module: string;
  readonly state: State;
  /** For an area to test: how soon. */
  readonly tier?: Exclude<Tier, 'skip'>;
  /** Cases to run here. */
  readonly cases: readonly Case[];
  /** Parts of this area checked and found unchanged. */
  readonly notes: readonly Case[];
  /** Why it is safe to skip, or why it cannot be ruled out. */
  readonly why?: string;
  readonly evidence: readonly Hop[];
  /** The area whose cases cover this one (a change on every screen). */
  readonly cover?: string;
}

export interface Module {
  readonly name: string;
  readonly areas: readonly Area[];
  readonly test: number;
  readonly skip: number;
  readonly unclear: number;
}

export interface Confidence {
  readonly level: 'high' | 'partial' | 'low';
  readonly title: string;
  readonly detail: string;
}

export interface Change {
  readonly id: string;
  readonly title: string;
  readonly kind: DeltaKind;
  readonly known: Known;
  readonly cause?: Hop;
  /** Areas this change reaches. */
  readonly areas: number;
}

export interface Brief {
  readonly none: boolean;
  readonly areas: readonly Area[];
  readonly modules: readonly Module[];
  readonly test: number;
  readonly skip: number;
  readonly unclear: number;
  /** Cases to run, and how many of them come first. */
  readonly cases: number;
  readonly first: number;
  readonly confidence: Confidence;
  readonly changes: readonly Change[];
  /** What could not be seen, less the notes the area map already shows as areas. */
  readonly unseen: readonly Unseen[];
}

/** The skip rule, stated once, so a lead can defend every skip with it. */
export const SKIP_RULE = 'An area is skipped only when every changed line was explained or followed to where it runs, none of it reaches the area, and every file the area runs was read. Each skip names the lines that show it.';

/**
 * What CI holds every build to. The proving ground fails the build on any
 * trust failure, so a build that ships has met it.
 */
export const PROVING = 'OrderDesk, an enterprise-style Spring Boot and Angular app, with 25 developer PRs whose impact was written down by hand before Teslon ran. CI fails the build on a single wrong skip, silent miss, false alarm or unchecked citation; this build has none.';

export const KNOWN_WORD: Record<Known, { word: string; means: string }> = {
  proven: { word: 'Proven', means: 'a typed rule in the code says what changes here' },
  followed: { word: 'Followed', means: 'the changed code runs here; what it does differently is not typed, so check it works as before' },
};

const KIND_ORDER: Readonly<Record<string, number>> = { screen: 0, widget: 1, 'test-plan': 2, data: 3, api: 4, job: 5, dashboard: 6, module: 7, deploy: 8 };
const TIER_ORDER: Readonly<Record<string, number>> = { 'test-first': 0, 'test-next': 1, watch: 2 };
const STATE_ORDER: Readonly<Record<State, number>> = { test: 0, unclear: 1, skip: 2 };
const EVERY = 'Every screen';
const PLATFORM = 'Platform';

export function known(r: ImpactReport, c: Case): Known {
  const d = r.deltas.find((x) => x.id === c.delta);
  if (!d) return 'followed';
  if (isTyped(d.kind) || d.id.startsWith('api-gone:')) return 'proven';
  // a migration that makes every write or read fail is a rule of the database, not a guess
  if (d.id.startsWith('db:') && c.tier === 'test-first') return 'proven';
  return 'followed';
}

/* ---------- modules: from routes and paths, for grouping only ---------- */

const STOP = new Set(['api', 'apis', 'rest', 'v1', 'v2', 'v3', 'v4', 'public', 'internal', 'services', 'service']);
const segs = (path: string): string[] => path.split(/[/?#]/).filter((s) => s && !/^[:{*]/.test(s) && !/^\*\*?$/.test(s) && !STOP.has(s.toLowerCase()));
/** customers, Customer, customer-list → customer */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/ies$/, 'y').replace(/(ss|us)$/, '$1_').replace(/s$/, '').replace(/_$/, '');
const pretty = (s: string): string => {
  const w = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').trim().toLowerCase();
  return w ? w[0]!.toUpperCase() + w.slice(1) : s;
};

function moduleOf(kind: SurfaceKind, id: string, name: string, where: string, screens: Map<string, string>): string {
  const match = (parts: readonly string[]): string | null => {
    for (const p of parts) { const k = norm(p); if (screens.has(k)) return screens.get(k)!; }
    return null;
  };
  const contains = (text: string): string | null => {
    const t = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    let best: string | null = null, len = 0;
    for (const [k, v] of screens) if (k.length > 2 && t.includes(k) && k.length > len) { best = v; len = k.length; }
    return best;
  };
  switch (kind) {
    case 'screen': {
      if (id === 'screen:*') return EVERY;
      const s = segs(where)[0];
      // the root route is a module of its own, named as the app names it: Dashboard, Home
      return s ? screens.get(norm(s)) ?? pretty(s) : name && name !== where && name.length <= 32 ? name : 'Home';
    }
    case 'widget': return EVERY;
    case 'api': {
      const path = name.split(' ')[1] ?? where;
      const ps = segs(path);
      return match(ps) ?? (ps[0] ? pretty(ps[0]) : 'APIs');
    }
    case 'job': return contains(name.split('.')[0] ?? name) ?? 'Jobs';
    case 'data': return match([where]) ?? contains(where) ?? 'Data';
    default: return PLATFORM;
  }
}

/* ---------- the brief ---------- */

export function brief(r: ImpactReport): Brief {
  const none = r.triage.appEffect === 'none';
  const held = r.held ?? [];
  // module names come from the screens: what the team sees in the app
  const screens = new Map<string, string>();
  const screenPaths = [...r.surfaces.filter((s) => s.kind === 'screen' && s.id !== 'screen:*').map((s) => s.where), ...held.map((h) => h.where)];
  for (const p of screenPaths) { const s = segs(p)[0]; if (s && !screens.has(norm(s))) screens.set(norm(s), pretty(s)); }
  // the root screen's own name groups what belongs to it: /api/dashboard under Dashboard
  for (const x of [...r.surfaces.filter((y) => y.kind === 'screen'), ...held]) if (!segs(x.where).length && x.name !== x.where && x.name.length <= 32 && !screens.has(norm(x.name))) screens.set(norm(x.name), x.name);

  const areas: Area[] = [];
  const seen = new Set<string>();
  for (const s of r.surfaces) {
    seen.add(s.id);
    const run = r.cases.filter((c) => c.surface === s.id && c.tier !== 'skip');
    const notes = r.cases.filter((c) => c.surface === s.id && c.tier === 'skip');
    const module = moduleOf(s.kind, s.id, s.name, s.where, screens);
    if (s.tier === 'skip') {
      areas.push({ id: s.id, kind: s.kind, name: s.name, where: s.where, module, state: 'skip', cases: [], notes, ...(s.reason ? { why: s.reason } : {}), evidence: s.evidence ?? [] });
      continue;
    }
    // a place listed with nothing to run is a place checked and found unchanged
    if (!run.length) {
      areas.push({ id: s.id, kind: s.kind, name: s.name, where: s.where, module, state: 'skip', cases: [], notes, why: notes[0]?.expect ?? s.reason ?? 'nothing here changes', evidence: notes.flatMap((n) => n.hops).slice(0, 3) });
      continue;
    }
    areas.push({ id: s.id, kind: s.kind, name: s.name, where: s.where, module, state: 'test', tier: s.tier, cases: run, notes, evidence: [] });
  }
  for (const h of held) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    const covered = h.cover && r.surfaces.some((s) => s.id === h.cover && s.tier !== 'skip');
    const kind = h.kind ?? 'screen';
    areas.push({ id: h.id, kind, name: h.name, where: h.where, module: moduleOf(kind, h.id, h.name, h.where, screens), state: covered ? 'test' : 'unclear', ...(covered ? { tier: 'test-next' as const, cover: h.cover! } : {}), cases: [], notes: [], why: covered ? 'a change reaches every screen; the cases are under Every screen' : h.why, evidence: h.evidence });
  }
  areas.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (TIER_ORDER[a.tier ?? ''] ?? 3) - (TIER_ORDER[b.tier ?? ''] ?? 3) || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name));

  const byModule = new Map<string, Area[]>();
  for (const a of areas) { if (!byModule.has(a.module)) byModule.set(a.module, []); byModule.get(a.module)!.push(a); }
  const modules: Module[] = [...byModule].map(([name, as]) => ({ name, areas: as, test: as.filter((a) => a.state === 'test').length, skip: as.filter((a) => a.state === 'skip').length, unclear: as.filter((a) => a.state === 'unclear').length }));
  const weight = (m: Module): number => (m.areas.some((a) => a.tier === 'test-first') ? 0 : m.test ? 1 : m.unclear ? 2 : 3);
  modules.sort((a, b) => weight(a) - weight(b) || Number(b.name === EVERY) - Number(a.name === EVERY) || Number(a.name === PLATFORM) - Number(b.name === PLATFORM) || b.test - a.test || a.name.localeCompare(b.name));

  const own = areas.filter((a) => a.state === 'test');
  const cases = own.reduce((n, a) => n + a.cases.length, 0);
  const first = own.reduce((n, a) => n + a.cases.filter((c) => c.tier === 'test-first').length, 0);

  // confidence: said in words, from what the engine could and could not do
  const failed = r.verification.failed.length;
  const unfollowed = r.ledger.filter((l) => l.status === 'not-modelled');
  const unread = r.unseen.filter((u) => /^the \S+ front end \(/.test(u.what));
  const checked = r.verification.hops - failed;
  const confidence: Confidence = failed
    ? { level: 'low', title: 'Not proven', detail: `${failed} cited line${failed === 1 ? '' : 's'} did not re-check at ${r.head.slice(0, 7)}. Treat this brief as a draft; this is a Teslon bug, please report it.` }
    : unfollowed.length || unread.length
      ? {
        level: 'partial', title: 'Partial',
        detail: [
          unfollowed.length ? `${unfollowed.length} changed file${unfollowed.length === 1 ? ' has' : 's have'} lines Teslon did not follow (${unfollowed.slice(0, 2).map((l) => l.file.split('/').pop()).join(', ')}${unfollowed.length > 2 ? ', …' : ''}), so no screen is skipped until they are read.` : '',
          unread.length ? `${unread.map((u) => u.what.replace(/^the (\S+) front end.*/, 'The $1 front end')).join(' and ')} is not read, so its screens are neither listed nor skipped.` : '',
          `Everything listed to test is still backed by the code: ${checked} of ${r.verification.hops} cited lines re-checked.`,
        ].filter(Boolean).join(' '),
      }
      : none
        ? { level: 'high', title: 'High', detail: `No changed file reaches the running app: ${r.triage.summary.replace(/^No effect on the running app: /, '')}` }
        : { level: 'high', title: 'High', detail: `Every changed line is accounted for, and all ${r.verification.hops} cited lines re-checked at ${r.head.slice(0, 7)}.` };

  const changes: Change[] = r.deltas.map((d) => {
    const cs = r.cases.filter((c) => c.delta === d.id && c.tier !== 'skip');
    const k: Known = cs.length ? (cs.some((c) => known(r, c) === 'proven') ? 'proven' : 'followed') : isTyped(d.kind) ? 'proven' : 'followed';
    return { id: d.id, title: d.title, kind: d.kind, known: k, ...(d.causes[0] ? { cause: d.causes[0] } : {}), areas: new Set(cs.map((c) => c.surface)).size };
  });

  // a note the map already shows, area by area, is not repeated under "could not see"
  const shown = new Set(areas.filter((a) => a.state !== 'skip').map((a) => a.id));
  const unseen = r.unseen.filter((u) => !(u.areas && u.areas.length && u.areas.every((id) => shown.has(id))));

  return {
    none, areas, modules,
    test: own.length, skip: areas.filter((a) => a.state === 'skip').length, unclear: areas.filter((a) => a.state === 'unclear').length,
    cases, first, confidence, changes, unseen,
  };
}

/** Words in area names that say what kind of place it is, not what it is about. */
const GENERIC = new Set(['add', 'new', 'edit', 'update', 'create', 'delete', 'list', 'detail', 'view', 'page', 'screen', 'form', 'table', 'api', 'get', 'post', 'put', 'patch', 'every', 'information', 'info', 'home', 'dashboard', 'job', 'report', 'the', 'and', 'for', 'id']);

/** Modules the PR's own words do not name, among those it reaches: where "I changed this page" falls short. */
export function unnamed(b: Brief, said: string): string[] {
  const words = said.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean).map(norm);
  const named = (w: string): boolean => { const k = norm(w); return k.length > 2 && words.includes(k); };
  const out: string[] = [];
  // a change on every screen is the one a description most often leaves out
  const every = b.modules.find((m) => m.name === EVERY);
  if (every?.test && !/\b(every|all|global|each|whole|everywhere|app-wide)\b/i.test(said)) out.push(EVERY);
  for (const m of b.modules) {
    if (m.name === EVERY || m.name === PLATFORM) continue;
    // what a module reaches on its own, not only through a change on every screen
    if (!m.areas.some((a) => (a.state === 'test' && !a.cover) || a.state === 'unclear')) continue;
    // a module counts as named when its name, or a word of a screen it reaches, is in the text: "pet" names Add Pet.
    // API paths do not count: naming an endpoint is not naming the screens that call it
    const own = (n: string): string[] => n.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2 && !GENERIC.has(norm(w)));
    if (named(m.name) || own(m.name).some(named) || m.areas.some((a) => a.state !== 'skip' && (a.kind === 'screen' || a.kind === 'widget' || a.kind === 'data') && own(a.name).some(named))) continue;
    out.push(m.name);
  }
  return out;
}

/** The surface an area was built from, when it has one. */
export const surfaceOf = (r: ImpactReport, a: Area): Surface | undefined => r.surfaces.find((s) => s.id === a.id);
