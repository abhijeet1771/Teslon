/**
 * What the engine says about a change. Surfaces first: a QA engineer reads
 * screens, fields and data, not files. Every claim carries its hops, and every
 * hop names a file, a line and the text expected on it, so the report can be
 * re-verified against git at any time.
 */

export type Tier = 'test-first' | 'test-next' | 'watch' | 'skip';

export interface Hop {
  /** What this step is, in plain words: "New rule", "The field". */
  readonly label: string;
  readonly file: string;
  readonly line: number;
  /** Text that must appear on that line for the hop to count as evidence. */
  readonly quote: string;
  /** The rule that makes this a step: "@Valid enforces every rule on the body". */
  readonly rule: string;
  /** Set by verification: does the line still say this at head? */
  verified?: boolean;
}

export type SurfaceKind = 'screen' | 'widget' | 'api' | 'data' | 'dashboard' | 'job' | 'test-plan';

export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly name: string;
  /** Route for a screen, path for an API, table for data, file otherwise. */
  readonly where: string;
  tier: Tier;
  /** For a skip: why it is safe, with its own evidence. */
  reason?: string;
  evidence?: Hop[];
}

export interface Case {
  readonly surface: string;
  readonly delta: string;
  readonly tier: Tier;
  /** Section and field on the screen, when known. */
  readonly section?: string;
  readonly field?: string;
  readonly do: string;
  readonly expect: string;
  readonly before: string;
  readonly after: string;
  /** The rule still lets something through that its name suggests it stops. */
  readonly hole?: boolean;
  /** derived = follows from named rules; it was not run. */
  readonly proof: 'derived';
  readonly hops: readonly Hop[];
}

export interface Delta {
  readonly id: string;
  readonly kind: 'request-rules-enforced' | 'request-rules-relaxed';
  readonly title: string;
  readonly endpoint: string;
  readonly rules: readonly { readonly field: string; readonly json: string; readonly rule: string; readonly name: string; readonly file: string; readonly line: number }[];
  readonly causes: readonly Hop[];
}

export interface Unseen { readonly what: string; readonly why: string; readonly resolve: string }

export interface LedgerEntry {
  readonly file: string;
  readonly status: 'explained' | 'test-only' | 'not-modelled' | 'no-runtime-effect' | 'deleted';
  readonly by: readonly string[];
  /** For not-modelled: the changed lines no rule accounted for. */
  readonly lines: readonly number[];
}

export interface ImpactReport {
  readonly schema: 'teslon.impact/1';
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly deltas: readonly Delta[];
  readonly surfaces: readonly Surface[];
  readonly cases: readonly Case[];
  readonly unseen: readonly Unseen[];
  readonly ledger: readonly LedgerEntry[];
  readonly verification: { readonly hops: number; readonly failed: readonly Hop[] };
  /** Channels seen in the repo that no rule in this build covers. */
  readonly notModelled: readonly string[];
  readonly ms: number;
}
