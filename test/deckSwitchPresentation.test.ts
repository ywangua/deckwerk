import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck, serializeDeck } from '../src/main/deckStore.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
  wait,
} from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * Which deck does Present actually present, with more than one open?
 *
 * Open, New and Import each put their deck in a window of its own, and every
 * window owns its document: its own session, its own watchers, its own
 * projector. What that has to guarantee is that nothing crosses between them
 * — a save, a watcher reload, or a Present belonging to one presentation must
 * never reach another's folder or another's audience window. The bug class
 * this file was written for is the same one in a new shape: work still in
 * flight for one document landing in another.
 *
 * These tests drive the real toolbar in the real app and read what the real
 * audience window renders, so a mismatch between an editor and its projector
 * cannot pass. Only the two things a test cannot supply are scripted: the
 * native file panels (see src/main/dialogs.ts) and Apple's format decoder,
 * which is replaced by a sidecar stub speaking the same protocol. Everything
 * from the IPC handler inwards is the shipping code.
 */

const runnable = Boolean(electronBinary)
  && process.platform !== 'win32';

const MARKER_ID = 'deck-marker';

/** A deck whose only content is a marker the audience window can be read for. */
function markerDeck(title: string, marker: string): Deck {
  const deck = emptyDeck(title);
  deck.slides[0].elements.push({
    id: MARKER_ID,
    type: 'text',
    x: 160,
    y: 400,
    w: 1600,
    h: 240,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html: marker,
    align: 'center',
    valign: 'middle',
  });
  return deck;
}

/** A one-pixel PNG: real bytes for the importer to hash and copy. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * An SVG sized to say which deck it came from. Size rather than text because a
 * `file://` page cannot `fetch` another scheme, but it can load an image from
 * one and measure it -- which is how the app itself uses these URLs.
 */
function probeSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"></svg>`;
}

/** A minimal image element, for a clipboard payload the schema will accept. */
function imageElement(id: string, src: string): Record<string, unknown> {
  return {
    id,
    type: 'image',
    src,
    x: 100,
    y: 100,
    w: 200,
    h: 200,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
  };
}

const THEME = [
  '.slide { background: #ffffff; color: #111111; }',
  '.element-text { font: 700 72px/1.1 Arial, sans-serif; }',
  '',
].join('\n');

async function writeMarkerDeck(dir: string, title: string, marker: string): Promise<Deck> {
  const deck = markerDeck(title, marker);
  await mkdir(dir, { recursive: true });
  await saveDeck(dir, deck);
  await writeFile(join(dir, 'theme.css'), THEME, 'utf8');
  return deck;
}

let workDir = '';
let appProcess: ChildProcess | null = null;
let appLog: () => string = () => '';
let debugPort = 0;
let dialogQueue = '';
let alphaDir = '';
let bravoDir = '';
let charlieDir = '';
let deltaDir = '';
let keyFile = '';

/** Pre-answer the next native file panels, in the order the app will open them. */
async function scriptDialogs(...answers: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(dialogQueue, JSON.stringify(answers), 'utf8');
}

/** One editor window, and the document it currently holds. */
interface EditorHandle {
  cdp: Cdp;
  dir: string | null;
  filePath?: string;
  marker: string | null;
  /** The renderer has actually adopted the deck, so its deck-only UI is up. */
  ready: boolean;
}

async function listTargets(): Promise<Array<{ url: string; webSocketDebuggerUrl?: string }>> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  return await response.json() as Array<{ url: string; webSocketDebuggerUrl?: string }>;
}

/**
 * One debugger connection per editor window, for as long as the app runs.
 *
 * `clickByText` marks the element it is about to click with an id counted per
 * connection, so a second connection to the same window would reuse an id
 * already in that document and click whatever wore it first.
 */
const editorConnections = new Map<string, Cdp>();

async function connectionTo(webSocketDebuggerUrl: string): Promise<Cdp> {
  const existing = editorConnections.get(webSocketDebuggerUrl);
  if (existing) return existing;
  const cdp = await Cdp.connect(webSocketDebuggerUrl);
  editorConnections.set(webSocketDebuggerUrl, cdp);
  return cdp;
}

/**
 * Connect to every editor window and read what it has open.
 *
 * The whole point of the feature under test is that there can be more than
 * one, so nothing here may assume "the" editor: each window is asked, through
 * the same bridge its own renderer uses, which deck it holds.
 */
async function openEditors(): Promise<EditorHandle[]> {
  const handles: EditorHandle[] = [];
  for (const target of await listTargets()) {
    if (!target.webSocketDebuggerUrl || !target.url.includes('/editor/index.html')) continue;
    const cdp = await connectionTo(target.webSocketDebuggerUrl);
    const state = await cdp.evaluate<{ dir: string | null; marker: string | null; ready: boolean }>(`
        window.api.getDeck().then((session) => ({
          dir: session?.dir ?? null,
          filePath: session?.filePath,
          marker: document.querySelector('#canvas [data-element-id="${MARKER_ID}"]')?.textContent ?? null,
          // The main process has the deck before the renderer has drawn it,
          // and the toolbar's deck-only controls -- Present among them -- are
          // neither present nor laid out until it has. Clicking one before
          // that is a race, so wait for a real box rather than for the class.
          ready: !document.body.classList.contains('welcome-mode')
            && (document.querySelector('#toolbar .bar-right')?.getBoundingClientRect().width ?? 0) > 0,
        }))
      `);
    handles.push({ cdp, ...state });
  }
  return handles;
}

/** Wait for some editor window to be showing a deck, and keep that connection. */
async function editorShowing(dir: string, message: string): Promise<EditorHandle> {
  const found = await eventually<EditorHandle | null>(
    async () => {
      const handles = await openEditors();
      return handles.find((handle) => (handle.dir === dir || handle.filePath === `${dir}.dw`) && handle.ready) ?? null;
    },
    message,
    (value) => value !== null,
    20_000,
  );
  return found!;
}

/** How many editor windows the app has up. */
async function editorWindowCount(): Promise<number> {
  return (await listTargets())
    .filter((target) => target.webSocketDebuggerUrl && target.url.includes('/editor/index.html'))
    .length;
}

async function markerOf(handle: EditorHandle, marker: string, message: string): Promise<void> {
  await eventually(
    async () => handle.cdp.evaluate<string | null>(
      `document.querySelector('#canvas [data-element-id="${MARKER_ID}"]')?.textContent ?? null`,
    ),
    message,
    (value) => value === marker,
    20_000,
  );
}

/**
 * Click Present in one editor window, read what its audience window renders,
 * then close it.
 *
 * The deck folder is read back through the same bridge the window itself used,
 * so a window showing the right slides from the wrong deck cannot pass either.
 */
/**
 * Close any audience window still up from an earlier step. One left open
 * would be read as this step's projector, and would also make Present focus
 * it instead of opening a window.
 */
async function closeAudienceWindows(): Promise<void> {
  const leftOver = (await listTargets())
    .filter((candidate) => candidate.webSocketDebuggerUrl && candidate.url.includes('/present/index.html'));
  if (leftOver.length === 0) return;
  for (const target of leftOver) {
    const stale = await Cdp.connect(target.webSocketDebuggerUrl!);
    await stale.evaluate('window.close()').catch(() => {});
    stale.close();
  }
  await eventually(
    async () => !(await listTargets()).some((candidate) => candidate.url.includes('/present/index.html')),
    'a leftover audience window did not close',
  );
}

async function present(handle: EditorHandle): Promise<{ marker: string | null; dir: string | null }> {
  await closeAudienceWindows();
  await handle.cdp.clickByText('button', 'Present', 'Present');
  const target = await findTarget(
    debugPort,
    (candidate) => candidate.url.includes('/present/index.html'),
    appLog,
  );
  const audience = await Cdp.connect(target.webSocketDebuggerUrl!);
  try {
    // Wait for a rendered slide rather than for the expected content: a
    // window that comes up with the wrong deck must fail the assertion below,
    // not be waited out until it happens to be right.
    const rendered = await eventually(
      async () => audience.evaluate<{ marker: string | null; dir: string | null; slide: boolean }>(`
        window.api.getDeck().then((session) => ({
          marker: document.querySelector('[data-element-id="${MARKER_ID}"]')?.textContent ?? null,
          dir: session?.dir ?? null,
          slide: Boolean(document.querySelector('.slide')),
        }))
      `),
      'the audience window never rendered a slide',
      (value) => value.slide && Boolean(value.dir),
    );
    return { marker: rendered.marker, dir: rendered.dir };
  } finally {
    await audience.evaluate('window.close()').catch(() => {});
    audience.close();
    // The next Present must open a window rather than focus this one.
    await eventually(
      async () => !(await listTargets()).some((candidate) => candidate.url.includes('/present/index.html')),
      'the audience window did not close',
    );
  }
}

/**
 * A stand-in for the Keynote sidecar: it speaks the importer's protocol (a
 * progress line on stderr, the deck as JSON on stdout, the converted folder on
 * disk) without needing Apple's format decoder or a Python environment.
 */
async function installImporterStub(appDir: string, outDir: string, deck: Deck): Promise<void> {
  const payload = join(appDir, 'imported-payload.json');
  await writeFile(payload, JSON.stringify({
    dir: outDir,
    deck,
    report: { slides: deck.slides.length, elements: 1, unsupported: {}, warnings: [] },
  }), 'utf8');
  await mkdir(join(appDir, 'importers', 'keynote'), { recursive: true });
  // Only its existence is checked; the interpreter below never reads it.
  await writeFile(join(appDir, 'importers', 'keynote', 'import_keynote.py'), '', 'utf8');
  await mkdir(join(appDir, '.venv-import', 'bin'), { recursive: true });
  const stub = join(appDir, '.venv-import', 'bin', 'python');
  await writeFile(stub, [
    '#!/bin/sh',
    '# argv: <script> <keyPath> --out <outDir>',
    'set -e',
    'out="$4"',
    'mkdir -p "$out"',
    `cp ${JSON.stringify(join(appDir, 'imported-deck.json'))} "$out/deck.json"`,
    `cp ${JSON.stringify(join(appDir, 'imported-theme.css'))} "$out/theme.css"`,
    'printf "@progress 0.5 Converting slides\\n" >&2',
    `node -e 'const fs = require("node:fs"); const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); payload.dir = process.argv[2]; process.stdout.write(JSON.stringify(payload));' ${JSON.stringify(payload)} "$out"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(stub, 0o755);
  await writeFile(join(appDir, 'imported-deck.json'), serializeDeck(deck), 'utf8');
  await writeFile(join(appDir, 'imported-theme.css'), THEME, 'utf8');
}

describe.skipIf(!runnable)('presenting with several presentations open', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deck-switch-present-'));
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    // The app runs from the shared build, but out of its own working
    // directory, which is where the importer stub is found.
    await materializeDesktopApp(appDir, 'deckwerk-deck-switch-test');

    alphaDir = join(workDir, 'alpha');
    bravoDir = join(workDir, 'bravo');
    charlieDir = join(workDir, 'charlie');
    deltaDir = join(workDir, 'delta');
    keyFile = join(workDir, 'charlie.key');
    await writeMarkerDeck(alphaDir, 'Alpha', 'ALPHA DECK');
    await writeMarkerDeck(bravoDir, 'Bravo', 'BRAVO DECK');
    await writeFile(keyFile, 'not a real Keynote archive', 'utf8');
    await installImporterStub(appDir, charlieDir, markerDeck('Charlie', 'CHARLIE IMPORT'));

    dialogQueue = join(workDir, 'dialogs.json');
    await scriptDialogs();

    const app = await launchDesktopApp(appDir, [alphaDir], { profileDir, cwd: appDir, env: { DECKWERK_TEST_DIALOGS: dialogQueue } });
    appProcess = app.process;
    debugPort = app.debugPort;
    appLog = app.log;
    await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
      30_000,
    );
    await editorShowing(alphaDir, 'the editor did not open the first deck');
  }, 90_000);

  afterAll(async () => {
    for (const cdp of editorConnections.values()) cdp.close();
    editorConnections.clear();
    await stopBrowser(appProcess);
    appProcess = null;
    if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
    workDir = '';
  }, 30_000);

  it('presents the deck the app was opened with', async () => {
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    expect(await present(alpha)).toEqual({ marker: 'ALPHA DECK', dir: alphaDir });
  }, 60_000);

  it('opens a second presentation in a window of its own', async () => {
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    await scriptDialogs({ canceled: false, filePaths: [bravoDir] });
    // With a deck open, New and Open live in the File menu.
    await alpha.cdp.clickByText('.shape-menu-trigger', 'File', 'File');
    await alpha.cdp.clickByText('.shape-menu-item', 'Open…', 'File → Open…');

    await editorShowing(bravoDir, 'Open did not put the second deck in a window');
    // The window the author opened from keeps the presentation it had.
    await markerOf(alpha, 'ALPHA DECK', 'Open replaced the first deck instead of adding a window');
    expect(await editorWindowCount()).toBe(2);
  }, 60_000);

  it('presents each window its own deck', async () => {
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    expect(await present(bravo)).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
    expect(await present(alpha)).toEqual({ marker: 'ALPHA DECK', dir: alphaDir });
  }, 90_000);

  it('brings an open presentation forward rather than opening it twice', async () => {
    // Two windows on one folder would be two debounced whole-file writers
    // racing over the same deck.json.
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    await scriptDialogs({ canceled: false, filePaths: [bravoDir] });
    // With a deck open, New and Open live in the File menu.
    await alpha.cdp.clickByText('.shape-menu-trigger', 'File', 'File');
    await alpha.cdp.clickByText('.shape-menu-item', 'Open…', 'File → Open…');
    await wait(1500);
    expect(await editorWindowCount()).toBe(2);
    await markerOf(alpha, 'ALPHA DECK', 'the asking window lost its own deck');
  }, 60_000);

  it("refuses a save that names another window's deck", async () => {
    // An autosave issued for a deck this window does not hold. It must be
    // refused: writing it would put those slides in another document's folder
    // and, because Present reads the window's session, on a projector.
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    const stale = markerDeck('Alpha', 'ALPHA STALE');
    const refused = await bravo.cdp.evaluate<string | null>(`
      window.api.saveDeck(${JSON.stringify(alphaDir)}, ${JSON.stringify(stale)})
        .then(() => null, (error) => String(error.message ?? error))
    `);
    expect(refused).toMatch(/no longer open/);
    expect(await present(bravo)).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
  }, 60_000);

  it('imports into a window of its own', async () => {
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    await scriptDialogs(
      { canceled: false, filePaths: [keyFile] },
      { canceled: false, filePath: charlieDir },
    );
    // With a deck open, New / Open / Import / Save As all live in the one
    // File menu; the expanded buttons are the welcome screen's only.
    await alpha.cdp.clickByText('.shape-menu-trigger', 'File', 'File');
    await alpha.cdp.clickByText('.shape-menu-item', 'Keynote…', 'File → Keynote…');

    const charlie = await editorShowing(charlieDir, 'the import did not open in a window');
    await markerOf(alpha, 'ALPHA DECK', 'the import replaced the deck the author was working on');
    expect(await present(charlie)).toEqual({ marker: 'CHARLIE IMPORT', dir: charlie.dir });
  }, 90_000);

  it('creates a new presentation in a window of its own', async () => {
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    await scriptDialogs({ canceled: false, filePath: deltaDir });
    await alpha.cdp.clickByText('.shape-menu-trigger', 'File', 'File');
    await alpha.cdp.clickByText('.shape-menu-item', 'New', 'File → New');

    const delta = await editorShowing(deltaDir, 'New did not open a window for the new deck');
    await markerOf(alpha, 'ALPHA DECK', 'New replaced the deck the author was working on');
    const presented = await present(delta);
    expect(presented.dir).toBe(delta.dir);
    expect(presented.marker).toBe(null);
  }, 90_000);

  it("keeps one window's outside edits out of another window's projector", async () => {
    // An outside writer — an agent, a git checkout — keeps changing one open
    // deck. Its window must follow, and no other window's may.
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    const stale = serializeDeck(markerDeck('Stale', 'STALE EXTERNAL'));
    await writeFile(join(alphaDir, 'deck.json'), stale, 'utf8');
    await markerOf(alpha, 'STALE EXTERNAL', 'the window holding the deck did not follow the outside edit');
    // Longer than the watcher's debounce: any reload still owed has fired.
    await wait(1000);

    await markerOf(bravo, 'BRAVO DECK', 'another window followed an edit to a deck it does not hold');
    expect(await present(bravo)).toEqual({ marker: 'BRAVO DECK', dir: bravoDir });
    expect(await present(alpha)).toEqual({ marker: 'STALE EXTERNAL', dir: alphaDir });
  }, 90_000);


  it("serves each window its own deck's assets", async () => {
    // Asset requests carry no window identity, so the `deck://` URL has to
    // name the deck. Same relative path in both decks, different bytes: a
    // single app-wide asset root would hand one window the other's file.
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    await mkdir(join(alphaDir, 'assets'), { recursive: true });
    await mkdir(join(bravoDir, 'assets'), { recursive: true });
    await writeFile(join(alphaDir, 'assets', 'probe.svg'), probeSvg(8), 'utf8');
    await writeFile(join(bravoDir, 'assets', 'probe.svg'), probeSvg(16), 'utf8');

    const measure = (handle: EditorHandle) => handle.cdp.evaluate<number>(`
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => reject(new Error('the deck asset did not load'));
        image.src = window.api.assetUrl('assets/probe.svg');
      })
    `);
    expect(await measure(alpha)).toBe(8);
    expect(await measure(bravo)).toBe(16);

    const urlOf = (handle: EditorHandle) => handle.cdp.evaluate<string>(
      "window.api.assetUrl('assets/probe.svg')",
    );
    expect(await urlOf(alpha)).not.toBe(await urlOf(bravo));
  }, 60_000);

  it('imports a copied element\'s media into the deck it is pasted into', async () => {
    // Copy resolves absolute asset paths against the *sending* window's deck,
    // and paste re-imports them into the *receiving* window's deck. Reading
    // either from anything app-wide would copy the wrong bytes, or none.
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    const source = join(workDir, 'clipboard-source.png');
    await writeFile(source, PNG_1PX);

    const imported = await alpha.cdp.evaluate<{ src: string; w: number; h: number }>(`
      window.api.importAssets([${JSON.stringify(source)}]).then((assets) => assets[0])
    `);
    expect(existsSync(join(alphaDir, imported.src))).toBe(true);
    expect(existsSync(join(bravoDir, imported.src))).toBe(false);

    await alpha.cdp.evaluate(`
      window.api.writeClipboard({
        kind: 'elements',
        sourceSlideId: null,
        timeline: [],
        elements: [${JSON.stringify(imageElement('pasted-image', 'PLACEHOLDER'))}],
      })
    `.replace('"PLACEHOLDER"', JSON.stringify(imported.src)));

    const pasted = await bravo.cdp.evaluate<{
      kind: string;
      elements: Array<{ src?: string }>;
    }>('window.api.readClipboard()');
    expect(pasted.kind).toBe('elements');
    // Paste points the element at the destination deck's own copy, which the
    // importer names by content hash.
    const pastedSrc = pasted.elements[0].src!;
    expect(pastedSrc.startsWith('assets/')).toBe(true);
    expect(existsSync(join(bravoDir, pastedSrc))).toBe(true);
    // And the destination window can load it through its own asset host.
    const loaded = await bravo.cdp.evaluate<boolean>(`
      new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = window.api.assetUrl(${JSON.stringify(pastedSrc)});
      })
    `);
    expect(loaded).toBe(true);
  }, 60_000);

  it('leaves a copied element behind when its source deck is gone', async () => {
    // The window that copied has closed its document since. Paste must still
    // produce the element -- broken media is visible and fixable, a silently
    // dropped element is not.
    const alpha = await editorShowing(alphaDir, 'the first deck is not open');
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    const vanishing = join(workDir, 'vanishing.png');
    await writeFile(vanishing, PNG_1PX);
    const imported = await alpha.cdp.evaluate<{ src: string }>(`
      window.api.importAssets([${JSON.stringify(vanishing)}]).then((assets) => assets[0])
    `);
    await alpha.cdp.evaluate(`
      window.api.writeClipboard({
        kind: 'elements',
        sourceSlideId: null,
        timeline: [],
        elements: [${JSON.stringify(imageElement('vanishing-image', 'PLACEHOLDER'))}],
      })
    `.replace('"PLACEHOLDER"', JSON.stringify(imported.src)));
    await rm(join(alphaDir, imported.src), { force: true });

    const pasted = await bravo.cdp.evaluate<{
      kind: string;
      elements: Array<{ id: string; src?: string }>;
    }>('window.api.readClipboard()');
    expect(pasted.kind).toBe('elements');
    expect(pasted.elements).toHaveLength(1);
    expect(pasted.elements[0].src).toBe(imported.src);
  }, 60_000);

  it('re-points an audience window when Save As moves a document', async () => {
    // Save As is the one route that still changes a window's document in
    // place. Present, save a copy without closing the projector, then present
    // again: the window that is already up has to be showing the saved copy.
    const bravo = await editorShowing(bravoDir, 'the second deck is not open');
    let savedDir = join(workDir, 'bravo-copy');
    const savedFile = `${savedDir}.dw`;
    await closeAudienceWindows();
    await bravo.cdp.clickByText('button', 'Present', 'Present');
    const target = await findTarget(
      debugPort,
      (candidate) => candidate.url.includes('/present/index.html'),
      appLog,
    );
    const audience = await Cdp.connect(target.webSocketDebuggerUrl!);
    try {
      await eventually(
        async () => audience.evaluate<boolean>("Boolean(document.querySelector('.slide'))"),
        'the audience window never rendered a slide',
      );
      await scriptDialogs({ canceled: false, filePath: savedDir });
      await bravo.cdp.clickByText('.shape-menu-trigger', 'File', 'File');
      await bravo.cdp.clickByText('.shape-menu-item', 'Save As…', 'File → Save As…');
      await eventually(
        async () => bravo.cdp.evaluate<string | null>(
          'window.api.getDeck().then((session) => session?.filePath ?? null)',
        ),
        'the editor did not move to the saved copy',
        (value) => value === savedFile,
        20_000,
      );
      savedDir = await bravo.cdp.evaluate<string>('window.api.getDeck().then(session => session.dir)');
      await bravo.cdp.clickByText('button', 'Present', 'Present');

      const shown = await eventually(
        async () => audience.evaluate<{ marker: string | null; dir: string | null }>(`
          window.api.getDeck().then((session) => ({
            marker: document.querySelector('[data-element-id="${MARKER_ID}"]')?.textContent ?? null,
            dir: session?.dir ?? null,
          }))
        `),
        'the open audience window never followed Save As',
        (value) => value.dir === savedDir,
        5_000,
      ).catch((error: Error) => error.message);
      expect(shown).toEqual({ marker: 'BRAVO DECK', dir: savedDir });
    } finally {
      await audience.evaluate('window.close()').catch(() => {});
      audience.close();
      await eventually(
        async () => !(await listTargets()).some((candidate) => candidate.url.includes('/present/index.html')),
        'the audience window did not close',
      );
    }
  }, 90_000);
});

describe.skipIf(runnable)('presenting with several presentations open (skipped)', () => {
  it('needs a built Electron app', () => {
    expect(runnable).toBe(false);
  });
});
