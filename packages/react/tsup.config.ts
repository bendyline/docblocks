import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'ai/index': 'src/Ai/headless-api.ts',
    'calculation/index': 'src/Calculation/public-api.ts',
    'export/index': 'src/Export/public-api.ts',
    'proofing/index': 'src/Proofing/public-api.ts',
    'settings/index': 'src/Settings/public-api.ts',
    editor: 'src/editor.ts',
    'workspace-index-worker/index': 'src/WorkspaceIndex/worker.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: [
    'react',
    'react-dom',
    '@bendyline/docblocks',
    '@bendyline/docblocks/workspace-index',
    '@bendyline/gezel-retrieval',
    '@bendyline/gezel-retrieval/sqlite-wasm',
    '@sqlite.org/sqlite-wasm',
    '@bendyline/squisq',
    '@bendyline/squisq-calc',
    '@bendyline/squisq-calc/ironcalc',
    '@bendyline/squisq-react',
    '@bendyline/squisq-editor-react',
    '@bendyline/squisq-editor-react/proofing',
    '@bendyline/squisq-formats',
    '@bendyline/squisq-video',
    '@bendyline/squisq-video-react',
    'monaco-editor',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
