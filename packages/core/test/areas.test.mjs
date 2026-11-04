import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { impact, brief, unnamed, renderHtml, renderComment } from '../dist/index.js';

/**
 * The report as QA decides on it: every area of the app is test, skip or
 * unclear, grouped by module, with how sure Teslon is in words. Run on
 * OrderDesk, the proving-ground app, with a real change.
 */

const APP = fileURLToPath(new URL('../../../fixtures/orderdesk', import.meta.url));
const J = 'src/main/java/com/orderdesk';
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo(change, prepare) {
  const d = mkdtempSync(join(tmpdir(), 'teslon-areas-'));
  cpSync(APP, d, { recursive: true });
  prepare?.(d);
  g(d, 'init', '-q', '-b', 'main');
  g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); g(d, 'config', 'commit.gpgsign', 'false');
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'app');
  const base = g(d, 'rev-parse', 'HEAD');
  change(d);
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'change');
  return { d, base, head: g(d, 'rev-parse', 'HEAD') };
}
const edit = (d, f, from, to) => { const t = readFileSync(join(d, f), 'utf8'); assert.ok(t.includes(from), `${f}: ${from}`); writeFileSync(join(d, f), t.replace(from, to)); };
const put = (d, f, c) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), c); };
const moveCancel = (d) => edit(d, `${J}/web/rest/OrderResource.java`, '@PostMapping("/{id}/cancel")', '@PatchMapping("/{id}/cancellation")');

test('every screen and job of the app gets exactly one answer, grouped by module, and the skips carry proof', () => {
  const { d, base, head } = repo(moveCancel);
  try {
    const r = impact({ repo: d, base, head });
    const b = brief(r);
    assert.equal(b.confidence.level, 'high');
    assert.match(b.confidence.detail, /Every changed line is accounted for/);
    // one answer per area, never two
    const ids = b.areas.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(b.test + b.skip + b.unclear, b.areas.length);
    // the whole front end is on the map: every route is an area
    const routes = r.surfaces.filter((s) => s.kind === 'screen').length + (r.held ?? []).filter((h) => (h.kind ?? 'screen') === 'screen').length;
    assert.equal(b.areas.filter((a) => a.kind === 'screen').length, routes);
    assert.ok(routes >= 12, `OrderDesk has a dozen screens, the map has ${routes}`);
    // modules are what the team calls them, from routes and paths
    const mod = (name) => b.modules.find((m) => m.name === name);
    assert.ok(mod('Orders')?.test, 'the moved endpoint is tested under Orders');
    assert.ok(b.areas.filter((a) => a.id.startsWith('api:')).every((a) => a.module === 'Orders'));
    assert.ok(mod('Customers') && mod('Customers').skip === mod('Customers').areas.length, 'Customers is untouched: every area skipped');
    assert.equal(b.modules[0].name, 'Orders', 'what breaks first comes first');
    // a skip names why and the line that shows it
    for (const a of b.areas.filter((x) => x.state === 'skip')) {
      assert.ok(a.why && !/ of $/.test(a.why), `${a.id}: ${a.why}`);
      assert.ok(a.evidence.length, a.id);
    }
    // a screen that calls the changed API but shows nothing traced is unclear, with why, not dropped into a sentence
    const unclear = b.areas.filter((a) => a.state === 'unclear');
    assert.ok(unclear.length);
    for (const a of unclear) assert.match(a.why, /traced|follow/);
    assert.ok(!b.unseen.some((u) => /could not be ruled out/.test(u.what)), 'the map shows them, so "could not see" does not repeat them');
    assert.ok(r.unseen.some((u) => /could not be ruled out/.test(u.what)), 'the report itself still says it');
    // removed endpoint: proven, not guessed
    assert.equal(b.changes.find((c) => c.id.startsWith('api-gone:'))?.known, 'proven');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('with changed lines Teslon did not follow, nothing is skipped: screens and jobs are unclear, and confidence says partial', () => {
  const { d, base, head } = repo((dir) => {
    moveCancel(dir);
    put(dir, 'tools/fix_totals.py', 'import sys\n\nfor line in sys.stdin:\n    print(line.strip().upper())\n');
  });
  try {
    const r = impact({ repo: d, base, head });
    assert.equal(r.triage.appEffect, 'unknown');
    const b = brief(r);
    assert.equal(b.confidence.level, 'partial');
    assert.match(b.confidence.detail, /did not follow \(fix_totals\.py\)/);
    assert.ok(!r.surfaces.some((s) => s.tier === 'skip' && (s.kind === 'screen' || s.kind === 'job')), 'no screen or job is called safe');
    const jobs = b.areas.filter((a) => a.kind === 'job');
    assert.ok(jobs.length >= 2, 'the jobs are on the map');
    for (const a of jobs) { assert.equal(a.state, 'unclear', a.id); assert.match(a.why, /did not follow/); }
    assert.ok(r.unseen.some((u) => /job/.test(u.what) && /not reached/.test(u.what)));
    const h = renderHtml(r, { number: 9, baseRef: 'main', state: 'open', how: 'x', version: 't' });
    assert.match(h, /Partial confidence/);
    assert.match(h, /none until every line is followed/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('what the developer said, against what the change reaches', () => {
  const { d, base, head } = repo(moveCancel);
  try {
    const b = brief(impact({ repo: d, base, head }));
    assert.deepEqual(unnamed(b, 'REST cleanup: cancellation is a PATCH now.').slice(0, 1), ['Orders']);
    assert.ok(!unnamed(b, 'Order cancel moved to PATCH').includes('Orders'), 'a module named in the singular counts');
    const c = renderComment(impact({ repo: d, base, head }), { number: 9, title: 'REST cleanup', baseRef: 'main', state: 'open', how: 'x', version: 't' });
    assert.match(c, /Not named in the PR:\*\* Orders/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('what following callers alone misses: an event no longer published, a value no longer stored', async () => {
  const { brief: b0 } = await import('../dist/index.js');
  {
    const { d, base, head } = repo((dir) => edit(dir, `${J}/service/OrderService.java`, '        events.publishEvent(new OrderPlacedEvent(saved.getId()));\n', ''));
    try {
      const r = impact({ repo: d, base, head });
      for (const id of ['job:InvoiceService.onOrderPlaced', 'job:NotificationService.onOrderPlaced']) {
        const s = r.surfaces.find((x) => x.id === id);
        assert.equal(s?.tier, 'test-first', `${id} runs no more: it must be tested first`);
        assert.match(r.cases.find((c) => c.surface === id).expect, /never runs, because nothing publishes OrderPlacedEvent/);
      }
      assert.equal(r.verification.failed.length, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  {
    const { d, base, head } = repo((dir) => edit(dir, `${J}/service/OrderService.java`, '        order.setTotal(pricing.orderTotal(customer, order.getItems()));\n', ''));
    try {
      const r = impact({ repo: d, base, head });
      const b = b0(r);
      for (const id of ['screen:/orders', 'screen:/orders/:id', 'job:InvoiceService.onOrderPlaced']) {
        assert.ok(!r.surfaces.some((s) => s.id === id && s.tier === 'skip'), `${id} shows the total: never safe to skip`);
        const a = b.areas.find((x) => x.id === id);
        assert.ok(a && a.state !== 'skip', id);
      }
      assert.match(b.areas.find((x) => x.id === 'screen:/orders').why, /shows Order data, and this PR changes what is written to Order\.total/);
      assert.equal(r.verification.failed.length, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('an image is never "no app effect": it is followed to where the app names it, or said', () => {
  {
    const { d, base, head } = repo((dir) => put(dir, 'src/main/webapp/content/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"/></svg>\n'));
    try {
      const r = impact({ repo: d, base, head });
      assert.equal(r.triage.appEffect, 'yes');
      assert.ok(r.surfaces.some((s) => s.id === 'screen:*' && s.tier !== 'skip'), 'the navbar shows it on every screen');
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
  {
    const { d, base, head } = repo((dir) => writeFileSync(join(dir, 'src/main/webapp/content/empty-cart.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3])));
    try {
      const r = impact({ repo: d, base, head });
      assert.notEqual(r.triage.appEffect, 'none');
      assert.equal(r.ledger[0].status, 'not-modelled');
      assert.ok(r.unseen.some((u) => /empty-cart\.png/.test(u.what)));
      assert.ok(!r.surfaces.some((s) => s.kind === 'screen' && s.tier === 'skip'));
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('a call written over several lines is cited where the method is named, and its result is still followed into the field', () => {
  const split = (dir) => edit(dir, `${J}/service/OrderService.java`, 'order.setTotal(pricing.orderTotal(customer, order.getItems()));', 'order.setTotal(pricing\n            .orderTotal(customer, order.getItems()));');
  const { d, base, head } = repo((dir) => edit(dir, `${J}/service/PricingService.java`, 'new BigDecimal("0.95")', 'new BigDecimal("0.90")'), split);
  try {
    const r = impact({ repo: d, base, head });
    assert.equal(r.verification.failed.length, 0, r.verification.failed.map((h) => `${h.file}:${h.line} ${h.quote}`).join('; '));
    const why = brief(r).areas.find((a) => a.id === 'screen:/orders')?.why ?? '';
    assert.match(why, /Order\.total/, 'the total is still known to be written by the changed code');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
