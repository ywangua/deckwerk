import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DeckSession } from '@shared/ipc.js';
import { createDeck, copyDeck, loadDeck } from './deckStore.js';
import { archiveFileAllowed, dwFilePath, extractDwArchive, folderFingerprint, writeDwArchive, type ArchiveProgress } from './dwArchive.js';
import { registerDocument, unregisterDocument } from './documentPersistence.js';

interface CacheState { signature: string | null; fingerprint: string }
interface Document {
  dir: string;
  filePath: string;
  metadata: string;
  lock: string;
  signature: string | null;
  fingerprint: string;
  queue: Promise<void>;
  saving?: boolean;
  requested?: boolean;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}

async function signature(path: string): Promise<string | null> {
  try {
    const s = await stat(path);
    return JSON.stringify([s.size, s.mtimeMs, s.ctimeMs, s.ino]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** .dw is the durable document; a recoverable working folder serves media and agents. */
export class DwDocuments {
  private documents = new Map<string, Document>();
  constructor(private cacheRoot: string, private onError: (dir: string, error: unknown) => void = () => {}) {}

  private async location(path: string): Promise<{ filePath: string; root: string; dir: string }> {
    const absolute = resolve(dwFilePath(path));
    const filePath = await realpath(absolute).catch(async () => join(await realpath(dirname(absolute)), basename(absolute)));
    const hash = createHash('sha256').update(filePath).digest('hex');
    const root = join(this.cacheRoot, hash);
    return { filePath, root, dir: join(root, basename(filePath).slice(0, -3)) };
  }

  private async acquire(root: string): Promise<string> {
    await mkdir(root, { recursive: true });
    const lock = join(root, 'lock.json');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
        return lock;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid: number;
        try { pid = JSON.parse(await readFile(lock, 'utf8')).pid; }
        catch { throw new Error(`Presentation cache is locked: ${lock}`); }
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') { await rm(lock); continue; }
        }
        throw new Error('This presentation is already open in another DeckWerk process');
      }
    }
    throw new Error('Could not lock the presentation');
  }

  async open(path: string, progress?: ArchiveProgress): Promise<DeckSession> {
    if (!path.toLowerCase().endsWith('.dw')) return { dir: path, deck: await loadDeck(path) };
    const { filePath, root, dir } = await this.location(path);
    const existing = this.documents.get(filePath);
    if (existing) return { dir: existing.dir, filePath, deck: await loadDeck(existing.dir) };
    const lock = await this.acquire(root);
    try {
      const diskSignature = await signature(filePath);
      if (!diskSignature) throw new Error(`Presentation not found: ${filePath}`);
      const metadata = join(root, 'state.json');
      let cached: CacheState | null = null;
      try { cached = JSON.parse(await readFile(metadata, 'utf8')); } catch { /* first open */ }
      const current = await folderFingerprint(dir).catch(() => null);
      if (cached && current !== null && cached.signature !== diskSignature && current !== cached.fingerprint) {
        throw new Error(`The .dw file changed while recovered edits exist. Your edits are preserved in ${dir}. Copy that folder before reopening the changed file.`);
      }
      if (!cached || current === null || cached.signature !== diskSignature) {
        const temporary = join(root, `extract-${randomUUID()}`);
        try {
          await extractDwArchive(filePath, temporary, progress);
          await loadDeck(temporary);
          await rm(dir, { recursive: true, force: true });
          await rename(temporary, dir);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }
      const fingerprint = cached?.signature === diskSignature && current !== null
        ? cached.fingerprint : await folderFingerprint(dir);
      const document: Document = { dir, filePath, metadata, lock, signature: diskSignature, fingerprint, queue: Promise.resolve() };
      this.attach(document);
      // Recovered edits that never reached the archive are committed before opening completes.
      await this.save(document);
      return { dir, filePath, deck: await loadDeck(dir) };
    } catch (error) {
      const doc = this.documents.get(filePath);
      if (doc) this.detach(doc);
      await rm(lock, { force: true });
      throw error;
    }
  }

  /** Build new/imported copies away from the destination, then atomically publish them. */
  async create(path: string, sourceDir?: string, progress?: ArchiveProgress): Promise<DeckSession> {
    const { filePath, root, dir } = await this.location(path);
    if (this.documents.has(filePath)) throw new Error('That presentation is already open; choose a different filename');
    const lock = await this.acquire(root);
    const staging = join(root, `new-${randomUUID()}`);
    try {
      if (sourceDir) await copyDeck(sourceDir, staging);
      else await createDeck(staging, basename(filePath).slice(0, -3));
      await loadDeck(staging);
      const expected = await signature(filePath);
      await writeDwArchive(staging, filePath, async () => {
        if (await signature(filePath) !== expected) throw new Error('The destination changed while saving. Please try Save As again.');
      }, progress);
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
      const document: Document = {
        dir, filePath, lock, metadata: join(root, 'state.json'), signature: await signature(filePath),
        fingerprint: await folderFingerprint(dir), queue: Promise.resolve(),
      };
      await this.record(document);
      this.attach(document);
      return { dir, filePath, deck: await loadDeck(dir) };
    } catch (error) {
      const document = this.documents.get(filePath);
      if (document) this.detach(document);
      await rm(lock, { force: true });
      throw error;
    }
    finally { await rm(staging, { recursive: true, force: true }); }
  }

  private attach(doc: Document): void {
    this.documents.set(doc.filePath, doc);
    registerDocument(doc.dir, { filePath: doc.filePath, save: () => this.save(doc) });
    doc.watcher = watch(doc.dir, { recursive: true }, (_event, name) => {
      if (name && !archiveFileAllowed(name.toString().replaceAll('\\', '/'))) return;
      if (doc.timer) clearTimeout(doc.timer);
      doc.timer = setTimeout(() => {
        doc.timer = undefined;
        void this.save(doc).catch((error) => this.onError(doc.dir, error));
      }, 800);
      doc.timer.unref();
    });
    doc.watcher.on('error', (error) => this.onError(doc.dir, error));
  }

  private async record(doc: Document): Promise<void> {
    const temporary = `${doc.metadata}.tmp`;
    await writeFile(temporary, JSON.stringify({ signature: doc.signature, fingerprint: doc.fingerprint }));
    await rename(temporary, doc.metadata);
  }

  private save(doc: Document): Promise<void> {
    doc.requested = true;
    if (doc.saving) return doc.queue;
    doc.saving = true;
    const task = (async () => {
      do {
        doc.requested = false;
        const fingerprint = await folderFingerprint(doc.dir);
        if (await signature(doc.filePath) !== doc.signature) {
          throw new Error(`The .dw file changed outside DeckWerk. Use Save As to preserve your edits. Working folder: ${doc.dir}`);
        }
        if (fingerprint !== doc.fingerprint || doc.signature === null) {
          await loadDeck(doc.dir);
          let changed = false;
          try {
            await writeDwArchive(doc.dir, doc.filePath, async () => {
              // Never publish an archive assembled from files that changed midway through packing.
              if (await folderFingerprint(doc.dir) !== fingerprint) {
                changed = true;
                throw new Error('Presentation files changed while packing');
              }
              if (await signature(doc.filePath) !== doc.signature) throw new Error('The .dw file changed outside DeckWerk; use Save As.');
            });
          } catch (error) {
            if (!changed) throw error;
            doc.requested = true;
            continue;
          }
          doc.signature = await signature(doc.filePath);
          doc.fingerprint = fingerprint;
        }
        await this.record(doc);
      } while (doc.requested);
    })().finally(() => { doc.saving = false; });
    doc.queue = task;
    return task;
  }

  async flush(dir: string): Promise<void> {
    const doc = [...this.documents.values()].find((doc) => doc.dir === dir);
    if (doc) await this.save(doc);
  }

  private detach(doc: Document): void {
    if (doc.timer) clearTimeout(doc.timer);
    doc.watcher?.close();
    unregisterDocument(doc.dir);
    this.documents.delete(doc.filePath);
  }

  async close(dir: string, save = true): Promise<void> {
    const doc = [...this.documents.values()].find((doc) => doc.dir === dir);
    if (!doc) return;
    if (save) await this.save(doc);
    this.detach(doc);
    // Save As may abandon a conflicting archive, but no writer may outlive its lock.
    await doc.queue.catch(() => {});
    await rm(doc.lock, { force: true });
  }
}
