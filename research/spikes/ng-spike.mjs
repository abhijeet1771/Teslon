// @angular/compiler parseTemplate on real JHipster Angular templates: which reads of `.name` exist, with lines.
import { readFileSync } from 'node:fs';
const ng = await import(process.argv[2] + '/node_modules/@angular/compiler/fesm2022/compiler.mjs');
const root = process.argv[3];
const files = ['list/bank-account.html', 'detail/bank-account-detail.html', 'update/bank-account-update.html'].map((f) => `bank-account/${f}`)
  .concat(['list/operation.html', 'detail/operation-detail.html', 'update/operation-update.html'].map((f) => `operation/${f}`));
for (const f of files) {
  const path = `${root}/src/main/webapp/app/entities/${f}`;
  const src = readFileSync(path, 'utf8');
  const t = ng.parseTemplate(src, path, { preserveWhitespaces: false });
  const reads = [], controls = [], blocks = [], events = [];
  const line = (span) => (span ? span.start.line + 1 : 0);
  // property paths read in expressions: a.b.c
  const pathOf = (ast) => {
    if (ast instanceof ng.PropertyRead || ast instanceof ng.SafePropertyRead) { const r = pathOf(ast.receiver); return r ? `${r}.${ast.name}` : ast.name; }
    return null;
  };
  class V extends ng.TmplAstRecursiveVisitor {
    visitElement(el) {
      for (const a of el.attributes) if (a.name === 'formControlName') controls.push(`${a.value}@${line(a.sourceSpan)}`);
      for (const o of el.outputs) events.push(`(${o.name})@${line(o.sourceSpan)}`);
      for (const i of el.inputs) this.expr(i.value, line(i.sourceSpan));
      super.visitElement(el);
    }
    visitBoundText(t) { this.expr(t.value, line(t.sourceSpan)); }
    visitIfBlock(b) { for (const br of b.branches) blocks.push(`@if(${br.expression?.source ?? 'else'})@${line(br.sourceSpan)}`); super.visitIfBlock(b); }
    visitForLoopBlock(b) { blocks.push(`@for(${b.item.name} of ${b.expression.source})@${line(b.sourceSpan)}`); super.visitForLoopBlock(b); }
    expr(ast, ln) {
      const seen = new Set();
      const walk = (x) => {
        if (!x || typeof x !== 'object' || seen.has(x)) return; seen.add(x);
        const p = pathOf(x); if (p && /\.name$/.test(p)) reads.push(`${p}@${ln}`);
        for (const k of Object.keys(x)) if (k !== 'span' && k !== 'sourceSpan') { const v = x[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v); }
      };
      walk(ast?.ast ?? ast);
    }
  }
  ng.tmplAstVisitAll(new V(), t.nodes);
  console.log(`\n${f}  (parse errors: ${t.errors?.length ?? 0})`);
  console.log('  reads of *.name :', [...new Set(reads)].join('  '));
  if (controls.length) console.log('  form controls   :', controls.join('  '));
  console.log('  control flow    :', blocks.slice(0, 4).join('  '));
  console.log('  events          :', events.slice(0, 6).join('  '));
}
