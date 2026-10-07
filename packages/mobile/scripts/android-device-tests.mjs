import { setTimeout } from 'node:timers';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = path.join(root, 'packages/mobile');
const device = process.argv[2];
if (!device || !/^[a-zA-Z0-9_.:-]+$/.test(device))
  throw new Error(
    'Supply an explicit adb device ID. Tests use com.bendyline.docblocks.mobile.tests.',
  );
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(process.env.HOME, 'Library/Android/sdk');
const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const run = (args) => {
  const result = spawnSync(adb, ['-s', device, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
};
const appMetadata = JSON.parse(
  readFileSync(
    path.join(mobile, 'android/app/build/outputs/apk/debug/output-metadata.json'),
    'utf8',
  ),
);
const testMetadata = JSON.parse(
  readFileSync(
    path.join(mobile, 'android/app/build/outputs/apk/androidTest/debug/output-metadata.json'),
    'utf8',
  ),
);
if (
  appMetadata.applicationId !== 'com.bendyline.docblocks.mobile.tests' ||
  testMetadata.applicationId !== 'com.bendyline.docblocks.mobile.tests.test'
)
  throw new Error('Build with -PdocblocksTestApp before running instrumentation.');
run([
  'install',
  '-r',
  path.join(mobile, 'android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk'),
]);
run(['install', '-r', path.join(mobile, 'android/app/build/outputs/apk/debug/app-debug.apk')]);
for (const backend of ['local', 'saf']) {
  const token = randomBytes(32).toString('hex');
  const port = run(['forward', 'tcp:0', 'tcp:19874']);
  const test = spawn(adb, [
    '-s',
    device,
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'class',
    'com.bendyline.docblocks.mobile.SafContractServer',
    '-e',
    'docblocksToken',
    token,
    '-e',
    'docblocksBackend',
    backend,
    'com.bendyline.docblocks.mobile.tests.test/androidx.test.runner.AndroidJUnitRunner',
  ]);
  let log = '';
  test.stdout.on('data', (data) => {
    log += data;
  });
  test.stderr.on('data', (data) => {
    log += data;
  });
  const completed = new Promise((resolve) => test.on('exit', resolve));
  const connect = () =>
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
      socket.on('error', reject);
      socket.on('connect', () => resolve(socket));
    });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      // adb may accept a connection before instrumentation has opened its socket.
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = await new Promise((resolve) => {
        const socket = createConnection({ host: '127.0.0.1', port: Number(port) });
        const finish = (value) => {
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(1000, () => finish(false));
        socket.on('error', () => finish(false));
        socket.on('connect', () => socket.write(`${token}\nping\n`));
        socket.on('data', (data) => finish(data.toString().trim() === 'pong'));
        socket.on('end', () => finish(false));
      });
      if (test.exitCode !== null) throw new Error(log);
    }
    if (!ready) throw new Error('The Android contract server did not start.');
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/mocha/bin/mocha.js',
        '--no-config',
        '--require',
        'tsx',
        'packages/mobile/test/native-storage.test.ts',
        '--timeout',
        '30000',
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          DOCBLOCKS_TEST_TOKEN: token,
          DOCBLOCKS_TEST_PORT: port,
          DOCBLOCKS_NATIVE_COMMAND: JSON.stringify([
            process.execPath,
            path.join(mobile, 'scripts/android-contract-client.mjs'),
          ]),
        },
      },
    );
    const socket = await connect();
    socket.end(`${token}\nshutdown\n`);
    await completed;
    if (result.status !== 0 || !log.includes('OK (2 tests)'))
      throw new Error(log || 'Android contract suite failed.');
  } finally {
    run(['forward', '--remove', `tcp:${port}`]);
    if (test.exitCode === null) {
      run(['shell', 'am', 'force-stop', 'com.bendyline.docblocks.mobile.tests']);
      test.kill();
    }
    mkdirSync(path.join(root, 'reports/mobile-native'), { recursive: true });
    writeFileSync(
      path.join(root, `reports/mobile-native/android-${backend}-instrumentation.txt`),
      log,
    );
  }
  process.stdout.write(`Android ${backend} conformance passed.\n`);
}
