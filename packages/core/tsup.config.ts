import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'workspace/index': 'src/workspace/index.ts',
    'host/index': 'src/host/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@bendyline/squisq', 'localforage'],
});
