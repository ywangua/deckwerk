import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        // Bundling ws breaks its optional native bufferutil/utf-8-validate
        // loading (bufferUtil.unmask is not a function at runtime).
        // Electron-vite's ESM shim mistakes "import" in language keyword
        // tables for a JS import. Load CodeMirror and Lezer from runtime
        // dependencies in main, keeping their shared parser/tag identities
        // together. Browser builds still bundle the highlighters.
        external: ['ws', 'bufferutil', 'utf-8-validate', /^@codemirror\//, /^@lezer\//],
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          editor: resolve(__dirname, 'src/renderer/editor/index.html'),
          present: resolve(__dirname, 'src/renderer/present/index.html'),
          presenter: resolve(__dirname, 'src/renderer/presenter/index.html'),
          print: resolve(__dirname, 'src/renderer/print/index.html'),
          trim: resolve(__dirname, 'src/renderer/trim/index.html'),
          raster: resolve(__dirname, 'src/renderer/raster/index.html'),
        },
      },
    },
    resolve: { alias: { '@shared': shared } },
  },
});
