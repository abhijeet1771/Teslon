// The official PromQL grammar on the spm dashboard: metric and label matchers per query, compared with our regex.
import { execFileSync } from 'node:child_process';
const { parser } = await import(process.argv[2] + '/node_modules/@prometheus-io/lezer-promql/dist/index.es.js');
const json = JSON.parse(execFileSync('git', ['show', '1d76b00:docker/grafana/dashboards/grafana-petclinic-dashboard.json'], { cwd: process.argv[3], encoding: 'utf8' }));
const exprs = [];
const walk = (ps) => { for (const p of ps ?? []) { for (const t of p.targets ?? []) if (t.expr) exprs.push([p.title, t.expr]); walk(p.panels); } };
walk(json.panels);
for (const [title, e] of exprs) {
  const tree = parser.parse(e);
  const sel = [];
  let err = false;
  tree.iterate({ enter: (n) => {
    if (n.type.isError) err = true;
    if (n.name === 'VectorSelector') {
      const txt = e.slice(n.from, n.to);
      const metric = /^[a-zA-Z_:][\w:]*/.exec(txt)?.[0] ?? '';
      const ms = [];
      const c = n.node.cursor();
      c.iterate((m) => { if (m.name === 'UnquotedLabelMatcher' || m.name === 'LabelMatcher') ms.push(e.slice(m.from, m.to).replace(/\s+/g, '')); });
      sel.push(`${metric}{${ms.join(',')}}`);
    }
  } });
  console.log(`${title.padEnd(24)} ${err ? 'PARSE ERROR ' : ''}${sel.join('  ')}`);
}
