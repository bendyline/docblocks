import { defineConfig } from 'tsup';

export default defineConfig([
  // Desktop (Node.js) extension host — CJS
  {
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: false,
    clean: true,
    external: ['vscode'],
    // Workspace catalogs render in the extension host, so the Squisq Markdown
    // and plain-HTML modules ship inside the bundle (the VSIX carries no
    // node_modules).
    noExternal: [
      '@bendyline/docblocks',
      '@bendyline/squisq',
      '@bendyline/squisq-formats',
      'jsonc-parser',
    ],
  },
  // Web extension host (vscode.dev) — browser-targeted CJS. The web extension
  // host loads `browser` entries as CommonJS inside its worker, so this is CJS
  // like the desktop bundle; only the platform and NODE_ENV define differ.
  {
    entry: { 'extension.web': 'src/extension.ts' },
    format: ['cjs'],
    sourcemap: false,
    platform: 'browser',
    external: ['vscode'],
    // Workspace catalogs render in the extension host, so the Squisq Markdown
    // and plain-HTML modules ship inside the bundle (the VSIX carries no
    // node_modules).
    noExternal: [
      '@bendyline/docblocks',
      '@bendyline/squisq',
      '@bendyline/squisq-formats',
      'jsonc-parser',
    ],
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
