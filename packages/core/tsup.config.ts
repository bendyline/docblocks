import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'filesystem/index': 'src/filesystem/index.ts',
    'filesystem/indexeddb': 'src/filesystem/indexeddb.ts',
    'filesystem/memory': 'src/filesystem/memory.ts',
    'filesystem/native': 'src/filesystem/native.ts',
    'filesystem/electron': 'src/filesystem/electron.ts',
    'document/index': 'src/document/index.ts',
    'workspace/index': 'src/workspace/index.ts',
    'host/index': 'src/host/index.ts',
    'share/index': 'src/share/index.ts',
    'vscode/index': 'src/vscode/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    'mcp/zod': 'src/mcp/zod.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@bendyline/squisq', 'localforage'],
});
