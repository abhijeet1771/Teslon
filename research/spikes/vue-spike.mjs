// Official Vue template parser vs the engine's tag reader, on real templates.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(process.argv[2] + '/');
const { parse: parseSfc } = require('@vue/compiler-sfc');
const { parse: domParse } = require('@vue/compiler-dom');
const { readVue } = await import(new URL('../../packages/core/dist/engine/vue.js', import.meta.url));
const { snapshot } = await import(new URL('../../packages/core/dist/engine/snapshot.js', import.meta.url));

function walk(ast, visit, parents = []) {
  visit(ast, parents);
  for (const c of ast.children ?? []) walk(c, visit, [...parents, ast]);
  if (ast.branches) for (const b of ast.branches) walk(b, visit, parents);
}
function facts(tplText, lineOffset) {
  const errs = []; const ast = domParse(tplText, { comments: false, onError: (e) => errs.push(e.message) }); if (errs.length) console.log('parse errors:', errs.slice(0, 3));
  const out = { models: [], conditional: [], handlers: [], components: new Set(), loops: [] };
  walk(ast, (n, parents) => {
    if (n.type !== 1) return; // ELEMENT
    const line = n.loc.start.line + lineOffset;
    const dirs = n.props.filter((p) => p.type === 7);
    for (const d of dirs) {
      if (d.name === 'model') out.models.push(`${n.tag}[${d.exp?.content}]${d.modifiers?.length ? '.' + d.modifiers.map((m) => m.content ?? m).join('.') : ''}@${line}`);
      if (d.name === 'if' || d.name === 'show' || d.name === 'else-if') out.conditional.push(`${n.tag} v-${d.name}="${d.exp?.content}"@${line}`);
      if (d.name === 'on') out.handlers.push(`${n.tag} @${d.arg?.content}="${d.exp?.content}"@${line}`);
      if (d.name === 'for') out.loops.push(`${n.tag} v-for="${d.exp?.content ?? ''}"@${line}`);
    }
    // a condition on any ancestor also hides this element
    if (/^[A-Z]|-/.test(n.tag) && !['router-link', 'router-view'].includes(n.tag)) out.components.add(n.tag);
  });
  out.components = [...out.components];
  return out;
}

// spm: templates are template literals inside .js components
const spm = process.argv[3];
const snap = snapshot(spm, '1d76b00');
const ui = readVue(snap);
for (const f of ['PetFormPage.js', 'OwnerDetailsPage.js']) {
  const file = snap.files.find((x) => x.endsWith('/' + f));
  const text = snap.read(file);
  const m = /template:\s*`([\s\S]*?)`/.exec(text);
  const off = text.slice(0, m.index + m[0].indexOf('`') + 1).split('\n').length - 1;
  const official = facts(m[1], off);
  const ours = ui.components.get(file);
  console.log(`\n== spm ${f}`);
  console.log('official v-model:', official.models);
  console.log('ours v-model    :', ours.elements.filter((e) => Object.keys(e.attrs).some((k) => k.startsWith('v-model'))).map((e) => `${e.tag}[${Object.entries(e.attrs).find(([k]) => k.startsWith('v-model'))[1]}]@${e.line}`));
  console.log('official conditional (ours: none):', official.conditional);
  console.log('official handlers (ours: none):', official.handlers);
  console.log('official child components:', official.components);
}

// JHipster Vue: real SFCs
const jv = process.argv[4];
for (const f of ['src/main/webapp/app/entities/test-root/bank-account-my-suffix/bank-account-my-suffix-update.vue', 'src/main/webapp/app/entities/test-root/operation/operation.vue']) {
  const raw = (await import('node:fs')).readFileSync(jv + '/' + f, 'utf8');
  const { descriptor, errors } = parseSfc(raw, { filename: f });
  const t = descriptor.template;
  const off = raw.slice(0, raw.indexOf(t.content)).split('\n').length - 1;
  const official = facts(t.content, off);
  console.log(`\n== jhipster-vue ${f.split('/').pop()} (sfc errors: ${errors.length}, script: ${descriptor.scriptSetup ? 'setup' : descriptor.script ? 'options/defineComponent' : 'none'}${descriptor.script?.src ? ' src=' + descriptor.script.src : ''})`);
  console.log('v-model:', official.models.slice(0, 6), official.models.length > 6 ? `+${official.models.length - 6}` : '');
  console.log('conditional:', official.conditional.slice(0, 5));
  console.log('handlers:', official.handlers.slice(0, 5));
  console.log('loops:', official.loops.slice(0, 3));
}
