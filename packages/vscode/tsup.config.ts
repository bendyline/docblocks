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
  // Web extension host — ESM bundle for web worker
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
]);
