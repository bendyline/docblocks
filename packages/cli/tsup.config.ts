import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    '@modelcontextprotocol/sdk',
    'playwright-core',
    '@bendyline/squisq-cli',
    '@bendyline/squisq-formats',
    '@bendyline/squisq-react',
    '@bendyline/squisq-video',
    '@bendyline/squisq',
    'zod',
  ],
});
