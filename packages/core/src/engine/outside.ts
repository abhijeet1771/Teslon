import type { Snapshot } from './snapshot.js';

/**
 * Things outside the code path that still depend on it: dashboards that query
 * metrics, load-test plans that call the API, and seed data that has to keep
 * passing the rules.
 */

const lineAt = (text: string, i: number): number => text.slice(0, i).split('\n').length;

/* ---------------- dashboards ---------------- */

export interface Panel { readonly file: string; readonly line: number; readonly title: string; readonly expr: string }

export function readDashboards(snap: Snapshot): Panel[] {
  const out: Panel[] = [];
  for (const f of snap.files) {
    if (!f.endsWith('.json')) continue;
    const text = snap.read(f);
    if (!text || !/"expr"\s*:/.test(text) || !/"panels"\s*:/.test(text)) continue;
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { continue; }
    const lines = text.split('\n');
    let cursor = 0;
    const walk = (panels: unknown): void => {
      if (!Array.isArray(panels)) return;
      for (const p of panels as Record<string, unknown>[]) {
        for (const t of (Array.isArray(p['targets']) ? p['targets'] : []) as Record<string, unknown>[]) {
          const expr = t['expr'];
          if (typeof expr !== 'string') continue;
          const needle = JSON.stringify(expr).slice(1, -1);
          const k = lines.findIndex((l, i) => i >= cursor && l.includes(needle));
          if (k >= 0) cursor = k + 1;
          out.push({ file: f, line: k + 1, title: String(p['title'] ?? ''), expr });
        }
        walk(p['panels']);
      }
    };
    walk((doc as Record<string, unknown>)['panels']);
  }
  return out;
}

/** Does a PromQL selector's label filter keep a series with these labels? */
export function promKeeps(expr: string, labels: Readonly<Record<string, string>>): boolean {
  return [...expr.matchAll(/(\w+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].every(([, k, op, v]) => {
    if (!(k! in labels)) return true;
    const hit = op!.includes('~') ? new RegExp(`^(?:${v})$`).test(labels[k!]!) : labels[k!] === v;
    return op!.startsWith('!') ? !hit : hit;
  });
}

/* ---------------- load-test and request plans ---------------- */

export interface PlannedRequest { readonly file: string; readonly line: number; readonly method: string; readonly path: string; readonly body: string; readonly bodyLine: number }

const unescapeXml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#xd;/g, '').replace(/&#xa;/g, '\n').replace(/&amp;/g, '&');

export function readRequestPlans(snap: Snapshot): PlannedRequest[] {
  const out: PlannedRequest[] = [];
  for (const f of snap.files) {
    if (f.endsWith('.jmx')) {
      const x = snap.read(f) ?? '';
      for (const m of x.matchAll(/<HTTPSamplerProxy\b[\s\S]*?<\/HTTPSamplerProxy>/g)) {
        const blk = m[0];
        const path = /name="HTTPSampler\.path">([^<]*)</.exec(blk)?.[1] ?? '';
        const method = /name="HTTPSampler\.method">([^<]*)</.exec(blk)?.[1] ?? 'GET';
        const arg = /name="Argument\.value">([\s\S]*?)<\/stringProp>/.exec(blk);
        const body = arg ? unescapeXml(arg[1]!) : '';
        out.push({ file: f, line: lineAt(x, m.index! + blk.indexOf('HTTPSampler.path')), method, path: path.replace(/\$\{[^}]*\}/g, '{*}'), body, bodyLine: arg ? lineAt(x, m.index! + arg.index!) : 0 });
      }
    }
    if (f.endsWith('.http') || f.endsWith('.rest')) {
      const x = snap.read(f) ?? '';
      for (const m of x.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)[^\n]*\n((?:[^\n]+\n)*)\n?(\{[\s\S]*?\n\})?/gm)) {
        const url = m[2]!.replace(/^https?:\/\/[^/]+/, '').replace(/\{\{[^}]*\}\}/g, '{*}');
        out.push({ file: f, line: lineAt(x, m.index!), method: m[1]!, path: url, body: m[4] ?? '', bodyLine: m[4] ? lineAt(x, m.index! + m[0].indexOf(m[4])) : 0 });
      }
    }
  }
  return out;
}

/* ---------------- seed data ---------------- */

export interface SeedRow { readonly file: string; readonly line: number; readonly values: ReadonlyMap<string, string | null> }

function splitValues(s: string): (string | null)[] {
  const out: (string | null)[] = [];
  let cur = '', q = false, quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) { if (c === "'" && s[i + 1] === "'") { cur += "'"; i++; } else if (c === "'") q = false; else cur += c; continue; }
    if (c === "'") { q = true; quoted = true; cur = cur.trim(); continue; }
    if (c === ',') { out.push(!quoted && /^null$/i.test(cur.trim()) ? null : quoted ? cur : cur.trim()); cur = ''; quoted = false; continue; }
    if (quoted && /\s/.test(c)) continue; // after the closing quote
    cur += c;
  }
  out.push(!quoted && /^null$/i.test(cur.trim()) ? null : quoted ? cur : cur.trim());
  return out;
}

/** Rows of a table in seed SQL, with column names from CREATE TABLE or the INSERT itself. */
export function readSeedRows(snap: Snapshot, table: string): { rows: SeedRow[]; files: string[] } {
  const sqlFiles = snap.files.filter((f) => f.endsWith('.sql'));
  const columns = new Map<string, string[]>(); // per directory, from schema files
  for (const f of sqlFiles) {
    const x = snap.read(f) ?? '';
    const m = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${table}\`?\\s*\\(([\\s\\S]*?)\\)\\s*(?:ENGINE|;)`, 'i').exec(x);
    if (!m) continue;
    const cols = m[1]!.split(/,(?![^(]*\))/).map((d) => d.trim().split(/\s+/)[0]!.replace(/[`"]/g, '')).filter((c) => c && !/^(PRIMARY|FOREIGN|KEY|INDEX|CONSTRAINT|UNIQUE|CHECK)$/i.test(c));
    columns.set(f.split('/').slice(0, -1).join('/'), cols);
  }
  const rows: SeedRow[] = [];
  const files: string[] = [];
  for (const f of sqlFiles) {
    const x = snap.read(f) ?? '';
    const re = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+\`?${table}\`?\\s*(\\(([^)]*)\\))?\\s*VALUES\\s*([\\s\\S]*?);`, 'gi');
    let any = false;
    for (const m of x.matchAll(re)) {
      const cols = m[2] ? m[2].split(',').map((c) => c.trim().replace(/[`"]/g, '')) : columns.get(f.split('/').slice(0, -1).join('/')) ?? [];
      if (!cols.length) continue;
      any = true;
      for (const tup of m[3]!.matchAll(/\(((?:[^()']|'(?:[^']|'')*')*)\)/g)) {
        const vals = splitValues(tup[1]!);
        rows.push({ file: f, line: lineAt(x, m.index! + m[0].indexOf(tup[0])), values: new Map(cols.map((c, i) => [c, vals[i] ?? null])) });
      }
    }
    if (any) files.push(f);
  }
  return { rows, files };
}

/** Does a value break a bean-validation rule? undefined: this rule is not evaluated here. */
export function breaks(rule: string, value: string | null, today: string): boolean | undefined {
  const name = /^@(\w+)/.exec(rule)?.[1] ?? '';
  const num = (k: string): number | undefined => { const m = new RegExp(`${k}\\s*=\\s*(-?\\d+)`).exec(rule); return m ? Number(m[1]) : undefined; };
  switch (name) {
    case 'NotNull': return value === null;
    case 'NotEmpty': return value === null || value === '';
    case 'NotBlank': return value === null || value.trim() === '';
    case 'Size': case 'Length': {
      if (value === null) return false;
      const min = num('min'), max = num('max');
      return (min !== undefined && value.length < min) || (max !== undefined && value.length > max);
    }
    case 'PastOrPresent': return value !== null && value.slice(0, 10) > today;
    case 'Past': return value !== null && value.slice(0, 10) >= today;
    case 'FutureOrPresent': return value !== null && value.slice(0, 10) < today;
    case 'Future': return value !== null && value.slice(0, 10) <= today;
    case 'Min': { const n = /\((-?\d+)\)/.exec(rule)?.[1]; return value !== null && n !== undefined && Number(value) < Number(n); }
    case 'Max': { const n = /\((-?\d+)\)/.exec(rule)?.[1]; return value !== null && n !== undefined && Number(value) > Number(n); }
    default: return undefined;
  }
}

/** A query that finds the rows a rule now refuses, or null. */
export function probe(rule: string, table: string, column: string): string | null {
  const name = /^@(\w+)/.exec(rule)?.[1] ?? '';
  const min = /min\s*=\s*(\d+)/.exec(rule)?.[1];
  const max = /max\s*=\s*(\d+)/.exec(rule)?.[1];
  switch (name) {
    case 'PastOrPresent': return `SELECT id FROM ${table} WHERE ${column} > CURRENT_DATE;`;
    case 'Past': return `SELECT id FROM ${table} WHERE ${column} >= CURRENT_DATE;`;
    case 'FutureOrPresent': return `SELECT id FROM ${table} WHERE ${column} < CURRENT_DATE;`;
    case 'Future': return `SELECT id FROM ${table} WHERE ${column} <= CURRENT_DATE;`;
    case 'NotNull': return `SELECT id FROM ${table} WHERE ${column} IS NULL;`;
    case 'NotBlank': return `SELECT id FROM ${table} WHERE ${column} IS NULL OR TRIM(${column}) = '';`;
    case 'NotEmpty': return `SELECT id FROM ${table} WHERE ${column} IS NULL OR ${column} = '';`;
    case 'Size': case 'Length': {
      const parts = [min ? `CHAR_LENGTH(${column}) < ${min}` : '', max ? `CHAR_LENGTH(${column}) > ${max}` : ''].filter(Boolean);
      return parts.length ? `SELECT id FROM ${table} WHERE ${parts.join(' OR ')};` : null;
    }
    default: return null;
  }
}
