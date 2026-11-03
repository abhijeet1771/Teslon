import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { impact } from '../dist/index.js';
import { snapshot } from '../dist/engine/snapshot.js';
import { readAngular } from '../dist/engine/angular.js';

/**
 * An Angular front end, read with Angular's own template parser and the
 * TypeScript compiler: lazy route files, a resolver that feeds a screen its
 * data, a service whose URL is built from an unresolved base, components
 * drawn by selector, and a navbar in a named outlet. Then a Spring change
 * followed through to those screens.
 */

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };

const J = 'src/main/java/com/acme/shop';
const A = 'src/main/webapp/app';
const item = (json) => `package com.acme.shop;

public class Item {
  private Long id;
${json ? '  @com.fasterxml.jackson.annotation.JsonProperty("title")\n' : ''}  private String name;
}
`;
const APP = {
  'tsconfig.json': '{\n  // comments are allowed here\n  "compilerOptions": { "paths": { "app/*": ["./src/main/webapp/app/*"] } }\n}\n',
  'src/main/resources/application.yml': 'spring:\n  application:\n    name: shop\n',
  [`${J}/Item.java`]: item(false),
  [`${J}/ItemResource.java`]: `package com.acme.shop;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ItemResource {
  @GetMapping("/items")
  public java.util.List<Item> all() {
    return null;
  }

  @GetMapping("/items/{id}")
  public Item one(@PathVariable Long id) {
    return null;
  }
}
`,
  [`${J}/PingResource.java`]: `package com.acme.shop;

import org.springframework.web.bind.annotation.*;

@RestController
public class PingResource {
  @GetMapping("/api/ping")
  public String ping() {
    return "ok";
  }
}
`,
  [`${A}/config/index.ts`]: "export * from './endpoint.constants';\n",
  [`${A}/config/endpoint.constants.ts`]: 'declare const SERVER_API_URL: string;\nexport const serverApiUrl = SERVER_API_URL;\n',
  [`${A}/app.routes.ts`]: `import { Routes } from '@angular/router';

const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./home/home'),
  },
  {
    path: '',
    loadComponent: () => import('./layouts/navbar/navbar'),
    outlet: 'navbar',
  },
  {
    path: 'items',
    loadChildren: () => import('./items/items.routes'),
  },
];

export default routes;
`,
  [`${A}/home/home.ts`]: `import { Component, inject } from '@angular/core';
import { PingService } from './ping.service';

@Component({
  selector: 'app-home',
  template: \`<h1>Welcome</h1>
<p>{{ status() }}</p>\`,
})
export default class Home {
  private readonly ping = inject(PingService);
}
`,
  [`${A}/home/ping.service.ts`]: `import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class PingService {
  private readonly http = inject(HttpClient);

  ping() {
    return this.http.get<string>('/api/ping');
  }
}
`,
  [`${A}/layouts/navbar/navbar.ts`]: `import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-navbar',
  template: '<nav><a routerLink="/items">Items</a><button (click)="open.update(o => !o)">Menu</button></nav>',
})
export default class Navbar {
  readonly open = signal(false);
}
`,
  [`${A}/items/items.routes.ts`]: `import { Routes } from '@angular/router';
import { ItemResolve } from './item.resolve';

const itemRoutes: Routes = [
  {
    path: '',
    loadComponent: () => import('./list/item-list').then(m => m.ItemList),
  },
  {
    path: ':id/view',
    loadComponent: () => import('./detail/item-detail').then(m => m.ItemDetail),
    resolve: {
      item: ItemResolve,
    },
  },
];

export default itemRoutes;
`,
  [`${A}/items/item.model.ts`]: 'export interface IItem {\n  id: number;\n  name?: string | null;\n}\n',
  [`${A}/items/item.service.ts`]: `import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { serverApiUrl } from 'app/config';
import { IItem } from './item.model';

@Injectable({ providedIn: 'root' })
export class ItemService {
  protected readonly http = inject(HttpClient);
  protected readonly resourceUrl = \`\${serverApiUrl}api/items\`;

  find(id: number) {
    return this.http.get<IItem>(\`\${this.resourceUrl}/\${encodeURIComponent(id)}\`);
  }

  query() {
    return this.http.get<IItem[]>(this.resourceUrl);
  }
}
`,
  [`${A}/items/item.resolve.ts`]: `import { inject } from '@angular/core';
import { ItemService } from './item.service';

export const ItemResolve = (route: { params: { id: number } }) => inject(ItemService).find(route.params.id);
`,
  [`${A}/items/list/item-list.ts`]: `import { Component, inject } from '@angular/core';
import { ItemService } from '../item.service';

@Component({
  selector: 'app-item-list',
  templateUrl: './item-list.html',
})
export class ItemList {
  private readonly items = inject(ItemService);
}
`,
  [`${A}/items/list/item-list.html`]: `<h2>
  <span>Items</span>
  <button type="button">Refresh</button>
</h2>
@for (item of items(); track item.id) {
  <app-badge [item]="item"></app-badge>
  <a [routerLink]="['/items', item.id, 'view']">{{ item.name }}</a>
}
`,
  [`${A}/items/detail/item-detail.ts`]: `import { Component, input } from '@angular/core';
import { IItem } from '../item.model';

@Component({
  selector: 'app-item-detail',
  template: '<h2>Item</h2><dl><dt>Name</dt><dd>{{ item()?.name }}</dd></dl>',
})
export class ItemDetail {
  readonly item = input<IItem | null>(null);
}
`,
  [`${A}/shared/badge.ts`]: `import { Component, input } from '@angular/core';

@Component({
  selector: 'app-badge',
  template: '<span class="badge">{{ item().id }}</span>',
})
export class Badge {
  readonly item = input.required<{ id: number }>();
}
`,
};

let dir;
const setup = () => {
  if (dir) return dir;
  dir = mkdtempSync(join(tmpdir(), 'teslon-ng-'));
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 'T'); g(dir, 'config', 'commit.gpgsign', 'false');
  put(dir, APP); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'base');
  put(dir, { [`${J}/Item.java`]: item(true) }); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'json name');
  return dir;
};
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('Angular: lazy route files become screens, with their full paths', () => {
  const f = readAngular(snapshot(setup(), 'HEAD'));
  assert.deepEqual(f.routes.map((r) => r.path).sort(), ['/', '/items', '/items/:id/view']);
  const list = f.routes.find((r) => r.path === '/items');
  assert.equal(list.component, `${A}/items/list/item-list.ts`);
  assert.equal(list.file, `${A}/items/items.routes.ts`);
  assert.equal(list.quote, 'path', 'the child route file says path: \'\' on that line, not "items"');
  assert.deepEqual(f.globals.map((x) => [x.tag, x.file]), [['app-navbar', `${A}/layouts/navbar/navbar.ts`]], 'a named outlet is on every screen');
});

test('Angular: service calls with URLs built from an unresolved base, a const in another file and this.resourceUrl', () => {
  const f = readAngular(snapshot(setup(), 'HEAD'));
  const calls = f.calls.map((c) => `${c.verbs.join('/')} ${c.tpl}${c.baseAssumed ? ' *' : ''} <${c.resultType ?? ''}>`).sort();
  assert.deepEqual(calls, ['GET /api/items * <IItem[]>', 'GET /api/items/{*} * <IItem>', 'GET /api/ping <string>']);
});

test('Angular: a screen includes its template, the components it draws by selector, and its route\'s resolver', () => {
  const f = readAngular(snapshot(setup(), 'HEAD'));
  const list = f.components.get(`${A}/items/list/item-list.ts`);
  assert.ok(list.deps.includes(`${A}/items/list/item-list.html`));
  assert.ok(list.deps.includes(`${A}/shared/badge.ts`), 'drawn as <app-badge>');
  assert.equal(list.elements.find((e) => e.tag === 'h2').text, 'Items', 'a heading without the buttons inside it');
  assert.deepEqual(list.links.map((l) => l.target), ['/items/*/view']);
  const detail = f.components.get(`${A}/items/detail/item-detail.ts`);
  assert.ok(detail.deps.includes(`${A}/items/item.resolve.ts`), 'the resolver loads its data');
  assert.equal(detail.depFiles[`${A}/items/item.resolve.ts`], `${A}/items/items.routes.ts`);
  // an arrow function in a template parses
  assert.equal(f.components.get(`${A}/layouts/navbar/navbar.ts`).opaque.length, 0);
});

test('Angular: a change to what an API returns reaches the screens that load it, and only those', () => {
  const r = impact({ repo: setup(), base: 'HEAD~1', head: 'HEAD' });
  const screens = r.surfaces.filter((s) => s.kind === 'screen');
  const reached = screens.filter((s) => s.tier !== 'skip').map((s) => s.where).sort();
  assert.deepEqual(reached, ['/items', '/items/:id/view']);
  assert.deepEqual(screens.filter((s) => s.tier === 'skip').map((s) => s.where), ['/'], 'home calls only /api/ping');
  assert.equal(r.verification.failed.length, 0, JSON.stringify(r.verification.failed));
  assert.ok(!r.unseen.some((u) => /Angular/.test(u.what)), 'the Angular front end is read, not reported as unseen');
  const viaResolver = r.cases.find((c) => c.surface === 'screen:/items/:id/view');
  assert.ok(viaResolver.hops.some((h) => h.file === `${A}/items/items.routes.ts` && /uses item\.resolve\.ts/.test(h.rule)));
});
