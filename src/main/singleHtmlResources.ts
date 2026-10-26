import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { resolveAsset } from './deckStore.js';

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.ogv': 'video/ogg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i;

/** Resolve resources inside the staged export, falling back to original deck
 * files for dependencies of self-contained web/SVG assets. Every read uses the
 * same deck boundary (including symlinks) as ordinary export. */
export class SingleHtmlResources {
  private cache = new Map<string, string>();
  private pending = new Set<string>();

  constructor(private roots: string[], private report?: (path: string) => void) {}

  async asset(src: string, from = 'index.html'): Promise<string | null> {
    if (absolute.test(src)) return null;
    const [path, fragment] = src.split('#', 2);
    let decoded: string;
    try { decoded = decodeURIComponent(path.split('?')[0]); } catch { return null; }
    const key = relative(this.roots[0], resolve(this.roots[0], dirname(from), decoded));
    const cached = this.cache.get(key);
    if (cached) return cached + (fragment ? `#${fragment}` : '');
    if (this.pending.has(key)) return null;
    let bytes: Buffer | undefined;
    for (const root of this.roots) {
      try { bytes = await readFile(resolveAsset(root, key)); break; } catch { /* missing or outside root */ }
    }
    if (!bytes) return null;
    this.report?.(key);
    this.pending.add(key);
    try {
      const ext = extname(key).toLowerCase();
      if (ext === '.css') bytes = Buffer.from(await this.css(bytes.toString('utf8'), key));
      if (ext === '.html' || ext === '.htm' || ext === '.svg') {
        bytes = Buffer.from(await this.html(bytes.toString('utf8'), key, ext === '.svg'));
      }
      const uri = `data:${MIME[ext] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`;
      this.cache.set(key, uri);
      return uri + (fragment ? `#${fragment}` : '');
    } finally { this.pending.delete(key); }
  }

  async css(source: string, from = 'theme.css'): Promise<string> {
    let result = '';
    let end = 0;
    const pattern = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi;
    for (const match of source.matchAll(pattern)) {
      result += source.slice(end, match.index);
      const src = (match[2] ?? match[4]).trim();
      const uri = await this.asset(src, from);
      result += uri ? (match[2] ? `url("${uri}")` : `@import "${uri}"`) : match[0];
      end = match.index! + match[0].length;
    }
    return result + source.slice(end);
  }

  private async html(source: string, from: string, svg: boolean): Promise<string> {
    const doc = parse(source);
    const visit = async (node: DefaultTreeAdapterMap['node']): Promise<void> => {
      if ('attrs' in node) {
        for (const attr of node.attrs) {
          if (['src', 'poster'].includes(attr.name)
            || (attr.name === 'href' && ['link', 'image', 'use'].includes(node.tagName))) {
            attr.value = await this.asset(attr.value, from) ?? attr.value;
          } else if (attr.name === 'style') attr.value = await this.css(attr.value, from);
        }
        if (node.tagName === 'style') {
          for (const child of node.childNodes) {
            if ('value' in child) child.value = await this.css(child.value, from);
          }
        }
      }
      if ('childNodes' in node) for (const child of node.childNodes) await visit(child);
    };
    await visit(doc);
    if (svg) {
      const find = (node: DefaultTreeAdapterMap['node']): DefaultTreeAdapterMap['element'] | undefined => {
        if ('tagName' in node && node.tagName === 'svg') return node;
        if ('childNodes' in node) for (const child of node.childNodes) { const found = find(child); if (found) return found; }
      };
      const root = find(doc);
      // Keep the SVG document's outer root; serialize(element) only emits children.
      if (root) { const wrapper = parse(''); wrapper.childNodes = [root]; return serialize(wrapper); }
    }
    return serialize(doc);
  }
}
