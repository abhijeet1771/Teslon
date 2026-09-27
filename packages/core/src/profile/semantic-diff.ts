import type { AstReading, AstBranch, AstConstraint, BehaviourClaim } from './ast.js';

/**
 * What changed about a file's behaviour, not about its text.
 *
 * This is how the reading engine earns its place in an impact analyser. The
 * graph answers "who is downstream of this file". A text diff answers "which
 * lines moved". Neither answers the question a reviewer actually asks, which
 * is *what is different now* — and that is the thing that decides what has to
 * be re-tested.
 *
 * Reading the same file at the merge base and at the head, then comparing the
 * two readings, turns a diff into a list of consequences:
 *
 *   a new branch            a case nobody has ever run
 *   a tightened constraint  input that used to be accepted is now rejected
 *   a removed prop          every caller that passed it is broken
 *   a deleted test          a behaviour that was guarded yesterday is not
 */

export type ChangeSeverity = 'breaking' | 'behaviour' | 'surface' | 'coverage';

export interface SemanticChange {
  readonly severity: ChangeSeverity;
  readonly what: string;
  /** What a tester has to do about it. Empty when nothing is required. */
  readonly test?: string;
  readonly detail?: string;
}

export interface SemanticDiff {
  readonly file: string;
  readonly shapeBefore: AstReading['shape'] | null;
  readonly shapeAfter: AstReading['shape'] | null;
  readonly changes: readonly SemanticChange[];
}

const byCondition = (b: AstBranch): string => b.condition;
const byField = (c: AstConstraint): string => c.field;
const claimKey = (c: BehaviourClaim): string => [...c.context, c.name].join(' › ');

function added<T>(before: readonly T[], after: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set(before.map(key));
  return after.filter((t) => !seen.has(key(t)));
}

function removed<T>(before: readonly T[], after: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set(after.map(key));
  return before.filter((t) => !seen.has(key(t)));
}

/** A numeric argument inside a rule like `min(3)`. */
function ruleValue(rules: readonly string[], name: string): number | null {
  for (const r of rules) {
    const m = new RegExp(`^${name}\\((-?\\d+(?:\\.\\d+)?)\\)$`).exec(r);
    if (m) return Number(m[1]);
  }
  return null;
}

function constraintChanges(before: AstConstraint, after: AstConstraint): SemanticChange[] {
  const out: SemanticChange[] = [];

  // A tightened bound rejects input that used to be accepted, which is the
  // definition of a breaking change for anyone already sending it.
  for (const [rule, tightens] of [
    ['min', (b: number, a: number) => a > b],
    ['minLength', (b: number, a: number) => a > b],
    ['max', (b: number, a: number) => a < b],
    ['maxLength', (b: number, a: number) => a < b],
  ] as const) {
    const b = ruleValue(before.rules, rule);
    const a = ruleValue(after.rules, rule);
    if (b === null || a === null || a === b) continue;
    out.push({
      severity: tightens(b, a) ? 'breaking' : 'behaviour',
      what: `${after.field}.${rule} moved from ${b} to ${a}`,
      test: tightens(b, a)
        ? `values that were valid and are not any more: try ${Math.min(b, a)} and ${Math.max(b, a)}`
        : `the newly allowed range: try ${Math.min(b, a)} and ${Math.max(b, a)}`,
      ...(tightens(b, a)
        ? { detail: 'Callers already sending the old value will start failing validation.' }
        : {}),
    });
  }

  const newRules = added(before.rules, after.rules, (r) => r);
  const goneRules = removed(before.rules, after.rules, (r) => r);
  for (const r of newRules) {
    if (/^(min|max|minLength|maxLength)\(/.test(r) && out.some((c) => c.what.includes(after.field))) continue;
    out.push({
      severity: 'breaking',
      what: `${after.field} gained the rule ${r}`,
      test: `input that does not satisfy ${r}`,
    });
  }
  for (const r of goneRules) {
    if (/^(min|max|minLength|maxLength)\(/.test(r) && out.some((c) => c.what.includes(after.field))) continue;
    out.push({
      severity: 'behaviour',
      what: `${after.field} lost the rule ${r}`,
      test: `input that ${r} used to reject — it is accepted now`,
    });
  }

  return out;
}

export function semanticDiff(before: AstReading | null, after: AstReading | null): SemanticDiff {
  const file = after?.file ?? before?.file ?? '(unknown)';
  const changes: SemanticChange[] = [];

  if (!before && after) {
    changes.push({
      severity: 'surface',
      what: `new file, read as a ${after.shape}`,
      test: 'nothing here has ever been exercised',
    });
  }
  if (before && !after) {
    return {
      file,
      shapeBefore: before.shape,
      shapeAfter: null,
      changes: [
        {
          severity: 'breaking',
          what: `file removed (was a ${before.shape})`,
          test: 'anything that imported it',
        },
      ],
    };
  }
  if (!before || !after) {
    return { file, shapeBefore: before?.shape ?? null, shapeAfter: after?.shape ?? null, changes };
  }

  if (before.shape !== after.shape) {
    changes.push({
      severity: 'behaviour',
      what: `this file changed kind: ${before.shape} → ${after.shape}`,
    });
  }

  // ---- exports: the contract with everything downstream --------------
  for (const e of removed(before.exports, after.exports, (x) => x)) {
    changes.push({
      severity: 'breaking',
      what: `export removed: ${e}`,
      test: 'every file that imported it',
    });
  }
  for (const e of added(before.exports, after.exports, (x) => x)) {
    changes.push({ severity: 'surface', what: `new export: ${e}`, test: `${e} has no caller yet` });
  }

  // ---- branches: each one is a path through the code -----------------
  for (const b of added(before.branches, after.branches, byCondition)) {
    changes.push({
      severity: 'behaviour',
      what: `new branch at line ${b.line}: ${b.condition}`,
      test:
        b.literals.length > 0
          ? `both sides, using ${b.literals.join(', ')}`
          : 'both sides of the new condition',
    });
  }
  for (const b of removed(before.branches, after.branches, byCondition)) {
    changes.push({
      severity: 'behaviour',
      what: `branch removed: ${b.condition}`,
      test: 'input that used to take that path',
    });
  }

  // ---- constraints ----------------------------------------------------
  const beforeByField = new Map(before.constraints.map((c) => [c.field, c]));
  for (const after_ of after.constraints) {
    const before_ = beforeByField.get(after_.field);
    if (before_) changes.push(...constraintChanges(before_, after_));
  }
  for (const c of added(before.constraints, after.constraints, byField)) {
    changes.push({
      severity: 'breaking',
      what: `${c.field} is now validated: ${c.rules.join(' ')}`,
      test: c.boundaries.length ? `its limits: ${c.boundaries.join(', ')}` : 'invalid input',
    });
  }
  for (const c of removed(before.constraints, after.constraints, byField)) {
    changes.push({
      severity: 'behaviour',
      what: `${c.field} is no longer validated`,
      test: 'input that used to be rejected',
    });
  }

  // ---- component surface ---------------------------------------------
  for (const p of removed(before.props, after.props, (x) => x)) {
    changes.push({ severity: 'breaking', what: `prop removed: ${p}`, test: 'every place that passed it' });
  }
  for (const p of added(before.props, after.props, (x) => x)) {
    changes.push({ severity: 'surface', what: `new prop: ${p}`, test: 'with and without it' });
  }
  for (const r of added(before.conditionalRenders, after.conditionalRenders, (x) => x)) {
    changes.push({
      severity: 'behaviour',
      what: `a new state renders <${r}>`,
      test: `reach the state where <${r}> is shown`,
    });
  }
  for (const e of added(before.events, after.events, (x) => x)) {
    changes.push({ severity: 'surface', what: `new event: ${e}`, test: `the ${e} path` });
  }

  // ---- services and stores --------------------------------------------
  for (const m of removed(before.methods, after.methods, (x) => x)) {
    changes.push({ severity: 'breaking', what: `method removed: ${m}()`, test: 'every caller' });
  }
  for (const m of added(before.methods, after.methods, (x) => x)) {
    changes.push({ severity: 'surface', what: `new method: ${m}()`, test: `${m}() directly` });
  }
  for (const d of added(before.injected, after.injected, (x) => x)) {
    changes.push({
      severity: 'behaviour',
      what: `now depends on ${d}`,
      test: `whatever ${d} does is now part of this path`,
    });
  }
  for (const a of added(before.actions, after.actions, (x) => x)) {
    changes.push({ severity: 'surface', what: `new action: ${a}`, test: a });
  }
  for (const a of removed(before.actions, after.actions, (x) => x)) {
    changes.push({ severity: 'breaking', what: `action removed: ${a}`, test: 'every dispatcher of it' });
  }

  // ---- types -----------------------------------------------------------
  const beforeTypes = new Map(before.types.map((t) => [t.name, t.fields]));
  for (const t of after.types) {
    const fieldsBefore = beforeTypes.get(t.name);
    if (!fieldsBefore) continue;
    for (const f of removed(fieldsBefore, t.fields, (x) => x)) {
      changes.push({
        severity: 'breaking',
        what: `${t.name} lost the field ${f}`,
        test: 'consumers reading that field',
      });
    }
  }

  // ---- coverage: a deleted test is a guarantee that quietly left -------
  for (const c of removed(before.claims, after.claims, claimKey)) {
    changes.push({
      severity: 'coverage',
      what: `a test was removed: "${claimKey(c)}"`,
      test: 'that behaviour is no longer guarded — confirm it is still true',
    });
  }
  for (const c of added(before.claims, after.claims, claimKey)) {
    changes.push({ severity: 'coverage', what: `new test: "${claimKey(c)}"` });
  }

  return { file, shapeBefore: before.shape, shapeAfter: after.shape, changes };
}

const SEVERITY_ORDER: Record<ChangeSeverity, number> = {
  breaking: 0,
  behaviour: 1,
  coverage: 2,
  surface: 3,
};

/** Most consequential first, so the top of the list is the thing to read. */
export function sortChanges(changes: readonly SemanticChange[]): SemanticChange[] {
  return [...changes].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.what.localeCompare(b.what),
  );
}
