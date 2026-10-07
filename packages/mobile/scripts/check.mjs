import './check-ai-sdk.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = path.join(root, 'packages/mobile');
const read = (file) => readFileSync(path.join(mobile, file), 'utf8');
const manifest = JSON.parse(read('package.json'));
for (const dependency of ['core', 'ios', 'android'])
  assert.equal(
    manifest.dependencies[`@capacitor/${dependency}`],
    manifest.devDependencies['@capacitor/cli'],
  );
assert.match(
  read('ios/App/CapApp-SPM/Package.swift'),
  new RegExp(`exact: "${manifest.dependencies['@capacitor/core'].replaceAll('.', '\\.')}"`),
);
assert.match(read('capacitor.config.ts'), /webDir: 'dist'/);
assert.doesNotMatch(read('capacitor.config.ts'), /allowNavigation|cleartext|server:\s*\{[^}]*url:/);
assert.match(
  read('android/app/src/main/AndroidManifest.xml'),
  /android:windowSoftInputMode="adjustResize"/,
);
assert.doesNotMatch(
  read('android/app/src/main/AndroidManifest.xml'),
  /MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|usesCleartextTraffic="true"/,
);
assert.match(read('ios/App/App/Info.plist'), /net.daringfireball.markdown/);
assert.match(read('dist/index.html'), /Content-Security-Policy/);
assert.match(read('dist/index.html'), /fonts\/fonts.css/);
assert.doesNotMatch(read('dist/index.html'), /https?:\/\/[^"']+\.js/);
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
for (const name of readdirSync(path.join(root, 'packages/site/public/fonts')).filter((name) =>
  name.endsWith('.woff2'),
)) {
  assert.equal(
    hash(path.join(mobile, 'dist/fonts', name)),
    hash(path.join(root, 'packages/site/public/fonts', name)),
    `Font mismatch: ${name}`,
  );
}
for (const file of [
  'harper/harper_wasm_bg.wasm',
  'harper/LICENSE.txt',
  'ironcalc/wasm_bg.wasm',
  'THIRD_PARTY_COMPONENTS.json',
  'THIRD_PARTY_NOTICES.txt',
  'NATIVE_NOTICES.txt',
])
  assert.ok(statSync(path.join(mobile, 'dist', file)).size > 0, `Missing ${file}`);
assert.equal(read('dist/THIRD_PARTY_NOTICES.txt'), read('THIRD_PARTY_NOTICES.txt'));
assert.equal(read('dist/NATIVE_NOTICES.txt'), read('NATIVE_NOTICES.txt'));
const nativeModules = JSON.parse(read('native/android/dependencies.json')).modules;
const lockedModules = read('android/app/gradle.lockfile')
  .split('\n')
  .filter(
    (line) =>
      !line.startsWith('#') && line.split('=')[1]?.split(',').includes('releaseRuntimeClasspath'),
  )
  .map((line) => line.split('=')[0])
  .sort();
assert.deepEqual(
  nativeModules,
  lockedModules,
  'Native runtime inventory must match the Gradle lock',
);
assert.ok(nativeModules.every((coordinate) => read('NATIVE_NOTICES.txt').includes(coordinate)));
assert.match(read('ios/App/App/PrivacyInfo.xcprivacy'), /C617.1/);
assert.match(
  read('android/gradle/wrapper/gradle-wrapper.properties'),
  /distributionSha256Sum=[a-f0-9]{64}/,
);
const assets = readdirSync(path.join(mobile, 'dist/assets'));
for (const worker of ['editor.worker', 'json.worker', 'css.worker', 'html.worker', 'ts.worker'])
  assert.ok(
    assets.some((name) => name.startsWith(worker)),
    `Missing ${worker}`,
  );
assert.ok(
  assets.every((name) => !name.includes('ffmpeg-core')),
  'GPL FFmpeg engine must not enter the mobile payload.',
);
for (const name of assets.filter((name) => name.endsWith('.js')))
  assert.ok(
    statSync(path.join(mobile, 'dist/assets', name)).size < 8_000_000,
    `Oversized mobile chunk: ${name}`,
  );
process.stdout.write(
  'Mobile native configuration, offline assets, fonts, notices and bundle limits passed.\n',
);
