import { pythonLanguage } from '@codemirror/lang-python';
import { javascriptLanguage } from '@codemirror/lang-javascript';
import { cppLanguage } from '@codemirror/lang-cpp';
import { javaLanguage } from '@codemirror/lang-java';
import { StreamLanguage, type Language } from '@codemirror/language';
import { c, csharp } from '@codemirror/legacy-modes/mode/clike';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { typstParser, typstLezerHighlighting } from 'codemirror-lang-typst/lezer';
import { type CodeLanguage } from './codeLanguages.js';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { defaultTreeAdapter as adapter, parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';

export { CODE_LANGUAGES, type CodeLanguage } from './codeLanguages.js';

const languages = {
  python: pythonLanguage,
  javascript: javascriptLanguage,
  c: StreamLanguage.define(c),
  cpp: cppLanguage,
  csharp: StreamLanguage.define(csharp),
  java: javaLanguage,
  matlab: StreamLanguage.define(octave),
  julia: StreamLanguage.define(julia),
  latex: StreamLanguage.define(stex),
  typst: { parser: typstParser.configure([typstLezerHighlighting]) },
  markdown: markdownLanguage,
} satisfies Record<CodeLanguage, Pick<Language, 'parser'>>;
const TOKEN_NAMES = ['keyword', 'string', 'number', 'comment', 'function', 'type', 'operator'] as const;
type TokenName = typeof TOKEN_NAMES[number];
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.bool, tags.null, tags.meta, tags.heading, tags.processingInstruction, tags.contentSeparator], class: 'keyword' },
  { tag: [tags.string, tags.regexp, tags.monospace], class: 'string' },
  { tag: tags.number, class: 'number' },
  { tag: tags.comment, class: 'comment' },
  { tag: [tags.function(tags.variableName), tags.standard(tags.variableName), tags.tagName, tags.link, tags.url], class: 'function' },
  { tag: [tags.typeName, tags.className, tags.emphasis, tags.strong], class: 'type' },
  { tag: [tags.operator, tags.escape], class: 'operator' },
]);

export function codeTokens(source: string, language: CodeLanguage = 'python') {
  const tokens: Array<{ from: number; to: number; token: TokenName }> = [];
  const parser = languages[language].parser;
  highlightTree(parser.parse(source), highlighter, (from, to, classes) => {
    // Markup inherits parent styles (e.g. a strong run inside a heading).
    // A code token owns one color, so let the innermost matching style win.
    const token = classes.split(/\s+/).at(-1) as TokenName;
    tokens.push({ from, to, token });
  });
  return tokens;
}

const BLOCKS = new Set(['p', 'div', 'pre', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Index text without flattening the authored paragraphs, breaks or formatting. */
function indexText<N>(root: N, read: (node: N) => { text?: string; tag?: string; children?: N[] }) {
  let source = '';
  const runs: Array<{ node: N; from: number; to: number }> = [];
  const visit = (node: N) => {
    const value = read(node);
    if (value.text !== undefined) {
      const from = source.length;
      source += value.text;
      runs.push({ node, from, to: source.length });
      return;
    }
    if (value.tag === 'br') { source += '\n'; return; }
    const block = value.tag && BLOCKS.has(value.tag);
    if (block && source && !source.endsWith('\n')) source += '\n';
    for (const child of value.children ?? []) visit(child);
    if (block && !source.endsWith('\n')) source += '\n';
  };
  visit(root);
  return { source, runs };
}

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Generated spans exist only in rendered output, never in the deck's source HTML. */
export function highlightedCodeHtml(html: string, language: CodeLanguage = 'python'): string {
  const root = parseFragment(html);
  type Node = DefaultTreeAdapterMap['node'];
  const { source, runs } = indexText<Node>(root, (node) => ({
    ...(adapter.isTextNode(node) ? { text: adapter.getTextNodeContent(node) } : {}),
    ...(adapter.isElementNode(node) ? { tag: adapter.getTagName(node) } : {}),
    ...('childNodes' in node ? { children: node.childNodes } : {}),
  }));
  const tokens = codeTokens(source, language);
  for (const run of runs) {
    const node = run.node;
    if (!adapter.isTextNode(node) || !node.parentNode) continue;
    let cursor = run.from;
    let markup = '';
    for (const token of tokens) {
      const from = Math.max(run.from, token.from), to = Math.min(run.to, token.to);
      if (to <= from) continue;
      markup += escapeText(source.slice(cursor, from));
      markup += `<span data-code-token="${token.token}">${escapeText(source.slice(from, to))}</span>`;
      cursor = to;
    }
    markup += escapeText(source.slice(cursor, run.to));
    const children = parseFragment(markup).childNodes;
    const parent = node.parentNode;
    parent.childNodes.splice(parent.childNodes.indexOf(node), 1, ...children);
    for (const child of children) child.parentNode = parent;
  }
  return serialize(root);
}

// Only one box is edited at once. Browser highlight ranges color its existing
// text nodes without mutating contenteditable, the native undo stack or selection.
export function clearLiveCodeHighlight(): void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return;
  for (const token of TOKEN_NAMES) CSS.highlights.delete(`code-${token}`);
}

export function highlightLiveCode(root: HTMLElement, language: CodeLanguage = 'python'): void {
  clearLiveCodeHighlight();
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  const { source, runs } = indexText<Node>(root, (node) => ({
    ...(node.nodeType === 3 ? { text: node.textContent ?? '' } : {}),
    ...(node instanceof Element ? { tag: node.tagName.toLowerCase() } : {}),
    children: [...node.childNodes],
  }));
  const highlights = new Map(TOKEN_NAMES.map((token) => [token, new Highlight()]));
  for (const token of codeTokens(source, language)) {
    for (const run of runs) {
      const from = Math.max(token.from, run.from), to = Math.min(token.to, run.to);
      if (to <= from) continue;
      const range = root.ownerDocument.createRange();
      range.setStart(run.node, from - run.from);
      range.setEnd(run.node, to - run.from);
      highlights.get(token.token)!.add(range);
    }
  }
  for (const [token, ranges] of highlights) CSS.highlights.set(`code-${token}`, ranges);
}
