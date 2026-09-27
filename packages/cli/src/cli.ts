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
  proofPaths,
  shortestPathPerDestination,
  exportedSymbols,
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

  for (const e of [...graph.edges, ...names.edges, ...dataCouplingEdges(profiles)]) {
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
  teslon version

Teslon never narrows on a guess. When it cannot resolve something it widens
the radius and says so.
`);
}
