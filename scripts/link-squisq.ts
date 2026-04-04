/**
 * Links local squisq packages into docblocks' node_modules via symlinks.
 *
 * This avoids `npm link` which requires write access to the global
 * node_modules prefix (/usr/local/lib/node_modules on macOS).
 * Instead, we create symlinks directly in the local node_modules.
 */

import fs from 'fs';
import path from 'path';

const packages: [string, string][] = [
  ['core', '@bendyline/squisq'],
  ['react', '@bendyline/squisq-react'],
  ['editor-react', '@bendyline/squisq-editor-react'],
  ['formats', '@bendyline/squisq-formats'],
  ['video', '@bendyline/squisq-video'],
  ['video-react', '@bendyline/squisq-video-react'],
  ['cli', '@bendyline/squisq-cli'],
];

const root = path.resolve(import.meta.dirname, '..');
const squisqRoot = path.resolve(root, '..', 'squisq', 'packages');
const nmBendyline = path.resolve(root, 'node_modules', '@bendyline');

if (!fs.existsSync(squisqRoot)) {
  console.error(`squisq not found at ${squisqRoot}`);
  process.exit(1);
}

fs.mkdirSync(nmBendyline, { recursive: true });

for (const [dir, pkg] of packages) {
  const src = path.resolve(squisqRoot, dir);
  const dest = path.resolve(root, 'node_modules', pkg);

  if (!fs.existsSync(src)) {
    console.warn(`  SKIP ${pkg} — ${src} not found`);
    continue;
  }

  try {
    fs.rmSync(dest, { recursive: true });
  } catch {
    // didn't exist
  }

  fs.symlinkSync(src, dest, 'dir');
  console.warn(`  ${pkg} -> ${path.relative(root, src)}`);
}

console.warn('\nDone. Local squisq packages linked.');
