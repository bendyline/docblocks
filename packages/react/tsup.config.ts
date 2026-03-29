import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    'react',
    'react-dom',
    '@bendyline/docblocks',
    '@bendyline/squisq',
    '@bendyline/squisq-react',
    '@bendyline/squisq-editor-react',
    '@bendyline/squisq-formats',
    '@bendyline/squisq-video',
    '@bendyline/squisq-video-react',
    'monaco-editor',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
