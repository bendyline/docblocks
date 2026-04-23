import { defineConfig } from 'tsup';

/**
 * Builds the Electron main process and preload script to CommonJS.
 *
 * Each entry type-checks against its dedicated tsconfig so a preload
 * file accidentally importing a main-only module (or vice versa) is
 * caught at compile time rather than surfacing as a runtime crash.
 */
export default defineConfig([
  // Main process — Node runtime, no DOM globals.
  {
    entry: { main: 'main/main.ts' },
    outDir: 'dist/main',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    shims: false,
    tsconfig: 'tsconfig.main.json',
    external: ['electron', 'electron-updater', 'chokidar', 'electron-window-state'],
    outExtension: () => ({ js: '.cjs' }),
  },
  // Preload — runs in renderer sandbox with limited Node APIs + DOM.
  {
    entry: { preload: 'preload/preload.ts' },
    outDir: 'dist/preload',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    clean: true,
    shims: false,
    tsconfig: 'tsconfig.preload.json',
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
