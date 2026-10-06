import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import path from 'node:path';
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
  let javaHome = process.env.JAVA_HOME_21_X64 || process.env.JAVA_HOME;
  if (!javaHome && process.platform === 'darwin') {
    const result = spawnSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8' });
    if (result.status === 0) javaHome = result.stdout.trim();
  }
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const java = javaHome ? path.join(javaHome, 'bin', `java${suffix}`) : `java${suffix}`;
  const javac = javaHome ? path.join(javaHome, 'bin', `javac${suffix}`) : `javac${suffix}`;
  const environment = {
    ...process.env,
    ANDROID_HOME: androidHome,
    ...(javaHome ? { JAVA_HOME: javaHome } : {}),
  };
  // The tracked Gradle settings include Capacitor's generated, gitignored
  // Cordova plugin project, which a fresh checkout lacks. Unlike `cap sync`,
  // `cap update` regenerates it without needing a web build.
  run(
    process.execPath,
    [path.join(repo, 'node_modules/@capacitor/cli/bin/capacitor'), 'update', 'android'],
    { cwd: mobile },
  );
  run(
    process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
    ['--no-daemon', ':app:writeMobileConformanceClasspath'],
    { cwd: path.join(mobile, 'android'), env: environment, shell: process.platform === 'win32' },
  );
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
