#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import {
  listFiles,
  buildImportGraph,
  buildNameIndex,
  walk,
  walkWithParents,
  profileFile,
  dataCouplingEdges,
  buildSymbolEdges,
  wideningEdges,
  proofPaths,
  shortestPathPerDestination,
  exportedSymbols,
  readCode,
  readAst,
  readJava,
  buildJavaGraph,
  unresolvedSummary,
  semanticDiff,
  sortChanges,
  analyze,
  readAstSource,
  isTestFile,
  TIER_LABEL,
  type AstReading,
  type TeslonResult,
  type Tier,
  type Limitation,
  gitIn as gitRunner,
  resolveChange,
  gitIn,
  NoMergeBaseError,
  NotAGitRepositoryError,
  GitUnavailableError,
  SCHEMA_VERSION,
  type Provenance,
} from '@teslon/core';

const [, , command = 'help', ...rest] = process.argv;

function combinedReverse(root: string) {
  const files = listFiles(root);
  const graph = buildImportGraph(root, files);
  const names = buildNameIndex(root, files);
  const profiles = files
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))
    .map((f) => profileFile(root, f))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  const rev = new Map<string, Set<string>>(files.map((f) => [f, new Set<string>()]));
  const why = new Map<string, Provenance[]>();

  // The widening layers are what take recall from roughly two thirds to
  // almost all of it: every one exists because a dependency has no import to
  // follow. Measured on the torture fixture, 69.6% without them, 95.7% with.
  for (const e of [
    ...graph.edges,
    ...names.edges,
    ...dataCouplingEdges(profiles),
    ...wideningEdges(root, files),
  ]) {
    rev.get(e.from)?.add(e.to);
    const key = `${e.from}\u0000${e.to}`;
    const list = why.get(key) ?? [];
    list.push(e.why);
    why.set(key, list);
  }
  return { files, rev, why, profiles };
}



/**
 * Recent authors per file, as git evidence for ownership where CODEOWNERS says
 * nothing. Bounded: one `git log` per file is fine for a pull request's worth
 * of files and would be absurd for a whole repository, so only the changed
 * files are looked up and the rest fall back to "nobody declared".
 */
function authorsFor(root: string, files: readonly string[]): Map<string, readonly string[]> {
  const git = gitIn(root);
  const out = new Map<string, readonly string[]>();
  for (const file of files.slice(0, 200)) {
    try {
      const names = git(['log', '-n', '20', '--format=%an', '--', file])
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean);
      if (names.length === 0) continue;
      const counts = new Map<string, number>();
      for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
      const ranked = [...counts]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 2)
        .map(([n]) => n);
      out.set(file, ranked);
    } catch {
      // A file with no history is a new file. Nothing to infer, and saying so
      // is better than naming whoever happened to touch the directory.
    }
  }
  return out;
}

/**
 * Policies a build can fail on.
 *
 * A gate has to be about something the analysis can prove, or it will be
 * turned off within a week. Each of these is a counted fact, not a score
 * threshold: "a Tier 1 file has no test" is arguable in a code review and not
 * arguable in a build log.
 */
const GATES = {
  'tier1-untested':
    'a Tier 1 file has no test that reaches it directly',
  breaking: 'the change removes or tightens an existing contract',
  'untested-surface': 'an affected endpoint, screen or job has no test reaching it at all',
  'undeclared-owner': 'a Tier 1 file has no owner in CODEOWNERS',
} as const;

type GateName = keyof typeof GATES;

function evaluateGates(result: TeslonResult, names: readonly GateName[]): { name: GateName; hits: string[] }[] {
  const failures: { name: GateName; hits: string[] }[] = [];
  for (const name of names) {
    let hits: string[] = [];
    if (name === 'tier1-untested') {
      hits = result.priority
        .filter((p) => p.tier === 1 && p.because.some((f) => /^no test/.test(f.factor)))
        .map((p) => p.file);
    } else if (name === 'breaking') {
      hits = result.priority
        .filter((p) => p.because.some((f) => f.factor === 'breaking change'))
        .map((p) => `${p.file}: ${p.because.find((f) => f.factor === 'breaking change')!.detail}`);
    } else if (name === 'untested-surface') {
      hits = result.surfaces
        .filter((s) => s.directTests.length === 0 && s.indirectTests.length === 0)
        .map((s) => `${s.kind} ${s.id}`);
    } else if (name === 'undeclared-owner') {
      hits = result.priority.filter((p) => p.tier === 1 && p.ownerSource === 'none').map((p) => p.file);
    }
    if (hits.length > 0) failures.push({ name, hits });
  }
  return failures;
}

const xml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * JUnit XML, because every CI already knows how to read it.
 *
 * Each coverage gap and each untested surface becomes a failing case, so the
 * findings land in the same place as test failures rather than in a log nobody
 * opens. Everything Teslon could not do becomes a skipped case, which is how
 * JUnit expresses "this was not checked" — a limitation rendered as a pass
 * would be a lie told in a machine-readable format.
 */
function junitXml(result: TeslonResult): string {
  const cases: string[] = [];
  for (const g of result.gaps) {
    cases.push(
      `    <testcase classname="teslon.coverage" name="${xml(g.file)}">\n      <failure message="${xml(g.reason)}"/>\n    </testcase>`,
    );
  }
  for (const s of result.surfaces.filter((x) => x.directTests.length === 0 && x.indirectTests.length === 0)) {
    cases.push(
      `    <testcase classname="teslon.surface" name="${xml(`${s.kind} ${s.id}`)}">\n      <failure message="no test reaches this surface"/>\n    </testcase>`,
    );
  }
  for (const p of result.priority.filter((x) => x.tier === 1)) {
    cases.push(`    <testcase classname="teslon.tier1" name="${xml(p.file)}"/>`);
  }
  for (const l of result.limitations) {
    cases.push(
      `    <testcase classname="teslon.limitation" name="${xml(l.what.slice(0, 120))}">\n      <skipped message="${xml(l.mitigation)}"/>\n    </testcase>`,
    );
  }
  const failures = result.gaps.length + result.surfaces.filter((x) => x.directTests.length === 0 && x.indirectTests.length === 0).length;
  const skipped = result.limitations.length;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="teslon" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
    `  <testsuite name="teslon impact" tests="${cases.length}" failures="${failures}" skipped="${skipped}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

/**
 * Read the changed files as they were at the merge base, so the semantic diff
 * can run. The merge-base version of a file is not on disk — it is in git — so
 * it is piped through the reader from a string.
 *
 * A file that did not exist at the base reads as null, which is exactly right:
 * the diff then reports it as new, with nothing ever exercised.
 */
function baseReadingsAt(root: string, sha: string, files: readonly string[]): Map<string, AstReading | null> {
  const git = gitIn(root);
  const out = new Map<string, AstReading | null>();
  for (const file of files) {
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    try {
      out.set(file, readAstSource(file, git(['show', `${sha}:${file}`])));
    } catch {
      out.set(file, null); // absent at the base, or unreadable there
    }
  }
  return out;
}

const bar = (n: number, of: number, width = 18): string => {
  const filled = of === 0 ? 0 : Math.max(n > 0 ? 1 : 0, Math.round((n / of) * width));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
};

/**
 * Everything that happens after a result exists: render it, write the machine
 * formats, and apply the gates.
 *
 * Shared between `analyze` and `pr` on purpose. The first version of this CLI
 * had two impact code paths that could disagree, and the weaker one was the
 * only one anyone saw; one tail means one behaviour.
 */
function finish(result: TeslonResult, argv: readonly string[], json: boolean): void {
  if (json) console.log(JSON.stringify(result, null, 2));
  else printResult(result);

  const junitAt = argv.indexOf('--junit');
  if (junitAt >= 0) {
    const path = argv[junitAt + 1];
    if (!path || path.startsWith('--')) {
      console.error('--junit needs a file path');
      process.exitCode = 1;
      return;
    }
    writeFileSync(path, junitXml(result), 'utf8');
    if (!json) console.log(`JUnit written to ${path}\n`);
  }

  const failAt = argv.indexOf('--fail-on');
  if (failAt >= 0) {
    const asked = (argv[failAt + 1] ?? '').split(',').filter(Boolean);
    const unknown = asked.filter((a) => !(a in GATES));
    if (asked.length === 0 || unknown.length > 0) {
      console.error(
        `--fail-on takes a comma-separated list of: ${Object.keys(GATES).join(', ')}${unknown.length ? `\nunknown: ${unknown.join(', ')}` : ''}`,
      );
      process.exitCode = 1;
      return;
    }
    const failures = evaluateGates(result, asked as GateName[]);
    for (const f of failures) {
      console.error(`\x1b[31mgate failed\x1b[0m ${f.name}: ${GATES[f.name]}`);
      for (const h of f.hits.slice(0, 10)) console.error(`  ${h}`);
      if (f.hits.length > 10) console.error(`  … and ${f.hits.length - 10} more`);
    }
    if (failures.length > 0) {
      // 5 is its own code: the analysis succeeded and the policy rejected the
      // change. A build log has to be able to tell that from a broken run.
      process.exitCode = 5;
    }
  }
}

function printResult(result: TeslonResult): void {
  const { brief, priority, tests, surfaces, gaps, limitations, completeness } = result;

  console.log('\n\x1b[1mWHAT TO KNOW\x1b[0m');
  for (const line of brief) console.log(`  ${line}`);

  console.log('\n\x1b[1mWHAT TO TEST, IN ORDER\x1b[0m');
  const counts = ([1, 2, 3, 4] as Tier[]).map((t) => priority.filter((p) => p.tier === t).length);
  const most = Math.max(1, ...counts);
  for (const tier of [1, 2, 3, 4] as Tier[]) {
    const rows = priority.filter((p) => p.tier === tier);
    if (rows.length === 0) continue;
    console.log(`\n  ${bar(rows.length, most)}  \x1b[1mTier ${tier} · ${TIER_LABEL[tier]}\x1b[0m  (${rows.length})`);
    for (const p of rows) {
      const surfaces = p.surfaces.length ? `  \x1b[2m${p.surfaces.slice(0, 2).join(', ')}\x1b[0m` : '';
      console.log(`      ${String(p.score).padStart(2)}  ${p.file}${surfaces}`);
      // Every row shows why it is where it is. A tier nobody can argue with is
      // a tier nobody reads.
      for (const f of p.because.filter((x) => x.points !== 0)) {
        console.log(`          \x1b[2m+${f.points} ${f.factor} — ${f.detail}\x1b[0m`);
      }
    }
  }

  if (surfaces.length > 0) {
    console.log('\n\x1b[1mWHAT A PERSON CAN OPEN\x1b[0m');
    for (const s of surfaces) {
      const cov =
        s.directTests.length > 0
          ? `${s.directTests.length} direct test(s)`
          : s.indirectTests.length > 0
            ? `${s.indirectTests.length} indirect only`
            : '\x1b[33mno test reaches it\x1b[0m';
      console.log(`  ${s.isNew ? '\x1b[32mNEW\x1b[0m ' : '    '}${s.kind.padEnd(9)} ${s.id.padEnd(38)} ${cov}`);
    }
  }

  if (tests.length > 0) {
    console.log('\n\x1b[1mEXISTING TESTS THAT TOUCH THIS\x1b[0m');
    for (const t of tests) {
      const what = t.coversDirectly.length
        ? `covers ${t.coversDirectly.length} changed file(s) directly`
        : `reaches ${t.coversIndirectly.length} changed file(s) only as a side effect`;
      console.log(`  Tier ${t.highestTierCovered}  ${t.file.padEnd(44)} ${what}`);
    }
  }

  if (gaps.length > 0) {
    console.log('\n\x1b[1mCOVERAGE GAPS\x1b[0m');
    for (const g of gaps) console.log(`  \x1b[33m${g.file}\x1b[0m\n      ${g.reason}`);
  }

  if (result.effort.minimumCases > 0) {
    console.log('\n\x1b[1mHOW MUCH TESTING THIS IMPLIES\x1b[0m');
    console.log(`  \x1b[1m${result.effort.minimumCases} cases minimum\x1b[0m`);
    for (const l of result.effort.lines) {
      console.log(`    ${String(l.cases).padStart(3)}  ${l.reason}`);
      for (const e of l.examples) console.log(`         \x1b[2m${e}\x1b[0m`);
    }
    console.log(`  \x1b[2m${result.effort.note}\x1b[0m`);
  }

  if (result.ownership.length > 0) {
    console.log('\n\x1b[1mWHO TO ASK\x1b[0m');
    for (const o of result.ownership) {
      const how = o.source === 'CODEOWNERS' ? 'declared' : o.source === 'git-history' ? 'from git history' : 'undeclared';
      console.log(`  Tier ${o.topTier}  ${o.owner.padEnd(28)} ${String(o.files).padStart(3)} file(s)  \x1b[2m${how}\x1b[0m`);
    }
  }

  console.log('\n\x1b[1mHOW MUCH OF THIS TO TRUST\x1b[0m');
  console.log(`  ${completeness.verdict}`);
  for (const s of completeness.signalsRun) {
    const worth = s.filesAdded < 0 ? 'not measured on a tree this size' : `${s.filesAdded} file(s) found by nothing else`;
    console.log(`    \x1b[2m${s.signal.padEnd(15)} ${String(s.edges).padStart(5)} edges   ${worth}\x1b[0m`);
  }
  for (const s of completeness.signalsAbsent) {
    console.log(`    \x1b[2m${s.signal.padEnd(15)} \x1b[33moff\x1b[0m\x1b[2m — ${s.why}\x1b[0m`);
  }
  if (completeness.unreadable.length > 0) {
    console.log(`  \x1b[33m${completeness.unreadable.length} file(s) no signal can read:\x1b[0m ${completeness.unreadable.slice(0, 6).join(', ')}${completeness.unreadable.length > 6 ? ', …' : ''}`);
  }

  if (limitations.length > 0) {
    console.log('\n\x1b[1mLIMITATIONS\x1b[0m');
    for (const l of limitations) {
      console.log(`  ${l.what}`);
      console.log(`      \x1b[2m${l.mitigation}\x1b[0m`);
    }
  }
  console.log('');
}

function printRadius(root: string, seeds: readonly string[]): void {
  const { files, rev, why } = combinedReverse(root);
  const missing = seeds.filter((s) => !files.includes(s));
  if (missing.length) {
    console.error(`not in the repository: ${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const { dist, parent } = walkWithParents(rev, seeds);
  const rows = [...dist]
    .filter(([f]) => !seeds.includes(f))
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  console.log(`\nchanged: ${seeds.join(', ')}`);
  console.log(`radius:  ${rows.length} file(s) reached of ${files.length}\n`);

  for (const [file, hops] of rows) {
    const from = parent.get(file);
    const reason = from ? why.get(`${from}\u0000${file}`)?.[0] : undefined;
    const label = reason
      ? `${reason.signal}: ${reason.detail}`
      : 'reached, reason unavailable';
    const through = from && hops > 1 ? `  (through ${from.split('/').pop()})` : '';
    console.log(`  hop ${hops}  ${file.padEnd(42)} ${label}${through}`);
  }
  console.log('');
}

switch (command) {
  case 'analyze': {
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const json = rest.includes('--json');
    const files = rest.filter((r) => !r.startsWith('--'));
    if (files.length === 0) {
      console.error('usage: teslon analyze <file> [<file>...] [--json]');
      process.exitCode = 1;
      break;
    }
    const allFiles = listFiles(root);
    const present = new Set(allFiles);
    if (files.every((f) => !present.has(f))) {
      // Every path wrong is a mistake worth stopping for. Some paths wrong is
      // a deleted file, which the analysis handles and reports.
      console.error(`none of those paths are in the repository: ${files.join(', ')}`);
      process.exitCode = 2;
      break;
    }
    const { result } = analyze({
      root,
      allFiles,
      repo: root,
      change: { baseSha: '(working tree)', headSha: '(working tree)', mergeBase: '(none)', files },
      authors: authorsFor(root, files),
    });
    finish(result, rest, json);
    break;
  }

  case 'pr': {
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const base = rest[0] ?? 'origin/main';
    const head = rest[1] ?? 'HEAD';
    try {
      const { change, limitations } = resolveChange(gitIn(root), { base, head });
      const json = rest.includes('--json');
      if (!json) {
        console.log(`\nmerge base: ${change.mergeBase.slice(0, 10)}   changed: ${change.files.length} file(s)`);
      }
      if (change.files.length === 0) {
        console.log('Nothing changed between those two refs.\n');
        break;
      }
      // A PR that deletes a file lists it in the diff and it is not on disk.
      // The analysis reports that as a limitation; refusing to run, which is
      // what this command used to do, made Teslon unusable on any PR with a
      // deletion in it.
      const { result } = analyze({
        root,
        allFiles: listFiles(root),
        repo: root,
        change,
        limitations,
        baseReadings: baseReadingsAt(root, change.mergeBase, change.files),
        authors: authorsFor(root, change.files),
      });
      finish(result, rest, json);
    } catch (err) {
      if (err instanceof NotAGitRepositoryError || err instanceof GitUnavailableError) {
        console.error(`\n${err.message}\n`);
        process.exitCode = 4;
      } else if (err instanceof NoMergeBaseError) {
        console.error(`\n${err.message}\n`);
        console.error('Teslon will not guess a change set. Fetch more history and try again.');
        process.exitCode = 3;
      } else throw err;
    }
    break;
  }

  case 'profile': {
    const root = process.env.TESLON_ROOT ?? process.cwd();
    for (const file of rest) {
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
        console.error(`${file}: not a source file — nothing to profile`);
        process.exitCode = 2;
        continue;
      }
      const p = profileFile(root, file);
      if (!p) {
        console.log(`${file}: unreadable`);
        continue;
      }
      console.log(`\n┌─ ${p.file}`);
      if (p.http) console.log(`│ endpoint     ${p.http.method} ${p.http.path}`);
      console.log(`│ nature       ${p.nature}${p.nature !== 'read-only' ? '  ← treated as state-changing' : ''}`);
      if (p.input) console.log(`│ takes        ${p.input.type}: ${p.input.fields.join(', ')}`);
      if (p.output) console.log(`│ returns      ${p.output.type}: ${p.output.fields.join(', ')}`);
      console.log(`│ reads        ${p.readsTables.join(', ') || '—'}`);
      console.log(`│ writes       ${p.writesTables.join(', ') || '—'}`);
      console.log(`│ calls out    ${p.callsOut.join(', ') || '—'}`);
      console.log(`│ effects      ${p.sideEffects.join(', ') || '—'}`);
      console.log(`│ auth         ${p.auth ?? 'none declared'}`);
      console.log(`│ flags        ${p.flags.join(', ') || '—'}`);
      console.log(`└─ errors      ${p.errorPaths.join(' | ') || '—'}`);
    }
    break;
  }

  case 'paths': {
    // Proof, not a picture. A graph of two thousand nodes is a hairball;
    // two thousand paths sorted by length are read one at a time.
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const file = rest[0];
    if (!file) {
      console.error('usage: teslon paths <file> [symbol]');
      process.exitCode = 1;
      break;
    }
    const files = listFiles(root);
    const edges = buildSymbolEdges(root, files);
    const symbols = rest[1] ? [rest[1]] : exportedSymbols(root, file);
    if (symbols.length === 0) {
      console.error(`${file}: no exported symbols found`);
      process.exitCode = 2;
      break;
    }

    for (const symbol of symbols) {
      const paths = shortestPathPerDestination(proofPaths(edges, file, symbol));
      console.log(`\n── change ${symbol}() ──`);
      if (paths.length === 0) {
        console.log('   nothing imports it');
        continue;
      }
      for (const p of paths) {
        const chain = p.steps.map((step) => step.file.split('/').pop()).join('  →  ');
        console.log(`   ${symbol}()  →  ${chain}${p.exact ? '' : '   [widened: import did not name a symbol]'}`);
      }
    }
    console.log('');
    break;
  }

  case 'cases': {
    // What a tester is obliged to cover, read out of what the code declares.
    const root = process.env.TESLON_ROOT ?? process.cwd();
    if (rest.length === 0) {
      console.error('usage: teslon cases <file...>');
      process.exitCode = 1;
      break;
    }
    for (const file of rest) {
      const r = readCode(root, file);
      if (!r) {
        console.error(`${file}: unreadable`);
        process.exitCode = 2;
        continue;
      }
      console.log(`\n┌─ ${r.file}   [${r.kind}]`);
      if (r.ui) {
        console.log(`│ props        ${r.ui.props.join(', ') || '—'}`);
        console.log(`│ state        ${r.ui.state.join(', ') || '—'}  ·  ${r.ui.effects} effect(s)`);
        console.log(`│ events       ${r.ui.events.join(', ') || '—'}`);
        console.log(`│ shows        ${r.ui.conditionalRenders.join(', ') || '—'}`);
      }
      for (const c of r.constraints) {
        console.log(`│ ${c.field.padEnd(12)} ${c.rules.join(' ')}  →  try ${c.boundaries.join(', ')}`);
      }
      if (r.cases.length === 0) console.log('│ (nothing was recognised — no cases claimed)');
      for (const c of r.cases) console.log(`│ • ${c}`);
      for (const n of r.notRead) console.log(`└─ not read: ${n}`);
      if (r.notRead.length === 0) console.log('└─');
    }
    console.log('');
    break;
  }

  case 'changed': {
    // What is different about behaviour, not about text. This is what the
    // reading engine is for inside an impact analyser.
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const base = rest[0] ?? 'origin/main';
    const git = gitRunner(root);
    let files: readonly string[];
    try {
      const resolved = resolveChange(git, { base, head: 'HEAD' });
      files = resolved.change.files;
      console.log(`\nmerge base ${resolved.change.mergeBase.slice(0, 10)} · ${files.length} file(s) changed`);
    } catch (err) {
      console.error(`\n${(err as Error).message}\n`);
      process.exitCode = 3;
      break;
    }

    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const scratch = mkdtempSync(join(tmpdir(), 'teslon-base-'));

    try {
      let reported = 0;
      for (const file of files) {
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;

        let beforeReading = null;
        try {
          const old = git(['show', `${base}:${file}`]);
          const staged = join(scratch, file);
          mkdirSync(dirname(staged), { recursive: true });
          writeFileSync(staged, old);
          beforeReading = readAst(scratch, file);
        } catch {
          // Added in this change: no previous version to read.
        }

        const changes = sortChanges(semanticDiff(beforeReading, readAst(root, file)).changes);
        if (changes.length === 0) continue;
        reported += 1;

        console.log(`\n┌─ ${file}`);
        for (const c of changes) {
          console.log(`│ [${c.severity.toUpperCase().padEnd(9)}] ${c.what}`);
          if (c.test) console.log(`│             → test: ${c.test}`);
          if (c.detail) console.log(`│             ${c.detail}`);
        }
        console.log('└─');
      }
      if (reported === 0) console.log('\nno behaviour changes found in the changed source files');
      console.log('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    break;
  }

  case 'java': {
    // Java resolves by package, not by path, so it gets its own graph.
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const files = listFiles(root).filter((f) => f.endsWith('.java'));
    if (files.length === 0) {
      console.error('no .java files found');
      process.exitCode = 2;
      break;
    }
    const readings = files.map((f) => readJava(root, f)).filter((r): r is NonNullable<typeof r> => r !== null);

    for (const r of readings) {
      console.log(`\n┌─ ${r.file}   [${r.shape}]   package ${r.packageName || '(default)'}`);
      if (r.httpRoutes.length) console.log(`│ routes       ${r.httpRoutes.join('  ·  ')}`);
      if (r.transactional) console.log('│ nature       TRANSACTIONAL — changes state');
      if (r.auth) console.log(`│ auth         ${r.auth}`);
      if (r.injected.length) console.log(`│ injected     ${r.injected.join(', ')}`);
      if (r.methods.length) console.log(`│ methods      ${r.methods.join(', ')}`);
      if (r.entityTables.length) console.log(`│ maps table   ${r.entityTables.join(', ')}`);
      if (r.entityColumns.length) console.log(`│ columns      ${r.entityColumns.join(', ')}`);
      for (const c of r.constraints) {
        console.log(`│ validation   ${c.rules.join(' ')}  →  try ${c.boundaries.join(', ')}`);
      }
      if (r.throws.length) console.log(`│ throws       ${r.throws.join(' | ')}`);
      if (r.claims.length) {
        for (const c of r.claims) console.log(`│ verifies     ${c.name}`);
      }
      for (const n of r.notRead) console.log(`│ not read     ${n}`);
      console.log('└─');
    }

    const graph = buildJavaGraph(readings);
    console.log(`\n── dependencies (${graph.edges.length}) ──`);
    for (const e of graph.edges) {
      console.log(`   ${e.from.split('/').pop()}  →  ${e.to.split('/').pop()}   [${e.why.signal}] ${e.why.detail}`);
    }

    const outside = unresolvedSummary(graph);
    if (outside.length > 0) {
      console.log('\n── imports resolved outside this repository ──');
      for (const o of outside.slice(0, 8)) console.log(`   ${o.prefix}.*  (${o.count})`);
      console.log('   these are third-party, or modules Teslon was not pointed at — it cannot tell which');
    }
    console.log('');
    break;
  }

  case 'version':
    console.log(`teslon 0.1.0 (schema ${SCHEMA_VERSION})`);
    break;

  default:
    // A mistyped command must not look like success in a pipeline.
    if (command !== 'help' && command !== '--help' && command !== '-h') {
      console.error(`unknown command: ${command}\n`);
      process.exitCode = 1;
    }
    console.log(`
teslon — what a change can actually break

  teslon pr [base] [head]     analyse the current branch against its merge base
  teslon analyze <file...>    blast radius for specific files
  teslon profile <file...>    what a file does: endpoint, reads, writes, effects
  teslon paths <file> [sym]   proof paths from each exported symbol outward
  teslon cases <file...>      what a tester must cover, read from the code
  teslon changed [base]       what changed about behaviour, not about text
  teslon java                 read a Java source tree: routes, injection, entities
  teslon version

Teslon never narrows on a guess. When it cannot resolve something it widens
the radius and says so.
`);
}
