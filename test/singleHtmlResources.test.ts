import { exportDeckHtml } from '../src/main/exportDeck.js';
import { emptyDeck } from '../src/shared/deck.js';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { SingleHtmlResources } from '../src/main/singleHtmlResources.js';

let dir = '';
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
const decode = (uri: string) => Buffer.from(uri.split(',')[1].split('#')[0], 'base64').toString('utf8');

it('embeds nested HTML, CSS, fonts and SVG references relative to their files', async () => {
  dir = await mkdtemp(join(tmpdir(), 'html-resources-'));
  await mkdir(join(dir, 'assets/web'), { recursive: true });
  await writeFile(join(dir, 'assets/font.woff2'), 'font-bytes');
  await writeFile(join(dir, 'assets/pic.png'), 'image-bytes');
  await writeFile(join(dir, 'assets/web/theme.css'), '@font-face { font-family: Demo; src: url(../font.woff2); }');
  await writeFile(join(dir, 'assets/web/page.html'), '<link rel="stylesheet" href="theme.css"><img src="../pic.png"><script>window.ready = true;</script>');
  const resources = new SingleHtmlResources([dir]);
  const html = decode((await resources.asset('assets/web/page.html'))!);
  expect(html).toContain('data:image/png;base64,');
  expect(html).toContain('data:text/css;base64,');
  expect(html).toContain('window.ready = true');
  const style = /href="([^"]+)"/.exec(html)![1];
  expect(decode(style)).toContain('data:font/woff2;base64,');
  await writeFile(join(dir, 'assets/shape.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><image href="pic.png" width="1" height="1"/></svg>');
  const svg = decode((await resources.asset('assets/shape.svg#mark'))!);
  expect(svg).toMatch(/^<svg/);
  expect(svg).toContain('data:image/png;base64,');
  expect(svg).not.toContain('<html');
});

it('keeps existing data/remote/fragment URLs and refuses traversal and escaping symlinks', async () => {
  dir = await mkdtemp(join(tmpdir(), 'html-boundary-'));
  const root = join(dir, 'deck');
  await mkdir(root);
  await writeFile(join(dir, 'secret.png'), 'secret');
  await symlink(join(dir, 'secret.png'), join(root, 'escape.png'));
  const resources = new SingleHtmlResources([root]);
  expect(await resources.asset('../secret.png')).toBeNull();
  expect(await resources.asset('escape.png')).toBeNull();
  const css = '.x { filter:url(#mask); background:url(data:image/png;base64,AAAA); mask:url(https://example.com/a.svg); }';
  expect(await resources.css(css)).toBe(css);
  expect(await readFile(join(dir, 'secret.png'), 'utf8')).toBe('secret');
});

it('uses original deck resources for dependencies not copied by folder export', async () => {
  dir = await mkdtemp(join(tmpdir(), 'html-fallback-'));
  const staged = join(dir, 'staged'), deck = join(dir, 'deck');
  await mkdir(staged);
  await mkdir(join(deck, 'assets'), { recursive: true });
  await writeFile(join(deck, 'assets/image.png'), 'embedded');
  const resources = new SingleHtmlResources([staged, deck]);
  expect(decode((await resources.asset('./assets/image.png?version=1'))!)).toBe('embedded');
});

it('preserves an existing destination when export preparation fails', async () => {
  dir = await mkdtemp(join(tmpdir(), 'html-failure-'));
  const target = join(dir, 'talk.html');
  await writeFile(target, 'previous export');
  await expect(exportDeckHtml(dir, emptyDeck(), target, undefined,
    { playerBundleDir: join(dir, 'missing-player') })).rejects.toThrow('Export player bundle not found');
  expect(await readFile(target, 'utf8')).toBe('previous export');
});

it('embeds encoded asset paths while preserving fragment references in the deck', async () => {
  dir = await mkdtemp(join(tmpdir(), 'html-encoded-'));
  await mkdir(join(dir, 'assets'));
  await mkdir(join(dir, 'player'));
  await writeFile(join(dir, 'theme.css'), '');
  await writeFile(join(dir, 'assets/picture name.png'), 'image-bytes');
  await writeFile(join(dir, 'player/player.js'), 'void 0;');
  const deck = emptyDeck();
  deck.slides[0].elements.push({
    id: 'picture', type: 'image', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, src: 'assets/picture%20name.png#sample',
    fit: 'contain', alt: '',
  });
  const target = join(dir, 'talk.html');
  await exportDeckHtml(dir, deck, target, undefined, { playerBundleDir: join(dir, 'player') });
  const html = await readFile(target, 'utf8');
  const assets = JSON.parse(/window\.__DECK_ASSETS__ = (.*);<\/script>/.exec(html)![1]);
  expect(assets['assets/picture name.png']).toBe('data:image/png;base64,' + Buffer.from('image-bytes').toString('base64'));
  expect(html).toContain('assets/picture%20name.png#sample');
});
