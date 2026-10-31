import { unlinkSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DwDocuments } from '../src/main/dwDocuments.js';
import { createDeck, loadDeck, saveDeck, saveTheme } from '../src/main/deckStore.js';
import { extractDwArchive, writeDwArchive, dwFilePath } from '../src/main/dwArchive.js';
import { crc32, buildZip } from '../src/shared/zip.js';
import { emptyDeckHistory } from '../src/shared/deckHistory.js';
import { loadDeckHistory, saveDeckHistory } from '../src/main/deckHistoryStore.js';

let root = '';
const opened: Array<{ manager: DwDocuments; dir: string }> = [];
afterEach(async () => {
  for (const { manager, dir } of opened.splice(0)) await manager.close(dir, false);
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'dw-documents-'));
  return new DwDocuments(join(root, 'cache'));
}
async function track(manager: DwDocuments, path: string, create = false) {
  const session = create ? await manager.create(path) : await manager.open(path);
  opened.push({ manager, dir: session.dir });
  return session;
}
async function unzip(path: string) {
  const dir = join(root, `unzip-${Math.random()}`);
  await extractDwArchive(path, dir);
  return dir;
}

describe('.dw presentation documents', () => {
  it('creates a single ZIP document and persists edits, themes, media and history', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk'), true);
    expect(s.filePath).toBe(join(root, 'Talk.dw'));
    expect((await readFile(s.filePath!)).subarray(0, 2).toString()).toBe('PK');
    s.deck.title = 'Edited presentation';
    s.deck.slides[0].notes = 'Speaker notes';
    await writeFile(join(s.dir, 'assets', 'movie.mp4'), Buffer.alloc(1024 * 1024, 42));
    await saveDeck(s.dir, s.deck);
    await saveTheme(s.dir, s.deck.theme, '.slide { color: red; }');
    await saveDeckHistory(s.dir, emptyDeckHistory());
    const dir = await unzip(s.filePath!);
    expect((await loadDeck(dir)).title).toBe('Edited presentation');
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toContain('Speaker notes');
    expect(await readFile(join(dir, 'theme.css'), 'utf8')).toContain('color: red');
    expect((await stat(join(dir, 'assets', 'movie.mp4'))).size).toBe(1024 * 1024);
    expect(await loadDeckHistory(dir)).toEqual(emptyDeckHistory());
    expect((await stat(join(dir, 'deck-history-v2.json.gz'))).size).toBeGreaterThan(0);
  });

  it('opens in another cache, supports uppercase suffixes, and retains folder compatibility', async () => {
    const manager = await setup();
    const created = await track(manager, join(root, 'Talk.DW'), true);
    await manager.close(created.dir);
    const other = new DwDocuments(join(root, 'other-cache'));
    const s = await track(other, created.filePath!);
    expect(s.deck.title).toBe('Talk');
    expect(s.dir).not.toBe(created.dir);
    const folder = join(root, 'legacy');
    await createDeck(folder);
    expect(await other.open(folder)).toEqual({ dir: folder, deck: await loadDeck(folder) });
    expect(dwFilePath('talk.v1')).toBe('talk.v1.dw');
    expect(dwFilePath('talk.DW')).toBe('talk.DW');
  });

  it('deduplicates documents and refuses another writer sharing the cache', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    expect((await manager.open(s.filePath!)).dir).toBe(s.dir);
    const second = new DwDocuments(join(root, 'cache'));
    await expect(second.open(s.filePath!)).rejects.toThrow(/already open/);
  });

  it('commits agent workspace changes and recovers unsaved working files on reopening', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    await manager.close(s.dir);
    const changed = structuredClone(s.deck);
    changed.title = 'Recovered agent edits';
    // Simulate a terminated app: the workspace advanced beyond the last archive commit.
    await saveDeck(s.dir, changed);
    const recovered = await track(manager, s.filePath!);
    expect(recovered.deck.title).toBe('Recovered agent edits');
    expect((await loadDeck(await unzip(s.filePath!))).title).toBe('Recovered agent edits');
    await mkdir(join(s.dir, 'edit'), { recursive: true });
    await writeFile(join(s.dir, 'edit', 'work.html'), '<html>agent content</html>');
    await manager.flush(s.dir);
    expect(await readFile(join(await unzip(s.filePath!), 'edit', 'work.html'), 'utf8')).toContain('agent content');
  });

  it('does not overwrite an externally replaced archive, and allows Save As to preserve edits', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    const external = Buffer.from('new external file');
    await writeFile(s.filePath!, external);
    s.deck.title = 'Unsaved changes';
    await expect(saveDeck(s.dir, s.deck)).rejects.toThrow(/changed outside/);
    expect(await readFile(s.filePath!)).toEqual(external);
    const copy = await manager.create(join(root, 'Recovered.dw'), s.dir);
    opened.push({ manager, dir: copy.dir });
    expect(copy.deck.title).toBe('Unsaved changes');
    expect((await loadDeck(await unzip(copy.filePath!))).title).toBe('Unsaved changes');
  });

  it('protects recovered edits when an archive changed while DeckWerk was stopped', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    await manager.close(s.dir);
    await writeFile(join(s.dir, 'theme.css'), 'recovered css');
    await writeFile(s.filePath!, 'changed outside');
    await expect(manager.open(s.filePath!)).rejects.toThrow(/recovered edits exist/);
    expect(await readFile(join(s.dir, 'theme.css'), 'utf8')).toBe('recovered css');
  });

  it('reloads an externally changed document when there are no recovered edits', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    await manager.close(s.dir);
    const folder = join(root, 'replacement');
    await createDeck(folder, 'External replacement');
    await writeDwArchive(folder, s.filePath!);
    expect((await track(manager, s.filePath!)).deck.title).toBe('External replacement');
  });

  it('excludes server permissions, logs, versions and temporary files', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    for (const name of ['access.json', 'history.jsonl', '.temporary']) await writeFile(join(s.dir, name), 'private');
    await mkdir(join(s.dir, '.versions'));
    await writeFile(join(s.dir, '.versions', 'snapshot'), 'private');
    await manager.flush(s.dir);
    const dir = await unzip(s.filePath!);
    for (const name of ['access.json', 'history.jsonl', '.temporary', '.versions']) {
      await expect(stat(join(dir, name))).rejects.toThrow();
    }
  });

  it('keeps the original document when archiving fails', async () => {
    await setup();
    const folder = join(root, 'folder');
    await createDeck(folder);
    const target = join(root, 'original.dw');
    await writeDwArchive(folder, target);
    const original = await readFile(target);
    await symlink(join(root, 'outside'), join(folder, 'outside-link'));
    await expect(writeDwArchive(folder, target)).rejects.toThrow(/symbolic link/);
    expect(await readFile(target)).toEqual(original);
  });

  it('keeps the original archive when a file disappears during streaming', async () => {
    await setup();
    const folder = join(root, 'folder');
    await createDeck(folder);
    const target = join(root, 'original.dw');
    await writeDwArchive(folder, target);
    const original = await readFile(target);
    await writeFile(join(folder, 'assets', 'vanishes.mp4'), Buffer.alloc(128));
    await expect(writeDwArchive(folder, target, undefined, (message) => {
      if (message === 'Writing assets/vanishes.mp4') unlinkSync(join(folder, 'assets', 'vanishes.mp4'));
    })).rejects.toThrow();
    expect(await readFile(target)).toEqual(original);
  });

  it('autosaves files changed directly in the working folder', async () => {
    const manager = await setup();
    const s = await track(manager, join(root, 'Talk.dw'), true);
    await writeFile(join(s.dir, 'theme.css'), '/* edited by an agent */');
    await expect.poll(async () => {
      const dir = await unzip(s.filePath!);
      return readFile(join(dir, 'theme.css'), 'utf8');
    }, { timeout: 4000, interval: 100 }).toBe('/* edited by an agent */');
  });

  it('rejects malformed archives and cleans up so the same path can open later', async () => {
    const manager = await setup();
    const path = join(root, 'bad.dw');
    await writeFile(path, 'not a zip');
    await expect(manager.open(path)).rejects.toThrow();
    const folder = join(root, 'good');
    await createDeck(folder);
    await writeDwArchive(folder, path);
    expect((await track(manager, path)).deck.title).toBe('good');
  });

  it('rejects traversal, duplicates, broken checksums and missing deck.json', async () => {
    const manager = await setup();
    for (const names of [['../escape'], ['/absolute'], ['C:/escape'], ['same', 'same'], ['no-deck']]) {
      const bytes = buildZip(names.map((name) => ({ name, data: new TextEncoder().encode('content') })));
      const path = join(root, `invalid-${Math.random()}.dw`);
      await writeFile(path, bytes);
      await expect(manager.open(path)).rejects.toThrow();
    }
    const bytes = buildZip([{ name: 'deck.json', data: new TextEncoder().encode('content') }]);
    bytes[30 + 'deck.json'.length] ^= 1;
    const path = join(root, 'corrupt.dw');
    await writeFile(path, bytes);
    await expect(manager.open(path)).rejects.toThrow(/Corrupt/);
  });

  it('supports incremental CRC calculation for streamed extraction', () => {
    const bytes = new TextEncoder().encode('hello streamed archive');
    expect(crc32(bytes.subarray(7), crc32(bytes.subarray(0, 7)))).toBe(crc32(bytes));
  });
});
