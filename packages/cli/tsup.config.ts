import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/eval/cli.ts'],
  format: ['esm'],
  splitting: false,
  dts: true,
  sourcemap: false,
  clean: true,
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
