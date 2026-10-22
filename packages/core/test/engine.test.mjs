import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { impact, renderText } from '../dist/index.js';

/**
 * The engine on a small monolith written in a different style from the repo it
 * was first built against: no gateway, axios instead of a fetch wrapper, the
 * whole form model sent as the body, an inline object on the create screen.
 * The change turns on Bean Validation for a body that already carried rules,
 * adds one rule, and touches a pricing line no rule models.
 */

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (d, files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); } };

const J = 'src/main/java/com/acme/pets';
const BASE = {
  'src/main/resources/application.yml': 'spring:\n  application:\n    name: shop\n',
  [`${J}/PetForm.java`]: `package com.acme.pets;

import jakarta.validation.constraints.NotBlank;
import java.time.LocalDate;

public class PetForm {
  @NotBlank
  private String name;
  private LocalDate birthDate;
}
`,
  [`${J}/Pet.java`]: `package com.acme.pets;

import jakarta.persistence.*;
import java.time.LocalDate;

@Entity
@Table(name = "pets")
public class Pet {
  @Id
  private Long id;
  private String name;
  @Column(name = "birth_date")
  private LocalDate birthDate;
}
`,
  [`${J}/PetController.java`]: `package com.acme.pets;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/pets")
public class PetController {
  @GetMapping
  public java.util.List<Pet> list() { return null; }

  @PostMapping
  public Pet create(@RequestBody PetForm form) { return null; }

  @PutMapping("/{id}")
  public Pet update(@PathVariable Long id, @RequestBody PetForm form) { return null; }
}
`,
  [`${J}/PriceService.java`]: `package com.acme.pets;

public class PriceService {
  public double price(double base) {
    return base * 0.9;
  }
}
`,
  [`${J}/Reminders.java`]: `package com.acme.pets;

import org.springframework.scheduling.annotation.Scheduled;

public class Reminders {
  @Scheduled(cron = "0 0 8 * * *")
  public void send() {
    Pet p = null;
  }

  @Scheduled(fixedRate = 60000)
  public void heartbeat() {
    System.out.println("ok");
  }
}
`,
  'src/main/resources/db/data.sql': "INSERT INTO pets (id, name, birth_date) VALUES (1, 'Rex', '2020-01-01'), (2, 'Max', '2099-05-05');\n",
  'frontend/src/router.js': `import PetList from './views/PetList.vue';
import PetEdit from './views/PetEdit.vue';
import PetNew from './views/PetNew.vue';
import About from './views/About.vue';

export const routes = [
  { path: '/pets', component: PetList },
  { path: '/pets/:id/edit', component: PetEdit },
  { path: '/pets/new', component: PetNew },
  { path: '/about', component: About },
];
`,
  'frontend/src/views/PetEdit.vue': `<template>
  <form @submit.prevent="save">
    <h2>Edit pet</h2>
    <label for="nm">Name</label>
    <input id="nm" v-model.trim="pet.name" required>
    <label for="bd">Birth date</label>
    <input id="bd" type="date" v-model="pet.birthDate">
    <button type="submit">Save</button>
  </form>
</template>
<script>
import axios from 'axios';
export default {
  data() { return { pet: {} }; },
  methods: {
    async save() {
      await axios.put(\`/api/pets/\${this.$route.params.id}\`, this.pet);
      this.$router.push('/pets');
    },
  },
};
</script>
`,
  'frontend/src/views/PetNew.vue': `<template>
  <form @submit.prevent="add">
    <h2>New pet</h2>
    <label for="n2">Name</label>
    <input id="n2" v-model="name">
    <label for="b2">Born</label>
    <input id="b2" type="date" v-model="birthDate">
    <button type="submit">Add</button>
  </form>
</template>
<script>
import axios from 'axios';
export default {
  data() { return { name: '', birthDate: '' }; },
  methods: {
    async add() {
      await axios.post('/api/pets', { name: this.name, birthDate: this.birthDate });
    },
  },
};
</script>
`,
  'frontend/src/views/PetList.vue': `<template>
  <div>
    <h2>Pets</h2>
    <table>
      <tr><th>Born</th></tr>
      <tr v-for="pet in pets"><td>{{ pet.birthDate }}</td>
        <td><router-link :to="'/pets/' + pet.id + '/edit'">Edit</router-link></td></tr>
    </table>
  </div>
</template>
<script>
import axios from 'axios';
export default {
  data() { return { pets: [] }; },
  async mounted() { this.pets = (await axios.get('/api/pets')).data; },
};
</script>
`,
  'frontend/src/views/About.vue': '<template><div><h2>About</h2></div></template>\n<script>\nexport default {};\n</script>\n',
  'ops/dashboards/app.json': JSON.stringify({
    title: 'Shop',
    panels: [
      { title: 'Client errors', targets: [{ expr: 'sum(rate(http_server_requests_seconds_count{uri="/api/pets/{id}", status=~"4.."}[5m]))' }] },
      { title: 'Server errors', targets: [{ expr: 'sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))' }] },
    ],
  }, null, 2) + '\n',
  'requests.http': 'PUT http://localhost:8080/api/pets/1\nContent-Type: application/json\n\n{\n  "name": "Rex",\n  "birthDate": "2099-01-01"\n}\n',
};

const HEAD = {
  [`${J}/PetForm.java`]: BASE[`${J}/PetForm.java`].replace('import jakarta.validation.constraints.NotBlank;', 'import jakarta.validation.constraints.NotBlank;\nimport jakarta.validation.constraints.PastOrPresent;').replace('  private LocalDate birthDate;', '  @PastOrPresent\n  private LocalDate birthDate;'),
  [`${J}/PetController.java`]: BASE[`${J}/PetController.java`].replace('import org.springframework.web.bind.annotation.*;', 'import jakarta.validation.Valid;\nimport org.springframework.web.bind.annotation.*;').replace(/@RequestBody PetForm/g, '@Valid @RequestBody PetForm'),
  [`${J}/PriceService.java`]: BASE[`${J}/PriceService.java`].replace('0.9', '0.8'),
  'src/test/java/com/acme/pets/PetControllerTest.java': 'package com.acme.pets;\n\nclass PetControllerTest {}\n',
};

let dir, report;
test('setup', () => {
  dir = mkdtempSync(join(tmpdir(), 'teslon-engine-'));
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 'T');
  put(dir, BASE); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'base');
  put(dir, HEAD); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'validate pets');
  report = impact({ repo: dir, base: 'HEAD~1', head: 'HEAD', today: '2026-10-22' });
});

const surface = (id) => report.surfaces.find((s) => s.id === id);
const cases = (id) => report.cases.filter((c) => c.surface === id);

test('the change is read as rules now enforced, not as edited lines', () => {
  assert.deepEqual(report.deltas.map((d) => d.id).sort(), ['enf:POST /api/pets', 'enf:PUT /api/pets/{id}']);
  for (const d of report.deltas) {
    // @Valid switches on the rule that was already there, not only the new one
    assert.deepEqual(d.rules.map((r) => `${r.json} ${r.rule}`).sort(), ['birthDate @PastOrPresent', 'name @NotBlank']);
    assert.ok(d.causes.some((h) => h.label === '@Valid added'));
  }
});

test('every cited line is re-read at head and says what the report claims', () => {
  assert.ok(report.verification.hops > 20);
  assert.deepEqual(report.verification.failed.map((h) => `${h.file}:${h.line} ${h.quote}`), []);
});

test('the edit screen: whole model sent, field found by label, guard decides per field', () => {
  const s = surface('screen:/pets/:id/edit');
  assert.equal(s.tier, 'test-first');
  assert.equal(s.name, 'Edit pet');
  const cs = cases('screen:/pets/:id/edit');
  const bd = cs.find((c) => c.field === 'Birth date' && c.tier === 'test-first');
  assert.ok(bd, 'a future birth date is reachable: type=date with no max');
  assert.match(bd.do, /date after today/);
  assert.ok(bd.hops.some((h) => h.label === 'Which field' && /whole pet is sent/.test(h.rule)));
  // required + v-model.trim already stops an empty name in the browser
  assert.equal(cs.find((c) => c.field === 'Name').tier, 'skip');
});

test('the create screen: inline object with this.x, no required, so an empty name gets through', () => {
  const cs = cases('screen:/pets/new');
  assert.equal(cs.find((c) => c.field === 'Name').tier, 'test-first');
  assert.equal(cs.find((c) => c.field === 'Born' && /after today/.test(c.do)).tier, 'test-first');
});

test('stored rows: the probe, the seed rows that now break, and the screen that leads back to the form', () => {
  const data = cases('data:pets').find((c) => c.field === 'birth_date');
  assert.match(data.do, /birth_date > CURRENT_DATE/);
  assert.match(data.expect, /1 of 2 rows/);
  const list = cases('screen:/pets').find((c) => c.tier === 'test-next');
  assert.ok(list, 'the list shows birth dates and links to the edit form');
  assert.ok(list.hops.some((h) => h.label === 'The way to edit it'));
});

test('a reader is never a writer: the list screen is not asked to test the rule on its GET', () => {
  assert.notEqual(surface('screen:/pets').tier, 'test-first');
  assert.equal(surface('screen:/about').tier, 'skip');
});

test('outside the code path: the saved request now fails, the 4xx panel moves, the 5xx panel does not', () => {
  const plan = surface('plan:requests.http');
  assert.equal(plan.tier, 'test-first');
  const dash = cases('dashboard:ops/dashboards/app.json');
  assert.equal(dash.find((c) => c.field === 'Client errors').tier, 'watch');
  assert.ok(!dash.some((c) => c.field === 'Server errors' && c.tier !== 'skip'));
});

test('jobs: one that uses the entity is listed as not visible, one that does not is a skip', () => {
  assert.ok(report.unseen.some((u) => /Reminders\.send\(\)/.test(u.what)));
  assert.equal(surface('job:Reminders.heartbeat').tier, 'skip');
});

test('the ledger accounts for every changed file, and names the lines no rule explains', () => {
  const byFile = Object.fromEntries(report.ledger.map((l) => [l.file.split('/').pop(), l]));
  assert.equal(byFile['PetForm.java'].status, 'explained');
  assert.equal(byFile['PetController.java'].status, 'explained');
  assert.equal(byFile['PetControllerTest.java'].status, 'test-only');
  assert.equal(byFile['PriceService.java'].status, 'not-modelled');
  assert.deepEqual(byFile['PriceService.java'].lines, [5]);
});

test('the text report leads with what to test and flags the unexplained file', () => {
  const t = renderText(report);
  assert.match(t, /TEST FIRST/);
  assert.match(t, /Edit pet/);
  assert.match(t, /1 changed file with lines no rule explains/);
  assert.match(t, /NOT MODELLED\s+src\/main\/java\/com\/acme\/pets\/PriceService\.java\s+lines 5/);
});

test("cleanup", () => { if (process.env.KEEP) { console.error("kept", dir); return; } if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });
