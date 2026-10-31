import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { crc32 } from '@shared/zip.js';
import { HISTORY_FILES } from '@shared/editHistory.js';

export type ArchiveProgress = (message: string, ratio: number) => void;

const excluded = new Set([...HISTORY_FILES, 'access.json']);
export function archiveFileAllowed(name: string): boolean {
  return !name.split('/').some((part) => part.startsWith('.') || /\.copy-tmp$|\.[0-9a-f-]{36}\.partial\.[^/]+$/i.test(part) || excluded.has(part));
}

/** Collect regular files only: symlinks must never embed files outside the presentation. */
export async function archiveFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (!archiveFileAllowed(name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Cannot archive symbolic link: ${name}`);
    if (entry.isDirectory()) result.push(...await archiveFiles(dir, `${name}/`));
    else if (entry.isFile()) result.push(name);
  }
  return result.sort();
}

export async function folderFingerprint(dir: string): Promise<string> {
  const files = await archiveFiles(dir);
  return JSON.stringify(await Promise.all(files.map(async (name) => {
    const s = await stat(join(dir, name));
    return [name, s.size, s.mtimeMs, s.ctimeMs];
  })));
}

/** ZIP64, streamed media and atomic replacement: a failed save leaves the old file intact. */
export async function writeDwArchive(dir: string, target: string, beforeCommit?: () => Promise<void>, progress?: ArchiveProgress): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${randomUUID()}.dw.tmp`);
  const zip = new yazl.ZipFile();
  let activeInput: ReadStream | undefined;
  try {
    const files = await archiveFiles(dir);
    if (!files.includes('deck.json')) throw new Error('A presentation must contain deck.json');
    const entries = await Promise.all(files.map(async (name) => ({ name, info: await stat(join(dir, name)) })));
    const total = entries.reduce((sum, entry) => sum + entry.info.size, 0);
    let completed = 0;
    let lastUpdate = 0;
    for (const { name, info } of entries) {
      const compress = /\.(json|css|html?|md|txt|js|mjs|svg|csv|tex|typ)$/i.test(name);
      zip.addReadStreamLazy(name, { compress, size: info.size, mtime: info.mtime, mode: info.mode }, (callback) => {
        const input = activeInput = createReadStream(join(dir, name));
        input.on('error', (error) => (zip.outputStream as Readable).destroy(error));
        progress?.(`Writing ${name}`, total ? completed / total : 0);
        if (progress) input.on('data', (chunk) => {
          completed += chunk.length;
          if (Date.now() - lastUpdate > 100) {
            progress(`Writing ${name}`, total ? completed / total : 0);
            lastUpdate = Date.now();
          }
        });
        callback(null, input);
      });
    }
    const output = createWriteStream(temporary, { flags: 'wx' });
    const writing = pipeline(zip.outputStream, output);
    zip.on('error', (error) => (zip.outputStream as Readable).destroy(error));
    zip.end();
    await writing;
    progress?.('Finishing presentation archive', 0.99);
    await beforeCommit?.();
    await rename(temporary, target);
  } finally {
    activeInput?.destroy();
    await rm(temporary, { force: true });
  }
}

/** Read untrusted ZIP entries one at a time, with path, type, size and CRC validation. */
export async function extractDwArchive(source: string, target: string, progress?: ArchiveProgress): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => {
      if (error) reject(error); else resolve(file!);
    });
  });
  await mkdir(target, { recursive: true });
  const seen = new Set<string>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const name = entry.fileName;
          progress?.(`Reading ${name}`, seen.size / Math.max(1, zip.entryCount));
          const parts = name.replace(/\/$/, '').split('/');
          if (!name || /^[\/\\]|^[a-z]:/i.test(name) || name.includes('\\')
            || parts.some((p) => !p || p === '.' || p === '..') || name.includes('\0')
            || (process.platform === 'win32' && parts.some((p) => /[<>:\x00-\x1f"|?*]|[. ]$/.test(p)))) {
            throw new Error(`Unsafe archive path: ${name}`);
          }
          if (seen.has(name)) throw new Error(`Duplicate archive entry: ${name}`);
          seen.add(name);
          if (seen.size > 100_000) throw new Error('Too many files in presentation');
          const type = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (type && type !== 0o100000 && type !== 0o040000) throw new Error(`Unsupported archive entry: ${name}`);
          if (entry.isEncrypted()) throw new Error('Encrypted presentations are not supported');
          total += entry.uncompressedSize;
          if (total > 100 * 1024 ** 3) throw new Error('Presentation exceeds the 100 GB extraction limit');
          if (!archiveFileAllowed(name)) { zip.readEntry(); return; }
          const path = join(target, ...parts);
          if (name.endsWith('/')) await mkdir(path, { recursive: true });
          else {
            await mkdir(dirname(path), { recursive: true });
            const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
              zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream!));
            });
            let checksum = 0;
            let bytes = 0;
            const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) {
              checksum = crc32(chunk, checksum);
              bytes += chunk.length;
              callback(null, chunk);
            } });
            await pipeline(input, verify, createWriteStream(path, { flags: 'wx' }));
            if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw new Error(`Corrupt archive entry: ${name}`);
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}

export function dwFilePath(chosen: string): string {
  return extname(chosen).toLowerCase() === '.dw' ? chosen : `${chosen}.dw`;
}
