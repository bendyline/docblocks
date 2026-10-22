import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import path from 'node:path';
import { findJdk21 } from './jdk.mjs';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = path.join(repo, 'packages/mobile');
const output = path.join(repo, 'reports/mobile-native');
mkdirSync(output, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repo, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}
function conformance(command) {
  run(
    process.execPath,
    [
      'node_modules/mocha/bin/mocha.js',
      '--no-config',
      '--require',
      'tsx',
      'packages/mobile/test/native-storage.test.ts',
      '--timeout',
      '20000',
    ],
    { env: { ...process.env, DOCBLOCKS_NATIVE_COMMAND: JSON.stringify(command) } },
  );
}
const platform = process.argv[2];
if (!['ios', 'android', 'available'].includes(platform))
  throw new Error('Choose ios, android, or available.');
const androidHome =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  (process.platform === 'darwin' ? path.join(process.env.HOME, 'Library/Android/sdk') : undefined);
if (platform === 'ios' || (platform === 'available' && process.platform === 'darwin')) {
  if (process.platform !== 'darwin') throw new Error('The iOS storage tests need macOS and Xcode.');
  const scratch = path.join(output, 'swift');
  const args = ['--package-path', path.join(mobile, 'native/ios'), '--scratch-path', scratch];
  run('swift', ['build', ...args]);
  run('swift', ['test', ...args]);
  const result = spawnSync('swift', ['build', ...args, '--show-bin-path'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Swift could not locate its test binary.');
  conformance([path.join(result.stdout.trim(), 'StorageHarness')]);
}
if (
  platform === 'android' ||
  (platform === 'available' && androidHome && existsSync(androidHome))
) {
  if (!androidHome || !existsSync(androidHome))
    throw new Error('Set ANDROID_HOME to an installed Android SDK.');
  const javaHome = findJdk21();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const java = path.join(javaHome, 'bin', `java${suffix}`);
  const javac = path.join(javaHome, 'bin', `javac${suffix}`);
  const environment = { ...process.env, ANDROID_HOME: androidHome, JAVA_HOME: javaHome };
  // The tracked Gradle settings include Capacitor's generated, gitignored
  // Cordova plugin project and app assets, which a fresh checkout lacks.
  // `cap sync` generates both from the mobile web build (packages/mobile/dist).
  run(
    process.execPath,
    [path.join(repo, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'],
    { cwd: mobile },
  );
  const resolveClasspath = (extraArgs = []) =>
    run(
      process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
      ['--no-daemon', ...extraArgs, ':app:writeMobileConformanceClasspath'],
      { cwd: path.join(mobile, 'android'), env: environment, shell: process.platform === 'win32' },
    );
  // This step only resolves a classpath, which on a fresh runner means
  // downloading the Android Gradle plugin and its dependencies. Maven Central
  // has briefly answered 404 for artifacts it hosts, failing a release gate.
  // Retry once, refreshing because Gradle caches "not found" answers; a real
  // build error fails again, and the conformance tests below never retry.
  try {
    resolveClasspath();
  } catch {
    process.stderr.write('Retrying Android classpath resolution once.\n');
    resolveClasspath(['--refresh-dependencies']);
  }
  const classpath = readFileSync(
    path.join(mobile, 'android/app/build/mobile-conformance-classpath.txt'),
    'utf8',
  );
  const classes = path.join(output, 'java');
  mkdirSync(classes, { recursive: true });
  run(javac, [
    '-cp',
    classpath,
    '-d',
    classes,
    path.join(mobile, 'android/app/src/main/java/com/bendyline/docblocks/mobile/Storage.java'),
    path.join(mobile, 'android/app/src/main/java/com/bendyline/docblocks/mobile/StorageNode.java'),
    path.join(mobile, 'native/android/StorageHarness.java'),
  ]);
  conformance([java, '-cp', `${classes}${path.delimiter}${classpath}`, 'StorageHarness']);
}
