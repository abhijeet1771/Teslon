/**
 * The result object is the product. The local app, the CI check, the JSON
 * export and the gate are all renderings of this shape. Anything a screen
 * shows must exist here first.
 */

export const SCHEMA_VERSION = '1.0.0';

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

export interface TeslonResult {
  readonly schemaVersion: string;
  readonly repo: string;
  readonly change: ChangeSet;
  readonly radius: readonly RadiusItem[];
  readonly surfaces: readonly Surface[];
  readonly profiles: readonly CapabilityProfile[];
  /** Changed lines no test executes. The highest-value output. */
  readonly gaps: readonly { readonly file: string; readonly reason: string }[];
  readonly limitations: readonly Limitation[];
  /** Plain-language brief for whoever has to test this. */
  readonly brief: readonly string[];
}

/** Rank used when merging signals; higher wins. */
export function bandRank(b: Band): number {
  switch (b) {
    case 'certain':
      return 4;
    case 'likely':
      return 3;
    case 'possible':
      return 2;
    case 'look':
      return 1;
    case 'unknown':
      // Deliberately above `look`: an unknown is a thing we failed to analyse,
      // which is more alarming than a history hint, not less.
      return 2;
  }
}

/** Invariant I1: merging two bands may only move toward certainty. */
export function strongerBand(a: Band, b: Band): Band {
  return bandRank(a) >= bandRank(b) ? a : b;
}
