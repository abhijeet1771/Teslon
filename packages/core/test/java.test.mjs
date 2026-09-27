import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJava, buildJavaGraph, unresolvedSummary, listFiles, semanticDiff, sortChanges } from '../dist/index.js';

const JAVA = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'fixtures', 'java');
const readAll = () => listFiles(JAVA).filter((f) => f.endsWith('.java')).map((f) => readJava(JAVA, f));
const byName = (name) => readAll().find((r) => r.file.endsWith(name));

test('a Spring controller yields routes built from the class and method mappings', () => {
  const r = byName('OrderController.java');
  assert.equal(r.shape, 'endpoint');
  // @RequestMapping("/api/orders") on the class + @GetMapping("/{id}") on the
  // method is one route, and neither half means anything alone.
  assert.deepEqual(r.httpRoutes, ['GET /api/orders/{id}', 'POST /api/orders/{id}/cancel']);
});

test('constructor injection is read, and an annotation is not mistaken for a type', () => {
  const controller = byName('OrderController.java');
  assert.deepEqual(controller.injected, ['AuditLog', 'OrderService']);

  // Scanning a field for its first capitalised token picked up @Column and
  // reported it as an injected dependency.
  const entity = byName('OrderDto.java');
  assert.ok(!entity.injected.includes('Column'));
});

test('bean validation yields the boundary values', () => {
  const r = byName('OrderController.java');
  const size = r.constraints.find((c) => c.rules.includes('Size'));
  assert.deepEqual(size.boundaries, ['2', '3', '200', '201']);
});

test('the authorisation rule is kept, not just the annotation name', () => {
  assert.equal(byName('OrderController.java').auth, "PreAuthorize(hasRole('ADMIN'))");
});

test('@Transactional marks a service as state-changing', () => {
  assert.equal(byName('OrderService.java').transactional, true);
  assert.equal(byName('OrderRepository.java').transactional, false);
});

test('a JPA entity separates its table from its columns', () => {
  const r = byName('OrderDto.java');
  // Pooling them made "id" and "status" look like tables, which would couple
  // every entity that happens to have an id column.
  assert.deepEqual(r.entityTables, ['orders']);
  assert.deepEqual(r.entityColumns, ['id', 'status', 'total_cents']);
});

test('@DisplayName is the behaviour a JUnit test claims', () => {
  const r = byName('OrderServiceTest.java');
  assert.equal(r.shape, 'test');
  assert.equal(r.claims.length, 2);
  assert.ok(r.claims.some((c) => c.name.includes('shorter than 3 characters')));
});

test('a dependency inside the same package is found although nothing imports it', () => {
  const graph = buildJavaGraph(readAll());
  const implicit = graph.edges.find(
    (e) => e.from.endsWith('OrderService.java') && e.to.endsWith('OrderController.java'),
  );
  // This is the case Teslon exists for: in Java two classes in one package
  // use each other with nothing written down, so following import statements
  // alone misses the coupling entirely.
  assert.ok(implicit, 'same-package dependency was not found');
  assert.match(implicit.why.detail, /same package/);
});

test('a wildcard import widens to the whole package', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-java-'));
  try {
    mkdirSync(join(tmp, 'a'), { recursive: true });
    mkdirSync(join(tmp, 'b'), { recursive: true });
    writeFileSync(join(tmp, 'b', 'One.java'), 'package p.b;\npublic class One { }\n');
    writeFileSync(join(tmp, 'b', 'Two.java'), 'package p.b;\npublic class Two { }\n');
    writeFileSync(join(tmp, 'a', 'User.java'), 'package p.a;\nimport p.b.*;\npublic class User { }\n');

    const readings = listFiles(tmp).map((f) => readJava(tmp, f));
    const edges = buildJavaGraph(readings).edges.filter((e) => e.to === 'a/User.java');
    assert.equal(edges.length, 2, 'a wildcard names no type, so every type in the package is a candidate');
    assert.ok(edges.every((e) => e.why.signal === 'widen'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('imports that leave the repository are reported, not silently dropped', () => {
  const graph = buildJavaGraph(readAll());
  const summary = unresolvedSummary(graph);
  assert.ok(summary.some((s) => s.prefix.startsWith('org.springframework')));
});

test('a file that does not parse is read as unknown rather than disappearing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-java-'));
  try {
    writeFileSync(join(tmp, 'Broken.java'), 'package p;\npublic class Broken { void x( { }\n');
    const r = readJava(tmp, 'Broken.java');
    assert.ok(r);
    assert.equal(r.shape, 'unknown');
    assert.ok(r.notRead.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the semantic diff works on Java unchanged, because the schema is shared', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'teslon-jd-'));
  try {
    mkdirSync(join(tmp, 'a'));
    mkdirSync(join(tmp, 'b'));
    const before = `package p;
import javax.validation.constraints.Size;
public class Api {
  @GetMapping("/x") public String get(@Size(min = 3, max = 20) String q) { return q; }
  public void extra() { }
}`;
    const after = `package p;
import javax.validation.constraints.Size;
public class Api {
  @GetMapping("/x") public String get(@Size(min = 8, max = 20) String q) {
    if (q.startsWith("VIP")) { return "vip"; }
    return q;
  }
}`;
    writeFileSync(join(tmp, 'a', 'Api.java'), before);
    writeFileSync(join(tmp, 'b', 'Api.java'), after);

    const changes = sortChanges(
      semanticDiff(readJava(join(tmp, 'a'), 'Api.java'), readJava(join(tmp, 'b'), 'Api.java')).changes,
    );
    assert.ok(changes.some((c) => c.severity === 'breaking' && /extra/.test(c.what)), 'removed method');
    assert.ok(changes.some((c) => /new branch/.test(c.what)), 'new branch');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Java reading is deterministic', () => {
  assert.equal(JSON.stringify(readAll()), JSON.stringify(readAll()));
});
