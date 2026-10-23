import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { impact, renderText } from '../dist/index.js';

/**
 * The "where" layer: changes whose meaning no rule types are still followed
 * to the APIs, jobs and screens that run them, each with its chain. One small
 * app, one commit per kind of change, each scored on its own.
 */

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };

const J = 'shop/src/main/java/com/acme/shop';
const W = 'shop/src/main/webapp/app';
const BASE = {
  'pom.xml': '<project>\n  <modules>\n    <module>shop</module>\n  </modules>\n</project>\n',
  'shop/pom.xml': `<project>
  <artifactId>shop</artifactId>
  <dependencies>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>money</artifactId>
      <version>1.0.0</version>
    </dependency>
  </dependencies>
</project>
`,
  'shop/src/main/resources/application.yml': 'spring:\n  application:\n    name: shop\n',
  [`${J}/Order.java`]: `package com.acme.shop;

public class Order {
  private Long id;
  private String status;
}
`,
  [`${J}/OrderService.java`]: `package com.acme.shop;

public interface OrderService {
  Order find(Long id);
  java.util.List<Order> all();
}
`,
  [`${J}/OrderServiceImpl.java`]: `package com.acme.shop;

public class OrderServiceImpl implements OrderService {
  public Order find(Long id) {
    return null;
  }

  public java.util.List<Order> all() {
    return null;
  }
}
`,
  [`${J}/OrderController.java`]: `package com.acme.shop;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  private OrderService orders;

  @GetMapping("/{id}")
  public Order one(@PathVariable Long id) {
    return orders.find(id);
  }

  @GetMapping
  public java.util.List<Order> list() {
    return orders.all();
  }
}
`,
  [`${W}/main.js`]: "import { createApp } from 'vue';\nimport Root from './Root.vue';\nimport './styles/global.css';\n\ncreateApp(Root).mount('#app');\n",
  [`${W}/Root.vue`]: '<template>\n  <div>\n    <router-view/>\n  </div>\n</template>\n<script>\nexport default {};\n</script>\n',
  [`${W}/styles/global.css`]: 'body { margin: 0; }\n',
  [`${W}/router.js`]: "import OrderList from './views/OrderList.vue';\nimport OrderView from './views/OrderView.vue';\nimport Help from './views/Help.vue';\n\nexport const routes = [\n  { path: '/orders', component: OrderList },\n  { path: '/orders/:id', component: OrderView },\n  { path: '/help', component: Help },\n];\n",
  [`${W}/components/StatusBadge.vue`]: '<template>\n  <span class="badge">{{ status }}</span>\n</template>\n<script>\nexport default { props: [\'status\'] };\n</script>\n',
  [`${W}/views/OrderList.vue`]: `<template>
  <div>
    <h2>Orders</h2>
    <table>
      <tr v-for="o in orders"><td>{{ o.id }}</td><td><status-badge :status="o.status"/></td></tr>
    </table>
  </div>
</template>
<script>
import axios from 'axios';
import StatusBadge from '../components/StatusBadge.vue';
export default {
  components: { StatusBadge },
  data() { return { orders: [] }; },
  async mounted() { this.orders = (await axios.get('/api/orders')).data; },
};
</script>
`,
  [`${W}/views/OrderView.vue`]: `<template>
  <div>
    <h2>Order</h2>
    <dl><dt>Status</dt><dd>{{ order.status }}</dd></dl>
    <button @click="print">Print</button>
  </div>
</template>
<script>
import axios from 'axios';
import dayjs from 'dayjs';
export default {
  data() { return { order: {} }; },
  async mounted() { this.order = (await axios.get(\`/api/orders/\${this.$route.params.id}\`)).data; },
  methods: { print() { return dayjs().format(); } },
};
</script>
`,
  [`${W}/views/Help.vue`]: '<template>\n  <div><h2>Help</h2></div>\n</template>\n<script>\nexport default {};\n</script>\n',
  'package.json': JSON.stringify({ name: 'shop-ui', dependencies: { axios: '1.6.0', dayjs: '1.11.0', vue: '3.4.0' }, devDependencies: { eslint: '9.0.0' } }, null, 2) + '\n',
  'docker-compose.yml': 'services:\n  shop:\n    image: acme/shop:1.0\n    ports:\n      - "8080:8080"\n',
  'README.md': '# Shop\n',
  '.github/workflows/ci.yml': 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n',
};

let dir;
const runs = {};
const commit = (name, files) => {
  put(dir, files); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', name);
  runs[name] = impact({ repo: dir, base: 'HEAD~1', head: 'HEAD', today: '2026-10-23' });
};

test('setup', () => {
  dir = mkdtempSync(join(tmpdir(), 'teslon-where-'));
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 'T');
  put(dir, BASE); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'base');
  commit('impl', { [`${J}/OrderServiceImpl.java`]: BASE[`${J}/OrderServiceImpl.java`].replace('  public Order find(Long id) {\n    return null;', '  public Order find(Long id) {\n    if (id == null) throw new IllegalArgumentException();\n    return null;') });
  commit('type', { [`${J}/Order.java`]: BASE[`${J}/Order.java`].replace('  private String status;', '  private String status;\n  private String note;') });
  commit('shared-ui', { [`${W}/components/StatusBadge.vue`]: BASE[`${W}/components/StatusBadge.vue`].replace('class="badge"', 'class="badge badge-pill"') });
  commit('own-ui', { [`${W}/views/OrderView.vue`]: BASE[`${W}/views/OrderView.vue`].replace('<button @click="print">Print</button>', '<button @click="print">Print order</button>') });
  commit('global-css', { [`${W}/styles/global.css`]: 'body { margin: 0; font-family: sans-serif; }\n' });
  commit('pom', { 'shop/pom.xml': BASE['shop/pom.xml'].replace('<version>1.0.0</version>', '<version>2.0.0</version>') });
  commit('npm', { 'package.json': BASE['package.json'].replace('"dayjs": "1.11.0"', '"dayjs": "1.12.0"') });
  commit('compose', { 'docker-compose.yml': BASE['docker-compose.yml'].replace('acme/shop:1.0', 'acme/shop:1.1') });
  // a private helper the endpoint calls in the same class
  commit('helper', { [`${J}/OrderController.java`]: BASE[`${J}/OrderController.java`].replace('    return orders.all();\n  }', '    return sorted(orders.all());\n  }\n\n  private java.util.List<Order> sorted(java.util.List<Order> all) {\n    return all;\n  }') });
  commit('helper2', { [`${J}/OrderController.java`]: (BASE[`${J}/OrderController.java`].replace('    return orders.all();\n  }', '    return sorted(orders.all());\n  }\n\n  private java.util.List<Order> sorted(java.util.List<Order> all) {\n    java.util.Collections.reverse(all);\n    return all;\n  }')) });
  // a removed line in a deployment file, and a build-only pom change
  commit('compose-removed', { 'docker-compose.yml': 'services:\n  shop:\n    image: acme/shop:1.1\n' });
  commit('pom-build', { 'shop/pom.xml': BASE['shop/pom.xml'].replace('<version>1.0.0</version>', '<version>2.0.0</version>').replace('</dependencies>', '</dependencies>\n  <build>\n    <plugins>\n      <plugin><artifactId>maven-surefire-plugin</artifactId></plugin>\n    </plugins>\n  </build>') });
  // the list endpoint is removed while its screen still calls it
  commit('endpoint-removed', { [`${J}/OrderController.java`]: (BASE[`${J}/OrderController.java`].replace('  @GetMapping\n  public java.util.List<Order> list() {\n    return orders.all();\n  }\n', '')) });
  commit('docs-ci', { 'README.md': '# Shop\n\nRun it with docker compose.\n', '.github/workflows/ci.yml': 'on: [push, pull_request]\njobs:\n  build:\n    runs-on: ubuntu-latest\n' });
});

const s = (r, id) => r.surfaces.find((x) => x.id === id);
const cs = (r, id) => r.cases.filter((c) => c.surface === id);
const allVerified = (r) => assert.deepEqual(r.verification.failed.map((h) => `${h.file}:${h.line} [${h.quote}]`), []);

test('a changed method behind an interface reaches the endpoint, its screen, and nothing else', () => {
  const r = runs.impl;
  allVerified(r);
  assert.equal(s(r, 'api:GET /api/orders/{id}').tier, 'test-next');
  assert.equal(s(r, 'api:GET /api/orders'), undefined, 'list() does not call find()');
  const view = cs(r, 'screen:/orders/:id')[0];
  assert.ok(view, 'the order screen calls GET /api/orders/{id}');
  assert.deepEqual(view.hops.map((h) => h.label), ['Changed', 'Called by', 'API', 'The page calls it', 'Screen']);
  assert.match(view.hops[1].rule, /OrderController\.one\(\) calls OrderService\.find\(\)/);
  assert.equal(r.ledger.find((l) => l.file.endsWith('OrderServiceImpl.java')).status, 'followed');
  // everything was followed, so the screens that run none of it are skipped with proof
  assert.equal(s(r, 'screen:/help').tier, 'skip');
  assert.equal(s(r, 'screen:/orders').tier, 'skip');
});

test('a changed type reaches every endpoint that returns it', () => {
  const r = runs.type;
  allVerified(r);
  assert.ok(s(r, 'api:GET /api/orders/{id}'));
  assert.ok(s(r, 'api:GET /api/orders'));
  assert.ok(s(r, 'screen:/orders') && s(r, 'screen:/orders/:id'));
});

test('a shared component: the screens that draw it; the screen\'s own component: test first, with what changed on it', () => {
  const shared = runs['shared-ui'];
  allVerified(shared);
  assert.equal(s(shared, 'screen:/orders').tier, 'test-next');
  // the order screen does not draw the badge, and everything was followed: skipped, with what it calls
  assert.equal(s(shared, 'screen:/orders/:id').tier, 'skip');
  assert.ok(cs(shared, 'screen:/orders')[0].hops.some((h) => h.label === 'Uses' && h.file.endsWith('OrderList.vue')));
  const own = runs['own-ui'];
  allVerified(own);
  assert.equal(s(own, 'screen:/orders/:id').tier, 'test-first');
  assert.match(cs(own, 'screen:/orders/:id')[0].do, /button "Print order"/);
});

test('a global stylesheet is every screen', () => {
  const r = runs['global-css'];
  assert.equal(s(r, 'screen:*').name, 'Every screen');
  assert.match(cs(r, 'screen:*')[0].do, /how it looks/);
});

test('a dependency bump: the module, its APIs and their screens, with the versions', () => {
  const r = runs.pom;
  allVerified(r);
  assert.equal(s(r, 'module:shop').kind, 'module');
  assert.match(cs(r, 'module:shop')[0].expect, /com\.acme:money 1\.0\.0 → 2\.0\.0/);
  assert.ok(s(r, 'api:GET /api/orders') && s(r, 'api:GET /api/orders/{id}'));
  const n = runs.npm;
  allVerified(n);
  assert.ok(s(n, 'screen:/orders/:id'), 'OrderView imports dayjs');
  assert.equal(s(n, 'screen:/orders').tier, 'skip');
});

test('deployment files: what to check after deploy', () => {
  const r = runs.compose;
  allVerified(r);
  assert.equal(s(r, 'deploy:docker-compose.yml').tier, 'watch');
  assert.match(cs(r, 'deploy:docker-compose.yml')[0].do, /shop service: image: acme\/shop:1\.1/);
});

test('a helper the endpoint calls in its own class is followed to that endpoint', () => {
  const r = runs.helper2;
  allVerified(r);
  const list = cs(r, 'api:GET /api/orders')[0];
  assert.ok(list, 'sorted() is called by list()');
  assert.match(list.hops.find((h) => h.label === 'Called by').rule, /OrderController\.list\(\) calls OrderController\.sorted\(\)/);
});

test('removing is a change: a removed deployment line is checked, read from base', () => {
  const r = runs['compose-removed'];
  allVerified(r);
  const c = cs(r, 'deploy:docker-compose.yml').find((x) => /removed/.test(x.do));
  assert.ok(c);
  assert.equal(c.hops[0].side, 'base');
  assert.notEqual(r.ledger[0].status, 'no-runtime-effect');
});

test('a build section of a pom changes nothing that runs', () => {
  const r = runs['pom-build'];
  assert.equal(r.triage.appEffect, 'none');
  assert.match(r.ledger[0].reason, /build section/);
});

test('a removed API is test first, and the screen that still calls it is named', () => {
  const r = runs['endpoint-removed'];
  allVerified(r);
  assert.equal(s(r, 'api:GET /api/orders').tier, 'test-first');
  assert.match(s(r, 'api:GET /api/orders').name, /removed/);
  const screen = cs(r, 'screen:/orders').find((c) => /removed/.test(c.expect));
  assert.ok(screen, 'OrderList still calls GET /api/orders');
  assert.equal(s(r, 'screen:/orders').tier, 'test-first');
});

test('docs and CI only: no effect on the running app, said first', () => {
  const r = runs['docs-ci'];
  assert.equal(r.triage.appEffect, 'none');
  assert.equal(r.surfaces.length, 0);
  assert.ok(r.ledger.every((l) => l.status === 'no-runtime-effect'));
  assert.match(renderText(r), /No effect on the running app: 2 files \(ci, docs\)\. Nothing to test in the app\./);
});

test('cleanup', () => { if (dir) rmSync(dir, { recursive: true, force: true }); });
