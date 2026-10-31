// @vitest-environment jsdom
/**
 * The deck picker's footer: Import is one menu rather than a button per
 * format. The upload itself is covered server-side in
 * `collabImportDeck.test.ts`; what matters here is that the menu offers every
 * format and that picking one uploads to the matching route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showDeckPicker } from '../src/renderer/collab/deckPicker.js';
import { readZip } from '../src/server/zip.js';

const ACCESS = { user: 'alice@tailnet.example', name: 'Alice', admin: false };

/**
 * Stand in for XMLHttpRequest, which the import uses because `fetch` cannot
 * report upload progress. Records what was sent and lets a test drive the
 * upload's progress events.
 */
interface SentUpload {
  url: string;
  body: Blob;
  progress: (loaded: number, total: number) => void;
  finish: (status: number, payload: unknown) => void;
}
let uploads: SentUpload[] = [];

function stubXhr(): void {
  class FakeXhr {
    status = 0;
    responseText = '';
    private url = '';
    private readonly listeners = new Map<string, (() => void)[]>();
    readonly upload = {
      listeners: new Map<string, ((event: ProgressEvent) => void)[]>(),
      addEventListener(type: string, fn: (event: ProgressEvent) => void) {
        this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]);
      },
    };

    open(_method: string, url: string) { this.url = url; }
    addEventListener(type: string, fn: () => void) {
      this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]);
    }

    send(body: Blob) {
      uploads.push({
        url: this.url,
        body,
        progress: (loaded, total) => {
          for (const fn of this.upload.listeners.get('progress') ?? []) {
            fn({ loaded, total, lengthComputable: total > 0 } as ProgressEvent);
          }
          if (loaded >= total) for (const fn of this.upload.listeners.get('load') ?? []) fn({} as ProgressEvent);
        },
        finish: (status, payload) => {
          this.status = status;
          this.responseText = JSON.stringify(payload);
          for (const fn of this.listeners.get('load') ?? []) fn();
        },
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

/** The import upload, if one was sent. */
const uploadCall = (): string | undefined =>
  uploads.find((upload) => upload.url.startsWith('/api/import-deck'))?.url;

/**
 * Stand in for a directory chooser: jsdom has no picker, and
 * `webkitRelativePath` is read-only on a real File.
 */
function givePickedFolder(input: HTMLInputElement, files: [string, string][]): void {
  const picked = files.map(([path, body]) => {
    const file = new File([body], path.split('/').pop()!);
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    // jsdom's File has no Blob.arrayBuffer; every target browser has had it
    // for years.
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(body).buffer,
    });
    return file;
  });
  Object.defineProperty(input, 'files', { value: picked });
}

/** jsdom's Blob has neither arrayBuffer() nor text(); FileReader it is. */
function blobBytes(blob: Blob): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(Buffer.from(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Open the menu and return its items by label. */
function openImportMenu(): Map<string, HTMLButtonElement> {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('.workflow-actions .shape-menu-trigger')]
    .find((button) => button.textContent?.includes('Import'));
  if (!trigger) throw new Error('no Import menu in the picker footer');
  trigger.click();
  return new Map([...document.querySelectorAll<HTMLButtonElement>('.shape-menu-item')]
    .map((item) => [item.textContent ?? '', item]));
}

describe('deck picker import menu', () => {
  let clicked: HTMLInputElement[];

  beforeEach(() => {
    document.body.innerHTML = '';
    clicked = [];
    uploads = [];
    stubXhr();
    // The file input never opens a real chooser under jsdom; capture it so a
    // test can hand it a file and fire the change the real dialog would.
    HTMLInputElement.prototype.click = function click(this: HTMLInputElement) { clicked.push(this); };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('collapses the import formats into one menu, DeckWerk decks included', () => {
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ACCESS, folder: '' });

    expect([...openImportMenu().keys()]).toEqual([
      'Keynote…', 'PowerPoint…', 'DeckWerk deck folder…', 'DeckWerk presentation (.dw)…',
    ]);
    // The flat per-format buttons are gone from the footer.
    const buttons = [...document.querySelectorAll('.workflow-actions > button')].map((b) => b.textContent);
    expect(buttons).not.toContain('Import Keynote…');
    expect(buttons).not.toContain('Import PowerPoint…');
  });

  it('picks a directory for a deck folder, since a deck on disk is one', () => {
    // A file chooser set to .zip cannot select a folder — Open just descends
    // into it — so the folder entry asks for a directory instead.
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ACCESS, folder: '' });

    openImportMenu().get('DeckWerk deck folder…')!.click();
    expect(clicked.at(-1)!.webkitdirectory).toBe(true);
  });

  it('zips a picked deck folder into the archive the import route takes', async () => {
    const status: string[] = [];
    showDeckPicker({ dismissable: true, onStatus: (text) => status.push(text), access: ACCESS, folder: '' });
    openImportMenu().get('DeckWerk deck folder…')!.click();

    const input = clicked.at(-1)!;
    givePickedFolder(input, [
      ['my-talk/deck.json', '{"slides":[]}'],
      ['my-talk/theme.css', '/* t */'],
      ['my-talk/assets/photo.jpg', 'jpeg bytes'],
    ]);
    input.dispatchEvent(new Event('change'));
    // Wait for the upload, but surface the status line if it never comes —
    // a failed zip reports itself there rather than as a missing request.
    await vi.waitFor(() => expect(
      uploadCall() ?? (status.find((line) => line.includes('failed')) as string | undefined),
    ).toBeDefined());
    expect(uploadCall(), status.at(-1)).toBeDefined();

    // Named after the folder, and uploaded as one archive holding every file
    // under it — the wrapping directory included, which the server strips.
    expect(uploadCall()).toBe('/api/import-deck?name=my-talk');
    const archive = readZip(await blobBytes(uploads[0].body));
    expect(archive.map((entry) => entry.name))
      .toEqual(['my-talk/deck.json', 'my-talk/theme.css', 'my-talk/assets/photo.jpg']);
    expect(archive[2].data.toString('utf8')).toBe('jpeg bytes');
  });

  it('refuses a folder that is not a deck before uploading anything', async () => {
    const status: string[] = [];
    showDeckPicker({ dismissable: true, onStatus: (text) => status.push(text), access: ACCESS, folder: '' });
    openImportMenu().get('DeckWerk deck folder…')!.click();

    const input = clicked.at(-1)!;
    givePickedFolder(input, [['Decks/deckwerk_intro/deck.json', '{}']]);
    input.dispatchEvent(new Event('change'));

    // Picking the folder *above* the deck is the easy mistake; say so rather
    // than uploading a megabyte and letting the server reject it.
    await vi.waitFor(() => expect(status.at(-1)).toContain('holds no deck.json'));
    expect(status.at(-1)).toContain("pick the deck's own folder");
    expect(uploadCall()).toBeUndefined();
  });

  it('reports the upload inside the dialog, not only on the toolbar', async () => {
    // The toolbar's status line is behind this modal's opaque overlay, so an
    // import that reported only there looked like nothing happening at all.
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ACCESS, folder: '' });
    openImportMenu().get('DeckWerk deck folder…')!.click();

    const input = clicked.at(-1)!;
    givePickedFolder(input, [['my-talk/deck.json', '{"slides":[]}']]);
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(uploads.length).toBe(1));

    const line = () => document.querySelector('.deck-picker-progress');
    expect(line()!.textContent).toContain('my-talk');

    uploads[0].progress(512, 2048);
    expect(line()!.textContent).toContain('25%');

    uploads[0].progress(2048, 2048);
    // Once the bytes are out, the wait is the server's; say so rather than
    // leaving "100%" up for a minute while it unpacks.
    expect(line()!.textContent).toContain('Converting');
  });

  it('shows why an import failed, where the dialog can be seen', async () => {
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ACCESS, folder: '' });
    openImportMenu().get('DeckWerk presentation (.dw)…')!.click();

    const input = clicked.at(-1)!;
    const file = new File(['not a zip'], 'talk.zip');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(uploads.length).toBe(1));

    uploads[0].finish(400, { error: 'not a zip archive' });
    await vi.waitFor(() => expect(
      document.querySelector('.deck-picker-progress')!.textContent,
    ).toContain('not a zip archive'));
  });

  it('imports without touching who can open the result', async () => {
    // Sharing is the Share… dialog's job; an import that quietly published
    // would be a second, inconsistent answer to the same question.
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ACCESS, folder: 'conferences' });

    openImportMenu().get('DeckWerk presentation (.dw)…')!.click();

    const input = clicked.at(-1)!;
    expect(input.accept).toBe('.dw,.zip');
    const file = new File(['zip bytes'], 'My Talk.dw');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(uploadCall()).toBeDefined());

    // The .dw suffix is dropped from the deck name and the folder rides
    // along; nothing in the request says anything about access.
    expect(uploadCall()).toBe('/api/import-deck?name=My%20Talk&folder=conferences');
  });
});
