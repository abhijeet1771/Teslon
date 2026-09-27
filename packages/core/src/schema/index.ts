/**
 * The result object is the product. The local app, the CI check, the JSON
 * export and the gate are all renderings of this shape. Anything a screen
 * shows must exist here first.
 */

export const SCHEMA_VERSION = '1.4.0';

/**
 * How sure we are that an item is affected.
 *
 * The order matters: `widen()` may only ever move an item toward `certain`,
 * and nothing may be dropped from a run below `certain`. See invariants I1/I2.
 */
export const BANDS = ['certain', 'likely', 'possible', 'look', 'unknown'] as const;
export type Band = (typeof BANDS)[number];

/** Signals that can put an item in the radius. One edge, one reason. */
export type SignalId =
  | 'changed' // the file is in the diff itself. Not an inference — the seed.
  | 'import' // S1  reverse import graph
  | 'route' // S2  url -> page -> spec
  | 'coverage' // S3  a test really executed this line
  | 'contract' // S4  api/schema/type break
  | 'cochange' // S5  git history says these move together
  | 'incident' // S6  this area has escaped before
  | 'name' // L2  shared rare name (di key, event topic, css class, column, i18n key)
  | 'widen' // L6/L7 unresolvable target, widened on purpose
  | 'template' // L3
  | 'config' // L4
  | 'generated' // L5
  | 'clone' // L8
  | 'runtime-string' // L9
  | 'data-coupling' // writes a table someone else reads
  | 'lockfile'; // dependency changed with no source diff

/** Why an edge exists. Never empty — invariant I4. */
export interface Provenance {
  readonly signal: SignalId;
  /** Human-readable, specific: `shared name "order.paid"`, `imports ../utils/money`. */
  readonly detail: string;
  /** The file the edge came from, when there is one. */
  readonly via?: string;
}

export interface RadiusItem {
  /** Repo-relative path. */
  readonly file: string;
  readonly band: Band;
  /** Shortest number of hops from a changed file. 0 means it was changed. */
  readonly hops: number;
  /** Every reason this file is here, in the order they were found. */
  readonly why: readonly Provenance[];
}

/** A thing a person can open: a screen, an endpoint, a job, an email. */
export interface Surface {
  readonly kind: 'screen' | 'endpoint' | 'job' | 'email' | 'event' | 'column';
  /** `/checkout`, `POST /api/subscriptions`, `orders.subscription_id`. */
  readonly id: string;
  /** The file that implements it, when known. */
  readonly file?: string;
  readonly isNew: boolean;
  /** Tests that reach it directly (an api test importing the handler). */
  readonly directTests: readonly string[];
  /** Tests that reach it only as a side effect of exercising something else. */
  readonly indirectTests: readonly string[];
}

/** What a piece of code does, extracted rather than guessed. */
export interface CapabilityProfile {
  readonly file: string;
  readonly symbol?: string;
  readonly http?: { readonly method: string; readonly path: string };
  readonly input?: { readonly type: string; readonly fields: readonly string[] };
  readonly output?: { readonly type: string; readonly fields: readonly string[] };
  readonly readsTables: readonly string[];
  readonly writesTables: readonly string[];
  readonly callsOut: readonly string[];
  readonly sideEffects: readonly string[];
  readonly auth?: string;
  readonly flags: readonly string[];
  readonly errorPaths: readonly string[];
  /**
   * `mutating` when it writes or has side effects, `read-only` when it
   * provably does neither, `unknown` when we could not tell. `unknown` is
   * treated as `mutating` everywhere downstream — never assume innocence.
   */
  readonly nature: 'read-only' | 'mutating' | 'unknown';
}

/** Something the analysis could not do, and what that cost. */
export interface Limitation {
  readonly what: string;
  /** What we did instead. Always the safe direction. */
  readonly mitigation: string;
  readonly files?: readonly string[];
}

export interface ChangeSet {
  readonly baseSha: string;
  readonly headSha: string;
  /** The merge base. This, not the base branch tip, defines the change. */
  readonly mergeBase: string;
  readonly files: readonly string[];
  /** merge / squash / rebase, when the PR is already on the base branch. */
  readonly recoveredFrom?: 'merge-commit' | 'squash-commit' | 'commit-range';
}

/**
 * Testing priority, which is deliberately *not* the same thing as a band.
 *
 * A band says how sure we are that a file is affected. A tier says what to
 * open first. They come apart constantly: a `possible` change to an untested
 * payment endpoint has to be tested before a `certain` change to a comment in
 * a well-covered helper. Ranking work by confidence alone inverts the order
 * a lead actually needs.
 *
 * The labels never say "not impacted". Tier 4 means we could not rule it out,
 * and a reader who treats it as "safe to skip" has been told something false.
 */
export type Tier = 1 | 2 | 3 | 4;

export const TIER_LABEL: Record<Tier, string> = {
  1: 'Test first — directly impacted',
  2: 'Test next — moderately impacted',
  3: 'Smoke — lightly impacted',
  4: 'Eyes on — could not be ruled out',
};

export interface ScoreFactor {
  readonly factor: string;
  readonly points: number;
  /** Why this factor scored what it did. A number nobody can explain is a number nobody trusts. */
  readonly detail: string;
}

export interface PriorityItem {
  readonly file: string;
  /** Who to ask about this file, and whether that was declared or inferred. */
  readonly owners: readonly string[];
  readonly ownerSource: 'CODEOWNERS' | 'git-history' | 'none';
  readonly tier: Tier;
  readonly score: number;
  /** Every component of the score, named and summing to it exactly. */
  readonly because: readonly ScoreFactor[];
  readonly band: Band;
  /** Things a person can open that live in this file. */
  readonly surfaces: readonly string[];
}

/**
 * A test that is inside the radius, and what it covers of this change.
 *
 * Tests are in the radius because they are genuinely impacted, but they do not
 * belong in the priority list: a lead reading "Tier 4: checkout.spec.ts" is
 * being told to keep an eye on a spec file, which is not a thing anyone does.
 * A test is something you *run*, so it gets its own list, ordered by how much
 * of the change it covers.
 */
export interface TestToRun {
  readonly file: string;
  /** Changed files this test reaches directly, by import. */
  readonly coversDirectly: readonly string[];
  /** Changed files it reaches only through something else. */
  readonly coversIndirectly: readonly string[];
  /** Highest tier among the files it covers — run the highest first. */
  readonly highestTierCovered: Tier;
}

/**
 * The result's own account of how much it can be trusted.
 *
 * This exists because the dangerous failure of an impact analyser is not being
 * wrong — it is being confidently incomplete. A radius printed with no caveat
 * reads as "the impact is exactly this", and a lead who believes that ships
 * untested code. So the run states which signals ran, which are not wired up
 * at all, and what it could not read, and the verdict is written to be quoted.
 */
export interface Completeness {
  readonly signalsRun: readonly { readonly signal: SignalId; readonly edges: number; readonly filesAdded: number }[];
  /** Declared signals that contributed nothing in this run, and why. */
  readonly signalsAbsent: readonly { readonly signal: SignalId; readonly why: string }[];
  /** Files no signal could read. Each one is a hole of unknown size. */
  readonly unreadable: readonly string[];
  /** The sentence to read before trusting the radius. */
  readonly verdict: string;
}

export interface TeslonResult {
  readonly schemaVersion: string;
  readonly repo: string;
  readonly change: ChangeSet;
  readonly radius: readonly RadiusItem[];
  /** The radius again, ordered by what to test first. Production code only. */
  readonly priority: readonly PriorityItem[];
  /** Existing tests that touch this change, and what each one covers. */
  readonly tests: readonly TestToRun[];
  readonly surfaces: readonly Surface[];
  readonly profiles: readonly CapabilityProfile[];
  /** Changed lines no test executes. The highest-value output. */
  readonly gaps: readonly { readonly file: string; readonly reason: string }[];
  readonly limitations: readonly Limitation[];
  /** Who to go and talk to, worst tier first. */
  readonly ownership: readonly {
    readonly owner: string;
    readonly files: number;
    readonly topTier: number;
    readonly source: 'CODEOWNERS' | 'git-history' | 'none';
  }[];
  /** How much testing this implies, counted in cases and never in hours. */
  readonly effort: {
    readonly minimumCases: number;
    readonly lines: readonly { readonly reason: string; readonly cases: number; readonly examples: readonly string[] }[];
    readonly filesNeedingNewTests: number;
    readonly note: string;
  };
  readonly completeness: Completeness;
  /** Plain-language brief for whoever has to test this. */
  readonly brief: readonly string[];
}

/** Rank used when merging signals; higher wins. */
export function bandRank(b: Band): number {
  switch (b) {
    case 'certain':
      return 5;
    case 'unknown':
      // A thing we failed to analyse outranks everything we merely inferred.
      // It was tied with `possible` in the first draft, which made the result
      // depend on the order signals happened to merge in — a determinism bug
      // (I3) hiding inside a correctness one.
      return 4;
    case 'likely':
      return 3;
    case 'possible':
      return 2;
    case 'look':
      return 1;
  }
}

/** Invariant I1: merging two bands may only move toward certainty. */
export function strongerBand(a: Band, b: Band): Band {
  return bandRank(a) >= bandRank(b) ? a : b;
}
