import { defineConfig } from 'tsup';

export default defineConfig([
  // Desktop (Node.js) extension host — CJS
  {
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: true,
    clean: true,
    external: ['vscode'],
    noExternal: ['@bendyline/docblocks', 'jsonc-parser'],
  },
  // Web extension host (vscode.dev) — browser-targeted CJS. The web extension
  // host loads `browser` entries as CommonJS inside its worker, so this is CJS
  // like the desktop bundle; only the platform and NODE_ENV define differ.
  {
    entry: { 'extension.web': 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: true,
    platform: 'browser',
    external: ['vscode'],
    noExternal: ['@bendyline/docblocks', 'jsonc-parser'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
  // Desktop extension-host E2E entry loaded by @vscode/test-electron.
  {
    entry: { 'desktop-e2e/index': 'desktop-e2e/suite/index.ts' },
    format: ['cjs'],
    platform: 'node',
    sourcemap: true,
    external: ['vscode'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
