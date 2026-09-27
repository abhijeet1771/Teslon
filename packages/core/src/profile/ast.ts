import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Reading code from its real syntax tree.
 *
 * The first reader used regular expressions, and a review against ten
 * ordinary code shapes found six of them returned nothing at all: a class
 * service with injected dependencies, a state store, a GraphQL resolver, a
 * Storybook file, a test file and a type declaration. That is not "limited to
 * APIs" — it is narrower than that, and regular expressions were never going
 * to get out of it.
 *
 * TypeScript's own parser is already a dependency, so this uses it. No
 * program, no type checker, no tsconfig: `createSourceFile` is a pure parse,
 * which keeps the engine deterministic and fast, and means a file that does
 * not compile still reads.
 */

export type Shape =
  | 'endpoint'
  | 'component'
  | 'hook'
  | 'service'
  | 'store'
  | 'resolver'
  | 'rule'
  | 'schema'
  | 'story'
  | 'test'
  | 'types'
  | 'config'
  | 'unknown';

export interface AstBranch {
  readonly condition: string;
  readonly literals: readonly string[];
  readonly line: number;
  readonly kind: 'if' | 'ternary' | 'switch' | 'logical' | 'guard';
}

export interface AstConstraint {
  readonly field: string;
  readonly rules: readonly string[];
  readonly boundaries: readonly string[];
}

/** A behaviour a test claims to verify. Test names are a specification. */
export interface BehaviourClaim {
  readonly name: string;
  /** describe() nesting above it, outermost first. */
  readonly context: readonly string[];
}

export interface AstReading {
  readonly file: string;
  readonly shape: Shape;
  readonly exports: readonly string[];
  readonly branches: readonly AstBranch[];
  readonly constraints: readonly AstConstraint[];
  /** Component/hook surface. */
  readonly props: readonly string[];
  readonly state: readonly string[];
  readonly events: readonly string[];
  readonly renders: readonly string[];
  readonly conditionalRenders: readonly string[];
  /** Class services: methods, and what was injected into the constructor. */
  readonly methods: readonly string[];
  readonly injected: readonly string[];
  /** Store/resolver actions, and Storybook story names — enumerated states. */
  readonly actions: readonly string[];
  /** Behaviours claimed by a test file. */
  readonly claims: readonly BehaviourClaim[];
  /** Declared types and their fields. */
  readonly types: readonly { readonly name: string; readonly fields: readonly string[] }[];
  readonly throws: readonly string[];
  /** A declared route, when the file is an endpoint. */
  readonly httpRoute?: string;
  /** A declared authorisation rule, when there is one. */
  readonly auth?: string;
  readonly notRead: readonly string[];
}

const EMPTY: Omit<AstReading, 'file' | 'shape'> = {
  exports: [], branches: [], constraints: [], props: [], state: [], events: [],
  renders: [], conditionalRenders: [], methods: [], injected: [], actions: [],
  claims: [], types: [], throws: [], notRead: [],
};

const BOUNDARY_RULES: Record<string, (n: number) => string[]> = {
  min: (n) => [String(n - 1), String(n)],
  minLength: (n) => [String(n - 1), String(n)],
  gte: (n) => [String(n - 1), String(n)],
  max: (n) => [String(n), String(n + 1)],
  maxLength: (n) => [String(n), String(n + 1)],
  lte: (n) => [String(n), String(n + 1)],
  length: (n) => [String(n - 1), String(n), String(n + 1)],
  gt: (n) => [String(n), String(n + 1)],
  lt: (n) => [String(n - 1), String(n)],
};

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function readAst(root: string, file: string): AstReading | null {
  let src: string;
  try {
    src = readFileSync(join(root, file), 'utf8');
  } catch {
    return null;
  }
  return readAstSource(file, src);
}

/**
 * The same reading, from source text rather than from disk.
 *
 * This is what makes the semantic diff possible: the merge-base version of a
 * file does not exist on disk, it exists in git, so the reader has to be able
 * to work on a string that was never written down.
 */
export function readAstSource(file: string, src: string): AstReading {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const text = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, ' ').trim();

  const exportsFound = new Set<string>();
  const branches: AstBranch[] = [];
  const constraints: AstConstraint[] = [];
  const props = new Set<string>();
  const state = new Set<string>();
  const events = new Set<string>();
  const renders = new Set<string>();
  const conditionalRenders = new Set<string>();
  const methods = new Set<string>();
  const injected = new Set<string>();
  const actions = new Set<string>();
  const claims: BehaviourClaim[] = [];
  const types: { name: string; fields: string[] }[] = [];
  const throws = new Set<string>();
  const notRead = new Set<string>();

  let hasJsx = false;
  let hasHooks = false;
  let httpRoute: string | undefined;
  const describeStack: string[] = [];

  const literalsIn = (n: ts.Node): string[] => {
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword ||
        node.kind === ts.SyntaxKind.FalseKeyword ||
        node.kind === ts.SyntaxKind.NullKeyword
      ) {
        out.push(node.getText(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(n);
    return [...new Set(out)];
  };

  const addBranch = (cond: ts.Node, kind: AstBranch['kind']): void => {
    const condition = text(cond);
    if (condition.length < 2 || condition.length > 200) return;
    branches.push({ condition, literals: literalsIn(cond), line: lineOf(cond), kind });
  };

  /** zod / yup / joi constraint chains: `z.string().min(3).max(20)` */
  const readChain = (expr: ts.Node): { rules: string[]; boundaries: string[] } | null => {
    const rules: string[] = [];
    const boundaries = new Set<string>();
    let node: ts.Node = expr;
    let sawValidator = false;

    while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const arg = node.arguments[0] ? text(node.arguments[0]) : undefined;
      rules.unshift(arg !== undefined ? `${name}(${arg})` : name);
      const n = arg !== undefined ? Number(arg) : NaN;
      if (Number.isFinite(n)) for (const b of BOUNDARY_RULES[name]?.(n) ?? []) boundaries.add(b);
      const base = node.expression.expression;
      if (ts.isIdentifier(base) && /^(z|yup|Joi)$/.test(base.text)) sawValidator = true;
      node = base;
    }
    // Numeric order, so `min(3).max(20)` reads 2, 3, 20, 21 rather than the
    // order the chain happened to be walked in — which is also what keeps the
    // output stable (invariant I3).
    const ordered = [...boundaries].sort((a, b) => Number(a) - Number(b));
    return sawValidator && rules.length > 0 ? { rules, boundaries: ordered } : null;
  };

  const visit = (node: ts.Node): void => {
    // ---- exports ------------------------------------------------------
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) &&
      node.name &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      exportsFound.add(node.name.text);
    }
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) exportsFound.add(d.name.text);
      }
    }

    // ---- declared types ------------------------------------------------
    if (ts.isInterfaceDeclaration(node)) {
      types.push({
        name: node.name.text,
        fields: node.members.filter(ts.isPropertySignature).map((m) => text(m).replace(/;$/, '')),
      });
    }
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      types.push({
        name: node.name.text,
        fields: node.type.members.filter(ts.isPropertySignature).map((m) => text(m).replace(/;$/, '')),
      });
    }

    // ---- branches -------------------------------------------------------
    if (ts.isIfStatement(node)) addBranch(node.expression, 'if');
    if (ts.isConditionalExpression(node)) {
      addBranch(node.condition, 'ternary');
      // Both arms of a ternary render a state somebody has to see.
      for (const arm of [node.whenTrue, node.whenFalse]) {
        if (ts.isJsxElement(arm)) conditionalRenders.add(arm.openingElement.tagName.getText(sf));
        if (ts.isJsxSelfClosingElement(arm)) conditionalRenders.add(arm.tagName.getText(sf));
      }
    }
    if (ts.isCaseClause(node)) addBranch(node.expression, 'switch');
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      (ts.isJsxElement(node.right) || ts.isJsxSelfClosingElement(node.right))
    ) {
      addBranch(node.left, 'logical');
      conditionalRenders.add(
        ts.isJsxElement(node.right)
          ? node.right.openingElement.tagName.getText(sf)
          : node.right.tagName.getText(sf),
      );
    }

    // ---- JSX ------------------------------------------------------------
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      hasJsx = true;
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName.getText(sf) : node.tagName.getText(sf);
      if (/^[A-Z]/.test(tag)) renders.add(tag);
      const attrs = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
      for (const a of attrs.properties) {
        if (ts.isJsxAttribute(a) && /^on[A-Z]/.test(a.name.getText(sf))) events.add(a.name.getText(sf));
      }
    }
    // An early `return <X/>` is a state the happy path never shows.
    if (ts.isReturnStatement(node) && node.expression) {
      const e = node.expression;
      const tag = ts.isJsxSelfClosingElement(e)
        ? e.tagName.getText(sf)
        : ts.isJsxElement(e)
          ? e.openingElement.tagName.getText(sf)
          : undefined;
      let p: ts.Node | undefined = node.parent;
      while (p && !ts.isIfStatement(p) && !ts.isFunctionLike(p)) p = p.parent;
      if (tag && p && ts.isIfStatement(p) && /^[A-Z]/.test(tag)) conditionalRenders.add(tag);
    }

    // ---- calls: hooks, tests, stores, http, validators -------------------
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : '';

      if (/^use[A-Z]/.test(callee)) {
        hasHooks = true;
        if (callee === 'useState' || callee === 'useReducer') {
          const decl = node.parent;
          if (ts.isVariableDeclaration(decl) && ts.isArrayBindingPattern(decl.name)) {
            const first = decl.name.elements[0];
            if (first && ts.isBindingElement(first)) state.add(first.name.getText(sf));
          }
        }
      }

      // describe/it/test names are a specification written in English.
      if (/^(describe|it|test)$/.test(callee)) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          if (callee === 'describe') {
            describeStack.push(arg.text);
            ts.forEachChild(node, visit);
            describeStack.pop();
            return;
          }
          claims.push({ name: arg.text, context: [...describeStack] });
        }
      }

      // Route registration: app.get('/x', …) / router.post(…)
      if (/^(get|post|put|delete|patch|all)$/i.test(callee) && ts.isPropertyAccessExpression(node.expression)) {
        const obj = node.expression.expression.getText(sf);
        const arg = node.arguments[0];
        if (/^(app|router|server|api)$/i.test(obj) && arg && ts.isStringLiteralLike(arg)) {
          httpRoute = `${callee.toUpperCase()} ${arg.text}`;
        }
      }

      const chain = readChain(node);
      if (chain) {
        // Only a chain attached to a named field is a constraint. The outer
        // `z.object({ … })` is a container: recording it produced a phantom
        // "(value) gained the rule object({…})" alongside the real per-field
        // change, which is noise on top of the finding that matters.
        const parent = node.parent;
        const isContainer = /^(object|array|record|union|tuple|shape)$/.test(
          chain.rules[0]?.replace(/\(.*$/, '') ?? '',
        );
        if (parent && ts.isPropertyAssignment(parent) && !isContainer) {
          constraints.push({
            field: parent.name.getText(sf),
            rules: chain.rules,
            boundaries: chain.boundaries,
          });
        }
      }

      if (/^(eval|Function)$/.test(callee)) notRead.add('code built and evaluated at runtime');
    }

    // ---- decorators: @Get('/x'), @Injectable() --------------------------
    if (ts.canHaveDecorators(node)) {
      for (const d of ts.getDecorators(node) ?? []) {
        if (!ts.isCallExpression(d.expression)) continue;
        const name = d.expression.expression.getText(sf);
        const arg = d.expression.arguments[0];
        if (/^(Get|Post|Put|Delete|Patch|All)$/.test(name) && arg && ts.isStringLiteralLike(arg)) {
          httpRoute = `${name.toUpperCase()} ${arg.text}`;
        }
      }
    }

    // ---- classes: methods and injected dependencies ---------------------
    if (ts.isClassDeclaration(node)) {
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name) methods.add(m.name.getText(sf));
        if (ts.isConstructorDeclaration(m)) {
          for (const p of m.parameters) {
            const typeName = p.type ? text(p.type) : undefined;
            if (typeName) injected.add(typeName);
          }
        }
      }
    }

    // ---- object literals: store actions, resolvers, story exports -------
    if (ts.isPropertyAssignment(node) && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      actions.add(node.name.getText(sf));
    }

    // ---- function params become component props -------------------------
    if (ts.isFunctionLike(node) && node.parameters.length > 0) {
      const first = node.parameters[0]!;
      if (ts.isObjectBindingPattern(first.name)) {
        for (const el of first.name.elements) props.add(el.name.getText(sf));
      }
    }

    if (ts.isThrowStatement(node)) throws.add(text(node.expression).slice(0, 120));

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);

  // Storybook: every named export next to a `component` default is a state.
  const isStory = /\.stories\.[jt]sx?$/.test(file);
  if (isStory) for (const e of exportsFound) if (e !== 'default') actions.add(e);

  const isTest = /\.(test|spec)\.[jt]sx?$/.test(file) || claims.length > 0;
  const isTypes = file.endsWith('.d.ts');

  const shape: Shape = httpRoute
    ? 'endpoint'
    : isStory
      ? 'story'
      : isTest
        ? 'test'
        : isTypes
          ? 'types'
          : actions.size > 0 && /Query|Mutation|Subscription/.test(src)
            ? 'resolver'
            : hasJsx
              ? 'component'
              : hasHooks
                ? 'hook'
                : methods.size > 0
                  ? 'service'
                  : constraints.length > 0
                    ? 'schema'
                    : /\b(create|defineStore|configureStore|atom|signal)\s*\(/.test(src) && actions.size > 0
                      ? 'store'
                      : branches.length > 0
                        ? 'rule'
                        : types.length > 0
                          ? 'types'
                          : exportsFound.size > 0
                            ? 'config'
                            : 'unknown';

  if (shape === 'unknown') notRead.add('the shape of this file was not recognised, so nothing was assumed about it');

  return {
    ...EMPTY,
    file,
    shape,
    exports: [...exportsFound].sort(),
    branches,
    constraints,
    props: [...props].sort(),
    state: [...state].sort(),
    events: [...events].sort(),
    renders: [...renders].sort(),
    conditionalRenders: [...conditionalRenders].sort(),
    methods: [...methods].sort(),
    injected: [...injected].sort(),
    actions: [...actions].sort(),
    claims,
    types,
    throws: [...throws].sort(),
    notRead: [...notRead].sort(),
    ...(httpRoute ? { httpRoute } : {}),
  } as AstReading & { httpRoute?: string };
}
