import { URL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url));
const root = path.dirname(require.resolve('@bendyline/gezel-capacitor/package.json'));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const { verifyCapacitorPackage } = await import('@bendyline/gezel-capacitor/packaging');
const compatibility = await verifyCapacitorPackage(root);
const mobile = new URL('../', import.meta.url);
assert.match(
  readFileSync(new URL('ios/App/CapApp-SPM/Package.swift', mobile), 'utf8'),
  /BendylineGezelCapacitor/,
);
assert.match(
  readFileSync(new URL('ios/App/CapApp-SPM/Package.swift', mobile), 'utf8'),
  /\.iOS\("16\.4"\)/,
);
assert.match(
  readFileSync(new URL('android/capacitor.settings.gradle', mobile), 'utf8'),
  /bendyline-gezel-capacitor/,
);
const provenance = read(new URL('vendor/provenance.json', mobile));
const pins = read(new URL('vendor/native-release.json', mobile));
assert.deepEqual(provenance.nativeRelease, pins);
for (const platform of ['ios', 'android'])
  assert.equal(compatibility.native[platform].version, pins.version);
for (const [name, entry] of Object.entries(provenance.packages)) {
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL(entry.file, new URL('vendor/', mobile))))
      .digest('hex'),
    entry.sha256,
  );
  const installed =
    name === '@bendyline/gezel-capacitor'
      ? root
      : path.resolve(
          path.dirname(
            fileURLToPath(
              import.meta.resolve(name === '@bendyline/gezel-app-sdk' ? `${name}/browser` : name),
            ),
          ),
          '..',
        );
  assert.equal(read(path.join(installed, 'package.json')).version, entry.version);
}

const privacy = readFileSync(new URL('ios/App/App/PrivacyInfo.xcprivacy', mobile), 'utf8');
assert.match(privacy, /NSPrivacyAccessedAPICategoryDiskSpace/);
assert.match(privacy, /E174.1/);
assert.match(privacy, /NSPrivacyAccessedAPICategorySystemBootTime/);
assert.match(privacy, /35F9.1/);

// npm can retain a removed local preview resolution when its version matches
// a registry pin. Clean installs must never rely on tarballs only in npm's cache.
const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
for (const entry of Object.values(read(path.join(repo, 'package-lock.json')).packages)) {
  if (!entry.resolved?.startsWith('file:')) continue;
  const file = path.resolve(repo, entry.resolved.slice(5));
  assert.ok(file.startsWith(`${repo}${path.sep}`));
  assert.equal(
    `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`,
    entry.integrity,
    `Local dependency integrity: ${file}`,
  );
}
