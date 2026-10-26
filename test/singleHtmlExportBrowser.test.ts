import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, copyFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { exportDeck, exportDeckHtml } from '../src/main/exportDeck.js';
import { getFfmpegPath, run } from '../src/main/ffmpeg.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { Cdp, launchBrowser, findTarget, eventually, stopBrowser } from './support/browserSession.js';
import { sharedBuild, collabClientDir } from './support/collabClient.js';
import { materializeDesktopApp, launchDesktopApp, isEditorTarget } from './support/desktopApp.js';

let root = '';
let child: ChildProcess | null = null;
let cdp: Cdp | null = null;
let server: RunningCollabServer | null = null;
afterEach(async () => {
  cdp?.close(); cdp = null;
  await stopBrowser(child); child = null;
  await server?.close(); server = null;
  if (root) await rm(root, { recursive: true, force: true });
});

async function playerBundle(): Promise<string> {
  return sharedBuild({
    cacheName: 'deckwerk-single-html-player', inputs: ['src', 'vite.export.config.ts', 'package-lock.json'],
    produce: async (outDir, checkout) => {
      await build({ configFile: join(checkout, 'vite.export.config.ts'), logLevel: 'silent', build: { outDir } });
    },
  });
}

async function fixture(dir: string): Promise<Deck> {
  await mkdir(join(dir, 'assets/web'), { recursive: true });
  await copyFile(join(process.cwd(), 'resources/deckwerk-icon.png'), join(dir, 'assets/pic.png'));
  await copyFile(join(process.cwd(), 'src/renderer/editor/fonts/Monaspace-Krypton-Var.woff2'), join(dir, 'assets/mono.woff2'));
  await run(getFfmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'assets/clip.mp4')]);
  await writeFile(join(dir, 'assets/web/page.html'), '<!doctype html><img src="../pic.png" onload="parent.postMessage(\'image-ready\', \'*\')"><script>parent.postMessage("script-ready", "*");</script>');
  const deck = parseDeck({ ...emptyDeck('Portable <HTML>'), slides: [
    { id: 'one', elements: [
      { id: 'title', type: 'text', x: 100, y: 100, w: 1500, h: 100, html: 'Portable export', class: ['role-title'] },
      { id: 'code', type: 'text', x: 100, y: 350, w: 900, h: 300, html: 'def greet():\n    return 42', class: ['role-code'], codeLanguage: 'python' },
      { id: 'picture', type: 'image', x: 1200, y: 300, w: 400, h: 400, src: 'assets/pic.png' },
    ] },
    { id: 'media', elements: [{ id: 'video', type: 'video', x: 200, y: 200, w: 1000, h: 600, src: 'assets/clip.mp4', autoplay: false, muted: true }] },
    { id: 'web', elements: [{ id: 'web-page', type: 'web', x: 200, y: 200, w: 1000, h: 600, src: 'assets/web/page.html', title: 'Interactive page' }] },
    { id: 'skip', skipped: true, elements: [] },
  ] });
  await saveDeck(dir, deck);
  await writeFile(join(dir, 'theme.css'), '@font-face { font-family: DemoMono; src: url("assets/mono.woff2"); }\n.slide { background:#fff; color:#123456; } .role-code { font-family:DemoMono; }');
  return deck;
}

it('opens a single HTML offline, matching the folder player, with fonts, video, and interactive pages', { timeout: 120_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'single-html-player-'));
  const dir = join(root, 'source'), file = join(root, 'single', 'talk.html');
  const deck = await fixture(dir);
  const bundle = await playerBundle();
  const progress: string[] = [];
  await exportDeckHtml(dir, deck, file, (message) => progress.push(message), { playerBundleDir: bundle, dropSkipped: true });
  await exportDeck(dir, deck, join(root, 'folder'), undefined, { playerBundleDir: bundle, dropSkipped: true });
  expect(await readdir(join(root, 'single'))).toEqual(['talk.html']);
  const html = await readFile(file, 'utf8');
  expect(html).toContain('data:video/mp4;base64,');
  expect(html).toContain('data:font/woff2;base64,');
  expect(html).toContain('data:text/html;base64,');
  expect(html).not.toContain('src="./player.js"');
  expect(progress).toContain('Embedding assets/clip.mp4');
  expect(progress.at(-1)).toBe('HTML export complete');
  await rm(dir, { recursive: true, force: true });
  const browser = await launchBrowser('about:blank', join(root, 'profile'));
  child = browser.process;
  const target = await findTarget(browser.debugPort, (item) => item.url === 'about:blank', browser.log);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
  const snapshot = async (path: string) => {
    await cdp!.call('Page.navigate', { url: pathToFileURL(path).href });
    await eventually(() => cdp!.evaluate<boolean>('!!window.__SLIDE_PLAYER__ && [...document.images].every(img => img.complete && img.naturalWidth > 0)'), 'export player and images did not load');
    await cdp!.evaluate('document.fonts.ready');
    await cdp!.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    return (await cdp!.call('Page.captureScreenshot', { format: 'png' })).data as string;
  };
  const folder = await snapshot(join(root, 'folder', 'index.html'));
  const single = await snapshot(file);
  expect(Buffer.from(single, 'base64').equals(Buffer.from(folder, 'base64')), 'single HTML must paint the same slide as web export').toBe(true);
  expect(await cdp.evaluate<number>('window.__DECK__.slides.length')).toBe(3);
  await cdp.evaluate('window.__SLIDE_PLAYER__.goToSlide(1)');
  await eventually(() => cdp!.evaluate<boolean>('document.querySelector("video")?.readyState >= 2'), 'embedded video did not load');
  expect(await cdp.evaluate<string>('document.querySelector("video").src')).toMatch(/^data:video\/mp4/);
  await cdp.evaluate('window.__exportTestMessages = []; addEventListener("message", e => window.__exportTestMessages.push(e.data)); window.__SLIDE_PLAYER__.goToSlide(2)');
  await eventually(() => cdp!.evaluate<boolean>('window.__exportTestMessages.includes("script-ready") && window.__exportTestMessages.includes("image-ready")'), 'embedded page scripts and nested assets did not run');
});

it('exports from the desktop menu below Web and downloads HTML through the hosted route', { timeout: 120_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'single-html-menu-'));
  const dir = join(root, 'decks', 'demo'), output = join(root, 'download.html');
  await fixture(dir);
  const bundle = await playerBundle();
  const appDir = join(root, 'app'), runtime = join(root, 'runtime');
  await materializeDesktopApp(appDir, 'single-html-test');
  await mkdir(join(runtime, 'out'), { recursive: true });
  await symlink(bundle, join(runtime, 'out/export'), 'dir');
  const dialogs = join(root, 'dialogs.json');
  await writeFile(dialogs, JSON.stringify([{ filePath: output }]));
  const app = await launchDesktopApp(appDir, [dir], { profileDir: join(root, 'desktop-profile'), cwd: runtime, env: { DECKWERK_TEST_DIALOGS: dialogs } });
  child = app.process;
  const target = await findTarget(app.debugPort, isEditorTarget, app.log);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(() => cdp!.evaluate<boolean>('!!document.querySelector("#canvas .slide")'), 'desktop fixture did not open');
  // Force the expanded toolbar so the visible Save As menu is the one driven.
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await eventually(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('.shape-menu-trigger')].some(el =>
    ['Save As…', 'File'].includes(el.textContent.trim()) && el.getBoundingClientRect().width > 0)`), 'export menu is not visible');
  await cdp.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')].find(el =>
    ['Save As…', 'File'].includes(el.textContent.trim()) && el.getBoundingClientRect().width > 0).dataset.exportTestTrigger = 'true'`);
  await cdp.click('[data-export-test-trigger]');
  const labels = await cdp.evaluate<string[]>('[...document.querySelectorAll(".shape-menu-item")].map(item => item.textContent)');
  const expanded = labels.includes('Web…');
  expect(labels[labels.indexOf(expanded ? 'Web…' : 'Export Web…') + 1]).toBe(expanded ? 'Single HTML…' : 'Export Single HTML…');
  await cdp.clickByText('.shape-menu-item', expanded ? 'Single HTML…' : 'Export Single HTML…');
  await cdp.choose('.web-export-quality select', 'original');
  await cdp.click('.web-export-dialog .primary');
  await eventually(async () => existsSync(output), 'menu HTML export was not saved', Boolean, 30_000);
  expect(await readFile(output, 'utf8')).toContain('window.__DECK_ASSETS__');
  // A cancelled destination leaves no busy operation behind.
  await writeFile(dialogs, JSON.stringify([{ canceled: true }]));
  expect(await cdp.evaluate('window.api.exportSingleHtml({ quality: "original" })')).toBeNull();
  await stopBrowser(child); child = null; cdp.close(); cdp = null;

  server = await startCollabServer({ rootDir: join(root, 'decks'), host: '127.0.0.1', port: 0, exportPlayerDir: bundle, clientDir: await collabClientDir() });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/export/web?deck=demo&format=html&quality=original`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('content-disposition')).toContain('demo.html');
  expect(await response.text()).toContain('window.__DECK_ASSETS__');
  const browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=demo&name=Exporter`, join(root, 'hosted-profile'));
  child = browser.process;
  const hostedTarget = await findTarget(browser.debugPort, item => item.url.includes('?deck=demo'), browser.log);
  cdp = await Cdp.connect(hostedTarget.webSocketDebuggerUrl!);
  await cdp.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(root, 'downloads') });
  await eventually(() => cdp!.evaluate<boolean>('!!document.querySelector("#canvas .slide")'), 'hosted fixture did not open');
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await eventually(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('.shape-menu-trigger')].some(el =>
    ['Save As…', 'File'].includes(el.textContent.trim()) && el.getBoundingClientRect().width > 0)`), 'hosted export menu is not visible');
  await cdp.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')].find(el =>
    ['Save As…', 'File'].includes(el.textContent.trim()) && el.getBoundingClientRect().width > 0).dataset.exportTestTrigger = 'true'`);
  await cdp.click('[data-export-test-trigger]');
  const hostedLabels = await cdp.evaluate<string[]>('[...document.querySelectorAll(".shape-menu-item")].map(item => item.textContent)');
  const hostedExpanded = hostedLabels.includes('Web…');
  expect(hostedLabels[hostedLabels.indexOf(hostedExpanded ? 'Web…' : 'Export Web…') + 1]).toBe(hostedExpanded ? 'Single HTML…' : 'Export Single HTML…');
  await cdp.clickByText('.shape-menu-item', hostedExpanded ? 'Single HTML…' : 'Export Single HTML…');
  await cdp.choose('.web-export-quality select', 'original');
  await cdp.click('.web-export-dialog .primary');
  await eventually(async () => existsSync(join(root, 'downloads/demo.html')), 'hosted menu did not download the HTML file', Boolean, 30_000);
  expect(await readFile(join(root, 'downloads/demo.html'), 'utf8')).toContain('window.__DECK_ASSETS__');
});
