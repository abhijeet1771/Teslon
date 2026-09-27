import { CODE_RE, buildImportGraph, walkWithParents, type Alias, type Edge } from '../graph/imports.js';
import { TEXT_RE, buildNameIndex, nameIndexLimitation } from '../graph/names.js';
import { buildSymbolEdges, proofPaths, shortestPathPerDestination, type ProofPath } from '../graph/symbols.js';
import {
  cloneEdges,
  configEdgesDetailed,
  dynamicDispatchEdges,
  dynamicImportEdges,
  generatedEdges,
  runtimeStringEdges,
  templateEdges,
} from '../graph/widening.js';
import { buildJavaGraph, readJava, unresolvedSummary, type JavaReading } from '../lang/java/index.js';
import { readAst, type AstReading } from '../profile/ast.js';
import { dataCouplingEdges, minimumCases, profileFile } from '../profile/capability.js';
import { semanticDiff, sortChanges, type SemanticChange, type SemanticDiff } from '../profile/semantic-diff.js';
import {
  SCHEMA_VERSION,
  strongerBand,
  bandRank,
  type Band,
  type Completeness,
  type PriorityItem,
  type ScoreFactor,
  type TestToRun,
  type Tier,
  type CapabilityProfile,
  type ChangeSet,
  type Limitation,
  type Provenance,
  type RadiusItem,
  type SignalId,
  type Surface,
  type TeslonResult,
} from '../schema/index.js';

/**
 * The orchestrator. Everything else in this package is a primitive that
 * answers one narrow question; this is the only place that produces the
 * `TeslonResult` the product is defined by.
 *
 * It is deliberately pure: git has already run, the change set is an
 * argument, and nothing here reads the network or the clock. Two calls with
 * the same arguments on the same tree return byte-identical results, which is
 * invariant I3 and also the only way a CI gate can be trusted.
 *
 * The assembly order is the order a person reads the answer in:
 *
 *   1. what changed          the seeds, and what changed *about* them
 *   2. who is downstream     one adjacency built from every signal at once
 *   3. how sure we are       a band per item, merged so unknown wins
 *   4. what a person opens   surfaces, and which tests actually reach them
 *   5. what nobody tests     the gaps — the highest-value output
 *   6. what we could not see limitations, stated rather than swallowed
 *   7. the brief             the five lines someone reads before testing
 */

export interface AnalyzeOptions {
  readonly root: string;
  /** Every file in the tree, already listed. */
  readonly allFiles: readonly string[];
  readonly change: ChangeSet;
  readonly repo?: string;
  readonly aliases?: readonly Alias[];
  /** Limitations from earlier stages (git resolution), carried through. */
  readonly limitations?: readonly Limitation[];
  /**
   * Readings of the changed files as they were at the merge base. Supplying
   * them turns on the semantic diff, which is what upgrades "this file
   * changed" into "this behaviour changed". Without them the analysis is
   * still safe, just less specific — and it says so in `limitations`.
   */
  readonly baseReadings?: ReadonlyMap<string, AstReading | null>;
}

export interface AnalyzeResult {
  readonly result: TeslonResult;
  /** Per-file semantic diffs, for the detail views. */
  readonly diffs: readonly SemanticDiff[];
  /** Readable proofs, shortest per destination, for the "prove it" view. */
  readonly proofs: readonly ProofPath[];
}

/** Test files, by the conventions every JS and Java repo actually uses. */
const TEST_RE = /(^|\/)(?:tests?|specs?|__tests__|e2e|cypress|playwright)\/|\.(?:test|spec|e2e|cy|steps)\.[cm]?[jt]sx?$|(?:^|\/)src\/test\/|Test(?:s|Case|Suite)?\.java$|\.feature$/;

export function isTestFile(file: string): boolean {
  return TEST_RE.test(file);
}

/**
 * The band a signal is worth on its own.
 *
 * These are confidence in *being affected*, not confidence that the edge
 * exists. An import edge is a fact; whether the importer's behaviour changed
 * is an inference, so a plain import is `likely`, not `certain`.
 *
 * `unknown` sits above `likely` on purpose (see `bandRank`): a file we failed
 * to analyse is more dangerous than one we merely inferred, because the
 * inference at least had evidence behind it.
 */
const SIGNAL_BAND: Record<SignalId, Band> = {
  changed: 'certain', // it is in the diff. Nothing to infer.
  coverage: 'certain', // a test really executed this line
  contract: 'certain', // the exported shape itself moved
  import: 'likely',
  route: 'likely',
  'data-coupling': 'likely', // one writes the table the other reads
  name: 'possible', // a rare shared name, but a name all the same
  cochange: 'possible',
  incident: 'possible',
  widen: 'unknown', // we could not resolve the target, so we widened
  template: 'unknown',
  config: 'unknown',
  generated: 'unknown',
  'runtime-string': 'unknown',
  lockfile: 'unknown',
  clone: 'look', // textually similar. Not a dependency — go and look.
};

/**
 * Distance weakens an inference, but never a failure to analyse.
 *
 * Decaying `unknown` by hop count would be narrowing on the strength of a
 * hop count, which is evidence about the graph and not evidence about the
 * unresolved thing — invariant I2 forbids it. Nothing is ever dropped from
 * the radius by this function; `possible` is the floor.
 */
function bandFor(signal: SignalId, hops: number): Band {
  const base = SIGNAL_BAND[signal];
  if (base === 'unknown' || base === 'look' || base === 'possible') return base;
  if (hops <= 1) return base;
  if (hops === 2) return base === 'certain' ? 'likely' : base;
  return 'possible';
}

const byPath = (a: { file: string }, b: { file: string }): number => a.file.localeCompare(b.file);

/**
 * Signals whose mechanism does not exist yet, as opposed to signals that ran
 * and found nothing. Conflating the two is how a tool comes to look more
 * complete than it is, so the two cases are reported in different words.
 */
const NOT_WIRED: Partial<Record<SignalId, string>> = {
  coverage: 'no runtime coverage data was supplied, so "a test really executed this line" could not be used',
  cochange: 'git history was not read in this run, so files that always move together were not linked',
  incident: 'no incident history is configured, so areas that have escaped before are not weighted',
  route: 'no URL-to-page-to-spec bridge ran, so a route is only followed when a config file names the file',
  lockfile: 'no lockfile diff was supplied, so a dependency bump with no source change is invisible',
};

/** Files nothing reads, and nothing needs to. */
const IRRELEVANT = /\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|mp4|webm|mp3|wav|map|md|mdx|txt|log|snap|patch|license)$|(?:^|\/)(?:\.git|\.gitignore|\.gitattributes|\.npmrc|LICENSE|CHANGELOG)/i;


/**
 * Surfaces are a claim, and a claim follows the opposite rule to the radius.
 *
 * In the radius, doubt must widen: keep the file, because a missed file is an
 * untested file. In the surface inventory, doubt must not assert: a fabricated
 * endpoint is worse than a missing one, because it sends a tester to a page
 * that does not exist and it discredits every true row next to it.
 *
 * This is not the invariants being bent. I1 and I2 are about never dropping an
 * impacted file, and nothing here touches the radius — the file stays, at full
 * band, in its tier. What is withheld is only the assertion that a named thing
 * exists, and every withholding is counted and reported.
 *
 * The three gates below exist because running Teslon on its own source
 * produced all three fabrications at once: `ast.ts` was reported as serving
 * `GET /x` (a string inside the parser), as emitting the events `gt`, `gte`,
 * `min`, `max` and `length` (the keys of a lookup table), and as enqueuing a
 * job (a word matched in its own source).
 */

/** Shapes that genuinely declare named events or actions. */
const ACTION_SHAPES = new Set<AstReading['shape']>(['store', 'resolver', 'component', 'hook']);

/**
 * Comparison and validation vocabulary. These are the names a schema builder,
 * a validator or a parser uses for its own machinery, and they are never what
 * anyone calls an event.
 */
const NOT_AN_EVENT = new Set([
  'gt', 'gte', 'lt', 'lte', 'min', 'max', 'eq', 'ne', 'length', 'minLength', 'maxLength',
  'size', 'count', 'value', 'values', 'type', 'name', 'id', 'key', 'index', 'default',
  'required', 'optional', 'nullable', 'pattern', 'regex', 'enum', 'email', 'url', 'uuid',
]);

/** An event name looks like a name: it is namespaced, or a handler, or two words. */
const EVENT_SHAPED = /[.:\/_-]|^on[A-Z]|^[a-z]+[A-Z]/;

function looksLikeEventName(name: string): boolean {
  return !NOT_AN_EVENT.has(name) && EVENT_SHAPED.test(name);
}

/** Score at which each tier begins. A floor lifts a score to one of these. */
const TIER_MIN: Record<Tier, number> = { 1: 13, 2: 9, 3: 5, 4: 0 };

const tierFor = (score: number): Tier =>
  score >= TIER_MIN[1] ? 1 : score >= TIER_MIN[2] ? 2 : score >= TIER_MIN[3] ? 3 : 4;

/**
 * Score the whole radius by what to open first.
 *
 * Every factor is named and the points sum to the score exactly, because a
 * lead who cannot see why a file is Tier 1 will either ignore the tier or
 * test everything — and both outcomes waste the analysis.
 */
function prioritise(a: {
  radius: readonly RadiusItem[];
  surfaces: readonly Surface[];
  profiles: readonly CapabilityProfile[];
  java: ReadonlyMap<string, JavaReading>;
  diffs: readonly SemanticDiff[];
  reachedBy: ReadonlyMap<string, { direct: Set<string>; indirect: Set<string> }>;
  readings: ReadonlyMap<string, AstReading | null>;
  newFiles: ReadonlySet<string>;
}): PriorityItem[] {
  const surfacesByFile = new Map<string, Surface[]>();
  for (const s of a.surfaces) {
    if (!s.file) continue;
    const list = surfacesByFile.get(s.file);
    if (list) list.push(s);
    else surfacesByFile.set(s.file, [s]);
  }
  const profileByFile = new Map(a.profiles.map((p) => [p.file, p]));
  const diffByFile = new Map(a.diffs.map((d) => [d.file, d]));

  const out: PriorityItem[] = [];
  for (const item of a.radius) {
    if (isTestFile(item.file)) continue; // a test is something you run, not something you test
    const because: ScoreFactor[] = [];
    const add = (factor: string, points: number, detail: string): void => {
      if (points !== 0) because.push({ factor, points, detail });
    };

    add('confidence', bandRank(item.band), `band is ${item.band}`);
    const prox = item.hops === 0 ? 3 : item.hops === 1 ? 2 : item.hops === 2 ? 1 : 0;
    add('proximity', prox, item.hops === 0 ? 'changed directly' : `${item.hops} hop${item.hops === 1 ? '' : 's'} from a changed file`);

    const mine = surfacesByFile.get(item.file) ?? [];
    const exposure = mine.reduce(
      (n, s) => Math.max(n, s.kind === 'endpoint' || s.kind === 'screen' ? 3 : 2),
      0,
    );
    add('exposure', exposure, mine.length > 0 ? `a person can reach this: ${mine.map((s) => `${s.kind} ${s.id}`).slice(0, 2).join(', ')}` : '');

    // Java says so in an annotation, which is a declaration rather than a
    // pattern match — stronger evidence than anything the TypeScript profiler
    // has. Without this a changed Java file could not reach Tier 1 at all,
    // which made the tiering quietly worse for the language it was added for.
    const java = a.java.get(item.file);
    if (java) {
      if (java.transactional) add('mutation', 3, '@Transactional — this method writes inside a transaction');
      else if (java.entityTables.length > 0) add('mutation', 3, `maps the table${java.entityTables.length === 1 ? '' : 's'} ${java.entityTables.join(', ')}`);
      if (java.httpRoutes.length > 0 && mine.length === 0) {
        add('exposure', 3, `declares ${java.httpRoutes.slice(0, 2).join(', ')}`);
      }
    }
    const profile = profileByFile.get(item.file);
    if (profile && profile.nature !== 'read-only') {
      // `writes <table>` is evidenced by a SQL clause. A side effect is a
      // textual match, so it is worded as one rather than asserted as fact.
      const detail =
        profile.nature !== 'mutating'
          ? 'could not be proven side-effect free'
          : profile.writesTables.length > 0
            ? `writes ${profile.writesTables.slice(0, 2).join(', ')}`
            : profile.sideEffects.length > 0
              ? `treated as state-changing — the source matches "${profile.sideEffects[0]}"`
              : 'writes state';
      add('mutation', 3, detail);
    }

    const reach = a.reachedBy.get(item.file);
    const direct = reach?.direct.size ?? 0;
    const indirect = reach?.indirect.size ?? 0;
    if (direct === 0 && indirect === 0) add('no test reaches it', 3, 'nothing in this repository exercises this file');
    else if (direct === 0) add('no direct test', 1, `${indirect} test${indirect === 1 ? '' : 's'} reach it only as a side effect`);

    const breaking = diffByFile.get(item.file)?.changes.filter((c) => c.severity === 'breaking') ?? [];
    if (breaking.length > 0) add('breaking change', 4, breaking[0]!.what);

    if (a.newFiles.has(item.file)) add('new code', 2, 'this file did not exist at the merge base');
    const auth = a.readings.get(item.file)?.auth;
    if (auth) add('guarded', 2, `carries an authorisation rule: ${auth}`);

    let score = because.reduce((n, f) => n + f.points, 0);
    let tier: Tier = tierFor(score);

    // Floors. A score is a heuristic; these are not. Each one exists because
    // the alternative is a report that quietly deprioritises something a
    // human would never agree to skip.
    //
    // A floor lifts the score to the tier's threshold rather than overriding
    // the tier behind the score's back. The first draft did override it, and
    // the result was a Tier 2 row scoring 5 printed above a Tier 3 row scoring
    // 8 — defensible policy that reads as a broken sort, which costs more
    // trust than the policy was worth.
    const floor = (t: Tier, why: string): void => {
      if (tier > t) {
        const lift = TIER_MIN[t] - score;
        because.push({ factor: 'floor', points: lift, detail: why });
        score = TIER_MIN[t];
        tier = t;
      }
    };
    if (breaking.length > 0) floor(1, 'a breaking change is never below Tier 1, whatever it scores');
    const writes = (profile && profile.nature !== 'read-only') || java?.transactional === true;
    if (direct === 0 && writes) {
      floor(1, 'code that writes state with no test of its own is never below Tier 1');
    }
    if (item.hops === 0) floor(2, 'a file in the diff is never below Tier 2');
    if (item.band === 'unknown') floor(2, 'a file we could not analyse is never below Tier 2 — the gap is in our reading, not in the risk');

    out.push({ file: item.file, tier, score, because, band: item.band, surfaces: mine.map((s) => `${s.kind} ${s.id}`) });
  }

  return out.sort((x, y) => x.tier - y.tier || y.score - x.score || x.file.localeCompare(y.file));
}

/**
 * What this run could and could not see, in its own words.
 *
 * `filesAdded` is a counterfactual: the radius is rebuilt with that one signal
 * removed, and the difference is how many files only that signal found. It is
 * the only honest way to answer "what does this signal actually buy", and it
 * turns "we have fifteen signals" into a number a reviewer can check.
 */
function assessCompleteness(a: {
  allEdges: readonly Edge[];
  /** Reasons that override NOT_WIRED for this run, when a signal was possible in principle but not here. */
  contextual: Partial<Record<SignalId, string>>;
  seeds: readonly string[];
  radiusSize: number;
  allFiles: readonly string[];
  unreadable: readonly string[];
  limitations: readonly Limitation[];
}): Completeness {
  const bySignal = new Map<SignalId, Edge[]>();
  for (const e of a.allEdges) {
    const list = bySignal.get(e.why.signal);
    if (list) list.push(e);
    else bySignal.set(e.why.signal, [e]);
  }

  const COUNTERFACTUAL_LIMIT = 20000;
  const affordable = a.allFiles.length <= COUNTERFACTUAL_LIMIT;

  const signalsRun: { signal: SignalId; edges: number; filesAdded: number }[] = [];
  for (const [signal, edges] of [...bySignal].sort((x, y) => x[0].localeCompare(y[0]))) {
    let filesAdded = -1;
    if (affordable) {
      const without = new Map<string, Set<string>>();
      for (const e of a.allEdges) {
        if (e.why.signal === signal) continue;
        const out = without.get(e.from);
        if (out) out.add(e.to);
        else without.set(e.from, new Set([e.to]));
      }
      filesAdded = a.radiusSize - walkWithParents(without, a.seeds).dist.size;
    }
    signalsRun.push({ signal, edges: edges.length, filesAdded });
  }

  const signalsAbsent: { signal: SignalId; why: string }[] = [];
  for (const signal of Object.keys(SIGNAL_BAND) as SignalId[]) {
    if (bySignal.has(signal) || signal === 'changed') continue;
    signalsAbsent.push({
      signal,
      why:
        a.contextual[signal] ??
        NOT_WIRED[signal] ??
        'the mechanism ran and nothing in this change triggered it',
    });
  }
  signalsAbsent.sort((x, y) => x.signal.localeCompare(y.signal));

  // A signal blocked by this run's inputs counts as missing capability too,
  // otherwise the verdict undercounts what the reader is not being told.
  const notWired = signalsAbsent.filter((s) => NOT_WIRED[s.signal] ?? a.contextual[s.signal]).length;
  const parts = [
    `${signalsRun.length} of ${signalsRun.length + signalsAbsent.length} signals contributed to this radius.`,
  ];
  if (notWired > 0) {
    parts.push(
      `${notWired} ${notWired === 1 ? 'signal is' : 'signals are'} not wired up in this build, so this radius is a lower bound on the impact, not the whole of it.`,
    );
  }
  if (a.unreadable.length > 0) {
    parts.push(
      `${a.unreadable.length} file${a.unreadable.length === 1 ? '' : 's'} in this tree ${a.unreadable.length === 1 ? 'is' : 'are'} in a language or format no signal reads, so anything reached only through ${a.unreadable.length === 1 ? 'it' : 'them'} is invisible here.`,
    );
  }
  if (a.limitations.length > 0) {
    parts.push(`${a.limitations.length} named limitation${a.limitations.length === 1 ? '' : 's'} applied, each widening the radius rather than narrowing it.`);
  }
  parts.push('Treat this list as "at least these", never as "only these".');

  return {
    signalsRun,
    signalsAbsent,
    unreadable: [...a.unreadable].sort(),
    verdict: parts.join(' '),
  };
}


export function analyze(opts: AnalyzeOptions): AnalyzeResult {
  const { root, allFiles, change } = opts;
  const aliases = opts.aliases ?? [];
  const limitations: Limitation[] = [...(opts.limitations ?? [])];

  const present = new Set(allFiles);
  // A changed path that is not in the tree is either a deleted file or a path
  // from a different root. Both produce an empty analysis, and an empty
  // analysis that says nothing is the single most dangerous output this tool
  // could have: it reads as "nothing is affected".
  const absent = change.files.filter((f) => !present.has(f));
  const changedCode = change.files.filter((f) => CODE_RE.test(f) && present.has(f));
  const changedOther = change.files.filter((f) => !CODE_RE.test(f) && present.has(f));
  if (absent.length > 0) {
    limitations.push({
      what: `${absent.length} changed path${absent.length === 1 ? ' is' : 's are'} not present in the tree that was analysed, so nothing downstream of ${absent.length === 1 ? 'it' : 'them'} could be found.`,
      mitigation:
        'They are kept in the radius as changed. A deleted file needs its former callers checked by hand; a path that should exist means the analysis was pointed at the wrong root, and the result cannot be trusted until that is fixed.',
      files: absent,
    });
  }

  // ---- 1. what changed about the changed files ------------------------
  // Java resolves by package, not by path, so none of the TypeScript
  // machinery applies to it and it needs its own front end. The readings land
  // in the same map because `JavaReading extends AstReading`, which is what
  // lets the tiering, the surfaces and the gaps stay language-agnostic.
  const javaFiles = allFiles.filter((f) => f.endsWith('.java'));
  const javaReadings: JavaReading[] = [];
  for (const f of javaFiles) {
    const r = readJava(root, f);
    if (r) javaReadings.push(r);
  }
  const javaByFile = new Map(javaReadings.map((r) => [r.file, r]));
  const changedJava = change.files.filter((f) => f.endsWith('.java') && present.has(f));

  const headReadings = new Map<string, AstReading | null>();
  for (const f of changedCode) headReadings.set(f, readAst(root, f));
  for (const f of changedJava) headReadings.set(f, javaByFile.get(f) ?? null);

  const diffs: SemanticDiff[] = [];
  if (opts.baseReadings) {
    for (const f of [...changedCode, ...changedJava]) {
      const before = opts.baseReadings.get(f) ?? null;
      const after = headReadings.get(f) ?? null;
      const d = semanticDiff(before, after);
      if (d.changes.length > 0) diffs.push({ ...d, changes: sortChanges(d.changes) });
    }
  } else if (changedCode.length + changedJava.length > 0) {
    limitations.push({
      what: 'The files were not read as they were at the merge base, so no semantic diff ran.',
      mitigation:
        'Every changed file is treated as changed in full, and its whole downstream radius is kept. Safe, but it cannot tell you which behaviour moved.',
      files: [...changedCode, ...changedJava],
    });
  }

  // ---- 2. one adjacency, every signal at once -------------------------
  // Every primitive filters its own input (CODE_RE or TEXT_RE), so each one
  // gets the whole tree. Handing them a pre-filtered list is not an
  // optimisation — it starves the cross-language signals, and a measured
  // review caught exactly that: passing code files only dropped ground-truth
  // recall from 95.7% to 69.6%, because a .css class, a .sql column and an
  // i18n .json key are all evidence that lives outside code. Narrowing the
  // input is narrowing the answer, which invariant I2 forbids.
  const importGraph = buildImportGraph(root, allFiles, aliases);
  const nameIndex = buildNameIndex(root, allFiles);
  const config = configEdgesDetailed(root, allFiles);
  const profiles: CapabilityProfile[] = [];
  for (const f of changedCode) {
    const p = profileFile(root, f);
    if (p) profiles.push(p);
  }
  // Data coupling needs profiles of both ends, so it is profiled across the
  // tree's endpoints, not only the changed ones — a changed writer reaches a
  // reader that is not in the diff, which is the whole point of the signal.
  const endpointish = allFiles.filter((f) => CODE_RE.test(f) && /(?:api|route|handler|controller|repo|dao|service)/i.test(f));
  const couplingProfiles: CapabilityProfile[] = [];
  for (const f of endpointish.slice(0, 2000)) {
    const p = profileFile(root, f);
    if (p) couplingProfiles.push(p);
  }
  if (endpointish.length > 2000) {
    limitations.push({
      what: `Data coupling was computed over the first 2,000 of ${endpointish.length} data-touching files.`,
      mitigation: 'Import, name and widening signals still cover the rest; only the table-sharing signal is capped.',
    });
  }

  const javaGraph = buildJavaGraph(javaReadings);
  if (javaFiles.length > 0) {
    const outside = unresolvedSummary(javaGraph);
    if (outside.length > 0) {
      limitations.push({
        what: `${outside.length} Java package prefix${outside.length === 1 ? '' : 'es'} could not be resolved inside this repository: ${outside.slice(0, 4).map((o) => `${o.prefix} (${o.count})`).join(', ')}.`,
        mitigation:
          'A third-party dependency and a module Teslon was not pointed at look identical from inside one repository, so these are left unresolved rather than assumed harmless. Point Teslon at the sibling module to close the gap.',
      });
    }
  }

  const allEdges: Edge[] = [
    ...importGraph.edges,
    ...nameIndex.edges,
    ...dynamicImportEdges(root, allFiles),
    ...dynamicDispatchEdges(root, allFiles, aliases),
    ...templateEdges(root, allFiles),
    ...config.edges,
    ...generatedEdges(root, allFiles),
    ...runtimeStringEdges(root, allFiles),
    ...cloneEdges(root, allFiles),
    ...dataCouplingEdges(couplingProfiles),
    ...javaGraph.edges,
  ];

  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map<string, Edge[]>();
  for (const e of allEdges) {
    const out = adjacency.get(e.from);
    if (out) out.add(e.to);
    else adjacency.set(e.from, new Set([e.to]));
    const inc = incoming.get(e.to);
    if (inc) inc.push(e);
    else incoming.set(e.to, [e]);
  }

  const { dist } = walkWithParents(adjacency, change.files);

  // ---- 3. a band per item ---------------------------------------------
  const radius: RadiusItem[] = [];
  for (const [file, hops] of [...dist].sort((a, b) => a[0].localeCompare(b[0]))) {
    const why: Provenance[] = [];
    let band: Band;

    if (hops === 0) {
      band = 'certain';
      const d = diffs.find((x) => x.file === file);
      const breaking = d?.changes.filter((c) => c.severity === 'breaking') ?? [];
      why.push({
        signal: breaking.length > 0 ? 'contract' : 'changed',
        detail:
          breaking.length > 0
            ? `changed, and the change is breaking: ${breaking[0]!.what}`
            : 'changed in this pull request',
        via: file,
      });
    } else {
      // Every reason, not just the one the walk happened to arrive by.
      const reasons = (incoming.get(file) ?? [])
        .filter((e) => dist.has(e.from) && (dist.get(e.from) ?? Infinity) < hops)
        .sort((a, b) => bandRank(SIGNAL_BAND[b.why.signal]) - bandRank(SIGNAL_BAND[a.why.signal]) || a.from.localeCompare(b.from));
      if (reasons.length === 0) continue; // unreachable in practice; never guess a reason
      band = reasons.reduce<Band>((acc, e) => strongerBand(acc, bandFor(e.why.signal, hops)), 'look');
      for (const e of reasons) why.push(e.why);
    }

    radius.push({ file, band, hops, why });
  }

  // ---- 4. surfaces, and which tests actually reach them ---------------
  const inRadius = new Set(radius.map((r) => r.file));
  const testsInRadius = radius.filter((r) => isTestFile(r.file)).map((r) => r.file);

  // Walk back from each test over the dependency direction, so "which tests
  // reach this file, and at what distance" is measured rather than assumed.
  const dependencyAdjacency = new Map<string, Set<string>>();
  for (const e of allEdges) {
    const out = dependencyAdjacency.get(e.to);
    if (out) out.add(e.from);
    else dependencyAdjacency.set(e.to, new Set([e.from]));
  }
  const TEST_BUDGET = 400;
  const walkedTests = testsInRadius.slice(0, TEST_BUDGET);
  if (testsInRadius.length > TEST_BUDGET) {
    limitations.push({
      what: `${testsInRadius.length} tests are in the radius; the first ${TEST_BUDGET} were traced to their targets.`,
      mitigation: 'The untraced tests are still listed in the radius, so nothing is dropped — only the per-surface attribution is capped.',
    });
  }
  const reachedBy = new Map<string, { direct: Set<string>; indirect: Set<string> }>();
  for (const test of walkedTests) {
    const { dist: back } = walkWithParents(dependencyAdjacency, [test]);
    for (const [target, d] of back) {
      if (d === 0) continue;
      let slot = reachedBy.get(target);
      if (!slot) {
        slot = { direct: new Set(), indirect: new Set() };
        reachedBy.set(target, slot);
      }
      if (d === 1) slot.direct.add(test);
      else slot.indirect.add(test);
    }
  }

  const surfaces: Surface[] = [];
  const seenSurface = new Set<string>();
  let withheld = 0;
  const addSurface = (kind: Surface['kind'], id: string, file: string | undefined, isNew: boolean): void => {
    const key = `${kind}\u0000${id}\u0000${file ?? ''}`;
    if (seenSurface.has(key)) return;
    seenSurface.add(key);
    const reach = file ? reachedBy.get(file) : undefined;
    surfaces.push({
      kind,
      id,
      ...(file ? { file } : {}),
      isNew,
      directTests: [...(reach?.direct ?? [])].sort(),
      indirectTests: [...(reach?.indirect ?? [])].sort(),
    });
  };

  const newFiles = new Set(
    opts.baseReadings ? changedCode.filter((f) => !opts.baseReadings!.get(f)) : [],
  );

  for (const item of radius) {
    if (isTestFile(item.file)) continue;
    const reading = headReadings.get(item.file) ?? readAst(root, item.file);
    if (!reading) continue;
    const isNew = newFiles.has(item.file);
    if (reading.shape === 'endpoint') addSurface('endpoint', reading.httpRoute ?? item.file, item.file, isNew);
    if (reading.shape === 'component') {
      addSurface('screen', reading.exports[0] ?? item.file.split('/').pop() ?? item.file, item.file, isNew);
    }
    const namesHere = ACTION_SHAPES.has(reading.shape) ? [...reading.events, ...reading.actions] : [];
    if (!ACTION_SHAPES.has(reading.shape)) withheld += reading.events.length + reading.actions.length;
    for (const e of namesHere) {
      if (looksLikeEventName(e)) addSurface('event', e, item.file, isNew);
      else withheld++;
    }
  }
  for (const item of radius) {
    const java = javaByFile.get(item.file);
    if (!java) continue;
    const isNew = newFiles.has(item.file);
    // Both come from annotations, which are declarations and not string
    // matches, so there is nothing to corroborate here.
    for (const route of java.httpRoutes) addSurface('endpoint', route, item.file, isNew);
    for (const column of java.entityColumns) addSurface('column', column, item.file, isNew);
    for (const table of java.entityTables) addSurface('column', table, item.file, isNew);
  }
  for (const p of profiles) {
    const isNew = newFiles.has(p.file);
    if (p.http) {
      // A route is only asserted when the file reads as an endpoint. A route
      // string found in a file that is not one is a string, not a route.
      const reading = headReadings.get(p.file);
      if (reading && (reading.shape === 'endpoint' || reading.httpRoute)) {
        addSurface('endpoint', `${p.http.method} ${p.http.path}`, p.file, isNew);
      } else withheld++;
    }
    for (const t of p.writesTables) addSurface('column', t, p.file, isNew);
    for (const t of p.readsTables) addSurface('column', t, p.file, isNew);
    for (const s of p.sideEffects) {
      if (/mail|email|smtp|ses\b|sendgrid/i.test(s)) addSurface('email', s, p.file, isNew);
      else if (/queue|cron|schedul|worker|job|enqueue/i.test(s)) addSurface('job', s, p.file, isNew);
    }
  }
  if (withheld > 0) {
    limitations.push({
      what: `${withheld} possible surface${withheld === 1 ? '' : 's'} were found but not asserted, because the file they were found in does not read as something that declares them.`,
      mitigation:
        'Those files stay in the radius at full strength and keep their tier — only the claim that a named endpoint or event exists was withheld. Naming a surface that does not exist sends a tester to a page that is not there, so silence is the safer error here.',
    });
  }
  // Side effects are matched textually, so a file that merely writes about
  // sending email reads the same as one that sends it. Said out loud rather
  // than quietly trusted; moving this onto the AST is the real fix.
  const effectSurfaces = surfaces.filter((s) => s.kind === 'job' || s.kind === 'email').length;
  if (effectSurfaces > 0) {
    limitations.push({
      what: `${effectSurfaces} job or email surface${effectSurfaces === 1 ? '' : 's'} came from a textual match on the source, not from a parsed call.`,
      mitigation:
        'A file that describes an effect in a comment, a string or a regular expression matches the same way one that performs it does. Confirm these against the code before promising them to anyone.',
    });
  }
  surfaces.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  // ---- 5. the gaps ----------------------------------------------------
  const gaps: { file: string; reason: string }[] = [];
  const profileByFile = new Map(profiles.map((p) => [p.file, p]));
  for (const file of [...changedCode, ...changedJava]) {
    if (isTestFile(file)) continue;
    const reach = reachedBy.get(file);
    const direct = reach?.direct.size ?? 0;
    const indirect = reach?.indirect.size ?? 0;
    const profile = profileByFile.get(file);
    const reading = headReadings.get(file);
    const d = diffs.find((x) => x.file === file);

    if (direct === 0 && indirect === 0) {
      gaps.push({ file, reason: 'no test in this repository reaches this file through any signal' });
    } else if (direct === 0) {
      gaps.push({
        file,
        reason: `reached only indirectly, by ${indirect} test${indirect === 1 ? '' : 's'} exercising something else — nothing tests it on purpose`,
      });
    }
    if (direct === 0 && profile && profile.nature !== 'read-only') {
      gaps.push({
        file,
        reason:
          profile.nature === 'mutating'
            ? `writes ${[...profile.writesTables, ...profile.sideEffects].slice(0, 3).join(', ') || 'state'} and has no test of its own`
            : 'could not be proven side-effect free, and has no test of its own',
      });
    }
    const newBranches = d?.changes.filter((c) => c.severity === 'behaviour' && c.what.startsWith('new branch')) ?? [];
    if (newBranches.length > 0 && direct === 0) {
      gaps.push({
        file,
        reason: `${newBranches.length} new branch${newBranches.length === 1 ? '' : 'es'} with no test that reaches this file`,
      });
    }
    for (const c of d?.changes ?? []) {
      if (c.severity === 'coverage' && c.what.startsWith('a test was removed')) {
        gaps.push({ file, reason: c.what });
      }
    }
    if (reading && reading.notRead.length > 0) {
      limitations.push({
        what: `Parts of ${file} were not read: ${reading.notRead.slice(0, 3).join('; ')}`,
        mitigation: 'The file is kept in the radius at full strength, and its whole downstream is kept with it.',
        files: [file],
      });
    }
  }
  // One entry per file. Two entries for one file made the brief say "2
  // coverage gaps" about a single untested file, which overstates the problem
  // to exactly the person least able to check it.
  const gapsByFile = new Map<string, string[]>();
  for (const g of gaps) {
    const list = gapsByFile.get(g.file);
    if (list) {
      if (!list.includes(g.reason)) list.push(g.reason);
    } else gapsByFile.set(g.file, [g.reason]);
  }
  const mergedGaps = [...gapsByFile]
    .map(([file, reasons]) => ({ file, reason: reasons.sort().join('; ') }))
    .sort(byPath);

  // ---- 6. what we could not see --------------------------------------
  const nameLimit = nameIndexLimitation(nameIndex);
  if (nameLimit) limitations.push(nameLimit);
  if (config.skipped.length > 0) {
    limitations.push({
      what: `${config.skipped.length} config file${config.skipped.length === 1 ? '' : 's'} named too many files to be a route table, so they were not treated as one.`,
      mitigation: 'Import, name and template signals still cover those files; only the config-mapping edge was skipped.',
      files: config.skipped.map((s) => s.file),
    });
  }
  const unresolvedFiles = [...importGraph.unresolved.keys()].sort();
  if (unresolvedFiles.length > 0) {
    const count = [...importGraph.unresolved.values()].reduce((n, l) => n + l.length, 0);
    limitations.push({
      what: `${count} import${count === 1 ? '' : 's'} across ${unresolvedFiles.length} file${unresolvedFiles.length === 1 ? '' : 's'} could not be resolved to a file in this repository.`,
      mitigation: 'Those files are widened rather than trimmed, so an unresolved import can only ever add to the radius.',
      files: unresolvedFiles,
    });
  }
  if (changedOther.length > 0) {
    limitations.push({
      what: `${changedOther.length} changed file${changedOther.length === 1 ? '' : 's'} are not code Teslon reads (${changedOther.slice(0, 4).join(', ')}${changedOther.length > 4 ? ', …' : ''}).`,
      mitigation: 'They are kept in the radius as changed, and anything referencing them by name or path is kept with them.',
      files: changedOther,
    });
  }
  if (change.recoveredFrom) {
    limitations.push({
      what: `This change was recovered from an already-merged ${change.recoveredFrom.replace('-', ' ')}.`,
      mitigation: 'The recovered file list is what the merge actually contained, so it is exact — but a rebase merge can lose the original boundary, and that is not detectable from the tree alone.',
    });
  }

  // ---- 7. proofs, shortest per destination ---------------------------
  const symbolEdges = buildSymbolEdges(root, allFiles, aliases);
  const proofs: ProofPath[] = [];
  for (const file of changedCode.slice(0, 50)) {
    const reading = headReadings.get(file);
    for (const symbol of (reading?.exports ?? []).slice(0, 20)) {
      proofs.push(...shortestPathPerDestination(proofPaths(symbolEdges, file, symbol)));
    }
  }
  proofs.sort(
    (a, b) =>
      a.origin.file.localeCompare(b.origin.file) ||
      a.origin.symbol.localeCompare(b.origin.symbol) ||
      (a.steps.at(-1)?.file ?? '').localeCompare(b.steps.at(-1)?.file ?? ''),
  );

  // ---- 8. what to test first -----------------------------------------
  const priority = prioritise({ radius, surfaces, profiles, java: javaByFile, diffs, reachedBy, readings: headReadings, newFiles });

  // ---- 9. which existing tests already cover this --------------------
  // Read straight out of the same measured walk the gaps came from, so the
  // "you are covered" claim and the "you are not covered" claim can never
  // disagree with each other.
  const tierOf = new Map(priority.map((p) => [p.file, p.tier]));
  const changedSet = new Set(change.files);
  const tests: TestToRun[] = [];
  for (const test of testsInRadius) {
    const coversDirectly: string[] = [];
    const coversIndirectly: string[] = [];
    for (const [target, slot] of reachedBy) {
      if (!changedSet.has(target)) continue;
      if (slot.direct.has(test)) coversDirectly.push(target);
      else if (slot.indirect.has(test)) coversIndirectly.push(target);
    }
    if (coversDirectly.length === 0 && coversIndirectly.length === 0) continue;
    const highestTierCovered = [...coversDirectly, ...coversIndirectly].reduce<Tier>(
      (best, f) => (Math.min(best, tierOf.get(f) ?? 4) as Tier),
      4,
    );
    tests.push({
      file: test,
      coversDirectly: coversDirectly.sort(),
      coversIndirectly: coversIndirectly.sort(),
      highestTierCovered,
    });
  }
  tests.sort(
    (x, y) =>
      x.highestTierCovered - y.highestTierCovered ||
      y.coversDirectly.length - x.coversDirectly.length ||
      x.file.localeCompare(y.file),
  );

  // ---- 10. how much of this can be trusted ---------------------------
  const unreadable: string[] = [];
  for (const f of allFiles) {
    if (CODE_RE.test(f) || TEXT_RE.test(f) || IRRELEVANT.test(f)) continue;
    if (f.endsWith('.java')) continue; // read by the Java front end
    unreadable.push(f);
  }
  for (const f of [...changedCode, ...changedJava]) {
    if (!headReadings.get(f)) unreadable.push(f);
  }
  const completeness = assessCompleteness({
    allEdges,
    contextual: opts.baseReadings
      ? {}
      : {
          // Saying "ran and found nothing" about a mechanism that never ran is
          // the exact overstatement this whole block exists to prevent.
          contract:
            'the files were not read at the merge base, so no contract change could be detected even if there was one',
        },
    seeds: change.files,
    radiusSize: dist.size,
    allFiles,
    unreadable: [...new Set(unreadable)],
    limitations,
  });

  // ---- 11. the brief -------------------------------------------------
  const brief = buildBrief({ change, radius, priority, tests, surfaces, gaps: mergedGaps, limitations, completeness, diffs, profiles });

  return {
    result: {
      schemaVersion: SCHEMA_VERSION,
      repo: opts.repo ?? root,
      change,
      radius,
      priority,
      tests,
      surfaces,
      profiles: [...profiles].sort(byPath),
      gaps: mergedGaps,
      limitations,
      completeness,
      brief,
    },
    diffs: [...diffs].sort(byPath),
    proofs,
  };
}

/**
 * The five or six lines someone reads before they start testing.
 *
 * Written as prose on purpose. A QA engineer under release pressure does not
 * read a graph; they read a paragraph, and then they open the two things it
 * told them to open. Every sentence here is derived from a counted fact, so
 * the brief can never say something the detail views contradict.
 */
function buildBrief(a: {
  change: ChangeSet;
  radius: readonly RadiusItem[];
  priority: readonly PriorityItem[];
  tests: readonly TestToRun[];
  surfaces: readonly Surface[];
  gaps: readonly { file: string; reason: string }[];
  limitations: readonly Limitation[];
  completeness: Completeness;
  diffs: readonly SemanticDiff[];
  profiles: readonly CapabilityProfile[];
}): string[] {
  const lines: string[] = [];
  let untestedSurfaces = 0;
  const counts = new Map<Band, number>();
  for (const r of a.radius) counts.set(r.band, (counts.get(r.band) ?? 0) + 1);
  const n = (b: Band): number => counts.get(b) ?? 0;
  const downstream = a.radius.length - a.change.files.length;

  lines.push(
    `${a.change.files.length} file${a.change.files.length === 1 ? '' : 's'} changed. ${downstream} more ${downstream === 1 ? 'is' : 'are'} downstream of them, so the blast radius is ${a.radius.length} file${a.radius.length === 1 ? '' : 's'} in total.`,
  );

  const tiers = [1, 2, 3, 4].map((t) => a.priority.filter((p) => p.tier === t).length);
  lines.push(
    `Testing order: ${tiers[0]} file${tiers[0] === 1 ? '' : 's'} first, ${tiers[1]} next, ${tiers[2]} on a smoke pass, ${tiers[3]} to keep an eye on. Tier 4 means Teslon could not rule ${tiers[3] === 1 ? 'it' : 'them'} out — it does not mean unaffected.`,
  );
  const top = a.priority.filter((p) => p.tier === 1).slice(0, 3);
  if (top.length > 0) {
    lines.push(
      `Start with ${top.map((p) => `${p.file} (${p.because[0]!.detail}${p.because.length > 1 ? `, ${p.because.filter((f) => f.points > 0).slice(1, 3).map((f) => f.factor).join(', ')}` : ''})`).join('; ')}.`,
    );
  }

  const breaking = a.diffs.flatMap((d) => d.changes.filter((c) => c.severity === 'breaking').map((c) => ({ file: d.file, c })));
  if (breaking.length > 0) {
    lines.push(
      `${breaking.length} change${breaking.length === 1 ? ' is' : 's are'} breaking. The first is in ${breaking[0]!.file}: ${breaking[0]!.c.what}.${breaking[0]!.c.test ? ` Test ${breaking[0]!.c.test}.` : ''}`,
    );
  } else if (a.diffs.length > 0) {
    lines.push('Nothing in this change removes or tightens an existing contract, so no caller should start failing on its own.');
  }

  const newSurfaces = a.surfaces.filter((s) => s.isNew);
  const untested = a.surfaces.filter((s) => s.directTests.length === 0 && s.indirectTests.length === 0);
  untestedSurfaces = untested.length;
  if (a.surfaces.length > 0) {
    lines.push(
      `${a.surfaces.length} thing${a.surfaces.length === 1 ? '' : 's'} a person can open ${a.surfaces.length === 1 ? 'is' : 'are'} affected${newSurfaces.length > 0 ? `, ${newSurfaces.length} of them new` : ''}: ${a.surfaces.slice(0, 4).map((s) => `${s.kind} ${s.id}`).join(', ')}${a.surfaces.length > 4 ? `, and ${a.surfaces.length - 4} more` : ''}.`,
    );
    if (untested.length > 0) {
      lines.push(
        `${untested.length} of those ${untested.length === 1 ? 'has' : 'have'} no test reaching ${untested.length === 1 ? 'it' : 'them'} at all — start there: ${untested.slice(0, 3).map((s) => s.id).join(', ')}.`,
      );
    }
  }

  if (a.tests.length > 0) {
    const direct = a.tests.filter((t) => t.coversDirectly.length > 0).length;
    const how =
      direct === a.tests.length
        ? a.tests.length === 1
          ? ', directly'
          : ', all of them directly'
        : direct === 0
          ? ', all of them only as a side effect of testing something else'
          : `, ${direct} of them directly and the rest only as a side effect`;
    lines.push(
      `${a.tests.length} existing test${a.tests.length === 1 ? '' : 's'} already reach${a.tests.length === 1 ? 'es' : ''} a changed file${how}: ${a.tests.slice(0, 3).map((t) => t.file).join(', ')}${a.tests.length > 3 ? `, and ${a.tests.length - 3} more` : ''}.`,
    );
  } else if (a.change.files.length > 0) {
    lines.push('No existing test in this repository reaches any changed file, directly or indirectly.');
  }

  const mutating = a.profiles.filter((p) => p.nature !== 'read-only');
  if (mutating.length > 0) {
    const cases = mutating.reduce((sum, p) => sum + minimumCases(p), 0);
    lines.push(
      `${mutating.length} changed file${mutating.length === 1 ? '' : 's'} write${mutating.length === 1 ? 's' : ''} state or could not be proven read-only; between them they need at least ${cases} case${cases === 1 ? '' : 's'} to cover their inputs and error paths.`,
    );
  }

  if (a.gaps.length > 0) {
    lines.push(
      `${a.gaps.length} coverage gap${a.gaps.length === 1 ? '' : 's'}: ${a.gaps[0]!.file} — ${a.gaps[0]!.reason}.`,
    );
  } else if (a.change.files.length > 0) {
    // Scoped on purpose. Saying "everything is covered" while the surfaces
    // list says two endpoints have no test is two true sentences that read as
    // one contradiction, and a reader who spots it stops believing both.
    lines.push(
      untestedSurfaces === 0
        ? 'Every changed file has a test that reaches it directly, and every affected surface has one too.'
        : `Every changed file has a test that reaches it directly, but ${untestedSurfaces} affected surface${untestedSurfaces === 1 ? '' : 's'} downstream of them still ${untestedSurfaces === 1 ? 'has' : 'have'} none.`,
    );
  }

  if (n('unknown') > 0 || n('look') > 0) {
    lines.push(
      `${n('unknown') + n('look')} file${n('unknown') + n('look') === 1 ? ' is' : 's are'} in the radius because Teslon could not prove ${n('unknown') + n('look') === 1 ? 'it is' : 'they are'} unaffected, not because it proved they are. That is the safe direction, and it is why this list is wider than a minimal one.`,
    );
  }
  lines.push(a.completeness.verdict);

  return lines;
}
