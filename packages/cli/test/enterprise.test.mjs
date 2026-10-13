/**
 * Enterprise edge cases, each one a real git repository driven through the
 * real CLI.
 *
 * Every case here failed before it was fixed, and each failure was silent: the
 * analysis ran, printed a confident result, and the result was wrong. That is
 * why they live in the suite rather than in a review document — a regression
 * in any of them would look exactly like a passing run.
 *
 *   E1  tsconfig paths        E8  Spring interface -> implementation
 *   E2  workspace packages    E10 importers of a deleted file
 *   E3  non-ASCII paths       E18 several implementations -> unknown, kept
 *   E4  head not checked out  E19 NestJS-style abstract class
 *   E5  dirty working tree    E20 flags in any position
 *   E7  default branch        E21 temporary worktree always removed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(files, branch = 'main') {
  const d = mkdtempSync(join(tmpdir(), 'tb-'));
  g(d, 'init', '-q', '-b', branch); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 'T');
  put(d, files); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base');
  return d;
}
function put(d, files) { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } }
function branch(d, name, files, msg = 'change') { g(d, 'checkout', '-qb', name); put(d, files); g(d, 'add', '-A'); g(d, 'commit', '-qm', msg); }
function teslon(d, ...args) {
  try { const out = execFileSync('node', [CLI, ...args, '--json'], { cwd: d, encoding: 'utf8', maxBuffer: 512*1024*1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TESLON_ROOT: d } });
    const i = out.indexOf('{'); return { code: 0, r: i >= 0 ? JSON.parse(out.slice(i)) : null, raw: out };
  } catch (e) { return { code: e.status, r: null, raw: (e.stdout || '') + (e.stderr || '') }; }
}
const results = [];
const check = (id, name, fn) => { let ok, note; try { [ok, note] = fn(); } catch (e) { ok = false; note = 'CRASH: ' + e.message.split('\n')[0]; } results.push({ id, name, ok, note }); };
const inR = (r, f) => !!r?.radius?.some((x) => x.file === f);
const lim = (r, re) => !!r?.limitations?.some((l) => re.test(l.what));

check('E1', 'tsconfig paths alias (@/lib/money)', () => {
  const d = repo({ 'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', 'src/lib/money.ts': 'export const fmt=(n:number)=>`$${n}`;\n', 'src/ui/Price.ts': "import { fmt } from '@/lib/money';\nexport const P=()=>fmt(1);\n" });
  branch(d, 'f', { 'src/lib/money.ts': 'export const fmt=(n:number)=>`USD ${n}`;\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/ui/Price.ts'), `radius=${r?.radius?.map((x) => x.file)}`];
});
check('E2', 'monorepo workspace package (@acme/utils)', () => {
  const d = repo({ 'package.json': '{"private":true,"workspaces":["packages/*"]}', 'packages/utils/package.json': '{"name":"@acme/utils","main":"src/index.ts"}', 'packages/utils/src/index.ts': 'export const add=(a:number,b:number)=>a+b;\n', 'packages/web/src/cart.ts': "import { add } from '@acme/utils';\nexport const total=()=>add(1,2);\n" });
  branch(d, 'f', { 'packages/utils/src/index.ts': 'export const add=(a:number,b:number)=>a+b+0;\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'packages/web/src/cart.ts'), `radius=${r?.radius?.map((x) => x.file)}`];
});
check('E3', 'unicode + space in a changed path', () => {
  const d = repo({ 'src/prïce tag.ts': 'export const a=1;\n', 'src/use.ts': "import { a } from './prïce tag';\nexport const b=a;\n" });
  branch(d, 'f', { 'src/prïce tag.ts': 'export const a=2;\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/use.ts') && !lim(r, /not present in the tree/), `changed=${JSON.stringify(r?.change?.files)}`];
});
check('E4', 'head branch NOT checked out (on main, analyse feature)', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n' });
  branch(d, 'f', { 'src/a.ts': 'export const a=1;\n', 'src/b.ts': "import { a } from './a';\nexport const b=a;\n", 'src/a.ts ': '' });
  // feature adds b.ts importing a.ts and changes a.ts
  put(d, { 'src/a.ts': 'export const a=99;\n' }); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'touch a');
  g(d, 'checkout', '-q', 'main');
  const { r, raw, code } = teslon(d, 'pr', 'main', 'f');
  const honest = inR(r, 'src/b.ts') && !lim(r, /not present in the tree/) && /clean checkout/.test(r?.change?.readFrom ?? '');
  return [honest, `code=${code} radius=${r?.radius?.map((x) => x.file)} lim=${r?.limitations?.map((l) => l.what.slice(0, 50))}`];
});
check('E5', 'dirty working tree is disclosed', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n' });
  branch(d, 'f', { 'src/a.ts': 'export const a=2;\n' });
  put(d, { 'src/a.ts': 'export const a=3; // uncommitted\n', 'src/scratch.ts': "import {a} from './a';\n" });
  const { r } = teslon(d, 'pr', 'main', 'f');
  const clean = !inR(r, 'src/scratch.ts') && /uncommitted/.test(r?.change?.readFrom ?? '');
  return [clean, `readFrom=${r?.change?.readFrom} scratchInRadius=${inR(r, 'src/scratch.ts')}`];
});
check('E6', 'rename (git mv) keeps the importers', () => {
  const d = repo({ 'src/old.ts': 'export const x=1;\n', 'src/use.ts': "import { x } from './old';\nexport const y=x;\n" });
  g(d, 'checkout', '-qb', 'f'); g(d, 'mv', 'src/old.ts', 'src/new.ts'); put(d, { 'src/use.ts': "import { x } from './new';\nexport const y=x;\n" }); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'rename');
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/use.ts') && inR(r, 'src/new.ts'), `changed=${r?.change?.files} lims=${r?.limitations?.map((l) => l.what.slice(0, 40))}`];
});
check('E7', 'default branch is master, no args given', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n' }, 'master');
  branch(d, 'f', { 'src/a.ts': 'export const a=2;\n' });
  const { r, code, raw } = teslon(d, 'pr'); return [!!r && r.change.files.includes('src/a.ts'), `code=${code} ${raw.slice(0, 90).replace(/\n/g, ' ')}`];
});
check('E8', 'Java: impl changes, callers depend on the interface', () => {
  const d = repo({
    'src/main/java/com/acme/OrderService.java': 'package com.acme;\npublic interface OrderService { void cancel(String id); }\n',
    'src/main/java/com/acme/impl/OrderServiceImpl.java': 'package com.acme.impl;\nimport com.acme.OrderService;\nimport org.springframework.stereotype.Service;\n@Service\npublic class OrderServiceImpl implements OrderService { public void cancel(String id) {} }\n',
    'src/main/java/com/acme/web/OrderController.java': 'package com.acme.web;\nimport com.acme.OrderService;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  private final OrderService service;\n  public OrderController(OrderService service) { this.service = service; }\n  @PostMapping("/{id}/cancel")\n  public void cancel(@PathVariable String id) { service.cancel(id); }\n}\n' });
  branch(d, 'f', { 'src/main/java/com/acme/impl/OrderServiceImpl.java': 'package com.acme.impl;\nimport com.acme.OrderService;\nimport org.springframework.stereotype.Service;\n@Service\npublic class OrderServiceImpl implements OrderService { public void cancel(String id) { throw new IllegalStateException(); } }\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/main/java/com/acme/web/OrderController.java'), `radius=${r?.radius?.map((x) => x.file.split('/').pop())}`];
});
check('E9', 'Java: @Autowired field injection', () => {
  const d = repo({
    'src/main/java/com/acme/Mailer.java': 'package com.acme;\npublic class Mailer { public void send() {} }\n',
    'src/main/java/com/acme/web/Ctl.java': 'package com.acme.web;\nimport com.acme.Mailer;\nimport org.springframework.beans.factory.annotation.Autowired;\npublic class Ctl {\n  @Autowired private Mailer mailer;\n  public void go() { mailer.send(); }\n}\n' });
  branch(d, 'f', { 'src/main/java/com/acme/Mailer.java': 'package com.acme;\npublic class Mailer { public void send() { System.out.println(1); } }\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/main/java/com/acme/web/Ctl.java'), `radius=${r?.radius?.map((x) => x.file.split('/').pop())}`];
});
check('E10', 'deleted file whose importers were NOT updated', () => {
  const d = repo({ 'src/money.ts': 'export const m=1;\n', 'src/cart.ts': "import { m } from './money';\nexport const c=m;\n" });
  g(d, 'checkout', '-qb', 'f'); g(d, 'rm', '-q', 'src/money.ts'); g(d, 'commit', '-qm', 'delete');
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/cart.ts'), `radius=${r?.radius?.map((x) => x.file)}`];
});
check('E11', '1,500-file PR does not fall over', () => {
  const files = {}; for (let i = 0; i < 1500; i++) files[`src/m${i}.ts`] = `export const v${i}=${i};\n`;
  const d = repo(files); const ch = {}; for (let i = 0; i < 1500; i++) ch[`src/m${i}.ts`] = `export const v${i}=${i + 1};\n`;
  branch(d, 'f', ch); const t = Date.now(); const { r, code } = teslon(d, 'pr', 'main', 'f');
  const ms = Date.now() - t; return [code === 0 && r?.radius?.length === 1500 && ms < 60000, `${ms}ms radius=${r?.radius?.length}`];
});
check('E12', 'mode-only change (chmod +x) is not a phantom behaviour change', () => {
  const d = repo({ 'scripts/run.sh': 'echo hi\n' }); g(d, 'checkout', '-qb', 'f'); chmodSync(join(d, 'scripts/run.sh'), 0o755); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'chmod');
  const { r, code } = teslon(d, 'pr', 'main', 'f'); return [code === 0, `files=${r?.change?.files}`];
});
check('E13', 'Python file changed: not a silent empty radius', () => {
  const d = repo({ 'app/billing.py': 'def total(): return 1\n', 'app/views.py': 'from app.billing import total\n' });
  branch(d, 'f', { 'app/billing.py': 'def total(): return 2\n' });
  const { r } = teslon(d, 'pr', 'main', 'f');
  const said = (r?.completeness?.unreadable ?? []).includes('app/billing.py') || lim(r, /not code Teslon reads|language/i);
  return [said, `unreadable=${r?.completeness?.unreadable}`];
});
check('E14', 'detached HEAD (CI checks out a sha)', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n', 'src/b.ts': "import {a} from './a';\n" });
  branch(d, 'f', { 'src/a.ts': 'export const a=2;\n' }); const sha = g(d, 'rev-parse', 'HEAD'); g(d, 'checkout', '-q', sha);
  const { r, code } = teslon(d, 'pr', 'main', 'HEAD'); return [code === 0 && inR(r, 'src/b.ts'), `code=${code}`];
});
check('E15', 'barrel re-export chain', () => {
  const d = repo({ 'src/core/price.ts': 'export const p=1;\n', 'src/core/index.ts': "export * from './price';\n", 'src/index.ts': "export * from './core';\n", 'src/app.ts': "import { p } from './index';\n" });
  branch(d, 'f', { 'src/core/price.ts': 'export const p=2;\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/app.ts'), `radius=${r?.radius?.map((x) => x.file)}`];
});
check('E16', 'Kotlin in a JVM repo is disclosed', () => {
  const d = repo({ 'src/main/kotlin/Pay.kt': 'class Pay { fun go() = 1 }\n' });
  branch(d, 'f', { 'src/main/kotlin/Pay.kt': 'class Pay { fun go() = 2 }\n' });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [(r?.completeness?.unreadable ?? []).includes('src/main/kotlin/Pay.kt'), `unreadable=${r?.completeness?.unreadable}`];
});
check('E17', 'git submodule pointer moved', () => {
  const sub = repo({ 'lib.ts': 'export const s=1;\n' });
  const d = repo({ 'src/a.ts': 'export const a=1;\n' });
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub'], { cwd: d, stdio: 'ignore' }); g(d, 'commit', '-qm', 'sub');
  g(d, 'checkout', '-qb', 'f'); g(sub, 'commit', '--allow-empty', '-qm', 'x');
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'pull', '-q'], { cwd: join(d, 'vendor/sub'), stdio: 'ignore' }); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'bump');
  const { r, code } = teslon(d, 'pr', 'main', 'f'); return [code === 0 && (lim(r, /submodule|not present|not code/i)), `code=${code} files=${r?.change?.files} lims=${r?.limitations?.map((l) => l.what.slice(0, 50))}`];
});

check('E18', 'Java: two implementations → kept, and marked unknown', () => {
  const j = (p, c) => [`src/main/java/com/acme/${p}`, c];
  const d = repo(Object.fromEntries([
    j('Pay.java', 'package com.acme;\npublic interface Pay { void go(); }\n'),
    j('impl/StripePay.java', 'package com.acme.impl;\nimport com.acme.Pay;\npublic class StripePay implements Pay { public void go() {} }\n'),
    j('impl/PaypalPay.java', 'package com.acme.impl;\nimport com.acme.Pay;\npublic class PaypalPay implements Pay { public void go() {} }\n'),
    j('web/Checkout.java', 'package com.acme.web;\nimport com.acme.Pay;\npublic class Checkout { private final Pay pay; public Checkout(Pay pay) { this.pay = pay; } }\n'),
  ]));
  branch(d, 'f', { 'src/main/java/com/acme/impl/StripePay.java': 'package com.acme.impl;\nimport com.acme.Pay;\npublic class StripePay implements Pay { public void go() { int x = 1; } }\n' });
  const { r } = teslon(d, 'pr', 'main', 'f');
  const pay = r?.radius?.find((x) => x.file.endsWith('/Pay.java'));
  return [inR(r, 'src/main/java/com/acme/web/Checkout.java') && pay?.band === 'unknown', `payBand=${pay?.band} radius=${r?.radius?.map((x) => x.file.split('/').pop())}`];
});
check('E19', 'TypeScript: NestJS-style abstract class implemented elsewhere', () => {
  const d = repo({
    'src/pay/gateway.ts': 'export abstract class PaymentGateway { abstract charge(n: number): Promise<void>; }\n',
    'src/pay/stripe.ts': "import { PaymentGateway } from './gateway';\nexport class StripeGateway extends PaymentGateway { async charge(n: number) {} }\n",
    'src/checkout/checkout.service.ts': "import { PaymentGateway } from '../pay/gateway';\nexport class CheckoutService { constructor(private readonly gw: PaymentGateway) {} }\n",
  });
  branch(d, 'f', { 'src/pay/stripe.ts': "import { PaymentGateway } from './gateway';\nexport class StripeGateway extends PaymentGateway { async charge(n: number) { if (n < 0) throw new Error('neg'); } }\n" });
  const { r } = teslon(d, 'pr', 'main', 'f'); return [inR(r, 'src/checkout/checkout.service.ts'), `radius=${r?.radius?.map((x) => x.file)}`];
});
check('E20', 'flags anywhere: `pr --json main f` and `--junit out` do not become refs/files', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n' }); branch(d, 'f', { 'src/a.ts': 'export const a=2;\n' });
  let out = ''; let code = 0;
  try { out = execFileSync('node', [CLI, 'pr', '--json', 'main', 'f', '--junit', join(d, 'j.xml')], { cwd: d, encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, TESLON_ROOT: d } }); } catch (e) { code = e.status; out = String(e.stderr); }
  const r = code === 0 ? JSON.parse(out.slice(out.indexOf('{'))) : null;
  return [code === 0 && r.change.files.includes('src/a.ts'), `code=${code} ${out.slice(0, 80)}`];
});
check('E21', 'the temp worktree is always cleaned up', () => {
  const d = repo({ 'src/a.ts': 'export const a=1;\n' }); branch(d, 'f', { 'src/a.ts': 'export const a=2;\n' }); g(d, 'checkout', '-q', 'main');
  teslon(d, 'pr', 'main', 'f');
  const wts = g(d, 'worktree', 'list').split('\n').length; return [wts === 1, `worktrees=${wts}`];
});

for (const x of results) {
  test(`${x.id} · ${x.name}`, () => assert.ok(x.ok, x.note));
}
