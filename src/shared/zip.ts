/**
 * The ZIP format itself, in terms both sides can use.
 *
 * The server streams archives out (`src/server/zip.ts`) and the collab client
 * assembles one in memory to upload a deck folder, so the header layout lives
 * here rather than in either of them. Everything is `Uint8Array`, not
 * `Buffer`: this module is bundled into the browser.
 *
 * Method 0 ("store") only. Deck folders are mostly already-compressed media
 * (H.264, PNG, JPEG), so deflate would buy little at real CPU cost, and
 * storing keeps both ends dependency-free. No ZIP64 — a deck over 4GB is not
 * a thing this path should carry.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Fixed timestamp: archives are downloads, not backups; determinism beats mtimes. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

const UTF8_FLAG = 0x0800;

export const LOCAL_HEADER_SIZE = 30;
export const CENTRAL_HEADER_SIZE = 46;
export const EOCD_SIZE = 22;

/** One file's place in the archive, as the central directory records it. */
export interface ZipRecord {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

export function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

export function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const header = new Uint8Array(LOCAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, 0, true); // method: store
  view.setUint16(10, DOS_TIME, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true); // compressed size
  view.setUint32(22, size, true); // uncompressed size
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true); // extra length
  return header;
}

export function centralHeader(record: ZipRecord): Uint8Array {
  const header = new Uint8Array(CENTRAL_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true); // version made by
  view.setUint16(6, 20, true); // version needed
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, 0, true); // method: store
  view.setUint16(12, DOS_TIME, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.size, true);
  view.setUint32(24, record.size, true);
  view.setUint16(28, record.name.length, true);
  // extra, comment, disk start, internal attrs, external attrs: all zero.
  view.setUint32(42, record.offset, true);
  return header;
}

export function endOfCentralDirectory(entries: number, size: number, start: number): Uint8Array {
  const eocd = new Uint8Array(EOCD_SIZE);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true); // entries on this disk
  view.setUint16(10, entries, true); // entries total
  view.setUint32(12, size, true);
  view.setUint32(16, start, true);
  return eocd;
}

/** A file going into an in-memory archive. */
export interface ZipInput {
  /** Forward-slash relative path inside the archive. */
  name: string;
  data: Uint8Array;
}

/**
 * Build a complete archive in memory. The streaming writer is the right tool
 * on the server, where a deck's videos should never all be resident at once;
 * in a browser uploading a folder the files are already in memory anyway.
 */
export function buildZip(files: ZipInput[]): Uint8Array<ArrayBuffer> {
  const records: ZipRecord[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encodeName(file.name);
    const crc = crc32(file.data);
    const header = localHeader(name, crc, file.data.length);
    parts.push(header, name, file.data);
    records.push({ name, crc, size: file.data.length, offset });
    offset += header.length + name.length + file.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of records) {
    const header = centralHeader(record);
    parts.push(header, record.name);
    centralSize += header.length + record.name.length;
  }
  parts.push(endOfCentralDirectory(records.length, centralSize, centralStart));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}
