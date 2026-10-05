import { URL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const require = createRequire(new URL('../package.json', import.meta.url));
const root = path.dirname(require.resolve('@bendyline/gezel-capacitor/package.json'));
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const manifests = ['ios', 'android'].map((platform) => {
  const folder = path.join(root, 'native', platform);
  const manifest = read(path.join(folder, 'sdk-manifest.json'));
  assert.equal(manifest.target, platform);
  assert.equal(manifest.scope, 'provider-model-runtime');
  assert.equal(manifest.gezelABIVersion, 1);
  for (const [relative, hash] of Object.entries(manifest.files)) {
    const file = path.resolve(folder, relative);
    assert.ok(file.startsWith(`${folder}${path.sep}`));
    assert.equal(
      createHash('sha256').update(readFileSync(file)).digest('hex'),
      hash,
      `SDK integrity: ${relative}`,
    );
  }
  return manifest;
});
assert.equal(manifests[0].packageVersion, manifests[1].packageVersion);
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
assert.equal(
  createHash('sha256')
    .update(readFileSync(new URL(provenance.file, new URL('vendor/', mobile))))
    .digest('hex'),
  provenance.sha256,
);

const privacy = readFileSync(new URL('ios/App/App/PrivacyInfo.xcprivacy', mobile), 'utf8');
assert.match(privacy, /NSPrivacyAccessedAPICategoryDiskSpace/);
assert.match(privacy, /E174.1/);
assert.match(privacy, /NSPrivacyAccessedAPICategorySystemBootTime/);
assert.match(privacy, /35F9.1/);

for (const [relative, hash] of Object.entries(provenance.sources)) {
  if (relative.startsWith('ios/') || relative.startsWith('android/'))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(path.join(root, relative)))
        .digest('hex'),
      hash,
      `Installed SDK is stale: ${relative}`,
    );
}
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
