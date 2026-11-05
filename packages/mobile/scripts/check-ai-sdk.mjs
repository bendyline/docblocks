import { URL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
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
const installed = (name) =>
  path.resolve(
    path.dirname(
      fileURLToPath(
        import.meta.resolve(name === '@bendyline/gezel-app-sdk' ? `${name}/browser` : name),
      ),
    ),
    '..',
  );
const plugin = read(path.join(root, 'package.json'));
const dependencies = read(new URL('package.json', mobile)).dependencies;
assert.equal(dependencies[plugin.name], plugin.version, `${plugin.name} must be pinned exactly`);
// The plugin was built against these published releases; mobile must run them.
for (const [name, version] of Object.entries(plugin.dependencies)) {
  assert.equal(dependencies[name], version, `${name} must be pinned to ${version}`);
  assert.equal(read(path.join(installed(name), 'package.json')).version, version);
}

// The Gradle lock must name exactly the Maven artifacts the installed plugin stages.
// Gezel's published plugin carries no speech runtime; a locally staged one needs its lock line.
const native = compatibility.native.android.version;
assert.equal(compatibility.native.ios.version, native);
const speechManifest = path.join(root, 'native/speech-android/sdk-manifest.json');
const speech = existsSync(speechManifest) ? read(speechManifest).packageVersion : undefined;
assert.deepEqual(
  readFileSync(new URL('android/app/gradle.lockfile', mobile), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.split('=')[0])
    .filter((coordinate) => coordinate.startsWith('com.bendyline.gezel:')),
  [
    `gezel-llama:${native}`,
    `gezel-runtime:${native}`,
    ...(speech ? [`gezel-speech:${speech}`] : []),
  ].map((artifact) => `com.bendyline.gezel:${artifact}`),
  'The Gradle lock must match the installed Gezel native payload',
);

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
