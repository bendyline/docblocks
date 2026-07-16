/**
 * Preflight for the multi-semantic-release ↔ semantic-release seam.
 *
 * multi-semantic-release reaches into semantic-release's PRIVATE internals:
 *
 *     // multi-semantic-release/lib/semrel.js:5
 *     api.semanticGetConfig = require("semantic-release/lib/get-config");
 *
 * That path resolves for exactly one reason — semantic-release ships no
 * `exports` map, so every file inside the package is reachable. The day it adds
 * one (a routine, non-breaking-looking change on their side) the require throws,
 * and msr *swallows it*: `lib/semrel.js:7-15` replaces the API with stubs that
 * throw `NOT_FOUND: semantic-release/lib/get-config`, behind a `console.debug`
 * nobody reads. The release then fails pointing nowhere near the cause.
 *
 * msr also declares no peerDependencies and depends on `semantic-release`
 * with an open `>=19.0.5`, so npm alone will never object to a combination msr
 * has never been tested against. The EXACT pin in the root manifest is what
 * actually holds this together — which is why this check enforces it.
 *
 * Runs before the release rather than during it: a loud failure here costs a
 * minute, the silent one costs a broken publish.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'package.json'));

interface Manifest {
  readonly devDependencies?: Record<string, string>;
  readonly exports?: unknown;
  readonly version?: string;
}

function readManifest(file: string): Manifest {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

function fail(message: string): never {
  throw new Error(message);
}

const root = readManifest(path.join(repoRoot, 'package.json'));
const declared = root.devDependencies ?? {};

// 1. The exact pin is the safety net for msr's open `>=19.0.5` range.
const pinned = declared['semantic-release'];
if (!pinned) fail('semantic-release is not a devDependency of the root manifest.');
if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
  fail(
    `semantic-release must be pinned exactly, found "${pinned}". multi-semantic-release depends on ` +
      'it via an open ">=19.0.5" range and declares no peerDependencies, so nothing else prevents ' +
      'an untested combination from being installed. See the header of this script.',
  );
}

// 2. The private path msr deep-imports must still resolve.
try {
  require.resolve('semantic-release/lib/get-config');
} catch {
  fail(
    'multi-semantic-release cannot reach semantic-release/lib/get-config.\n' +
      'It deep-imports that private path (multi-semantic-release/lib/semrel.js:5) and SWALLOWS the\n' +
      'failure, degrading to stubs that throw "NOT_FOUND: semantic-release/lib/get-config" during the\n' +
      'release. Most likely cause: semantic-release added an "exports" map, which makes its internals\n' +
      'unreachable. Fix by pinning back to a version without one, or migrate off multi-semantic-release\n' +
      '(@anolilab/multi-semantic-release is the maintained successor).',
  );
}

// 3. Name the reason that path resolves, so its disappearance is a caught
//    regression rather than a mystery. An exports map that still exposes the
//    subpath is fine — resolution above is the real test; this is diagnosis.
const semanticRelease = readManifest(require.resolve('semantic-release/package.json'));
const exportsMap = semanticRelease.exports;

process.stdout.write(
  `Release toolchain OK: semantic-release ${semanticRelease.version ?? '?'} pinned exactly` +
    `${
      exportsMap === undefined
        ? ' (no exports map, so the deep import is reachable)'
        : ' (exports map present, but the deep import still resolves)'
    }` +
    `, multi-semantic-release ${declared['multi-semantic-release'] ?? '?'}.\n`,
);
