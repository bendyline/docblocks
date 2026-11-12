import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/**/*.ts'],
  format: ['esm'],
  // Transpile file by file: a bundle would hoist the external pipeline
  // imports above cli.ts's DOM registration, and they need a DOM to load.
  bundle: false,
  dts: { entry: 'src/index.ts' },
  sourcemap: false,
  clean: true,
  target: 'node24',
});
