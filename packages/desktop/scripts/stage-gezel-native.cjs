/** electron-builder adapter. Gezel owns archive pins, extraction, and verification. */
const { readFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { stageVcRuntime } = require('./stage-vc-runtime.cjs');

async function stageForTarget(context, overrides = {}) {
  const appDir = context.packager.info.appDir;
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = require('builder-util').Arch[context.arch];
  const serviceRequire = createRequire(require.resolve('@bendyline/gezel-service/package.json'));
  const manifest = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  const installed = serviceRequire('./package.json');
  if (manifest.dependencies['@bendyline/gezel-service'] !== installed.version) {
    throw new Error("The installed Gezel service must match DocBlocks' exact dependency pin.");
  }
  const stage =
    overrides.stageElectronNative ??
    require('@bendyline/gezel-service/packaging').stageElectronNative;
  await stage({
    platform,
    arch,
    destination: path.join(
      appDir,
      'dist',
      'gezel-native',
      `${context.packager.platform.buildConfigurationKey}-${arch}`,
    ),
    cache: path.join(appDir, 'dist', 'gezel-native-cache'),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  if (platform === 'win32') {
    // This also serves DocBlocks' speech runtime, which is outside the text AI host.
    await stageVcRuntime({
      arch,
      destination: path.join(appDir, 'dist', 'vc-runtime', arch),
      ...(overrides.vcRuntime ?? {}),
    });
  }
}
exports.default = (context) => stageForTarget(context);
exports.stageForTarget = stageForTarget;
