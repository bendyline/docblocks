import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredVersion = (await readFile(path.join(repoRoot, '.nvmrc'), 'utf8')).trim();
const configuredMatch = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(configuredVersion);

if (!configuredMatch) {
  throw new Error(`.nvmrc must contain a numeric Node version; received ${configuredVersion}`);
}

const currentMatch = /^(\d+)\.(\d+)\.(\d+)$/u.exec(process.versions.node);
if (!currentMatch) {
  throw new Error(`Unable to parse the active Node version: ${process.versions.node}`);
}

const configuredParts = configuredMatch
  .slice(1)
  .filter((part): part is string => part !== undefined);
const currentParts = currentMatch.slice(1, 1 + configuredParts.length);

if (configuredParts.some((part, index) => part !== currentParts[index])) {
  const expected = configuredParts.length === 2 ? `${configuredVersion}.x` : configuredVersion;
  throw new Error(
    `Canonical assurance requires Node ${expected} from .nvmrc; the active runtime is ${process.versions.node}. ` +
      'Activate .nvmrc with your Node version manager, then rerun npm run all.',
  );
}
