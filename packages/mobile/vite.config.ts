import { builtinModules } from 'node:module';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import docblocksPackage from '../core/package.json';
import { harperWasmPlugin } from '../../scripts/vite-harper-wasm.js';
import { ironCalcWasmPlugin } from '../../scripts/vite-ironcalc-wasm.js';
import { thirdPartyComponentManifestPlugin } from '../../scripts/vite-third-party-manifest.js';

const mobileBoundary = (): Plugin => ({
  name: 'docblocks-mobile-boundary',
  enforce: 'pre',
  resolveId(id, importer) {
    // Harper's universal loader has an unreachable file:// branch in WebViews.
    // Give that single branch an explicit failure, never a Node polyfill.
    if (
      id === 'fs' &&
      /[/\\]harper\.js[/\\]dist[/\\]BinaryModule-[^/\\]+\.js$/.test(importer ?? '')
    )
      return '\0docblocks-no-fs';
    if (
      id.startsWith('node:') ||
      builtinModules.includes(id) ||
      id === 'electron' ||
      /packages\/desktop\/(main|preload)/.test(id)
    ) {
      throw new Error(`Native-only import in mobile renderer: ${id} from ${importer}`);
    }
    return null;
  },
  load(id) {
    if (id === '\0docblocks-no-fs')
      return `export function readFile() { throw new Error('Native file URLs are unavailable in the editor.'); }`;
    return null;
  },
});

export default defineConfig({
  base: './',
  publicDir: '../site/public',
  define: {
    __DOCBLOCKS_VERSION__: JSON.stringify(docblocksPackage.version),
    __DOCBLOCKS_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    {
      name: 'mobile-notices',
      generateBundle() {
        for (const filename of ['THIRD_PARTY_NOTICES.txt', 'NATIVE_NOTICES.txt']) {
          const notice = path.resolve(__dirname, filename);
          if (existsSync(notice))
            this.emitFile({
              type: 'asset',
              fileName: filename,
              source: readFileSync(notice, 'utf8'),
            });
        }
      },
    },
    mobileBoundary(),
    harperWasmPlugin(),
    ironCalcWasmPlugin(),
    thirdPartyComponentManifestPlugin(),
    react(),
  ],
  resolve: {
    dedupe: ['react', 'react-dom', 'monaco-editor'],
    alias: [
      {
        find: '@bendyline/docblocks/host/mobile',
        replacement: path.resolve(__dirname, '../core/src/host/mobile-wire.ts'),
      },
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../react/src/styles/docblocks.css'),
      },
      {
        find: /^@bendyline\/docblocks-react$/,
        replacement: path.resolve(__dirname, '../react/src/index.ts'),
      },
      ...['indexeddb', 'memory', 'native', 'host'].map((backend) => ({
        find: `@bendyline/docblocks/filesystem/${backend}`,
        replacement: path.resolve(__dirname, `../core/src/filesystem/${backend}.ts`),
      })),
      ...['filesystem', 'workspace', 'host', 'document'].map((entry) => ({
        find: new RegExp(`^@bendyline/docblocks/${entry}$`),
        replacement: path.resolve(__dirname, `../core/src/${entry}/index.ts`),
      })),
    ],
  },
  build: { chunkSizeWarningLimit: 8_000 },
  worker: { format: 'es', plugins: () => [mobileBoundary()] },
  server: { port: 5222, host: '127.0.0.1' },
});
