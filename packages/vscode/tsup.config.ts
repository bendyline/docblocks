import { defineConfig } from 'tsup';

export default defineConfig([
  // Desktop (Node.js) extension host — CJS
  {
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: true,
    clean: true,
    external: ['vscode'],
  },
  // Web extension host — ESM bundle for web worker
  {
    entry: { 'extension.web': 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: true,
    platform: 'browser',
    external: ['vscode'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  },
]);
