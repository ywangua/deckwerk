// @vitest-environment jsdom
import { CODE_LANGUAGES, CODE_LANGUAGE_LABELS, type CodeLanguage } from '../src/shared/codeLanguages.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeckSchema, ThemeStyleSchema, emptyDeck, type TextEl } from '../src/shared/deck.js';
import { CODE_FONT_FAMILY } from '../src/shared/textRoles.js';
import { FONT_SETS, roleForElement } from '../src/shared/fontSets.js';
import { clearLiveCodeHighlight, codeTokens, highlightedCodeHtml, highlightLiveCode } from '../src/shared/codeHighlight.js';
import { THEMES, themeStyleCss, themeStyleFromCss, themeStyleOf, themeVariant } from '../src/shared/themes.js';
import { applyTextRole } from '../src/renderer/editor/textFormatting.js';
import { renderElement } from '../src/renderer/player/render.js';
import { slidesToHtml } from '../src/shared/htmlSlides.js';

function code(html: string, codeLanguage: CodeLanguage = 'python'): TextEl {
  return { id: 'code', type: 'text', x: 10, y: 10, w: 1600, h: 700,
    rot: 0, z: 1, opacity: 1, class: ['role-code'], style: {}, html,
    align: 'left', valign: 'top', codeLanguage };
}

function highlightedText(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Code role defaults and compatibility', () => {
  it('uses caption size and spacing, normal weight and monospace in every preset', () => {
    for (const fonts of [...THEMES.map((theme) => theme.fonts), ...FONT_SETS.map((set) => set.roles)]) {
      expect(fonts.code).toMatchObject({ family: CODE_FONT_FAMILY, size: fonts.caption.size,
        lineHeight: fonts.caption.lineHeight, weight: 400, letterSpacing: '0' });
    }
    expect(roleForElement(['role-code'], 96, 100)).toBe('code');
  });

  it('loads older saved styles and custom themes without Code, retaining their caption size', () => {
    const style = themeStyleOf(THEMES[0]);
    const legacy = JSON.parse(JSON.stringify(style));
    delete legacy.fonts.code;
    legacy.fonts.caption.size = 37;
    const migrated = ThemeStyleSchema.parse(legacy);
    expect(migrated.fonts.code).toMatchObject({ size: 37, weight: 400, family: CODE_FONT_FAMILY });
    const deck = emptyDeck('Legacy');
    const loaded = DeckSchema.parse({ ...deck, themeStyle: legacy,
      customThemes: [{ ...THEMES[0], id: 'custom', ...legacy }] });
    expect(loaded.customThemes[0].fonts.code.size).toBe(37);
    expect(loaded.themeStyle!.fonts.code.size).toBe(37);
    expect(ThemeStyleSchema.parse(migrated)).toEqual(migrated);
  });

  it('resets box typography and alignment, preserving inline emphasis and source colors', () => {
    const el = code('<p style="text-align:center">def <b>hello</b>():</p>');
    el.align = 'center';
    el.style = { 'font-family': 'serif', 'font-weight': '700', 'text-align': 'right', color: '#ffffff' };
    el.contentStyle = { 'text-align': 'center' };
    delete el.codeLanguage;
    applyTextRole(el, 'code', THEMES[0].fonts.code);
    expect(el).toMatchObject({ align: 'left', codeLanguage: 'python',
      style: { 'font-weight': '400', 'font-family': CODE_FONT_FAMILY, color: '#ffffff' } });
    expect(el.contentStyle?.['text-align']).toBeUndefined();
    expect(highlightedText(el.html).querySelector('b')?.textContent).toBe('hello');
    expect(el.html).toContain('text-align: left');
    applyTextRole(el, 'body', THEMES[0].fonts.body);
    expect(el.codeLanguage).toBe('python');
  });

  it('generates theme-aware token colors and reads Code typography back from CSS', () => {
    const light = themeVariant(THEMES[0], 'light');
    const dark = themeVariant(THEMES[0], 'dark');
    expect(themeStyleCss(themeStyleOf(light))).toContain('--code-string: #166534');
    expect(themeStyleCss(themeStyleOf(dark))).toContain('--code-string: #86efac');
    const style = themeStyleOf(dark);
    style.fonts.code.size = 35;
    expect(themeStyleFromCss(themeStyleCss(style), themeStyleOf(light)).fonts.code).toEqual(style.fonts.code);
  });
});

describe('derived syntax highlighting', () => {
  it.each([
    ['python', 'def greet(name):\n    # comment\n    return "hi" + str(42)', ['keyword', 'string', 'number', 'comment', 'function']],
    ['javascript', 'function greet(name) {\n  // comment\n  return "hi" + 42;\n}', ['keyword', 'string', 'number', 'comment', 'function']],
    ['c', '#include <stdio.h>\nint main(void) {\n  /* comment */\n  printf("hi");\n  return 42;\n}', ['keyword', 'string', 'number', 'comment', 'type']],
    ['cpp', '#include <string>\nint main() {\n  // comment\n  auto message = "hi";\n  return 42;\n}', ['keyword', 'string', 'number', 'comment', 'type']],
    ['csharp', 'public class Example {\n  // comment\n  string message = "hi";\n  public int Value() { return 42; }\n}', ['keyword', 'string', 'number', 'comment', 'type']],
    ['java', 'public class Example {\n  // comment\n  String message = "hi";\n  public int value() { return 42; }\n}', ['keyword', 'string', 'number', 'comment', 'type']],
    ['matlab', 'function value = example(x)\n  % comment\n  text = "hi";\n  if x > 0\n    value = 42;\n  end\nend', ['keyword', 'string', 'number', 'comment']],
    ['julia', 'function example(x)\n  # comment\n  text = "hi"\n  return 42\nend', ['keyword', 'string', 'number', 'comment']],
    ['latex', String.raw`\section{Example}
% comment
$x = 42$ and \textbf{source}`, ['function', 'keyword', 'number', 'comment']],
    ['typst', '= Example\n#let value = 42\n#let text = "hi"\n// comment\n*strong* and _emphasis_', ['keyword', 'number', 'string', 'comment', 'type']],
    ['markdown', '# Example\n**strong** and *emphasis* with `code`\n[link](https://example.com)\n<!-- comment -->', ['keyword', 'type', 'string', 'function', 'comment']],
  ] as const)('tokenizes %s, retaining exact source text', (language, source, expected) => {
    const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = highlightedCodeHtml(escaped, language);
    const root = highlightedText(html);
    expect(root.textContent).toBe(source);
    for (const token of expected) expect(root.querySelector(`[data-code-token="${token}"]`)).not.toBeNull();
  });

  it('parses multiline strings across paragraph and span boundaries', () => {
    const html = '<p>value = """first</p><p>    <b>second</b> &lt;tag&gt;"""</p>';
    const root = highlightedText(highlightedCodeHtml(html, 'python'));
    expect(root.querySelector('b')?.textContent).toBe('second');
    expect(root.querySelector('b [data-code-token="string"]')?.textContent).toBe('second');
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.textContent).toBe(highlightedText(html).textContent);
  });

  it('escapes literal markup, preserves tabs and dollar signs, and never evaluates source', () => {
    const source = 'const price = "$x$";\n\tconst html = "&lt;script&gt;alert(1)&lt;/script&gt;";';
    const el = code(source, 'javascript');
    const node = renderElement(el, { resolveSrc: (src) => src });
    expect(node.querySelector('script, .katex')).toBeNull();
    expect(node.querySelector('.text-content')!.textContent).toContain('\n\tconst html');
    expect(node.querySelector('.text-content')!.textContent).toContain('$x$');
    expect(el.html).toBe(source);
    expect(el.style).toEqual({});
  });

  it.each([
    ['csharp', 'var text = @"first\nsecond"; // comment', 'first\nsecond'],
    ['matlab', '%{\nblock comment\n%}\nvalue = 42;', 'block comment'],
    ['julia', '#= outer\n#= nested =#\ncomment =#\nvalue = 42', 'nested'],
  ] as const)('keeps multiline %s tokens across HTML line breaks', (language, source, highlighted) => {
    const tokens = codeTokens(source, language);
    const expected = language === 'csharp' ? 'string' : 'comment';
    const text = tokens.filter((token) => token.token === expected)
      .map((token) => source.slice(token.from, token.to)).join('\n');
    expect(text).toContain(highlighted);
    const html = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const root = highlightedText(highlightedCodeHtml(html, language));
    expect(root.querySelectorAll('br')).toHaveLength(source.split('\n').length - 1);
    expect(root.querySelector(`[data-code-token="${expected}"]`)).not.toBeNull();
  });

  it('distinguishes C from C++ keywords', () => {
    const source = 'class Example {};';
    expect(codeTokens(source, 'c').some((token) => token.token === 'keyword')).toBe(false);
    expect(codeTokens(source, 'cpp').some((token) => token.token === 'keyword')).toBe(true);
  });

  it.each(CODE_LANGUAGES)('persists and exports %s with a stable language id', (language) => {
    const deck = emptyDeck(CODE_LANGUAGE_LABELS[language]);
    deck.slides[0].elements = [code('value = 42;', language)];
    const loaded = DeckSchema.parse(deck);
    expect(loaded.slides[0].elements[0]).toMatchObject({ codeLanguage: language });
    expect(slidesToHtml(loaded.slides, loaded.canvas)).toContain(`data-code-language="${language}"`);
  });

  it.each([
    ['latex', String.raw`\textbf{Bold} and $E = mc^2$`],
    ['typst', '= Heading\n*strong* and $x^2$'],
    ['markdown', '# Heading\n**strong** and `code` <em>literal</em>'],
  ] as const)('renders %s as literal colored source, preserving typography', (language, source) => {
    const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const element = code(escaped, language);
    const node = renderElement(element, { resolveSrc: (src) => src });
    expect(node.querySelector('.text-content')!.textContent).toBe(source);
    expect(node.querySelector('.katex, h1, strong, em, pre, code')).toBeNull();
    expect(node.querySelectorAll('[data-code-token]').length).toBeGreaterThan(0);
    expect(node.querySelector('[data-code-token][style]')).toBeNull();
    expect(element.html).toBe(escaped);
  });

  it.each([
    ['markdown', '# **Heading with _emphasis_**\n[**bold link**](https://example.com)'],
    ['typst', '= *Heading with _emphasis_*\n#link("https://example.com")[*bold link*]'],
  ] as const)('highlights nested %s markup in live text without invalid token categories', (language, source) => {
    const registry = new Map<string, Set<Range>>();
    vi.stubGlobal('Highlight', class extends Set<Range> {});
    vi.stubGlobal('CSS', { highlights: registry });
    const root = document.createElement('div');
    root.textContent = source;
    expect(() => highlightLiveCode(root, language)).not.toThrow();
    expect(root.textContent).toBe(source);
    expect(codeTokens(source, language).every((token) =>
      ['keyword', 'string', 'number', 'comment', 'function', 'type', 'operator'].includes(token.token))).toBe(true);
  });

  it('uses the selected language rather than guessing from text', () => {
    const source = '# comment\nconst value = 42;';
    expect(codeTokens(source, 'python').some((token) => token.token === 'comment')).toBe(true);
    expect(codeTokens(source, 'javascript').some((token) => token.token === 'comment')).toBe(false);
  });

  it('updates live color ranges without changing DOM, selection or source markup', () => {
    const registry = new Map<string, Set<Range>>();
    vi.stubGlobal('Highlight', class extends Set<Range> {});
    vi.stubGlobal('CSS', { highlights: registry });
    const root = highlightedText('<p>def hello():</p><p>    return 42</p>');
    document.body.append(root);
    const text = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 4); range.collapse(true);
    window.getSelection()!.addRange(range);
    const html = root.innerHTML;
    highlightLiveCode(root, 'python');
    expect([...registry.get('code-keyword')!].map(String)).toEqual(['def', 'return']);
    expect(root.innerHTML).toBe(html);
    expect(root.querySelector('p')!.firstChild).toBe(text);
    expect(window.getSelection()!.anchorNode).toBe(text);
    expect(window.getSelection()!.anchorOffset).toBe(4);
    text.textContent = 'class Example:';
    highlightLiveCode(root, 'python');
    expect([...registry.get('code-keyword')!].map(String)).toEqual(['class', 'return']);
    clearLiveCodeHighlight();
    expect(registry.size).toBe(0);
  });

  it('exports highlighted markup and language without changing stored source', () => {
    const deck = emptyDeck('Code');
    const el = code('const value = "$x$";\n  // &lt;hello&gt;', 'javascript');
    deck.slides[0].elements = [el];
    const html = slidesToHtml(deck.slides, deck.canvas);
    expect(html).toContain('data-code-language="javascript"');
    expect(html).toContain('data-code-token="keyword"');
    expect(el.html).not.toContain('data-code-token');
  });
});
