/**
 * vite.config.ts - Build pipeline for the Quantbrowse AI Chrome extension.
 *
 * Produces three bundles consumed by `extension/manifest.json`:
 *
 *   - extension/background/background-bundle.js   (service worker)
 *   - extension/content/content-bundle.js         (content script)
 *   - extension/popup/dashboard.js                (popup React entry)
 *
 * The extension's existing `background.js`, `content.js`, `popup.js`,
 * and `popup.html` continue to ship as-is for back-compat. The bundles
 * are emitted next to their TypeScript sources so the manifest paths
 * match exactly what the unpacked extension folder loads.
 *
 * Vitest configuration is included in the same file via `defineConfig`'s
 * `test` field, so `npm run test:ext` and `npm run build:ext` share one
 * source of truth.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    emptyOutDir: false,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'extension/background/SwarmCoordinator.ts'),
        content: resolve(__dirname, 'extension/content/content-entry.ts'),
        popup: resolve(__dirname, 'extension/popup/popup-entry.tsx'),
      },
      output: {
        dir: resolve(__dirname, 'extension'),
        format: 'es',
        entryFileNames: (chunk) => {
          switch (chunk.name) {
            case 'background':
              return 'background/background-bundle.js';
            case 'content':
              return 'content/content-bundle.js';
            case 'popup':
              return 'popup/dashboard.js';
            default:
              return '[name].js';
          }
        },
        chunkFileNames: 'shared/[name]-[hash].js',
        assetFileNames: 'shared/[name]-[hash][extname]',
        inlineDynamicImports: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['extension/tests/**/*.test.ts', 'extension/tests/**/*.test.tsx'],
    setupFiles: ['extension/tests/setup.ts'],
    css: false,
  },
});
