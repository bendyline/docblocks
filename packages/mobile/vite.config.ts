import { builtinModules, createRequire } from 'node:module';
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

/**
 * Files @bendyline/gezel-capacitor ships for the WebView, as hashed web assets
 * named by a virtual module: `export const <exportName> = { key: url, … }`.
 * The dev server has no emitted files, so it serves the package's own copies.
 */
const gezelAssets = (
  id: string,
  exportName: string,
  files: Record<string, { path: string; name: string }>,
): Plugin => {
  const root = () =>
    path.dirname(createRequire(import.meta.url).resolve('@bendyline/gezel-capacitor/package.json'));
  const urls: Record<string, string> = {};
  let serve = false;
  return {
    name: `docblocks-${id}`,
    configResolved: (config) => {
      serve = config.command === 'serve';
    },
    resolveId: (source) => (source === `virtual:${id}` ? `\0virtual:${id}` : null),
    buildStart() {
      for (const [key, file] of Object.entries(files)) {
        const source = path.join(root(), file.path);
        if (!existsSync(source))
          throw new Error(`${source} is missing; @bendyline/gezel-capacitor is too old.`);
        urls[key] = serve
          ? JSON.stringify(`/@fs${source}`)
          : `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: file.name, source: readFileSync(source) })}`;
      }
    },
    load: (source) =>
      source === `\0virtual:${id}`
        ? `export const ${exportName} = { ${Object.entries(urls)
            .map(([key, url]) => `${key}: ${url}`)
            .join(', ')} };\n`
        : null,
  };
};

/**
 * Kokoro's pronunciation dictionaries: narration plans phonemes in the
 * WebView. Android's asset packager treats a final `.gz` specially inside
 * APKs, so the same gzip bytes publish under a neutral `.bin` name.
 */
const kokoroLexicon = () =>
  gezelAssets('docblocks-kokoro-lexicon', 'kokoroLexiconUrls', {
    us: { path: 'kokoro-lexicon/lexicon-us-en.txt.gz', name: 'lexicon-us-en.bin' },
    gb: { path: 'kokoro-lexicon/lexicon-gb-en.txt.gz', name: 'lexicon-gb-en.bin' },
  });

/** The knowledge worker and the SQLite build it reads catalogs with. */
const gezelKnowledge = () =>
  gezelAssets('docblocks-gezel-knowledge', 'gezelKnowledgeUrls', {
    workerUrl: { path: 'dist/knowledge-worker.js', name: 'knowledge-worker.js' },
    wasmUrl: { path: 'dist/sqlite3.wasm', name: 'sqlite3.wasm' },
  });

export default defineConfig({
  base: './',
  publicDir: '../site/public',
  define: {
    __DOCBLOCKS_VERSION__: JSON.stringify(docblocksPackage.version),
    // The build instant; About shows it as the viewer's local day (a UTC day
    // read as tomorrow for anyone west of Greenwich in the evening).
    __DOCBLOCKS_BUILD_DATE__: JSON.stringify(new Date().toISOString()),
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
    kokoroLexicon(),
    gezelKnowledge(),
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
