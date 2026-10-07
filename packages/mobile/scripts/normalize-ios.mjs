import { URL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const target = new URL('../ios/App/CapApp-SPM/Package.swift', import.meta.url);
// Capacitor rounds the Xcode deployment floor to a major version. Gezel's
// verified XCFramework and Swift runtime require iOS 16.4.
const source = readFileSync(target, 'utf8');
if (!source.includes('BendylineGezelCapacitor'))
  throw new Error('Gezel native plugin was omitted by Capacitor sync.');
writeFileSync(
  target,
  source.replace(/platforms: \[\.iOS\([^\n]+\)\],/, 'platforms: [.iOS("16.4")],'),
);
