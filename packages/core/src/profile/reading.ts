import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reading code the way an experienced engineer reads it.
 *
 * The capability profile answers "what does this endpoint touch". That covers
 * handlers and nothing else — a React component, a pricing rule and a
 * validation schema all came back as `unknown`, which is honest but useless.
 *
 * What a senior reviewer actually extracts in the first ten seconds:
 *
 *   a component  → its props, its state, what it renders conditionally,
 *                  which events it raises
 *   a rule       → the branches, and the literal values that select them,
 *                  because those literals are the test cases
 *   a schema     → the constraints, because `min(3)` means somebody has to
 *                  try 2 and 3
 *
 * All of it is declared in the source. None of it needs a model. What it does
 * need is honesty about coverage: anything not recognised stays absent rather
 * than being invented.
 */

export type CodeKind = 'endpoint' | 'component' | 'rule' | 'schema' | 'config' | 'unknown';

/** A branch, and the literal values that decide it. */
export interface Branch {
  readonly condition: string;
  /** Literals in the condition. These are the values a tester has to hit. */
  readonly literals: readonly string[];
  readonly line: number;
}

/** A declared constraint on a field, and the values that sit on its edges. */
export interface FieldConstraint {
  readonly field: string;
  readonly rules: readonly string[];
  /**
   * Values worth trying, derived from the constraint itself: a minimum of 3
   * makes 2 and 3 interesting, and nothing else about that field is.
   */
  readonly boundaries: readonly string[];
}

export interface UiShape {
  readonly props: readonly string[];
  readonly state: readonly string[];
  readonly effects: number;
  readonly events: readonly string[];
  readonly renders: readonly string[];
  /** Renders that only happen in some states — each one is a case to see. */
  readonly conditionalRenders: readonly string[];
}

export interface CodeReading {
  readonly file: string;
  readonly kind: CodeKind;
  readonly branches: readonly Branch[];
  readonly constraints: readonly FieldConstraint[];
  readonly ui?: UiShape;
  /** What a tester is obliged to cover, in plain words. */
  readonly cases: readonly string[];
  /** Said out loud rather than left as a silent gap. */
  readonly notRead: readonly string[];
}

const LITERAL_RE = /'[^']*'|"[^"]*"|`[^`]*`|\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b|\bnull\b/g;

function readBranches(src: string): Branch[] {
  const out: Branch[] = [];
  const lines = src.split('\n');

  lines.forEach((text, i) => {
    const conditions: string[] = [];

    const ifMatch = /(?:^|\s)(?:if|else if)\s*\(([^)]{1,200})\)/.exec(text);
    if (ifMatch) conditions.push(ifMatch[1]!.trim());

    // A ternary is a branch too, and in UI code it is usually *the* branch.
    // The condition has to be cut out of whatever surrounds it — inside JSX
    // that is an open brace, otherwise a return or an assignment — or the
    // reported condition carries half a tag with it.
    const ternary = /([^?\n]{3,160})\?\s*[^:]{1,120}:/.exec(text);
    if (ternary && !ifMatch && !/\?\./.test(ternary[1]!)) {
      const cond = ternary[1]!
        .replace(/^.*[{(]\s*/, '')
        .replace(/^.*?(?:return|=>|=|&&|\|\|)\s*/, '')
        .trim();
      if (cond.length > 2 && !cond.includes('<')) conditions.push(cond);
    }

    const switchCase = /^\s*case\s+(.+?):/.exec(text);
    if (switchCase) conditions.push(`case ${switchCase[1]!.trim()}`);

    for (const condition of conditions) {
      const literals = [...new Set(condition.match(LITERAL_RE) ?? [])];
      out.push({ condition, literals, line: i + 1 });
    }
  });

  return out;
}

/**
 * Boundary values for a constraint. A minimum of 3 makes 2 and 3 worth
 * trying; 7 is not more interesting than 5.
 */
function boundariesFor(rule: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  const n = Number(value);
  if (!Number.isFinite(n)) return [];
  switch (rule) {
    case 'min':
    case 'minLength':
    case 'gte':
      return [String(n - 1), String(n)];
    case 'max':
    case 'maxLength':
    case 'lte':
      return [String(n), String(n + 1)];
    case 'length':
      return [String(n - 1), String(n), String(n + 1)];
    case 'gt':
      return [String(n), String(n + 1)];
    case 'lt':
      return [String(n - 1), String(n)];
    default:
      return [];
  }
}

/** zod, yup, joi and class-validator all spell constraints as chained calls. */
function readConstraints(src: string): FieldConstraint[] {
  const out: FieldConstraint[] = [];

  for (const m of src.matchAll(/(\w+)\s*:\s*((?:z|yup|Joi)\.[\w.]+\([^)]*\)(?:\.\w+\([^)]*\))*)/g)) {
    const field = m[1]!;
    const chain = m[2]!;
    const rules: string[] = [];
    const boundaries = new Set<string>();

    for (const call of chain.matchAll(/\.(\w+)\(([^)]*)\)/g)) {
      const name = call[1]!;
      const arg = call[2]!.trim();
      rules.push(arg ? `${name}(${arg})` : name);
      for (const b of boundariesFor(name, arg || undefined)) boundaries.add(b);
    }

    const base = /^(?:z|yup|Joi)\.(\w+)/.exec(chain)?.[1];
    // `z.string().min(3)` already yielded `string` from the first call; adding
    // the base again printed "string string".
    if (base && rules[0] !== base && !rules[0]?.startsWith(`${base}(`)) rules.unshift(base);
    if (rules.length > 0) out.push({ field, rules, boundaries: [...boundaries] });
  }

  return out;
}

function readUi(src: string): UiShape | undefined {
  const isComponent =
    /from\s*['"]react['"]/.test(src) ||
    /<[A-Z]\w*[\s/>]/.test(src) ||
    /\buse(?:State|Effect|Memo|Callback|Reducer)\s*\(/.test(src);
  if (!isComponent) return undefined;

  const props = new Set<string>();
  // Destructured props in the component signature.
  const sig = /function\s+\w+\s*\(\s*\{([^}]*)\}|=\s*\(\s*\{([^}]*)\}\s*(?::|\))/.exec(src);
  const clause = sig?.[1] ?? sig?.[2];
  if (clause) {
    for (const raw of clause.split(',')) {
      const name = raw.trim().split(/[:=]/)[0]?.trim();
      if (name && /^\w+$/.test(name)) props.add(name);
    }
  }

  const state = [...src.matchAll(/const\s*\[\s*(\w+)\s*,\s*set\w+\s*\]\s*=\s*use(?:State|Reducer)/g)].map(
    (m) => m[1]!,
  );
  const effects = [...src.matchAll(/\buseEffect\s*\(/g)].length;
  const events = [...new Set([...src.matchAll(/\bon([A-Z]\w+)\s*[=:]/g)].map((m) => `on${m[1]!}`))];
  const renders = [...new Set([...src.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]!))];

  // A component that returns early renders something the happy path never shows.
  const conditionalRenders = [
    ...new Set(
      [...src.matchAll(/if\s*\([^)]*\)\s*return\s*<(\w+)/g)].map((m) => m[1]!)
        .concat([...src.matchAll(/\?\s*<(\w+)/g)].map((m) => m[1]!))
        // The else branch of a ternary renders something too, and it is just
        // as much a state somebody has to see.
        .concat([...src.matchAll(/:\s*<(\w+)/g)].map((m) => m[1]!))
        .concat([...src.matchAll(/&&\s*<(\w+)/g)].map((m) => m[1]!)),
    ),
  ];

  return { props: [...props], state, effects, events, renders, conditionalRenders };
}

function classify(src: string, ui: UiShape | undefined, constraints: readonly FieldConstraint[]): CodeKind {
  if (/@(?:Get|Post|Put|Delete|Patch)\(|\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(/i.test(src))
    return 'endpoint';
  if (ui) return 'component';
  if (constraints.length > 0) return 'schema';
  if (/\bfunction\s+\w+|\bconst\s+\w+\s*=\s*\(/.test(src) && /\bif\s*\(|\?\s*[^.]/.test(src)) return 'rule';
  if (/^\s*(?:export\s+)?(?:const|default)\s+\w+\s*=\s*\{/m.test(src)) return 'config';
  return 'unknown';
}

/** Plain-language cases a tester is obliged to cover. */
function buildCases(kind: CodeKind, branches: readonly Branch[], constraints: readonly FieldConstraint[], ui: UiShape | undefined): string[] {
  const cases: string[] = [];

  for (const b of branches.slice(0, 12)) {
    const withValues = b.literals.length > 0 ? ` (try ${b.literals.join(', ')})` : '';
    cases.push(`both sides of: ${b.condition}${withValues}`);
  }

  for (const c of constraints) {
    if (c.boundaries.length > 0) {
      cases.push(`${c.field} at its limits: ${c.boundaries.join(', ')}`);
    }
  }

  if (ui) {
    for (const r of ui.conditionalRenders) cases.push(`the state where <${r}> is shown instead`);
    for (const e of ui.events) cases.push(`the ${e} path`);
    if (ui.state.length > 0) cases.push(`state transitions for: ${ui.state.join(', ')}`);
  }

  if (kind === 'endpoint' && cases.length === 0) cases.push('the happy path');
  return cases;
}

/** What we knowingly did not read, so a gap is never silent. */
function notRead(kind: CodeKind, src: string): string[] {
  const gaps: string[] = [];
  if (/\beval\s*\(|new Function\s*\(/.test(src)) gaps.push('code built and evaluated at runtime');
  if (/\bany\b/.test(src) && kind !== 'unknown') gaps.push('values typed as any, whose shape is not declared');
  if (kind === 'unknown') gaps.push('the kind of this file was not recognised, so nothing was assumed about it');
  return gaps;
}

export function readCode(root: string, file: string): CodeReading | null {
  let src: string;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }

  const ui = readUi(src);
  const constraints = readConstraints(src);
  const branches = readBranches(src);
  const kind = classify(src, ui, constraints);

  return {
    file,
    kind,
    branches,
    constraints,
    ...(ui ? { ui } : {}),
    cases: buildCases(kind, branches, constraints, ui),
    notRead: notRead(kind, src),
  };
}
