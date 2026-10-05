import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = path.join(root, 'packages/mobile');
const platform = process.argv[2],
  buildNumber = process.argv[3] || '1';
if (!['ios', 'android'].includes(platform) || !/^[1-9][0-9]{0,8}$/.test(buildNumber))
  throw new Error('Usage: npm run mobile:package -- ios|android [positive build number].');
if (platform === 'ios' && process.platform !== 'darwin')
  throw new Error('iOS packaging requires macOS and Xcode.');
const version = JSON.parse(readFileSync(path.join(mobile, 'package.json'), 'utf8')).version;
const output = path.join(
  root,
  'reports/mobile-release',
  `${platform}-${version}-${buildNumber}-${randomUUID()}`,
);
mkdirSync(output, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
const npm = (args) =>
  run(process.execPath, [path.join(root, 'node_modules/npm/bin/npm-cli.js'), ...args]);
let environment = { ...process.env };
if (platform === 'android') {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.HOME, 'Library/Android/sdk');
  let java = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME;
  if (!java && process.platform === 'darwin') {
    const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
    if (result.status === 0) java = result.stdout.trim();
  }
  if (!existsSync(sdk) || !java)
    throw new Error('Install Android SDK 36 and JDK 21, then set ANDROID_HOME and JAVA_HOME.');
  environment = { ...environment, ANDROID_HOME: sdk, JAVA_HOME: java };
}
npm(['run', 'mobile:build']);
npm(['run', 'mobile:check']);
npm(['run', `sync:${platform}`, '-w', 'docblocks-mobile']);
const artifacts = [];
if (platform === 'ios') {
  const archive = path.join(output, 'DocBlocks.xcarchive');
  run('xcodebuild', [
    '-project',
    path.join(mobile, 'ios/App/App.xcodeproj'),
    '-scheme',
    'App',
    '-configuration',
    'Release',
    '-destination',
    'generic/platform=iOS',
    '-archivePath',
    archive,
    '-derivedDataPath',
    path.join(output, 'derived'),
    '-skipPackageUpdates',
    'CODE_SIGNING_ALLOWED=NO',
    `MARKETING_VERSION=${version}`,
    `CURRENT_PROJECT_VERSION=${buildNumber}`,
    'archive',
  ]);
  run('python3', [
    path.join(mobile, 'scripts/verify-package.py'),
    'ios',
    archive,
    path.join(mobile, 'dist'),
    version,
    buildNumber,
  ]);
  artifacts.push({ path: archive, kind: 'xcarchive' });
} else {
  run(
    process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
    [
      '--no-daemon',
      ':app:assembleRelease',
      ':app:bundleRelease',
      `-PdocblocksVersionName=${version}`,
      `-PdocblocksVersionCode=${buildNumber}`,
    ],
    { cwd: path.join(mobile, 'android'), env: environment, shell: process.platform === 'win32' },
  );
  for (const [source, name] of [
    ['apk/release/app-release-unsigned.apk', 'docblocks-unsigned.apk'],
    ['bundle/release/app-release.aab', 'docblocks-unsigned.aab'],
  ]) {
    const target = path.join(output, name);
    copyFileSync(path.join(mobile, 'android/app/build/outputs', source), target);
    run('python3', [
      path.join(mobile, 'scripts/verify-package.py'),
      'android',
      target,
      path.join(mobile, 'dist'),
      version,
      buildNumber,
    ]);
    const bytes = readFileSync(target);
    artifacts.push({
      path: target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
}
writeFileSync(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    { platform, version, buildNumber: Number(buildNumber), unsigned: true, artifacts },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`Verified unsigned ${platform} artifacts: ${output}\n`);
