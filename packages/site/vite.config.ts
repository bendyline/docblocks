import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import docblocksPackage from '../core/package.json';

// Strips //# sourceMappingURL pragmas from upstream packages whose published
// tarballs reference sourcemaps or sources that aren't actually shipped, so
// Vite stops logging "missing source files" warnings on every dev request.
const stripBrokenSourcemapPragmas = (): Plugin => ({
  name: 'strip-broken-sourcemap-pragmas',
  enforce: 'pre',
  transform(code, id) {
    if (
      id.includes('/@bendyline/squisq-video/dist/') ||
      id.includes('\\@bendyline\\squisq-video\\dist\\') ||
      id.includes('/genson-js/dist/') ||
      id.includes('\\genson-js\\dist\\')
    ) {
      return {
        code: code.replace(/\n?\/\/# sourceMappingURL=.*$/m, ''),
        map: null,
      };
    }
    return null;
  },
});

function isDeferredFeatureAsset(fileName: string): boolean {
  const baseName = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  // Keep lazy chunks out of the initial modulePreload: the export pipeline
  // and Monaco (loaded on first editor mount via squisq's canonical
  // `@bendyline/squisq-editor-react/monaco` entry) should not be prefetched
  // up front. Vite names the dynamic-import chunk after `monaco.js`.
  return baseName.startsWith('export-') || baseName.startsWith('monaco');
}

function resolveModulePreloadDependencies(_filename: string, deps: string[]): string[] {
  return deps.filter((dep) => !isDeferredFeatureAsset(dep));
}

// PWA packaging. The whole dist is precached (~22 MB) so every feature —
// export formats, Monaco language workers, theme fonts — works offline even
// if the user never touched it while online. That is a deliberate product
// decision: never let functionality break offline to save bandwidth.
const docblocksPwa = (): Plugin[] =>
  VitePWA({
    // Updates are prompt-based: the shell shows an "Update available" status
    // notice that opens Reload/Later controls. Never auto-reload mid-edit.
    registerType: 'prompt',
    // The page CSP (`script-src 'self'`) forbids inline scripts, and we need
    // the update callbacks anyway — registration lives in src/pwa.ts.
    injectRegister: false,
    devOptions: { enabled: false }, // SW exists only in build/preview
    manifest: {
      name: 'DocBlocks',
      short_name: 'DocBlocks',
      description:
        'A local-first markdown document editor that runs entirely in your browser. Your files stay on your device.',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      // Prefer the custom titlebar when the browser supports it — the WCO
      // CSS lives in docblocks.css under `@media (display-mode:
      // window-controls-overlay)`. 'standalone' is the fallback.
      display_override: ['window-controls-overlay', 'standalone'],
      theme_color: '#f3eede',
      background_color: '#ffffff',
      categories: ['productivity'],
      launch_handler: { client_mode: 'focus-existing' },
      // Installed-app OS integration (Chromium desktop): double-clicking a
      // markdown file or a DocBlocks bundle opens it here (consumed by the
      // shell's launchQueue effect), and the taskbar jump list offers a
      // fresh document (`?action=new`, handled by the shell on boot).
      file_handlers: [
        {
          action: '/',
          accept: {
            'text/markdown': ['.md', '.markdown'],
            'application/x-docblocks': ['.dbk'],
          },
        },
      ],
      shortcuts: [
        {
          name: 'New document',
          url: '/?action=new',
          icons: [{ src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' }],
        },
      ],
      icons: [
        { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // Everything in dist. CNAME has no extension so it stays out.
      globPatterns: ['**/*.{html,js,css,png,webp,ttf,woff2,webmanifest,txt,xml}'],
      // Workbox's default cap is 2 MiB, which would SILENTLY drop the main
      // bundle, the monaco chunk, and ts.worker (6 MB) from the precache.
      // Any future chunk above this cap silently falls out too — check
      // dist/sw.js after adding heavy dependencies.
      maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      navigateFallback: 'index.html',
      // Only the root editor is an app-shell route. Static product pages,
      // crawl files, and custom 404s must resolve to their own responses.
      navigateFallbackAllowlist: [/^\/$/],
      cleanupOutdatedCaches: true,
      // Paired with registerType 'prompt': the waiting SW takes over only
      // when the user accepts the reload.
      skipWaiting: false,
      clientsClaim: false,
    },
  });

export default defineConfig({
  // The root remains the SPA editor, while product and policy routes are
  // real static documents copied from public/. Do not rewrite their 404s to
  // the editor during development or preview.
  appType: 'mpa',
  base: process.env.VITE_BASE || '/',
  define: {
    __DOCBLOCKS_VERSION__: JSON.stringify(docblocksPackage.version),
  },
  plugins: [stripBrokenSourcemapPragmas(), react(), docblocksPwa()],
  resolve: {
    preserveSymlinks: false,
    // Force a single monaco-editor copy across the graph. Without this, the
    // symlinked (linked-dev) squisq resolves its OWN nested monaco-editor for
    // the editor, while this app's `?worker` imports resolve this package's
    // copy — and if the versions differ (they have: squisq 0.50 vs 0.53 here)
    // the language-service workers and the editor speak mismatched protocols.
    // Deduping makes linked dev resolve one copy, exactly as a normal install
    // does via squisq's monaco-editor peer dependency.
    dedupe: ['react', 'react-dom', 'monaco-editor'],
    alias: [
      // No monaco-editor alias: DocBlocks gets Monaco straight from squisq's
      // canonical entry (`@bendyline/squisq-editor-react/monaco`, loaded by its
      // useMonacoLoader). squisq owns which slice of Monaco ships — DocBlocks no
      // longer maintains its own slim build (an easy way to silently drop the
      // suggest widget, as it did before).
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../react/src/styles/docblocks.css'),
      },
      {
        find: /^@bendyline\/docblocks-react$/,
        replacement: path.resolve(__dirname, '../react/src/index.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/indexeddb',
        replacement: path.resolve(__dirname, '../core/src/filesystem/indexeddb.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/memory',
        replacement: path.resolve(__dirname, '../core/src/filesystem/memory.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/native',
        replacement: path.resolve(__dirname, '../core/src/filesystem/native.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/electron',
        replacement: path.resolve(__dirname, '../core/src/filesystem/electron.ts'),
      },
      {
        find: /^@bendyline\/docblocks\/filesystem$/,
        replacement: path.resolve(__dirname, '../core/src/filesystem/index.ts'),
      },
      {
        find: '@bendyline/docblocks/workspace',
        replacement: path.resolve(__dirname, '../core/src/workspace/index.ts'),
      },
      {
        find: '@bendyline/docblocks/host',
        replacement: path.resolve(__dirname, '../core/src/host/index.ts'),
      },
      {
        find: '@bendyline/docblocks/document',
        replacement: path.resolve(__dirname, '../core/src/document/index.ts'),
      },
      {
        find: /^@bendyline\/docblocks$/,
        replacement: path.resolve(__dirname, '../core/src/index.ts'),
      },
    ],
  },
  build: {
    // Known large chunks have surface-specific limits in
    // scripts/check-bundle-size.ts; keep Vite's generic warning aligned.
    chunkSizeWarningLimit: 4_000,
    modulePreload: {
      resolveDependencies: resolveModulePreloadDependencies,
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5220,
    strictPort: true,
    open: true,
    fs: {
      // Allow serving files from the symlinked squisq workspace —
      // its CSS @imports `@fortawesome/fontawesome-free/css/all.min.css`,
      // which then references woff2 webfonts via relative url(). With
      // preserveSymlinks: false those resolve through squisq's realpath,
      // so we need to whitelist it for Vite to serve the font assets.
      allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../../squisq')],
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
      // CJS transitive deps of squisq packages that need pre-bundling.
      // The squisq packages themselves are excluded (served from source
      // via symlinks for live dev), but their CJS deps must be bundled.
      'localforage',
      'extend',
      'debug',
      'format',
      'genson-js',
      'jszip',
      'ngeohash',
      'pako',
      'lie',
      'immediate',
      'setimmediate',
      'readable-stream',
      'inherits',
      'core-util-is',
      'isarray',
      'safe-buffer',
      'string_decoder',
      'process-nextick-args',
      'util-deprecate',
    ],
    exclude: [
      // Symlinked squisq packages — serve from source for live dev
      '@bendyline/squisq',
      '@bendyline/squisq-react',
      '@bendyline/squisq-editor-react',
      '@bendyline/squisq-formats',
      '@bendyline/squisq-video',
      '@bendyline/squisq-video-react',
    ],
  },
});
