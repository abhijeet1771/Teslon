import { parse, NodeTypes, type RootNode, type ElementNode, type TemplateChildNode, type AttributeNode, type DirectiveNode } from '@vue/compiler-dom';

/**
 * Vue templates read with Vue's own parser, so what the engine sees is what
 * Vue compiles: every element with its attributes and directives as written,
 * the conditions it is drawn under (`v-if`, `v-else-if`, `v-else`, `v-show`,
 * and those of every ancestor), its event handlers, loops, the components it
 * uses, the values it shows and its links. Lines are absolute in the file.
 */

export interface TplElement {
  readonly tag: string;
  readonly line: number;
  /** Attributes and directives as written: `id`, `v-model.trim`, `:max`, `@submit.prevent`. */
  readonly attrs: Readonly<Record<string, string>>;
  /** Visible text inside, with interpolations kept as `{{ expr }}`. */
  readonly text: string;
  /** Conditions it is drawn under, outermost first: `loading`, `!(loading)`, `bankAccount.id`. */
  readonly when: readonly string[];
  /** Event → handler expression: `submit → save`. */
  readonly on: Readonly<Record<string, string>>;
  /** Inside `v-for`, outermost first: `pet in owner.pets`. */
  readonly loops: readonly string[];
}

export interface TplShow { readonly expr: string; readonly line: number; readonly label: string; readonly when: readonly string[] }
export interface TplLink { readonly target: string; readonly line: number; readonly text: string }

export interface TemplateFacts {
  readonly elements: readonly TplElement[];
  readonly shows: readonly TplShow[];
  readonly links: readonly TplLink[];
  /** Tags of components used: `loading-spinner`, `ChatBox`. */
  readonly uses: readonly string[];
  readonly errors: readonly string[];
}

const KEEP = /^(input|select|textarea|option|label|h[1-6]|button|dt|th|td|dd|a|form|legend|caption)$/;

const isComponentTag = (tag: string): boolean => /^[A-Z]/.test(tag) || (tag.includes('-') && !/^(router-view|router-link|transition|keep-alive|component|slot|teleport|suspense)$/.test(tag));

function rawName(p: AttributeNode | DirectiveNode): string {
  if (p.type === NodeTypes.ATTRIBUTE) return p.name;
  return p.rawName ?? (p.name === 'bind' ? `:${p.arg && 'content' in p.arg ? p.arg.content : ''}` : p.name === 'on' ? `@${p.arg && 'content' in p.arg ? p.arg.content : ''}` : `v-${p.name}`);
}

function valueOf(p: AttributeNode | DirectiveNode): string {
  if (p.type === NodeTypes.ATTRIBUTE) return p.value?.content ?? '';
  return p.exp && 'content' in p.exp ? p.exp.content : '';
}

function textOf(n: TemplateChildNode): string {
  if (n.type === NodeTypes.TEXT) return n.content;
  if (n.type === NodeTypes.INTERPOLATION) return `{{ ${'content' in n.content ? n.content.content : ''} }}`;
  if (n.type === NodeTypes.ELEMENT) return n.children.map(textOf).join(' ');
  return '';
}

/**
 * Read a template. `source` is the template's own text; `lineOffset` is the
 * number of lines in the file before it, so reported lines are file lines.
 */
export function readTemplate(source: string, lineOffset: number): TemplateFacts {
  const errors: string[] = [];
  let root: RootNode;
  try {
    root = parse(source, { comments: false, onError: (e) => errors.push(e.message) });
  } catch (e) {
    return { elements: [], shows: [], links: [], uses: [], errors: [(e as Error).message] };
  }
  const elements: TplElement[] = [];
  const shows: TplShow[] = [];
  const links: TplLink[] = [];
  const uses = new Set<string>();
  let lastLabel = '';
  const line = (l: number): number => l + lineOffset;

  const walk = (nodes: readonly TemplateChildNode[], when: string[], loops: string[]): void => {
    // v-else and v-else-if take the negation of the conditions before them in the same chain
    let chain: string[] = [];
    for (const n of nodes) {
      if (n.type === NodeTypes.INTERPOLATION) {
        const expr = 'content' in n.content ? n.content.content.trim() : '';
        if (expr) shows.push({ expr, line: line(n.loc.start.line), label: lastLabel, when });
        continue;
      }
      if (n.type !== NodeTypes.ELEMENT) continue;
      const el = n as ElementNode;
      const attrs: Record<string, string> = {};
      const on: Record<string, string> = {};
      let cond: string | null = null;
      let loop: string | null = null;
      for (const p of el.props) {
        const name = rawName(p);
        const value = valueOf(p);
        attrs[name] = value;
        if (p.type === NodeTypes.DIRECTIVE) {
          if (p.name === 'if') { chain = [value]; cond = value; }
          else if (p.name === 'else-if') { cond = [...chain.map((c) => `!(${c})`), value].join(' && '); chain.push(value); }
          else if (p.name === 'else') { cond = chain.map((c) => `!(${c})`).join(' && ') || null; chain = []; }
          else if (p.name === 'show') cond = cond ? `${cond} && ${value}` : value;
          else if (p.name === 'for') loop = value;
          else if (p.name === 'on' && p.arg && 'content' in p.arg) on[p.arg.content] = value;
          else if (p.name === 'bind' && p.arg && 'content' in p.arg && p.exp) {
            // a bound attribute shows a value too: :title, :value, :placeholder
            if (/^(title|value|placeholder|label|alt)$/.test(p.arg.content)) shows.push({ expr: value, line: line(p.loc.start.line), label: lastLabel, when });
          }
        }
      }
      if (!el.props.some((p) => p.type === NodeTypes.DIRECTIVE && /^(if|else-if|else)$/.test(p.name))) chain = [];
      const myWhen = cond ? [...when, cond] : when;
      const myLoops = loop ? [...loops, loop] : loops;
      const text = el.children.map(textOf).join(' ').replace(/\s+/g, ' ').trim();
      if (isComponentTag(el.tag)) uses.add(el.tag);
      if (KEEP.test(el.tag) || Object.keys(attrs).some((k) => k.startsWith('v-model')) || el.tag === 'router-link' || isComponentTag(el.tag)) {
        elements.push({ tag: el.tag, line: line(el.loc.start.line), attrs, text: text.slice(0, 120), when: myWhen, on, loops: myLoops });
      }
      if (/^(dt|th|label|legend)$/.test(el.tag) && text && !text.includes('{{')) lastLabel = text;
      if (el.tag === 'router-link') links.push({ target: attrs[':to'] ?? attrs['to'] ?? '', line: line(el.loc.start.line), text: text.slice(0, 60) });
      walk(el.children, myWhen, myLoops);
    }
  };
  walk(root.children, [], []);
  return { elements, shows, links, uses: [...uses], errors };
}

export interface SfcBlocks {
  readonly template: { readonly content: string; readonly lineOffset: number; readonly start: number; readonly end: number } | null;
  readonly script: { readonly content: string; readonly start: number; readonly src?: string; readonly setup: boolean; readonly lang: string } | null;
}

/** The blocks of a single-file component, with offsets into the file. */
export function readSfc(raw: string): SfcBlocks {
  let root: RootNode;
  try {
    root = parse(raw, { parseMode: 'sfc', comments: false, onError: () => {} });
  } catch {
    return { template: null, script: null };
  }
  let template: SfcBlocks['template'] = null;
  let script: SfcBlocks['script'] = null;
  for (const n of root.children) {
    if (n.type !== NodeTypes.ELEMENT) continue;
    const el = n as ElementNode;
    const inner = el.innerLoc ?? null;
    if (el.tag === 'template' && !template && inner) {
      template = { content: raw.slice(inner.start.offset, inner.end.offset), lineOffset: inner.start.line - 1, start: inner.start.offset, end: inner.end.offset };
    }
    if (el.tag === 'script') {
      const attr = (k: string): string | undefined => {
        const p = el.props.find((x) => x.type === NodeTypes.ATTRIBUTE && x.name === k) as AttributeNode | undefined;
        return p ? (p.value?.content ?? '') : undefined;
      };
      const setup = attr('setup') !== undefined;
      // `<script setup>` wins over a plain `<script>` for what the component does
      if (script && !setup) continue;
      const src = attr('src');
      script = { content: inner ? raw.slice(inner.start.offset, inner.end.offset) : '', start: inner ? inner.start.offset : raw.length, setup, lang: attr('lang') ?? 'js', ...(src ? { src } : {}) };
    }
  }
  return { template, script };
}
