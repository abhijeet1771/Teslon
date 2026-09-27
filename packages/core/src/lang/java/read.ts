import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'java-parser';
import type { AstReading, AstBranch, AstConstraint, BehaviourClaim, Shape } from '../../profile/ast.js';

/**
 * Reading Java.
 *
 * Deliberately produces the same `AstReading` shape as the TypeScript reader,
 * so everything downstream — the semantic diff, the bands, the brief — works
 * on Java without knowing it exists. One schema, many languages.
 *
 * The parser is java-parser (Chevrotain, pure JavaScript, the one behind
 * prettier-java). No native build, no WASM to load, nothing to ship per
 * platform. Measured at 0.28 ms a file, so a 20,000-file Java repository
 * parses in about six seconds.
 *
 * Enterprise Java says most of what matters in annotations, which is lucky:
 * a route, a transaction boundary, an authorisation rule, a column and a
 * validation bound are all declared rather than implied.
 */

interface CstNode {
  name?: string;
  image?: string;
  children?: Record<string, CstNode[]>;
}

const HTTP_MAPPING: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'ANY',
};

const AUTH_ANNOTATIONS = new Set(['PreAuthorize', 'PostAuthorize', 'Secured', 'RolesAllowed', 'PermitAll', 'DenyAll']);
const SERVICE_ANNOTATIONS = new Set(['Service', 'Component', 'Repository', 'Configuration', 'Bean']);
const CONTROLLER_ANNOTATIONS = new Set(['RestController', 'Controller']);
const TEST_ANNOTATIONS = new Set(['Test', 'ParameterizedTest', 'RepeatedTest', 'TestFactory']);

/** Bean-validation bounds, and the values on their edges. */
const BOUNDARY_FOR: Record<string, (n: number) => string[]> = {
  min: (n) => [String(n - 1), String(n)],
  max: (n) => [String(n), String(n + 1)],
  value: (n) => [String(n - 1), String(n)],
};

function walk(node: CstNode | undefined, visit: (n: CstNode) => void): void {
  if (!node || typeof node !== 'object') return;
  if (node.name) visit(node);
  const children = node.children;
  if (!children) return;
  for (const key of Object.keys(children)) {
    for (const child of children[key] ?? []) walk(child, visit);
  }
}

/** Every token underneath a node, in source order. */
function tokens(node: CstNode | undefined): string[] {
  const out: string[] = [];
  const collect = (n: CstNode | undefined): void => {
    if (!n || typeof n !== 'object') return;
    if (n.image !== undefined) out.push(n.image);
    for (const key of Object.keys(n.children ?? {})) {
      for (const c of n.children![key] ?? []) collect(c);
    }
  };
  collect(node);
  return out;
}

const text = (node: CstNode | undefined): string => tokens(node).join(' ');

/** `@Size(min = 3, max = 20)` → name plus its element pairs. */
interface Annotation {
  readonly name: string;
  /** The single unnamed argument, e.g. `@GetMapping("/{id}")`. */
  readonly value?: string;
  readonly pairs: ReadonlyMap<string, string>;
}

function readAnnotation(node: CstNode): Annotation {
  const all = tokens(node);
  const name = all[1] ?? '';
  const pairs = new Map<string, string>();
  let value: string | undefined;

  walk(node, (n) => {
    if (n.name !== 'elementValuePair') return;
    const t = tokens(n);
    const key = t[0];
    const val = t.slice(2).join(' ');
    if (key && val) pairs.set(key, val.replace(/^"|"$/g, ''));
  });

  if (pairs.size === 0) {
    const literal = all.find((t, i) => i > 1 && /^["']/.test(t));
    if (literal) value = literal.replace(/^"|"$/g, '');
  } else {
    const v = pairs.get('value') ?? pairs.get('path');
    if (v !== undefined) value = v;
  }

  return { name, ...(value !== undefined ? { value } : {}), pairs };
}

function annotationsOf(node: CstNode): Annotation[] {
  const out: Annotation[] = [];
  walk(node, (n) => {
    if (n.name === 'annotation') out.push(readAnnotation(n));
  });
  return out;
}

function joinRoute(base: string | undefined, path: string | undefined): string | undefined {
  if (base === undefined && path === undefined) return undefined;
  const b = (base ?? '').replace(/\/$/, '');
  const p = path ?? '';
  if (p === '') return b === '' ? undefined : b;
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`;
}

export interface JavaReading extends AstReading {
  /** `com.acme.orders` — Java resolves by package, not by path. */
  readonly packageName: string;
  /** Fully-qualified imports, plus wildcard packages as `com.acme.repo.*`. */
  readonly imports: readonly string[];
  /** Types declared here, so another file's import can be resolved to it. */
  readonly declares: readonly string[];
  readonly httpRoutes: readonly string[];
  /** `@Table(name=…)` — the table this entity maps to. */
  readonly entityTables: readonly string[];
  /** `@Column(name=…)` — the columns, which are not tables. */
  readonly entityColumns: readonly string[];
  readonly transactional: boolean;
}

export function readJava(root: string, file: string): JavaReading | null {
  let src: string;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }

  let cst: CstNode;
  try {
    cst = parse(src) as unknown as CstNode;
  } catch {
    // A file that does not parse must not vanish from the analysis. It comes
    // back as `unknown`, which every consumer treats as affected.
    return {
      ...emptyReading(file),
      notRead: ['this file could not be parsed, so nothing was read from it'],
    };
  }

  let packageName = '';
  const imports: string[] = [];
  const declares = new Set<string>();
  const exportsFound = new Set<string>();
  const methods = new Set<string>();
  const injected = new Set<string>();
  const branches: AstBranch[] = [];
  const constraints: AstConstraint[] = [];
  const claims: BehaviourClaim[] = [];
  const throws = new Set<string>();
  const entityTables = new Set<string>();
  const entityColumns = new Set<string>();
  const httpRoutes: string[] = [];
  const types: { name: string; fields: string[] }[] = [];
  const notRead = new Set<string>();

  let classRouteBase: string | undefined;
  let isController = false;
  let isService = false;
  let isEntity = false;
  let isTestClass = false;
  let transactional = false;
  let auth: string | undefined;
  let currentClass = '';

  walk(cst, (node) => {
    switch (node.name) {
      case 'packageDeclaration': {
        const t = tokens(node).slice(1, -1).filter((x) => x !== '.');
        packageName = t.join('.');
        break;
      }
      case 'importDeclaration': {
        const t = tokens(node).slice(1, -1).filter((x) => x !== '.' && x !== 'static');
        if (t.length > 0) imports.push(t.join('.').replace(/\.\*$/, '.*'));
        break;
      }
      case 'normalClassDeclaration':
      case 'normalInterfaceDeclaration':
      case 'enumDeclaration': {
        const name = node.children?.typeIdentifier?.[0];
        const className = name ? tokens(name).join('') : '';
        if (className) {
          declares.add(className);
          exportsFound.add(className);
          if (!currentClass) currentClass = className;
        }
        break;
      }
      case 'fieldDeclaration': {
        // Read the declared type from its own subtree. Scanning the whole
        // field for the first capitalised token picked up the *annotation*
        // instead, so an @Column-mapped entity reported "Column" as an
        // injected dependency.
        let typeName: string | undefined;
        walk(node, (child) => {
          if (typeName !== undefined) return;
          if (child.name === 'unannClassType' || child.name === 'unannClassOrInterfaceType') {
            typeName = tokens(child).find((x) => /^[A-Z]\w*$/.test(x));
          }
        });
        if (typeName) injected.add(typeName);
        break;
      }
      case 'methodDeclarator': {
        const name = tokens(node)[0];
        if (name && /^[a-z_]\w*$/.test(name)) methods.add(name);
        break;
      }
      case 'constructorDeclarator': {
        // Constructor injection is how Spring wires dependencies now.
        walk(node, (p) => {
          if (p.name !== 'formalParameter') return;
          const typeName = tokens(p).find((x) => /^[A-Z]\w*$/.test(x));
          if (typeName) injected.add(typeName);
        });
        break;
      }
      case 'ifStatement':
      case 'basicForStatement':
      case 'whileStatement': {
        const t = tokens(node);
        const open = t.indexOf('(');
        const condition = open >= 0 ? t.slice(open + 1, t.indexOf(')', open)).join(' ') : '';
        if (condition.length > 1 && condition.length < 200) {
          branches.push({
            condition,
            literals: [...new Set(t.filter((x) => /^["'\d]|^(?:true|false|null)$/.test(x)))],
            line: 0,
            kind: node.name === 'ifStatement' ? 'if' : 'guard',
          });
        }
        break;
      }
      case 'switchLabel': {
        const t = tokens(node);
        if (t[0] === 'case') {
          branches.push({ condition: t.join(' '), literals: t.slice(1), line: 0, kind: 'switch' });
        }
        break;
      }
      case 'throwStatement': {
        const t = tokens(node);
        const exception = t[2];
        const message = t.find((x) => /^"/.test(x));
        if (exception) throws.add(message ? `${exception}: ${message.replace(/"/g, '')}` : exception);
        break;
      }
      case 'throws_': {
        for (const e of tokens(node).slice(1)) if (/^[A-Z]/.test(e)) throws.add(e);
        break;
      }
      case 'annotation': {
        const a = readAnnotation(node);

        if (CONTROLLER_ANNOTATIONS.has(a.name)) isController = true;
        if (SERVICE_ANNOTATIONS.has(a.name)) isService = true;
        if (a.name === 'Entity') isEntity = true;
        if (a.name === 'Transactional') transactional = true;
        if (AUTH_ANNOTATIONS.has(a.name)) {
          const rule = a.value ?? (a.pairs.size ? [...a.pairs.values()].join(', ') : undefined);
          auth = rule ? `${a.name}(${rule})` : a.name;
        }
        if (TEST_ANNOTATIONS.has(a.name)) isTestClass = true;

        // A table and its columns are different things: pooling them made
        // "id" and "status" look like tables, which would then couple every
        // entity that happens to have an id column.
        if (a.name === 'Table') {
          const n = a.pairs.get('name') ?? a.value;
          if (n) entityTables.add(n);
        }
        if (a.name === 'Column') {
          const n = a.pairs.get('name') ?? a.value;
          if (n) entityColumns.add(n);
        }

        if (a.name === 'RequestMapping' && a.value && classRouteBase === undefined) {
          classRouteBase = a.value;
        }
        const verb = HTTP_MAPPING[a.name];
        if (verb && a.name !== 'RequestMapping') {
          const full = joinRoute(classRouteBase, a.value);
          if (full) httpRoutes.push(`${verb} ${full}`);
        }

        // @DisplayName("…") is the behaviour a JUnit test claims.
        if (a.name === 'DisplayName' && a.value) {
          claims.push({ name: a.value, context: currentClass ? [currentClass] : [] });
        }

        // Bean validation: @Size(min=3, max=20), @Min(1), @Max(90)
        if (/^(Size|Min|Max|Length|DecimalMin|DecimalMax)$/.test(a.name)) {
          const rules: string[] = [];
          const boundaries = new Set<string>();
          const take = (key: string, value: string | undefined): void => {
            if (value === undefined) return;
            rules.push(`${key}(${value})`);
            const n = Number(value);
            if (Number.isFinite(n)) for (const b of BOUNDARY_FOR[key]?.(n) ?? []) boundaries.add(b);
          };
          if (a.pairs.size > 0) {
            take('min', a.pairs.get('min'));
            take('max', a.pairs.get('max'));
          } else if (a.value !== undefined) {
            take(a.name === 'Max' || a.name === 'DecimalMax' ? 'max' : 'min', a.value);
          }
          if (rules.length > 0) {
            constraints.push({
              field: `@${a.name}`,
              rules: [a.name, ...rules],
              boundaries: [...boundaries].sort((x, y) => Number(x) - Number(y)),
            });
          }
        }
        break;
      }
      default:
        break;
    }
  });

  // A JUnit test with no @DisplayName still declares its behaviour in the
  // method name, which is why the convention exists.
  if (isTestClass && claims.length === 0) {
    for (const m of methods) {
      if (/^(should|test|when|given)/i.test(m) || m.includes('_')) {
        claims.push({ name: m, context: currentClass ? [currentClass] : [] });
      }
    }
  }

  if (isEntity) {
    types.push({ name: currentClass, fields: [...entityColumns].sort() });
  }

  const shape: Shape = isController
    ? 'endpoint'
    : isTestClass
      ? 'test'
      : isEntity
        ? 'types'
        : isService || methods.size > 0
          ? 'service'
          : constraints.length > 0
            ? 'schema'
            : branches.length > 0
              ? 'rule'
              : declares.size > 0
                ? 'types'
                : 'unknown';

  if (shape === 'unknown') notRead.add('the shape of this file was not recognised, so nothing was assumed about it');

  return {
    file,
    shape,
    exports: [...exportsFound].sort(),
    branches,
    constraints,
    props: [],
    state: [],
    events: [],
    renders: [],
    conditionalRenders: [],
    methods: [...methods].sort(),
    injected: [...injected].sort(),
    actions: [],
    claims,
    types,
    throws: [...throws].sort(),
    notRead: [...notRead].sort(),
    packageName,
    imports: [...new Set(imports)].sort(),
    declares: [...declares].sort(),
    httpRoutes: [...new Set(httpRoutes)].sort(),
    entityTables: [...entityTables].sort(),
    entityColumns: [...entityColumns].sort(),
    transactional,
    ...(auth !== undefined ? { auth } : {}),
  };
}

function emptyReading(file: string): JavaReading {
  return {
    file,
    shape: 'unknown',
    exports: [], branches: [], constraints: [], props: [], state: [], events: [],
    renders: [], conditionalRenders: [], methods: [], injected: [], actions: [],
    claims: [], types: [], throws: [], notRead: [],
    packageName: '', imports: [], declares: [], httpRoutes: [], entityTables: [], entityColumns: [],
    transactional: false,
  };
}
