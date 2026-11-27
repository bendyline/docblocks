/**
 * Stage the Mac app's iCloud helper where packaging copies it from:
 * dist/cloud-helper/docblocks-cloud-helper.
 *
 * The helper is the `CloudHelper` target of the Swift package that also holds
 * the iPhone and iPad storage layer (packages/mobile/native/ios), so both
 * collect the versions iCloud sets aside with the same code. It is built from
 * source here: nothing is downloaded, and there is no prebuilt copy to drift.
 * macOS only; other platforms have no iCloud folders to look after.
 */
const { execFile } = require('node:child_process');
const { chmod, copyFile, mkdir, stat } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const APP_DIR = path.join(__dirname, '..');
const BINARY_NAME = 'docblocks-cloud-helper';
const PRODUCT = 'CloudHelper';
const run = promisify(execFile);

function stagedCloudHelper(appDir = APP_DIR) {
  return path.join(appDir, 'dist', 'cloud-helper', BINARY_NAME);
}

function swiftPackageDirectory(appDir = APP_DIR) {
  return path.join(appDir, '..', 'mobile', 'native', 'ios');
}

async function stageCloudHelper(
  { appDir = APP_DIR, platform = process.platform, arch = process.arch } = {},
  overrides = {},
) {
  if (platform !== 'darwin') return null;
  // Intel Macs stopped at their final release; every Mac build is Apple silicon.
  if (arch !== 'arm64') throw new Error(`The iCloud helper is not built for darwin-${arch}.`);
  const swift = overrides.swift ?? ((args, options) => run('swift', args, options));
  const cwd = swiftPackageDirectory(appDir);
  const options = { cwd, timeout: 600000, maxBuffer: 16 * 1024 * 1024 };
  const build = ['build', '-c', 'release', '--arch', 'arm64'];
  try {
    await swift([...build, '--product', PRODUCT], options);
  } catch (error) {
    const detail = error && typeof error.stderr === 'string' ? `\n${error.stderr.trim()}` : '';
    throw new Error(
      `Could not build the iCloud helper. Building the Mac app needs the Swift toolchain (Xcode or its command line tools).${detail}`,
    );
  }
  const { stdout } = await swift([...build, '--show-bin-path'], options);
  const built = path.join(String(stdout).trim(), PRODUCT);
  const destination = stagedCloudHelper(appDir);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(built, destination);
  await chmod(destination, 0o755);
  const { size } = await stat(destination);
  if (size === 0) throw new Error('The staged iCloud helper is empty.');
  return destination;
}

module.exports = { BINARY_NAME, stageCloudHelper, stagedCloudHelper, swiftPackageDirectory };

if (require.main === module) {
  stageCloudHelper().then(
    (destination) =>
      console.log(
        destination
          ? `Staged the iCloud helper in ${destination}`
          : 'The iCloud helper is only built on macOS; nothing to stage.',
      ),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
