import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/extension.ts'],
  format: ['cjs'],
  sourcemap: true,
  clean: true,
  external: ['vscode'],
});
