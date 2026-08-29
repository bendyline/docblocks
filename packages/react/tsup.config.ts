import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'export/index': 'src/Export/public-api.ts',
    'proofing/index': 'src/Proofing/public-api.ts',
    'settings/index': 'src/Settings/public-api.ts',
    editor: 'src/editor.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  external: [
    'react',
    'react-dom',
    '@bendyline/docblocks',
    '@bendyline/squisq',
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
