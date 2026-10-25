import { CODE_LANGUAGES, CODE_LANGUAGE_LABELS } from '../src/shared/codeLanguages.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import { themeStyleCss, themeStyleOf, THEMES } from '../src/shared/themes.js';
import { Cdp, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

let dir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
afterEach(async () => {
  editor?.close(); editor = null;
  await stopBrowser(appProcess); appProcess = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

it('colors Code in the real editor, changes languages, and highlights typing without moving the caret', { timeout: 120_000 }, async () => {
  dir = await mkdtemp(join(tmpdir(), 'code-role-'));
  const appDir = join(dir, 'app'), deckDir = join(dir, 'deck');
  await mkdir(deckDir, { recursive: true });
  await materializeDesktopApp(appDir, 'deckwerk-code-test');
  const deck = emptyDeck('Code role');
  deck.themePreset = THEMES[0].id;
  deck.themeStyle = themeStyleOf(THEMES[0]);
  deck.slides[0].elements = [{
    id: 'code', type: 'text', x: 140, y: 150, w: 1600, h: 650,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: '# comment\nconst value = "$x$";', align: 'center', valign: 'top',
  }];
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), themeStyleCss(deck.themeStyle));
  const app = await launchDesktopApp(appDir, [deckDir], { profileDir: join(dir, 'profile') });
  appProcess = app.process;
  const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  const content = '#canvas [data-element-id="code"] .text-content';
  await eventually(async () => editor!.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(content)})`), 'Code fixture did not open');
  await editor.click('#canvas [data-element-id="code"]');
  await editor.choose('#inspector .text-role select', 'role-code');
  const style = await editor.evaluate<{ family: string; weight: string; size: string; align: string }>(`(() => {
    const style = getComputedStyle(document.querySelector(${JSON.stringify(content)}));
    return { family: style.fontFamily, weight: style.fontWeight, size: style.fontSize, align: style.textAlign };
  })()`);
  expect(style.family).toContain('monospace');
  expect(style.weight).toBe('400');
  expect(style.size).toBe(`${deck.themeStyle.fonts.caption.size}px`);
  expect(style.align).toBe('left');
  expect(await editor.evaluate(`!!document.querySelector('${content} [data-code-token="comment"]')`)).toBe(true);
  for (const language of CODE_LANGUAGES) {
    await editor.choose('#inspector .code-language select', CODE_LANGUAGE_LABELS[language]);
    expect(await editor.evaluate(`document.querySelector('#canvas [data-element-id="code"]').dataset.codeLanguage`)).toBe(language);
  }
  await editor.choose('#inspector .code-language select', 'JavaScript');
  await eventually(async () => editor!.evaluate<boolean>(`!document.querySelector('${content} [data-code-token="comment"]')`), 'Language change did not repaint tokens');
  expect(await editor.evaluate(`!!document.querySelector('${content} .katex')`)).toBe(false);

  await editor.doubleClickTextAtOffset(content, 2, 'edit code');
  await editor.selectTextRange(content, 0, '# comment\nconst value = "$x$";'.length, 'replace code');
  const source = 'function greet() { return 42; }';
  await editor.call('Input.insertText', { text: source });
  const live = await editor.evaluate<{ keywords: string[]; source: string; generatedSpans: number; caret: number; color: string }>(`(() => {
    const root = document.querySelector(${JSON.stringify(content)});
    const selection = getSelection();
    const range = document.createRange(); range.selectNodeContents(root);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return {
      keywords: [...CSS.highlights.get('code-keyword')].map(String), source: root.textContent,
      generatedSpans: root.querySelectorAll('[data-code-token]').length, caret: range.toString().length,
      color: getComputedStyle(root, '::highlight(code-keyword)').color,
    };
  })()`);
  expect(live.keywords).toEqual(['function', 'return']);
  expect(live.source).toBe(source);
  expect(live.generatedSpans).toBe(0);
  expect(live.caret).toBe(source.length);
  expect(live.color).toBe('rgb(124, 58, 237)');
  await editor.evaluate(`document.querySelector(${JSON.stringify(content)}).focus()`);
  const modifiers = process.platform === 'darwin' ? 4 : 2;
  await editor.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
  await editor.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
  const saved = await eventually(
    () => editor!.evaluate<{ html: string; codeLanguage: string }>(`window.api.getDeck().then(session => session.deck.slides[0].elements.find(el => el.id === 'code'))`),
    'Code source and language did not reach disk',
    (element) => element.codeLanguage === 'javascript' && element.html.includes('greet'),
  );
  expect(saved.codeLanguage).toBe('javascript');
  expect(saved.html).not.toContain('data-code-token');
  expect(await editor.evaluate(`CSS.highlights.has('code-keyword')`)).toBe(false);

  let currentSource = source;
  for (const [language, snippet, keywords] of [
    ['csharp', 'return 42; // comment', ['return']],
    ['matlab', 'if true; value = 42; end % comment', ['if', 'end']],
    ['julia', 'return 42 # comment', ['return']],
    ['latex', String.raw`\section{Hi} % comment`, []],
    ['typst', '#let value = 42 // comment', ['let']],
    ['markdown', '# **Heading** <!-- comment -->', null],
  ] as const) {
    await editor.choose('#inspector .code-language select', CODE_LANGUAGE_LABELS[language]);
    await editor.doubleClickTextAtOffset(content, 2, `edit ${language}`);
    await editor.selectTextRange(content, 0, currentSource.length, `replace ${language} code`);
    await editor.call('Input.insertText', { text: snippet });
    const tokens = await editor.evaluate<{ keywords: string[]; comments: string[]; generated: number }>(`(() => ({
      keywords: [...CSS.highlights.get('code-keyword')].map(String),
      comments: [...CSS.highlights.get('code-comment')].map(String),
      generated: document.querySelector(${JSON.stringify(content)}).querySelectorAll('[data-code-token]').length,
    }))()`);
    if (keywords) expect(tokens.keywords, language).toEqual(keywords);
    else expect(tokens.keywords.length, language).toBeGreaterThan(0);
    expect(tokens.comments.join(''), language).toContain('comment');
    expect(tokens.generated, language).toBe(0);
    await editor.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
    await editor.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
    currentSource = snippet;
  }
});
