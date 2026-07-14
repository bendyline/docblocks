/**
 * Validates packages/desktop/electron-builder.yml against the schema that the
 * installed electron-builder (app-builder-lib) ships. Catches unknown or
 * misplaced options (e.g. signtool keys that moved under `signtoolOptions` in
 * electron-builder 26) at `npm run all` time instead of during the release job's
 * `electron-builder --dir`, which is the only other place this config is read.
 *
 * This is a schema check only — it does not catch failures that surface during
 * actual packaging (missing icon files, signing errors, etc.).
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'packages/desktop/electron-builder.yml');
const preloadPath = path.join(repoRoot, 'packages/desktop/dist/preload/preload.cjs');

const config = yaml.load(readFileSync(configPath, 'utf8'));
// app-builder-lib is present because electron-builder depends on it; its
// scheme.json is the same schema electron-builder validates against at runtime.
const schema = JSON.parse(readFileSync(require.resolve('app-builder-lib/scheme.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

if (!validate(config)) {
  process.stderr.write(`electron-builder.yml failed schema validation:\n`);
  for (const error of validate.errors ?? []) {
    const where = error.instancePath || '(root)';
    const extra =
      error.keyword === 'additionalProperties' && error.params.additionalProperty
        ? ` ('${String(error.params.additionalProperty)}')`
        : '';
    process.stderr.write(`  ${where} ${error.message}${extra}\n`);
  }
  process.exit(1);
}

process.stdout.write('electron-builder.yml: schema OK\n');

// Electron's sandboxed preload exposes only a very small CommonJS surface.
// Workspace/package imports that tsup leaves as runtime `require()` calls make
// the entire preload fail before contextBridge exposes docBlocksHost. Inspect
// the artifact produced by the preceding desktop build, not just source config.
if (!existsSync(preloadPath)) {
  process.stderr.write(
    `Desktop preload artifact is missing at ${preloadPath}; build desktop before validating it.\n`,
  );
  process.exit(1);
}

const preload = readFileSync(preloadPath, 'utf8');
const runtimeRequires = new Set<string>();
for (const match of preload.matchAll(/\brequire\((['"])([^'"]+)\1\)/gu)) {
  runtimeRequires.add(match[2]);
}
const unsupportedRequires = [...runtimeRequires].filter((specifier) => specifier !== 'electron');
if (unsupportedRequires.length > 0) {
  process.stderr.write(
    `Sandboxed preload contains unsupported runtime require(s): ${unsupportedRequires.join(', ')}\n`,
  );
  process.exit(1);
}

if (!preload.includes('exposeInMainWorld("docBlocksHost"')) {
  process.stderr.write('Sandboxed preload does not expose the docBlocksHost bridge.\n');
  process.exit(1);
}

process.stdout.write('desktop preload: sandbox bundle OK\n');
