import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLISHED_NODE_ENGINE_MANIFESTS,
  WORKSPACE_NODE_BASELINE,
  WORKSPACE_NODE_ENGINE,
} from './node-engine-policy.js';

interface PackageManifest {
  readonly name?: string;
  engines?: Record<string, string>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const unexpectedArguments = process.argv.slice(2).filter((argument) => argument !== '--write');

if (unexpectedArguments.length > 0) {
  throw new Error(`Unknown arguments: ${unexpectedArguments.join(', ')}`);
}

const drift: string[] = [];

for (const relativePath of PUBLISHED_NODE_ENGINE_MANIFESTS) {
  const manifestPath = path.join(repoRoot, relativePath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  if (manifest.engines?.node === WORKSPACE_NODE_ENGINE) continue;

  if (!write) {
    drift.push(
      `${relativePath} declares ${JSON.stringify(manifest.engines?.node)} instead of ${JSON.stringify(WORKSPACE_NODE_ENGINE)}`,
    );
    continue;
  }

  manifest.engines = { ...manifest.engines, node: WORKSPACE_NODE_ENGINE };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const nvmrcPath = path.join(repoRoot, '.nvmrc');
const nvmrc = (await readFile(nvmrcPath, 'utf8')).trim();
if (nvmrc !== WORKSPACE_NODE_BASELINE) {
  if (write) await writeFile(nvmrcPath, `${WORKSPACE_NODE_BASELINE}\n`);
  else {
    drift.push(
      `.nvmrc selects ${JSON.stringify(nvmrc)} instead of the workspace baseline ${JSON.stringify(WORKSPACE_NODE_BASELINE)}`,
    );
  }
}

if (drift.length > 0) {
  throw new Error(
    `Node engine policy drift:\n- ${drift.join('\n- ')}\nRun npm run generate:node-engine-policy to synchronize it.`,
  );
}

process.stdout.write(
  `${write ? 'Synchronized' : 'Verified'} published package engines and .nvmrc against ${WORKSPACE_NODE_ENGINE}.\n`,
);
