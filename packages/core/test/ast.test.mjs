import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAst, semanticDiff, sortChanges } from '../dist/index.js';

function read(name, body) {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-ast-'));
  try {
    writeFileSync(join(tmp, name), body);
    return readAst(tmp, name);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// A review against ten ordinary code shapes found six returned nothing.
// Each of those six has a test now.

test('a class service yields its methods and what was injected', () => {
  const r = read(
    'svc.ts',
    `@Injectable()
export class PricingService {
  constructor(private readonly repo: OrderRepo, private readonly tax: TaxService) {}
  async quote(id: string) { return this.repo.findById(id); }
  applyDiscount(c: number) { return c; }
}\n`,
  );
  assert.equal(r.shape, 'service');
  assert.deepEqual(r.methods, ['applyDiscount', 'quote']);
  assert.deepEqual(r.injected, ['OrderRepo', 'TaxService']);
});

test('a test file yields the behaviours it claims, with their nesting', () => {
  const r = read(
    'c.test.ts',
    `describe('coupon', () => {
  describe('validation', () => {
    it('rejects codes shorter than 3 characters', () => {});
  });
  it('applies a discount for PRIME members', () => {});
});\n`,
  );
  assert.equal(r.shape, 'test');
  assert.equal(r.claims.length, 2);
  assert.deepEqual(r.claims[0].context, ['coupon', 'validation']);
  assert.equal(r.claims[0].name, 'rejects codes shorter than 3 characters');
  // The outer `it` must not inherit the inner describe.
  assert.deepEqual(r.claims[1].context, ['coupon']);
});

test('a Storybook file yields its stories, which are enumerated states', () => {
  const r = read(
    'B.stories.tsx',
    'export default { component: Button };\nexport const Primary = {};\nexport const Disabled = {};\n',
  );
  assert.equal(r.shape, 'story');
  assert.deepEqual(r.actions, ['Disabled', 'Primary']);
});

test('a store and a resolver yield their actions', () => {
  const store = read(
    's.ts',
    'export const useCart = create((set) => ({ addItem: (i) => set(i), clear: () => set({}) }));\n',
  );
  assert.equal(store.shape, 'store');
  assert.deepEqual(store.actions, ['addItem', 'clear']);

  const resolver = read(
    'r.ts',
    'export const resolvers = { Query: { order: async () => 1 }, Mutation: { cancel: async () => 2 } };\n',
  );
  assert.equal(resolver.shape, 'resolver');
  assert.deepEqual(resolver.actions, ['cancel', 'order']);
});

test('a declaration file yields its types and fields', () => {
  const r = read('t.d.ts', 'export interface Order { id: string; totalCents: number; }\n');
  assert.equal(r.shape, 'types');
  assert.equal(r.types[0].name, 'Order');
  assert.equal(r.types[0].fields.length, 2);
});

test('a component yields both arms of a ternary render', () => {
  const r = read(
    'C.tsx',
    `export function Cart({ items, onCheckout }: P) {
  const [total, setTotal] = useState(0);
  if (items.length === 0) return <EmptyCart />;
  return <button onClick={onCheckout}>{total > 5000 ? <FreeShipping /> : <ShippingCost />}</button>;
}\n`,
  );
  assert.equal(r.shape, 'component');
  assert.deepEqual(r.props, ['items', 'onCheckout']);
  assert.deepEqual(r.state, ['total']);
  assert.deepEqual(r.events, ['onClick']);
  assert.deepEqual(r.conditionalRenders, ['EmptyCart', 'FreeShipping', 'ShippingCost']);
});

test('a validator container is not reported as a field constraint', () => {
  // The outer z.object() produced a phantom "(value)" constraint alongside
  // the real per-field one, which buried the finding that mattered.
  const r = read('s.ts', 'export const S = z.object({ code: z.string().min(3).max(20) });\n');
  assert.equal(r.constraints.length, 1);
  assert.equal(r.constraints[0].field, 'code');
  assert.deepEqual(r.constraints[0].boundaries, ['2', '3', '20', '21']);
});

test('a file that does not parse still reads instead of throwing', () => {
  const r = read('broken.ts', 'export function f( { unclosed\n');
  assert.ok(r, 'a syntax error must not stop the reading');
});

// ---------------------------------------------------------------------------
// Semantic diff: the reason the reader belongs in an impact analyser.
// ---------------------------------------------------------------------------

function diff(name, before, after) {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-diff-'));
  try {
    mkdirSync(join(tmp, 'a'));
    mkdirSync(join(tmp, 'b'));
    writeFileSync(join(tmp, 'a', name), before);
    writeFileSync(join(tmp, 'b', name), after);
    return sortChanges(semanticDiff(readAst(join(tmp, 'a'), name), readAst(join(tmp, 'b'), name)).changes);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('a tightened constraint is breaking and names the values to try', () => {
  const changes = diff(
    's.ts',
    'export const S = z.object({ code: z.string().min(3) });\n',
    'export const S = z.object({ code: z.string().min(5) });\n',
  );
  const c = changes.find((x) => x.what.includes('code.min'));
  assert.equal(c.severity, 'breaking');
  assert.match(c.test, /3 and 5/);
});

test('a loosened constraint is a behaviour change, not a break', () => {
  const changes = diff(
    's.ts',
    'export const S = z.object({ pct: z.number().max(50) });\n',
    'export const S = z.object({ pct: z.number().max(80) });\n',
  );
  assert.equal(changes.find((x) => x.what.includes('pct.max')).severity, 'behaviour');
});

test('a new branch becomes a case nobody has run', () => {
  const changes = diff(
    'r.ts',
    'export function f(c) { if (c.pct > 50) return 1; return 2; }\n',
    "export function f(c) { if (c.pct > 50) return 1; if (c.code.startsWith('PRIME')) return 3; return 2; }\n",
  );
  const c = changes.find((x) => x.what.includes('new branch'));
  assert.equal(c.severity, 'behaviour');
  assert.match(c.test, /PRIME/);
});

test('a removed field and a removed export are breaking', () => {
  const changes = diff(
    't.ts',
    'export interface Order { id: string; expiresAt: string; }\nexport const a = 1;\nexport const b = 2;\n',
    'export interface Order { id: string; }\nexport const a = 1;\n',
  );
  assert.ok(changes.some((c) => c.severity === 'breaking' && /expiresAt/.test(c.what)));
  assert.ok(changes.some((c) => c.severity === 'breaking' && /export removed: b/.test(c.what)));
});

test('a deleted test is reported as coverage lost', () => {
  const changes = diff(
    'c.test.ts',
    "describe('cart', () => { it('applies a discount', () => {}); it('caps at 50 percent', () => {}); });\n",
    "describe('cart', () => { it('applies a discount', () => {}); });\n",
  );
  const c = changes.find((x) => x.severity === 'coverage');
  assert.match(c.what, /caps at 50 percent/);
  assert.match(c.test, /no longer guarded/);
});

test('breaking changes sort above everything else', () => {
  const changes = diff(
    'm.ts',
    'export interface T { a: string; b: string; }\n',
    'export interface T { a: string; }\nexport const extra = 1;\n',
  );
  assert.equal(changes[0].severity, 'breaking');
});
