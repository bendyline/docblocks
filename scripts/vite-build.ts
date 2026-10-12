/**
 * `vite build` with an explicit Node heap ceiling.
 *
 * Every surface bundles the full editor, and a production build of it keeps
 * close to 2 GiB live. That is over the default heap Node chooses on machines
 * with less than ~16 GiB of RAM — macOS CI runners and 8 GiB laptops — where
 * the build dies with "JavaScript heap out of memory". 4 GiB is what Node
 * already picks on larger machines, so this only removes the difference
 * between hosts. An explicit `--max-old-space-size` in NODE_OPTIONS wins.
 *
 * Run from a package directory: `tsx ../../scripts/vite-build.ts [vite build args]`.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const HEAP_MIB = 4096;

const require = createRequire(path.join(process.cwd(), 'package.json'));
const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const heapArgs = /--max-old-space-size=/u.test(process.env.NODE_OPTIONS ?? '')
  ? []
  : [`--max-old-space-size=${String(HEAP_MIB)}`];

const result = spawnSync(
  process.execPath,
  [...heapArgs, viteCli, 'build', ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
