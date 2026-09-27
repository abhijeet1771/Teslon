import type { AstReading } from '../profile/ast.js';
import type { SemanticDiff } from '../profile/semantic-diff.js';
import { minimumCases } from '../profile/capability.js';
import type { CapabilityProfile, Surface } from '../schema/index.js';

/**
 * How much testing this change implies.
 *
 * Reported in **cases**, never in hours, and that is a deliberate refusal
 * rather than a missing feature. Converting a case count to a duration needs
 * the team's own velocity, the tester's familiarity with the area, and how much
 * of the setup already exists — none of which is in the repository. A tool that
 * prints "about 3.5 hours" has invented two of those three, and the number will
 * be quoted at someone in a planning meeting.
 *
 * A case count is different: every case here is derived from something counted
 * in the code, and each one is a thing a person can tick off. A manager
 * multiplies by their own average and owns the arithmetic, which is the part
 * they are actually qualified to do.
 */

export interface EffortLine {
  readonly reason: string;
  readonly cases: number;
  /** The specific things this line counted, so the number can be checked. */
  readonly examples: readonly string[];
}

export interface Effort {
  readonly minimumCases: number;
  readonly lines: readonly EffortLine[];
  /** Files with no test at all: the setup cost nobody budgets for. */
  readonly filesNeedingNewTests: number;
  readonly note: string;
}

export function estimateEffort(a: {
  readonly profiles: readonly CapabilityProfile[];
  readonly diffs: readonly SemanticDiff[];
  readonly readings: ReadonlyMap<string, AstReading | null>;
  readonly surfaces: readonly Surface[];
  readonly untestedFiles: readonly string[];
}): Effort {
  const lines: EffortLine[] = [];
  const add = (reason: string, cases: number, examples: readonly string[]): void => {
    if (cases > 0) lines.push({ reason, cases, examples: [...examples].slice(0, 4) });
  };

  // 1. Inputs and error paths of the code that changed. `minimumCases` already
  //    counts these from the profile, so this is a roll-up, not a new guess.
  const perFile = a.profiles.map((p) => ({ file: p.file, cases: minimumCases(p) }));
  add(
    'inputs and error paths of the changed code',
    perFile.reduce((n, p) => n + p.cases, 0),
    perFile.filter((p) => p.cases > 0).map((p) => `${p.file} (${p.cases})`),
  );

  // 2. Every new branch is two cases: the side that is taken and the side that
  //    is not. A branch tested one way round is a branch half tested.
  const newBranches = a.diffs.flatMap((d) =>
    d.changes.filter((c) => c.severity === 'behaviour' && c.what.startsWith('new branch')).map((c) => c.what),
  );
  add('new branches, both sides of each', newBranches.length * 2, newBranches);

  // 3. Boundaries are enumerated, not estimated: a `min(3)` names exactly 2
  //    and 3 as the values that decide it.
  const boundaries: string[] = [];
  for (const reading of a.readings.values()) {
    for (const c of reading?.constraints ?? []) {
      for (const b of c.boundaries) boundaries.push(`${c.field} = ${b}`);
    }
  }
  add('boundary values named by the validation rules', boundaries.length, boundaries);

  // 4. A tightened rule breaks callers already sending the old value, so the
  //    old value is its own case.
  const breaking = a.diffs.flatMap((d) => d.changes.filter((c) => c.severity === 'breaking').map((c) => c.what));
  add('breaking changes, one case each to confirm the break', breaking.length, breaking);

  // 5. A new prop or a newly reachable render is a state somebody has to get
  //    the UI into.
  const states = a.diffs.flatMap((d) =>
    d.changes
      .filter((c) => /^new prop|^a new state renders/.test(c.what))
      .map((c) => `${d.file}: ${c.what}`),
  );
  add('new component states to reach', states.length, states);

  // 6. A surface nothing reaches needs at least one case before it is covered
  //    at all, whatever else this change did.
  const bare = a.surfaces.filter((s) => s.directTests.length === 0 && s.indirectTests.length === 0);
  add('affected surfaces with no test at all', bare.length, bare.map((s) => `${s.kind} ${s.id}`));

  const minimumCasesTotal = lines.reduce((n, l) => n + l.cases, 0);

  return {
    minimumCases: minimumCasesTotal,
    lines,
    filesNeedingNewTests: a.untestedFiles.length,
    note:
      a.untestedFiles.length > 0
        ? `${minimumCasesTotal} cases is the floor, and ${a.untestedFiles.length} file${a.untestedFiles.length === 1 ? ' has' : 's have'} no test to add them to — the setup for those is not in this number. Multiply by your own average per case; Teslon will not turn this into hours, because velocity and familiarity are not in the repository.`
        : `${minimumCasesTotal} cases is the floor, derived from counted branches, boundaries and surfaces. Multiply by your own average per case; Teslon will not turn this into hours, because velocity and familiarity are not in the repository.`,
  };
}
