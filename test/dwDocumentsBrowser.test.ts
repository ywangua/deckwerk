import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createDeck, loadDeck, saveDeck } from '../src/main/deckStore.js';
import { extractDwArchive, writeDwArchive } from '../src/main/dwArchive.js';
import { Cdp, electronBinary, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';
import type { DeckSession } from '../src/shared/ipc.js';

let root = '';
let process: ChildProcess | null = null;
let editor: Cdp | null = null;
afterEach(async () => {
  editor?.close(); editor = null;
  await stopBrowser(process); process = null;
  if (root) await rm(root, { recursive: true, force: true });
});

it('opens .dw, saves pending text on close, and preserves edits with Save As after an external replacement', { timeout: 120_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-desktop-'));
  const appDir = join(root, 'app'), folder = join(root, 'source'), path = join(root, 'Presentation.dw');
  await materializeDesktopApp(appDir, 'deckwerk-dw-test');
  const deck = await createDeck(folder, 'Archived talk');
  deck.slides[0].elements = [{
    id: 'text', type: 'text', x: 140, y: 150, w: 1600, h: 650,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: 'Original text', align: 'left', valign: 'top',
  }, {
    id: 'image', type: 'image', x: 100, y: 850, w: 100, h: 100,
    rot: 0, z: 2, opacity: 1, class: [], style: {}, src: 'assets/image.svg',
    fit: 'contain', sourceBox: null, alt: 'Archived image',
  }];
  await writeFile(join(folder, 'assets', 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>');
  await saveDeck(folder, deck);
  await writeDwArchive(folder, path);
  const profileDir = join(root, 'profile');
  const dialogs = join(root, 'dialogs.json');
  await writeFile(dialogs, JSON.stringify([{ filePath: join(root, 'Recovered.dw') }]));
  const options = { profileDir, env: { DECKWERK_TEST_DIALOGS: dialogs } };
  let app = await launchDesktopApp(appDir, [path], options);
  process = app.process;
  let target = await findTarget(app.debugPort, isEditorTarget, app.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  const content = '#canvas [data-element-id="text"] .text-content';
  await eventually(() => editor!.evaluate(`document.querySelector(${JSON.stringify(content)})?.textContent`), 'Archived slide did not render', (value) => value === 'Original text');
  const session = await editor.evaluate<DeckSession>('window.api.getDeck()');
  expect(session.filePath).toBe(path);
  expect(session.dir).not.toBe(folder);
  await eventually(() => editor!.evaluate<boolean>(`(() => {
    const image = document.querySelector('#canvas [data-element-id="image"] img');
    return image?.complete && image.naturalWidth === 80;
  })()`), 'Archived image did not load');
  await editor.doubleClickTextAtOffset(content, 2, 'Edit archived text');
  await editor.selectTextRange(content, 0, 'Original text'.length, 'Replace archived text');
  await editor.call('Input.insertText', { text: 'Saved on close' });
  // Closing immediately exercises the renderer/main save handshake, before the autosave timer.
  await editor.evaluate('window.close()').catch(() => {});
  await eventually(async () => app.process.exitCode !== null, 'Archive window did not finish closing', Boolean, 20_000);
  editor.close(); editor = null;
  process = null;
  const extracted = join(root, 'saved');
  await extractDwArchive(path, extracted);
  const saved = await loadDeck(extracted);
  expect(saved.slides[0].elements[0]).toMatchObject({ html: 'Saved on close' });
  expect(await readFile(join(extracted, 'assets', 'image.svg'), 'utf8')).toContain('fill="red"');
  app = await launchDesktopApp(appDir, [path], options);
  process = app.process;
  target = await findTarget(app.debugPort, isEditorTarget, app.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(() => editor!.evaluate(`document.querySelector(${JSON.stringify(content)})?.textContent`), 'Saved archive did not reopen', (value) => value === 'Saved on close');
  await writeFile(path, 'An externally replaced file');
  await editor.doubleClickTextAtOffset(content, 2, 'Edit after external replacement');
  await editor.selectTextRange(content, 0, 'Saved on close'.length, 'Replace text after external replacement');
  await editor.call('Input.insertText', { text: 'Recovered via Save As' });
  await editor.clickByText('.shape-menu-trigger', 'File', 'File');
  await editor.clickByText('.shape-menu-item', 'Save As…', 'Save As after external replacement');
  const recoveredPath = join(root, 'Recovered.dw');
  await eventually(() => editor!.evaluate('window.api.getDeck().then(s => s?.filePath)'), 'Save As did not preserve the conflicted document', (value) => value === recoveredPath);
  const recoveredFolder = join(root, 'recovered');
  await extractDwArchive(recoveredPath, recoveredFolder);
  expect((await loadDeck(recoveredFolder)).slides[0].elements[0]).toMatchObject({ html: 'Recovered via Save As' });
  expect(await readFile(path, 'utf8')).toBe('An externally replaced file');
});

it('creates .dw by default, supports Save As and folder export, and reopens via Open', { timeout: 120_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'dw-dialogs-'));
  const appDir = join(root, 'app'), dialogs = join(root, 'dialogs.json');
  await materializeDesktopApp(appDir, 'deckwerk-dw-dialog-test');
  await writeFile(dialogs, JSON.stringify([
    { filePath: join(root, 'New talk') },
    { filePath: join(root, 'Copy.dw') },
    { filePath: join(root, 'Folder copy') },
    { filePaths: [join(root, 'Copy.dw')] },
  ]));
  const app = await launchDesktopApp(appDir, [], {
    profileDir: join(root, 'profile'), env: { DECKWERK_TEST_DIALOGS: dialogs },
  });
  process = app.process;
  const target = await findTarget(app.debugPort, isEditorTarget, app.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(() => editor!.evaluate<boolean>(`[...document.querySelectorAll('#toolbar button')].some(button => button.textContent === 'New')`), 'New presentation control did not initialize');
  await editor.clickByText('#toolbar button', 'New', 'New presentation');
  await eventually(() => editor!.evaluate('window.api.getDeck().then(s => s?.filePath)'), 'New did not create .dw', (value) => value === join(root, 'New talk.dw'));
  await eventually(() => editor!.evaluate<boolean>("!document.body.classList.contains('welcome-mode')"), 'New did not open');
  await editor.clickByText('.shape-menu-trigger', 'File', 'File');
  await editor.clickByText('.shape-menu-item', 'Save As…', 'Save As');
  await eventually(() => editor!.evaluate('window.api.getDeck().then(s => s?.filePath)'), 'Save As did not create .dw', (value) => value === join(root, 'Copy.dw'));
  await editor.clickByText('.shape-menu-trigger', 'File', 'File');
  await editor.clickByText('.shape-menu-item', 'Save as project folder…', 'Save as project folder');
  await eventually(() => editor!.evaluate('window.api.getDeck().then(s => s?.dir)'), 'Folder copy did not open', (value) => value === join(root, 'Folder copy'));
  const folder = await editor.evaluate<DeckSession>('window.api.getDeck()');
  expect(folder.filePath).toBeUndefined();
  expect(folder.dir).toBe(join(root, 'Folder copy'));
  expect((await loadDeck(folder.dir)).title).toBe('New talk');
  // Opening a saved archive from another document must create a separate window.
  expect(await editor.evaluate('window.api.openDeck()')).toBe(null);
  const targets = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${app.debugPort}/json/list`);
    return await response.json() as Array<{ title: string; url: string; webSocketDebuggerUrl: string }>;
  }, 'Open did not create a second window', (values) => values.filter(isEditorTarget).length === 2);
  let found = false;
  for (const target of targets.filter(isEditorTarget)) {
    const connection = await Cdp.connect(target.webSocketDebuggerUrl);
    await eventually(() => connection.evaluate<boolean>('Boolean(window.api)'), 'New window preload did not initialize');
    const session = await connection.evaluate<DeckSession>('window.api.getDeck()');
    if (session?.filePath === join(root, 'Copy.dw')) found = true;
    connection.close();
  }
  expect(found).toBe(true);
  const secondLaunch = spawn(electronBinary, [appDir, `--user-data-dir=${join(root, 'profile')}`, pathToFileURL(join(root, 'Copy.dw')).href], {
    stdio: 'ignore', env: { ...globalThis.process.env, DECKWERK_HEADLESS_TEST: '1' },
  });
  await new Promise<void>((resolve, reject) => {
    secondLaunch.once('error', reject);
    secondLaunch.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Second launch exited ${code}`)));
  });
  const afterSecondLaunch = await fetch(`http://127.0.0.1:${app.debugPort}/json/list`).then((response) => response.json()) as Array<{ title: string; url: string }>;
  expect(afterSecondLaunch.filter(isEditorTarget)).toHaveLength(2);
  expect((await readFile(join(root, 'Copy.dw'))).subarray(0, 2).toString()).toBe('PK');
});
