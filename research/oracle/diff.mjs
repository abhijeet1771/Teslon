// Differential runtime oracle, part 2: which pages changed between two
// crawls, and how. The output is ground truth for a case: produced by running
// the app, never by reading its code.
//
//   node research/oracle/diff.mjs <before.json> <after.json> [--noise <before-again.json>]
//
// --noise: a second crawl of the unchanged app. Pages that differ between two
// crawls of the same build (live metrics, log lists) are volatile: they are
// reported, and kept out of the truth, because the change did not cause them.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const ni = args.indexOf('--noise');
const noiseFile = ni >= 0 ? args.splice(ni, 2)[1] : null;
const [a, bb] = args.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const noise = noiseFile ? JSON.parse(readFileSync(noiseFile, 'utf8')) : null;
const lines = (x) => new Set(x);
const delta = (x = [], y = []) => {
  const X = lines(x), Y = lines(y);
  return { gone: [...X].filter((v) => !Y.has(v)), new: [...Y].filter((v) => !X.has(v)) };
};

const pages = [...new Set([...Object.keys(a), ...Object.keys(bb)])].sort();
const same = (X, Y) => X && Y && ['calls', 'text', 'fields'].every((k) => JSON.stringify(X[k]) === JSON.stringify(Y[k]));
const volatile = noise ? pages.filter((pg) => a[pg] && noise[pg] && !same(a[pg], noise[pg])) : [];
if (volatile.length) console.log(`VOLATILE (differ between two crawls of the same build, excluded): ${volatile.join(', ')}\n`);
let changed = 0;
for (const pg of pages) {
  if (volatile.includes(pg)) continue;
  const A = a[pg], B = bb[pg];
  if (!A || !B) { console.log(`${A ? 'GONE' : 'NEW '}  ${pg}`); changed++; continue; }
  const c = delta(A.calls, B.calls), t = delta(A.text, B.text), f = delta(A.fields, B.fields);
  if (!c.gone.length && !c.new.length && !t.gone.length && !t.new.length && !f.gone.length && !f.new.length) continue;
  changed++;
  console.log(`CHANGED  ${pg}`);
  for (const [k, d] of [['call', c], ['text', t], ['field', f]]) {
    for (const v of d.gone.slice(0, 4)) console.log(`   - ${k}  ${v.slice(0, 110)}`);
    for (const v of d.new.slice(0, 4)) console.log(`   + ${k}  ${v.slice(0, 110)}`);
    const more = d.gone.length + d.new.length - Math.min(4, d.gone.length) - Math.min(4, d.new.length);
    if (more > 0) console.log(`     … ${more} more ${k} differences`);
  }
}
console.log(`\n${changed} of ${pages.length - volatile.length} stable pages differ${volatile.length ? ` (${volatile.length} volatile excluded)` : ''}`);
