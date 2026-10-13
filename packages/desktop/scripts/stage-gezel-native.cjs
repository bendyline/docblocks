/** electron-builder adapter. Gezel owns archive pins, extraction, and verification. */
const { readFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const path = require('node:path');
const { stageVcRuntime } = require('./stage-vc-runtime.cjs');
const { verifyNativePlatformRequirements } = require('./native-platform-requirements.cjs');
const intelMacFinal = require('../intel-mac-final.json');

async function stageForTarget(context, overrides = {}) {
  const appDir = context.packager.info.appDir;
  const platform = context.electronPlatformName === 'mas' ? 'darwin' : context.electronPlatformName;
  const arch = require('builder-util').Arch[context.arch];
  const serviceRequire = createRequire(require.resolve('@bendyline/gezel-inference/package.json'));
  const manifest = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  const installed = serviceRequire('./package.json');
  const dependency = manifest.dependencies['@bendyline/gezel-inference'];
  let expectedVersion = dependency;
  if (dependency?.startsWith('file:vendor/')) {
    const provenance = JSON.parse(
      await readFile(path.join(appDir, 'vendor/provenance.json'), 'utf8'),
    );
    const pin = provenance.packages['@bendyline/gezel-inference'];
    const archive = pin && (await readFile(path.join(appDir, 'vendor', pin.file)));
    if (
      !pin ||
      dependency !== `file:vendor/${pin.file}` ||
      require('node:crypto').createHash('sha256').update(archive).digest('hex') !== pin.sha256
    ) {
      throw new Error('The Gezel inference preview must match its recorded archive pin.');
    }
    expectedVersion = pin.version;
  }
  if (expectedVersion !== installed.version) {
    throw new Error(
      "The installed Gezel inference runtime must match DocBlocks' exact dependency pin.",
    );
  }
  // Intel Macs stopped at intel-mac-final.json's version. Only that release
  // builds their final update, and it has no engines to stage: the pinned
  // native release has no Intel Mac archives.
  const intelMac = platform === 'darwin' && arch === 'x64';
  if (intelMac && manifest.version !== intelMacFinal.version) {
    throw new Error(
      `Intel Macs are no longer supported; only DocBlocks ${intelMacFinal.version}, their final release, builds for darwin-x64.`,
    );
  }
  const stage =
    overrides.stageElectronNative ??
    require('@bendyline/gezel-inference/packaging').stageElectronNative;
  const destination = path.join(
    appDir,
    'dist',
    'gezel-native',
    `${context.packager.platform.buildConfigurationKey}-${arch}`,
  );
  await stage({
    platform,
    arch,
    destination,
    cache: path.join(appDir, 'dist', 'gezel-native-cache'),
    ...(intelMac ? { allowUnavailable: true } : {}),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  });
  await (overrides.verifyNativePlatformRequirements ?? verifyNativePlatformRequirements)({
    directory: destination,
    platform,
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
