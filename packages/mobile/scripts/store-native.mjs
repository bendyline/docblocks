import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { findJdk21 } from './jdk.mjs';
import {
  APP_ID,
  configureProject,
  decodeSecret,
  exportOptions,
  missingSecrets,
  parseKeychains,
  profileSettings,
} from './store-signing.mjs';
// Builds a signed store binary: a Google Play app bundle signed with the upload
// key, or an App Store Connect IPA. Unlike mobile:package, it fails closed when
// any signing input is missing. Credentials come from the environment, are
// decoded only into a private temporary directory, and are removed afterwards.
// Nothing is uploaded to Google Play or App Store Connect.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = path.join(root, 'packages/mobile');
const [platform, buildNumber = ''] = process.argv.slice(2);
if (!['ios', 'android'].includes(platform) || !/^[1-9][0-9]{0,8}$/u.test(buildNumber))
  throw new Error('Usage: npm run mobile:store -- ios|android <positive build number>.');
if (platform === 'ios' && process.platform !== 'darwin')
  throw new Error('iOS store builds require macOS and Xcode.');
const missing = missingSecrets(platform, process.env);
if (missing.length) throw new Error(`Set the store signing inputs: ${missing.join(', ')}.`);
const version = JSON.parse(readFileSync(path.join(mobile, 'package.json'), 'utf8')).version;
const name = `docblocks-${platform}-${version}-${buildNumber}`;
const output = path.join(root, 'reports/mobile-store', `${name}-${randomUUID()}`);
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docblocks-store-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  // Arguments can carry passwords, so failures name only the tool and subcommand.
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (${result.status ?? result.signal}).`);
  return result.stdout;
}
const capture = (command, args) =>
  run(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const npm = (args) =>
  run(process.execPath, [path.join(root, 'node_modules/npm/bin/npm-cli.js'), ...args]);
/** One plist value; plutil's raw format prints dates as ISO 8601 and data as base64. */
function plistValue(file, keyPath, format = 'raw') {
  const result = spawnSync('plutil', ['-extract', keyPath, format, '-o', '-', file], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  return format === 'json' ? JSON.parse(result.stdout) : result.stdout.trim();
}
function readProfile(file) {
  const plist = path.join(temp, `${randomUUID()}.plist`);
  capture('security', ['cms', '-D', '-i', file, '-o', plist]);
  const uuid = plistValue(plist, 'UUID');
  const expiration = plistValue(plist, 'ExpirationDate');
  if (!uuid || !expiration)
    throw new Error(`${path.basename(file)} is not a provisioning profile.`);
  return {
    uuid,
    expirationDate: new Date(expiration),
    teamIdentifier: plistValue(plist, 'TeamIdentifier', 'json') ?? [],
    applicationIdentifierPrefix: plistValue(plist, 'ApplicationIdentifierPrefix', 'json') ?? [],
    entitlements: plistValue(plist, 'Entitlements', 'json') ?? {},
    provisionedDevices: plistValue(plist, 'ProvisionedDevices', 'json'),
    provisionsAllDevices: plistValue(plist, 'ProvisionsAllDevices') === 'true',
    // An array's raw value is its length.
    developerCertificates: Array.from(
      { length: Number(plistValue(plist, 'DeveloperCertificates') ?? 0) },
      (_, index) => Buffer.from(plistValue(plist, `DeveloperCertificates.${index}`), 'base64'),
    ),
  };
}
function describe(file, kind) {
  const bytes = readFileSync(file);
  return {
    file: path.basename(file),
    kind,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
const verifyPayload = (artifact) =>
  run('python3', [
    path.join(mobile, 'scripts/verify-package.py'),
    platform,
    artifact,
    path.join(mobile, 'dist'),
    version,
    buildNumber,
  ]);
function buildAndroid() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), 'Library/Android/sdk');
  if (!existsSync(sdk)) throw new Error('Install Android SDK 36, then set ANDROID_HOME.');
  const javaHome = findJdk21();
  let keystore =
    process.env.ANDROID_UPLOAD_KEYSTORE_PATH &&
    path.resolve(process.env.ANDROID_UPLOAD_KEYSTORE_PATH);
  if (!keystore) {
    keystore = path.join(temp, 'upload.keystore');
    decodeSecret('ANDROID_UPLOAD_KEYSTORE_BASE64', keystore);
  }
  const environment = {
    ...process.env,
    ANDROID_HOME: sdk,
    JAVA_HOME: javaHome,
    ANDROID_UPLOAD_KEYSTORE_PATH: keystore,
    DOCBLOCKS_REQUIRE_RELEASE_SIGNING: '1',
  };
  const windows = process.platform === 'win32';
  run(
    windows ? 'gradlew.bat' : './gradlew',
    [
      '--no-daemon',
      ':app:bundleRelease',
      `-PdocblocksVersionName=${version}`,
      `-PdocblocksVersionCode=${buildNumber}`,
    ],
    { cwd: path.join(mobile, 'android'), env: environment, shell: windows },
  );
  const bundle = path.join(output, `${name}.aab`);
  copyFileSync(
    path.join(mobile, 'android/app/build/outputs/bundle/release/app-release.aab'),
    bundle,
  );
  // -strict fails on unsigned entries and invalid chains; the keystore makes the
  // self-signed upload certificate the trust anchor. An unsigned bundle exits 0
  // with "jar is unsigned.", so the verified line is required too.
  const verification = spawnSync(
    path.join(javaHome, 'bin', `jarsigner${windows ? '.exe' : ''}`),
    [
      '-J-Duser.language=en',
      '-verify',
      '-strict',
      '-keystore',
      keystore,
      '-storepass:env',
      'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
      bundle,
    ],
    { encoding: 'utf8', env: environment },
  );
  if (verification.status !== 0 || !/^jar verified\.$/mu.test(verification.stdout ?? '')) {
    process.stderr.write(`${verification.stdout ?? ''}${verification.stderr ?? ''}`);
    throw new Error('The app bundle is not signed by the upload key.');
  }
  verifyPayload(bundle);
  return [describe(bundle, 'aab')];
}
/** Checks the exported IPA itself: the store receives this file, not the archive. */
function verifyIpa(ipa, settings) {
  const extracted = path.join(temp, 'ipa');
  run('ditto', ['-x', '-k', ipa, extracted]);
  const app = path.join(extracted, 'Payload/App.app');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  if (readProfile(path.join(app, 'embedded.mobileprovision')).uuid !== settings.profile)
    throw new Error('The IPA embeds a different provisioning profile.');
  const entitlements = path.join(temp, 'entitlements.plist');
  run('codesign', ['-d', '--entitlements', entitlements, '--xml', app], { stdio: 'ignore' });
  if (plistValue(entitlements, 'get-task-allow') === 'true')
    throw new Error('The IPA is signed for development (get-task-allow).');
  if (!plistValue(entitlements, 'application-identifier')?.endsWith(`.${APP_ID}`))
    throw new Error(`The IPA is not signed for ${APP_ID}.`);
  verifyPayload(extracted);
}
function buildIos() {
  const project = path.join(mobile, 'ios/App/App.xcodeproj/project.pbxproj');
  const original = readFileSync(project);
  const keychains = parseKeychains(capture('security', ['list-keychains', '-d', 'user']));
  const keychain = path.join(temp, 'signing.keychain-db');
  const installedProfiles = [];
  try {
    const certificate = path.join(temp, 'certificate.p12');
    const profilePath = path.join(temp, 'profile.mobileprovision');
    decodeSecret('IOS_DISTRIBUTION_CERTIFICATE_BASE64', certificate);
    decodeSecret('IOS_PROVISIONING_PROFILE_BASE64', profilePath);
    const password = randomBytes(32).toString('hex');
    capture('security', ['create-keychain', '-p', password, keychain]);
    capture('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    capture('security', ['unlock-keychain', '-p', password, keychain]);
    capture('security', [
      'import',
      certificate,
      '-P',
      process.env.IOS_DISTRIBUTION_CERTIFICATE_PASSWORD,
      '-k',
      keychain,
      '-T',
      '/usr/bin/codesign',
      '-T',
      '/usr/bin/security',
    ]);
    capture('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    capture('security', ['list-keychains', '-d', 'user', '-s', keychain, ...keychains]);
    const settings = profileSettings(
      readProfile(profilePath),
      capture('security', ['find-identity', '-v', '-p', 'codesigning', keychain]),
    );
    // Xcode 16+ reads UserData; earlier releases read MobileDevice. A profile
    // already installed under its UUID belongs to this machine and stays.
    for (const directory of [
      'Library/Developer/Xcode/UserData/Provisioning Profiles',
      'Library/MobileDevice/Provisioning Profiles',
    ]) {
      const target = path.join(os.homedir(), directory, `${settings.profile}.mobileprovision`);
      if (existsSync(target)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(profilePath, target);
      installedProfiles.push(target);
    }
    writeFileSync(project, configureProject(original.toString('utf8'), settings));
    const archive = path.join(temp, 'DocBlocks.xcarchive');
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
      path.join(temp, 'derived'),
      '-skipPackageUpdates',
      `MARKETING_VERSION=${version}`,
      `CURRENT_PROJECT_VERSION=${buildNumber}`,
      'archive',
    ]);
    run('codesign', [
      '--verify',
      '--deep',
      '--strict',
      path.join(archive, 'Products/Applications/App.app'),
    ]);
    const options = path.join(temp, 'ExportOptions.plist');
    writeFileSync(options, JSON.stringify(exportOptions(settings)));
    run('plutil', ['-convert', 'xml1', options]);
    const exported = path.join(temp, 'export');
    run('xcodebuild', [
      '-exportArchive',
      '-archivePath',
      archive,
      '-exportPath',
      exported,
      '-exportOptionsPlist',
      options,
    ]);
    const ipas = readdirSync(exported).filter((file) => file.endsWith('.ipa'));
    if (ipas.length !== 1) throw new Error('Xcode did not export exactly one IPA.');
    const ipa = path.join(output, `${name}.ipa`);
    copyFileSync(path.join(exported, ipas[0]), ipa);
    verifyIpa(ipa, settings);
    const artifacts = [describe(ipa, 'ipa')];
    // Retain symbols for crash reports without shipping the whole archive.
    const symbols = path.join(archive, 'dSYMs');
    if (existsSync(symbols) && readdirSync(symbols).length) {
      const zip = path.join(output, `${name}-dsyms.zip`);
      run('ditto', ['-c', '-k', '--keepParent', symbols, zip]);
      artifacts.push(describe(zip, 'dsyms'));
    }
    return artifacts;
  } finally {
    writeFileSync(project, original);
    for (const file of installedProfiles) rmSync(file, { force: true });
    if (keychains.length)
      spawnSync('security', ['list-keychains', '-d', 'user', '-s', ...keychains]);
    spawnSync('security', ['delete-keychain', keychain], { stdio: 'ignore' });
  }
}
try {
  npm(['run', 'mobile:build']);
  npm(['run', 'mobile:check']);
  npm(['run', `sync:${platform}`, '-w', 'docblocks-mobile']);
  const artifacts = platform === 'android' ? buildAndroid() : buildIos();
  const sourceCommit =
    process.env.GITHUB_SHA ||
    spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  writeFileSync(
    path.join(output, `${name}.json`),
    JSON.stringify(
      {
        platform,
        appId: APP_ID,
        version,
        buildNumber: Number(buildNumber),
        signed: true,
        sourceCommit,
        artifacts,
      },
      null,
      2,
    ) + '\n',
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${platform} ${version} (build ${buildNumber})\n\n` +
        artifacts.map((item) => `- \`${item.file}\` — sha256 \`${item.sha256}\``).join('\n') +
        '\n\nAttached to the private draft release. Nothing was uploaded to a store.\n',
    );
  process.stdout.write(`Verified signed ${platform} store artifacts: ${output}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
