#!/usr/bin/env node
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
  semanticDiff,
  sortChanges,
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
    if (rest.length === 0) {
      console.error('usage: teslon analyze <file> [<file>...]');
      process.exitCode = 1;
      break;
    }
    printRadius(root, rest);
    break;
  }

  case 'pr': {
    const root = process.env.TESLON_ROOT ?? process.cwd();
    const base = rest[0] ?? 'origin/main';
    const head = rest[1] ?? 'HEAD';
    try {
      const { change, limitations } = resolveChange(gitIn(root), { base, head });
      console.log(`\nmerge base: ${change.mergeBase.slice(0, 10)}`);
      console.log(`changed:    ${change.files.length} file(s)`);
      for (const l of limitations) console.log(`note:       ${l.what}`);
      if (change.files.length) printRadius(root, change.files);
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
  teslon version

Teslon never narrows on a guess. When it cannot resolve something it widens
the radius and says so.
`);
}
