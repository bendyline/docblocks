import { defineConfig } from 'tsup';

/**
 * Builds the Electron main process and preload script to CommonJS.
 *
 * The main process loads the compiled renderer from dist/renderer/ via a
 * custom app:// protocol. Preload runs with Node integration but exposes
 * only a typed contextBridge surface to the renderer.
 */
export default defineConfig([
  // Main process — Node runtime
  {
    entry: { main: 'main/main.ts' },
    outDir: 'dist/main',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    shims: false,
    external: ['electron', 'electron-updater', 'chokidar', 'electron-window-state'],
    outExtension: () => ({ js: '.cjs' }),
  },
  // Preload — runs in renderer with limited Node APIs
  {
    entry: { preload: 'preload/preload.ts' },
    outDir: 'dist/preload',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    shims: false,
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
