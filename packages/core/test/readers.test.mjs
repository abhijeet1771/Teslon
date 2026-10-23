import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readTemplate, readSfc } from '../dist/engine/vue-template.js';
import { promSelectors, promKeeps } from '../dist/engine/outside.js';

test('Vue templates: conditions, else chains, handlers, loops and components, with file lines', () => {
  const src = [
    '<form @submit.prevent="save">',
    '  <loading-spinner v-if="loading"/>',
    '  <load-failure v-else-if="failed"/>',
    '  <div v-else>',
    '    <label for="n">Name</label>',
    '    <input id="n" v-model.trim="pet.name" required>',
    '    <div v-for="v in pet.visits"><span>{{ v.date }}</span></div>',
    '    <button type="submit" v-show="dirty">Save</button>',
    '  </div>',
    '</form>',
  ].join('\n');
  const t = readTemplate(src, 10);
  const input = t.elements.find((e) => e.tag === 'input');
  assert.equal(input.line, 16);
  assert.equal(input.attrs['v-model.trim'], 'pet.name');
  assert.ok('required' in input.attrs);
  assert.deepEqual(input.when, ['!(loading) && !(failed)']);
  const button = t.elements.find((e) => e.tag === 'button');
  assert.deepEqual(button.when, ['!(loading) && !(failed)', 'dirty']);
  assert.equal(t.elements.find((e) => e.tag === 'form').on.submit, 'save');
  assert.deepEqual(t.shows.find((s) => s.expr === 'v.date') && t.elements.length > 0, true);
  assert.deepEqual(t.uses.sort(), ['load-failure', 'loading-spinner']);
  assert.equal(t.errors.length, 0);
});

test('Vue SFC: a script that lives in another file is found, the template keeps its line offset', () => {
  const raw = '<template>\n  <div>\n    <h2>Operations</h2>\n  </div>\n</template>\n\n<script lang="ts" src="./operation.component.ts"></script>\n';
  const b = readSfc(raw);
  assert.equal(b.script.src, './operation.component.ts');
  assert.equal(b.script.lang, 'ts');
  const t = readTemplate(b.template.content, b.template.lineOffset);
  assert.equal(t.elements.find((e) => e.tag === 'h2').line, 3);
});

test('PromQL: selectors and matchers from the real grammar, and a query that does not parse is not guessed', () => {
  const q = 'sum by (uri) (rate(http_server_requests_seconds_count{status!~"5..", uri=~"/api/.*"}[1m])) / on(uri) sum(rate(http_server_requests_seconds_count[1m]))';
  const s = promSelectors(q);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0].matchers.map((m) => `${m.label}${m.op}${m.value}`), ['status!~5..', 'uri=~/api/.*']);
  assert.equal(promKeeps(q, { status: '400', uri: '/api/pets' }, 'http_server_requests'), true);
  assert.equal(promKeeps('sum(rate(http_server_requests_seconds_count{status=~"5.."}[1m]))', { status: '400' }, 'http_server_requests'), false);
  assert.equal(promKeeps('sum(rate(http_server_requests_seconds_count{status=~"5.."[1m]))', { status: '400' }), undefined);
});
