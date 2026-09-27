import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCode } from '../dist/index.js';

function withFile(name, body, fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-read-'));
  try {
    writeFileSync(join(tmp, name), body);
    return fn(readCode(tmp, name));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('a validation schema yields the boundary values, which is the whole job', () => {
  withFile(
    'schema.ts',
    'export const S = z.object({ code: z.string().min(3).max(20), pct: z.number().int().min(1).max(90) });\n',
    (r) => {
      assert.equal(r.kind, 'schema');
      const code = r.constraints.find((c) => c.field === 'code');
      // min(3) makes 2 and 3 interesting and nothing else about the field is.
      assert.deepEqual(code.boundaries, ['2', '3', '20', '21']);
      // The base type must not be repeated on top of the call that produced it.
      assert.deepEqual(code.rules, ['string', 'min(3)', 'max(20)']);

      const pct = r.constraints.find((c) => c.field === 'pct');
      assert.deepEqual(pct.boundaries, ['0', '1', '90', '91']);
    },
  );
});

test('a business rule yields its branches and the literals that select them', () => {
  withFile(
    'rule.ts',
    `export function eligible(o: Order): boolean {
  if (o.country === 'IN' && o.totalCents >= 50000) return true;
  if (o.isPrime) return true;
  return false;
}\n`,
    (r) => {
      assert.equal(r.kind, 'rule');
      assert.equal(r.branches.length, 2);
      assert.deepEqual(r.branches[0].literals, ["'IN'", '50000']);
      assert.match(r.cases[0], /both sides of/);
      assert.match(r.cases[0], /50000/);
    },
  );
});

test('a component yields props, state, events and every conditional render', () => {
  withFile(
    'C.tsx',
    `import { useState, useEffect } from 'react';
export function CartSummary({ items, onCheckout }: Props) {
  const [total, setTotal] = useState(0);
  useEffect(() => { setTotal(1); }, [items]);
  if (items.length === 0) return <EmptyCart />;
  return <button onClick={onCheckout}>{total > 5000 ? <FreeShipping /> : <ShippingCost />}</button>;
}\n`,
    (r) => {
      assert.equal(r.kind, 'component');
      assert.deepEqual(r.ui.props, ['items', 'onCheckout']);
      assert.deepEqual(r.ui.state, ['total']);
      assert.equal(r.ui.effects, 1);
      assert.deepEqual(r.ui.events, ['onClick']);

      // Both arms of the ternary render a state somebody has to see; only
      // capturing the `?` side left half the component untested.
      assert.deepEqual(r.ui.conditionalRenders, ['EmptyCart', 'FreeShipping', 'ShippingCost']);

      // The condition must be the condition, not half a JSX tag.
      const ternary = r.branches.find((b) => b.condition.includes('5000'));
      assert.equal(ternary.condition, 'total > 5000');
    },
  );
});

test('an unrecognised file says so instead of inventing a reading', () => {
  withFile('mystery.bin.ts', 'const x = globalThis.__opaque;\n', (r) => {
    assert.equal(r.kind, 'unknown');
    assert.deepEqual(r.cases, []);
    assert.ok(r.notRead.some((n) => /not recognised/.test(n)));
  });
});

test('runtime-built code is declared unread rather than passed over', () => {
  withFile('dyn.ts', 'export const f = new Function("return 1");\nif (a === 1) { b(); }\n', (r) => {
    assert.ok(r.notRead.some((n) => /runtime/.test(n)));
  });
});

test('reading is deterministic', () => {
  withFile('r.ts', 'export function f(x: number) { if (x > 10) return 1; return 2; }\n', (r) => {
    assert.equal(JSON.stringify(r), JSON.stringify(readCode(join(r.file, '..'), r.file) ?? r));
    assert.ok(r.branches.length >= 1);
  });
});
