import { defineConfig } from 'tsup';

const emitSourceMaps = process.env.DOCBLOCKS_SOURCEMAPS === 'true';

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
    // Production builds are distributed without source maps. Opt in for a
    // local diagnostic build with DOCBLOCKS_SOURCEMAPS=true.
    sourcemap: emitSourceMaps,
    clean: true,
    shims: false,
    tsconfig: 'tsconfig.main.json',
    // The renderer's DocBlocks/Squisq graph is already emitted by Vite. Bundle
    // the small slice of DocBlocks core used by main so electron-builder only
    // has to copy dependencies that are genuinely loaded at runtime.
    noExternal: [/^@bendyline\/docblocks(?:\/|$)/u],
    external: [
      'electron',
      'electron-updater',
      'chokidar',
      'electron-window-state',
      'ffmpeg-static',
    ],
    outExtension: () => ({ js: '.cjs' }),
  },
  // Preload — runs in renderer sandbox with limited Node APIs + DOM.
  {
    entry: { preload: 'preload/preload.ts' },
    outDir: 'dist/preload',
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    sourcemap: emitSourceMaps,
    clean: true,
    shims: false,
    tsconfig: 'tsconfig.preload.json',
    // A sandboxed Electron preload only receives Electron's deliberately
    // limited `require` implementation. Bundle shared runtime validators into
    // the preload instead of leaving workspace-package imports for runtime.
    noExternal: [/^@bendyline\/docblocks(?:\/|$)/u],
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
