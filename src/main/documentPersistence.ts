import { resolve } from 'node:path';

/** Folder-based tools keep their normal contract; archived documents add a final commit. */
const documents = new Map<string, { filePath: string; save: () => Promise<void> }>();
export function registerDocument(dir: string, document: { filePath: string; save: () => Promise<void> }): void {
  documents.set(resolve(dir), document);
}
export function unregisterDocument(dir: string): void { documents.delete(resolve(dir)); }
export function documentFilePath(dir: string): string | undefined { return documents.get(resolve(dir))?.filePath; }
export async function persistDocument(dir: string): Promise<void> {
  const document = documents.get(resolve(dir));
  if (!document) return;
  try { await document.save(); }
  catch (error) {
    // The working files have already been committed. Save As may copy them even
    // when the archive destination is unavailable or was changed elsewhere.
    throw new Error(`Could not save .dw archive: ${String(error)}`);
  }
}
