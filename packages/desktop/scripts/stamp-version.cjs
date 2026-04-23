#!/usr/bin/env node
/**
 * Stamp the desktop package.json version with a prerelease build id so
 * each CI release produces a distinct, SemVer-comparable version.
 *
 * Usage:
 *   node scripts/stamp-version.cjs --run 123
 *
 * Effect:
 *   "version": "0.1.0"  →  "0.1.0-build.123"
 *
 * electron-updater compares versions via SemVer, so a plain build
 * metadata suffix (`+build.N`) would be treated as equal to the base
 * version and never trigger an upgrade. A prerelease suffix is ordered
 * and detected as "newer" when the build number increments.
 *
 * When a proper `0.1.1` or `0.2.0` tag is cut, the tag itself wins — do
 * not stamp on tag-triggered runs.
 */

const fs = require('node:fs');
const path = require('node:path');

function argValue(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const run = argValue('run');
if (!run) {
  console.error('stamp-version: --run <number> is required');
  process.exit(1);
}

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const base = String(pkg.version).replace(/-build\.\d+$/, '');
const stamped = `${base}-build.${run}`;
pkg.version = stamped;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`stamp-version: ${base} → ${stamped}`);
